# Third-party code, services and AI use (disclosure)

The hackathon rules ask us to acknowledge open-source code, third-party resources and AI tool use. This file is the running list. **Add a line whenever a dependency or external service is added.** Everything else in this repo was written by the team during the hackathon.

## Open-source libraries (used as dependencies, not copied)
| Component | Used for | License |
|---|---|---|
| FastAPI, Uvicorn, SQLAlchemy, Pydantic | Backend API | MIT / BSD |
| PyNaCl (libsodium) | Envelope crypto on the server | Apache-2.0 |
| libsodium-wrappers | Envelope crypto in the web app | ISC |
| Capacitor | Wraps the web app for Android | MIT |
| Google Nearby Connections (Play Services) | Phone-to-phone relay | Google APIs terms |
| React, Vite | Web app | MIT |
| MapLibre GL / Leaflet | Distress Map | BSD / BSD-2 |

## External services and APIs
| Service | Used for | Status |
|---|---|---|
| Speech-to-text provider | Server-side transcription | to be chosen after B-05 Malayalam test |
| LLM provider | Intake, PII, triage agents | to be chosen (B-06); mock mode for offline demo |
| SMS gateway | SMS fallback | to be chosen (B-10) |

## Reference only (no code copied)
- Dictation apps such as OpenWhispr (MIT) and Wispr Flow were looked at as product references. We do not use or copy their code: they are desktop apps, Sahay's capture is a hold-to-talk button in an Android-wrapped PWA with server-side STT.

## AI tools
- Claude Code (Anthropic) assisted with coding, tests and documentation. Team members review and understand all merged code, as the rules require.
