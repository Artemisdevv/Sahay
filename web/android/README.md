# web/android: the Sahay Android app

Capacitor 8 project (`appId in.sahay.app`) that wraps the web app in `../`. Android only. The Kotlin plugins live in `app/src/main/java/sahay/`:

| Plugin | What | Contract |
|---|---|---|
| `SahayNearby` (`nearby/`) | Nearby Connections relay (P2P_CLUSTER) on top of `../../native/relay-core` + `relay-android`, with a foreground service (N-04) | `docs/api-contract.md` section 5 |
| `SahaySecureStore` (`securestore/`) | AES-256-GCM key in the Android Keystore for the device key and token | n/a |

`CapacitorHttp` is on: fetch/XHR run natively, so there is no CORS preflight.

## Requirements
- JDK 21 (the `native/` modules use JDK 17 only when built on their own), Android SDK with platform 36, Node 22.
- `web/android/local.properties` (git-ignored): `sdk.dir=D:/Android/Sdk` (forward slashes on Windows).
- adb on PATH, or use the full path (`D:\Android\Sdk\platform-tools\adb.exe`).

## Build and install a debug APK
```
cd web
npm install
npm run build:app                 # static SPA -> dist/client (CAPACITOR=1)
npx cap sync android
cd android
./gradlew assembleDebug           # app/build/outputs/apk/debug/app-debug.apk (debug-signed)
adb -s <serial> install -r app/build/outputs/apk/debug/app-debug.apk
```
Or copy the APK to the phone and open it (allow "install unknown apps"). Release builds are https only; debug builds also allow cleartext so the app can reach a local backend.

## Point the app at a backend
`VITE_API_BASE` and `VITE_WS_URL` are baked in at `npm run build:app` time.
- Local backend over USB: `adb reverse tcp:8000 tcp:8000`, build with `VITE_API_BASE=http://localhost:8000/api/v1 VITE_WS_URL=ws://localhost:8000/ws/v1`.
- Public tunnel / deploy: `VITE_API_BASE=https://<host>/api/v1 VITE_WS_URL=wss://<host>/ws/v1` (see `../../deploy/README.md`). The app origin is `https://localhost`; it is in the generated `SAHAY_CORS_ORIGINS`.

## Two-phone relay test page (dev only)
```
CAP_DEV=1 CAP_START_PATH=/relay-test.html npm run build:app
CAP_START_PATH=/relay-test.html npx cap sync android     # the variable is needed at BOTH steps
cd android && ./gradlew assembleDebug
```
`CAP_DEV=1` ships `dev/relay-test.html` and the TEST-ONLY crypto vector; never in a normal build. Install on both phones, tap **Start** (grants Location, Nearby devices, Notifications), queue a report on one, and watch the other. Results: `docs/n-03-results.md`.
Skip the permission dialogs with `adb shell pm grant in.sahay.app android.permission.<NAME>` for `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `BLUETOOTH_ADVERTISE`, `BLUETOOTH_CONNECT`, `BLUETOOTH_SCAN`, `NEARBY_WIFI_DEVICES`, `POST_NOTIFICATIONS`.

## Foreground service and battery
`start()` also starts `RelayForegroundService` (type `connectedDevice`) so the relay survives a locked screen and Back. Details and OEM battery steps (Vivo/iQOO, Motorola): `../../native/README.md`.

## Gotchas
- Git Bash on Windows mangles paths like `/sdcard` and `/relay-test.html`: `export MSYS_NO_PATHCONV=1`.
- adb drops phones often; `adb kill-server` makes them `unauthorized` until the USB-debugging prompt is accepted again.
- Bluetooth advertising can get stuck on some phones after heavy testing (seen once on a Moto G96, cleared by a reboot, see `docs/n-03-results.md`).
- Do not `npm ci` on Linux with the committed lock file (missing optional `@emnapi` entries); use `npm install`.
