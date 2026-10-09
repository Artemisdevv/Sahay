# Sahay web app

React app for the three Sahay workspaces: Civilian, Services and Admin. The same code runs as a browser app and, wrapped with Capacitor, as the Android app (see `docs/api-contract.md` section 5 for the native relay plugin).

Stack: TanStack Start (React, file-based routes), Tailwind, shadcn/ui, Vitest.

## Run
```
cd web
npm ci
npm run dev          # http://localhost:8080 (or the port Vite prints)
npm test             # unit and routing tests
npm run build        # server build
npm run build:app    # static SPA in dist/client for the Android WebView (CAPACITOR=1)
```

## Android
```
npm run build:app
npx cap sync android
cd android && ./gradlew assembleDebug     # needs JDK 21 and an Android SDK (sdk.dir in android/local.properties)
```
App id `in.sahay.app`. `android/local.properties` is git-ignored.

## Config
Copy `.env.example` to `.env.local`. Only `VITE_` variables reach the browser, so never put secrets there.

| Variable | Meaning |
|---|---|
| `VITE_API_BASE` | Backend REST base, default `http://localhost:8000/api/v1` |
| `VITE_WS_URL` | Backend WebSocket, default `ws://localhost:8000/ws/v1` |

## Routes
| Path | Who |
|---|---|
| `/login` | Everyone |
| `/user/:username` | Civilian |
| `/service/:serviceId` | Services (hospital, fire, police, municipal) |
| `/admin/dashboard` | Admin |

## Status
The UI is being connected to the Sahay backend (see `docs/issues.md`, F-xx and N-01). Until a screen says otherwise, treat its data as simulated and do not contact real emergency services from it.
