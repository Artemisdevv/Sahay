# Docker demo (one origin: web app + API)

For testers and judges before a real cloud deploy (B-12). One container serves the built web app and the API; a tunnel gives it a public URL.

```
python deploy/gen_secrets.py        # writes deploy/.env.demo (git-ignored): fresh keys + staff passwords
docker compose up --build -d        # http://localhost:8080 (container port 8000 is published on 8080)
ngrok http 8080                     # public https URL (WebSocket works over wss)
```

- Staff logins: `admin`, `amb-01`, `police-01`, `fire-01`. Passwords are `SAHAY_SEED_ADMIN_PASSWORD` / `SAHAY_SEED_SERVICE_PASSWORD` in `deploy/.env.demo`; they are seeded once on the first start (empty database). The admin can reveal PII: hand them only to people you trust.
- `SAHAY_DEV=0`: no `/dev/*` endpoints. Delete the volume (`docker compose down -v`) to start from a clean database.
- Agents run in `mock` mode. For live LLMs add `SAHAY_LLM_MODE=live`, `LLM_PROVIDER`, `LLM_API_KEY` (and optionally the Gemini fallback) to `deploy/.env.demo`.
- Keep ONE instance: the WebSocket manager and the device-challenge cache are in memory.
- The Android app can point at the tunnel URL by building with `VITE_API_BASE=https://<tunnel>/api/v1 VITE_WS_URL=wss://<tunnel>/ws/v1`; add `https://localhost` to `SAHAY_CORS_ORIGINS` (already in the generated file).
- `.env.demo` holds secrets: never commit it or paste it in chat. If you regenerate it, old reports can no longer be decrypted.

## SMS fallback (optional)

Set `SAHAY_GATEWAY_SECRET` (any long random string) and `SAHAY_GATEWAY_NUMBER` (the number phones text, with country code) in `deploy/.env.demo`, then rebuild. The app picks the number up from `/config/server-key` while it is online.
Messages reach the server through `POST /api/v1/sms-gateway/inbound` with the header `X-Gateway-Secret`. For the demo, `backend/scripts/sms_gateway_adb.py` turns a USB-connected phone with a SIM into the gateway (it reads that phone's SMS inbox over adb and forwards `SAHAY1|...` lines). For a real deployment point Twilio or a forwarder app at the same URL.
