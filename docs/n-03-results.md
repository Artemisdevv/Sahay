# N-03 two-phone relay test

Date: 2026-10-09. App: `native/relay-demo` (`:relay-demo:assembleDebug`), branch `feat/N-03-relay-protocol`.

## Setup
- Phone A (origin): iQOO Z9s, Android 16. Phone B (relay): Moto G96 5G, Android 16.
- Both phones in the offline demo state from `winning_solution.md` section 7: Wi-Fi off, mobile data off, Bluetooth on, Location on, **not** airplane mode. No router, hotspot or internet.
- Both on USB for adb only. Runtime permissions granted (location, Bluetooth advertise/connect/scan, nearby Wi-Fi devices).

## Result: PASS

| Step | Observed |
|---|---|
| Discovery and handshake | `PEER UP` on both phones, no pairing screen |
| A to B, 2 KB report x2 | B: `RECEIVED ... hops=0 ct=2 KB` |
| A to B, 150 KB report (stream path) | B: `RECEIVED ... ct=150 KB` |
| B simulates upload | B: `UPLOADED ... receipt+status sent back` for all 3 |
| Receipt and status back to A | A: `RECEIPT ... (delivered)` and `STATUS ... dispatched: Help dispatched, ETA 6 min` for all 3 |
| After delivery | B: `carrying=0 pending=0` |

## Findings
- First attempts failed: the Moto logged `[BLE][START_ADVERTISING] ... TIMEOUT` on every cycle and `requestConnection failed: 8012 STATUS_ENDPOINT_IO_ERROR`. A system Bluetooth fault on that phone, not the relay code; it cleared after rebooting the phone. For the demo: reboot both phones and toggle Bluetooth before going on stage, and keep the 20 s pre-recorded clip as the fallback (N-08).
- Wi-Fi is not needed. Neither phone had a network connection during the passing run.
- Windows host: if `adb` drops the iQOO, `adb kill-server` then `adb start-server` restores it.

## What this test does not cover
- The demo app passes accept-all receipt/status verifiers because it fabricates receipts. Verification is covered by JVM tests (`RelayEngineTest`); the Capacitor plugin (N-01) must wire the real Ed25519 check.
- Screen was on. Relaying with the screen off needs the foreground service (N-04).
- One hop only. Multi-hop is covered by the JVM simulation, not on devices.

## What a relay phone can see
The relay carries an opaque envelope. The report content (audio, transcript, location, category, reporter details) is sealed to the server key and cannot be read by the relay. The relay does see the envelope metadata it needs to route: `report_id`, the origin `device_id` (a random per-install UUID), `created_at`, `ttl`/`hops`, `key_id`, and the approximate size of the ciphertext. Receipts and statuses it forwards are server-signed (verified by the receiving phone in production).
