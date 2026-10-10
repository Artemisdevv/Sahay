# native/

Kotlin side of the Nearby relay (issue N-03). Kept separate from `android/` (which `npx cap add android` creates in N-01) so the protocol can be built and tested without the web app.

| Module | What | Needs a phone? |
|---|---|---|
| `relay-core` | Pure Kotlin/JVM. Wire protocol (contract section 5), `RelayEngine` (dedupe, ttl/hops, store-and-forward, receipts back along the path), `FileStore`. | No. `gradlew :relay-core:test` |
| `relay-android` | `NearbyTransport`: Google Nearby Connections under the engine (P2P_CLUSTER, auto-accept, BYTES vs STREAM, ordered inbound). | Yes |
| `relay-demo` | Two-phone test app: new report, relay, simulated upload + receipt. | Yes |

N-01 will wrap `relay-core` + `relay-android` in the Capacitor `SahayNearby` plugin (methods in contract section 5).

## Build and test
```
# JDK 17, ANDROID_HOME set, native/local.properties with sdk.dir
./gradlew :relay-core:test
./gradlew :relay-demo:assembleDebug
adb -s <phone> install -r relay-demo/build/outputs/apk/debug/relay-demo-debug.apk
```

## Two-phone test
1. Install on both, open, tap **Start** (grant permissions).
2. Phone A: **New report** (or **New 150 KB** to exercise the stream path). Phone B logs `RECEIVED`.
3. Phone B: **Simulate upload + receipt**. Phone A logs `RECEIPT` and `STATUS`.

## Hardening still open
- `RelayEngine` requires a `receiptVerifier` and a `statusVerifier` (contract section 5 rule 9). `ServerVerifier(serverVerifyKeyB64)` implements both against the server Ed25519 key from `/config/server-key` and is tested on the frozen contract vector. The demo app still passes accept-all stubs because it fabricates receipts.

## Foreground service (N-04)
`web/android/.../RelayForegroundService.kt`, started by `SahayNearby.start()` and stopped by `stop()` or the **Stop** action in its notification.
- Type `connectedDevice` (Android 14+ requires a type). Manifest: `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_CONNECTED_DEVICE`, `POST_NOTIFICATIONS`, `WAKE_LOCK`. Android only lets this type start when the app holds a Bluetooth / Nearby Wi-Fi runtime permission, which `start()` requests first.
- The relay state (engine, transport) lives in a process-wide `RelaySession`, not in the plugin, so pressing Back (Activity destroyed) does not stop the relay. Events that arrive while no UI is attached stay in the store and come out through `pendingForUpload()`.
- A partial wake lock (max 6 h, renewed on each `start()`) keeps the CPU awake for Nearby with the screen off.
- Notification permission (Android 13+) is asked once, together with the radio permissions, and is not required: the service runs without a visible notification if the user denies it.
- `START_NOT_STICKY`: if the system kills the process the relay is not silently restarted; the app starts it again from the UI.

### Measured battery drain: NOT YET MEASURED
To fill in on both test phones (screen off, relay on, no peers): `adb shell dumpsys batterystats --reset`, wait 60 min, then `adb shell dumpsys batterystats | grep -A5 in.sahay.app`. Record %/h here.

### OEM battery settings for the demo
Do these on every demo phone, otherwise the service can be frozen with the screen off:
- **Vivo / iQOO (Funtouch / OriginOS):** Settings > Battery > Background power consumption management > Sahay > Allow high background power consumption; Recent apps > lock Sahay; Settings > Apps > Autostart > Sahay on.
- **Motorola:** Settings > Apps > Sahay > Battery > Unrestricted (not Optimized).
- **All:** keep Bluetooth, Location and (for Nearby) Wi-Fi switched on; Wi-Fi does not need to be connected to a network.

## Uploading with the screen off (native uploader)
With the screen off the WebView is throttled: the relay event and the 30 s timer in the web layer did not reliably run, so a phone carrying someone else's report sat on it (seen on a Moto G96: carried 1 report, no upload for over 3 minutes until the app was poked).
`CarriedUploader` (relay-core, pure Kotlin, JVM-tested) now uploads **reports carried for others** from the relay's foreground service, with `NativeUploader` (Android: HttpURLConnection, connectivity check, 30 s timer, network-available trigger) around it. It reads the device bearer token from the Keystore vault (`SecureVault`, shared with the web layer's secure store) and the API base the web layer passes to `SahayNearby.start({ apiBase })`.
- Rules per envelope: 200/202 delivered (receipt handed back to the engine, stop carrying); 400/409/413/422 drop; 401 stop the round and wait for the app to refresh the token (12 h tokens); 429, 5xx and no answer retry later. The server is idempotent, so a double upload with the app's own queue is harmless.
- A phone's **own** reports still go through the app's queue.
- Measured: Moto display off (`dumpsys display` `mState=OFF`), iQOO sender with the app's internet blocked: `SahayNativeUpload: carried reports: Summary(delivered=1)` one second after the report arrived, server had the incident 5 s after the tap.
- Limit: if the token has expired (app not opened for 12 h) the uploader waits; the next time the app opens it refreshes the token and uploads.
