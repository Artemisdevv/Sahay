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
- Receipts are only shape-checked unless a `receiptVerifier` is passed to `RelayEngine`. Once the web layer shares the server Ed25519 key, wire a verifier so a nearby peer cannot forge "delivered".
- Foreground service so the relay survives screen-off: N-04.
