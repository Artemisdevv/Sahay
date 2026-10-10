# End-to-end results (N-07)

Scenario from the demo: **an offline phone sends a report, a nearby online phone carries it to the server, the admin sees it, status comes back.** Run by hand on real phones against the Docker demo server (live speech and AI agents) behind the ngrok tunnel. Dates are 2026-10-09 and 2026-10-10.

## Setup used
- Sender (A): iQOO Z9s or Vivo V2545. Uploader (C): Moto G96 (online). App: the Android APK built from `main` (`web/android/README.md`), pointed at the tunnel.
- "Offline" means the app has no internet, not that the Wi-Fi radio is off (see findings). On the iQOO this was done with `adb shell cmd connectivity set-chain3-enabled true` and `set-package-networking-enabled false in.sahay.app` (undo with `true` and `set-chain3-enabled false`). On the Vivo, Wi-Fi and data were switched off after the two phones had linked.
- Every phone opened the app online once first, to register its device key and cache the server key.

## Runs

| Run | Path | Result |
|---|---|---|
| Vivo offline, voice + Medical | Vivo -> Moto -> server | Server `202`, incident created. Vivo screen: "Delivered through a nearby phone" about 3 s after the send finished. |
| iQOO (app blocked), typed Medical message | iQOO -> Moto -> server | Delivered. iQOO queue entry `state: sent, via: relay` (the server receipt came back through the Moto and was verified on the iQOO). |
| iQOO (app blocked), typed Rescue message | iQOO -> Moto -> server | Server had the incident **3 s** after the tap. iQOO: "A nearby phone passed it on and the response centre has it." |
| iQOO (app blocked), typed Fire message, after the retry fix | iQOO -> Moto -> server | Server had it **4 s** after the tap. |

The admin (laptop) saw each report with an English summary written by the live agents, for example "Kitchen fire reported at a house near Edappally, with two people inside the building" (severity 4, pending approval). Approved incidents appear on the public map; units are called and glide to the incident (`docs/api-contract.md` section 9).

Relays do not see the report: the Moto's native store holds only the sealed envelope (report id, device id, time, ciphertext) and the app never lists carried reports.

## Findings (all fixed unless noted)
1. **The Wi-Fi radio must stay on.** Nearby Connections lost the link when the sender's Wi-Fi radio was switched off and did not recover until the app was restarted. The demo instruction is: turn off mobile data and leave Wi-Fi on but not connected to an internet network, or just have no internet.
2. **A carrying phone did not retry.** The Moto received the iQOO's report while the tunnel was down (ngrok answers 404 when no tunnel runs), and nothing retried the upload because carried reports are not in the local queue. Fixed in #87: the 30 s timer also checks the relay's pending reports, and the relay link is re-applied on network changes.
3. **ngrok interstitial.** Browser-like requests got ngrok's HTML warning page instead of the API; the app now sends `ngrok-skip-browser-warning` for tunnel URLs.
4. The first run of a day can stall at "Looking for nearby phones" on the Moto after many radio toggles (a Bluetooth advertising error seen earlier, `STATUS_RADIO_ERROR`); restarting the app or the phone's Bluetooth clears it.

## Not verified
- The signed dispatch **status** (dispatched, en route) travelling back to the offline sender over the relay: only the delivery receipt was observed. The listener exists and is unit tested.
- Three phones in a chain (A -> B -> C where A cannot reach C). The engine floods with a hop limit and is tested in chains in the JVM tests, but not on three real devices.
- Relay delivery with both screens off (see `native/README.md`, N-04 battery notes).
- A real voice recording from a phone through live speech-to-text (Android records WebM/Opus; Gemini's documented formats do not list it, Whisper is the fallback).
