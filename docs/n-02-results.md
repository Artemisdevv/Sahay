# N-02 Nearby Connections spike: results

Date: 2026-10-09. App: `spikes/nearby` (service ID `in.sahay.nearby`, `P2P_CLUSTER`, play-services-nearby 19.3.0).

## Verdict: PASS

Two real phones discovered each other, auto-accepted, completed the contract section 5 `hello` handshake, and exchanged a 51,385-byte envelope in both directions with matching SHA-256.

| Device | Android | Role in test |
|---|---|---|
| Moto G96 5G | 16 (API 36) | advertise |
| iQOO Z9s 5G (I2403) | 16 (API 36) | discover |

| Direction | Bytes | SHA-256 (first 16) | Transfer time |
|---|---|---|---|
| iQOO -> Moto | 51,385 | 133aec25a799ce4f (match) | 596 ms |
| Moto -> iQOO | 51,385 | 977d202a7f12b130 (match) | 690 ms |

Devices were next to each other; no range or screen-off test yet (N-04).

## Findings that change the plan

1. **Location permission is required for discovery on every Android version**, including 16. Without it, `startDiscovery` fails with `8034 MISSING_PERMISSION_ACCESS_COARSE_LOCATION`. Do not cap `ACCESS_*_LOCATION` with `maxSdkVersion`. Request location plus `BLUETOOTH_ADVERTISE/CONNECT/SCAN` and `NEARBY_WIFI_DEVICES` (13+). Carry this into N-03/N-06.
2. **`Payload.fromBytes` caps at 32 KB.** A 50 KB envelope must go as a STREAM (or FILE). Used STREAM; receiver reads to EOF. Contract section 5 already says this; keep it.
3. Either side can request the connection; both auto-accept. Both ends got `peers=1` after handshake.
4. Both phones need Google Play Services (true on both).

## Not yet tested
- Three-phone hop (A -> relay -> B), TTL/hops, dedupe: N-03.
- Screen off / backgrounded: N-04.
- Range, interference, older Android (<12), non-Pixel-class devices: N-08.

## Repro
```
cd spikes/nearby
./gradlew assembleDebug        # needs JDK 17, ANDROID_HOME, local.properties
adb -s <A> install -r app/build/outputs/apk/debug/app-debug.apk   # repeat for B
# A: Advertise.  B: Discover.  Then Send 50 KB on either.
```
