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
| Cloudflare Workers AI: Whisper large-v3-turbo (primary), Deepgram Nova-3, gpt-4o-transcribe (fallbacks) | Server-side transcription | chosen; ranking confirmed by B-05 Malayalam test |
| Groq (OpenAI-compatible API), model `openai/gpt-oss-120b` | Intake, PII-tagging and triage agents (B-06b). Receives report text with phone, email, ID, plate and the reporter's known name/phone masked; never audio, location or contact details. Mock mode for the offline demo and as the fallback. | chosen; live adapter in `backend/app/agents/llm_live.py` |
| Google Gemini API (`gemini-flash-latest`, OpenAI-compatible endpoint) | Optional failover for the same three agents when the primary LLM fails or is rate-limited (B-06b). Same masking rules apply. Free-tier prompts may be used by Google to improve products: use a paid key for anything beyond synthetic demo data. | chosen as fallback; `LLM_FALLBACK_PROVIDER=gemini` |
| Firecrawl search API | Hazard context for triage (B-06b). Query holds only hazard words such as "gas" or "chemical"; no report text, PII or location. | chosen; `backend/app/agents/search.py` |
| SMS gateway | SMS fallback | to be chosen (B-10) |

## AI-generated code
- The initial `web/` UI scaffold (layouts, shadcn/ui components, mock screens) was generated with an AI app builder (Lovable) and then adapted by the team. Its npm helper `@lovable.dev/vite-tanstack-config` is still a build dependency. Screens are being rewired to the Sahay API; the team reviews what is merged.

## Reference only (no code copied)
- Dictation apps such as OpenWhispr (MIT) and Wispr Flow were looked at as product references. We do not use or copy their code: they are desktop apps, Sahay's capture is a hold-to-talk button in an Android-wrapped PWA with server-side STT.

## AI tools
- Claude Code (Anthropic) assisted with coding, tests and documentation. Team members review and understand all merged code, as the rules require.
