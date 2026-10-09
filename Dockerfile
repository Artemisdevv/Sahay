# Demo image: FastAPI backend + built web app on ONE origin (no CORS, one tunnel).
# Build from the repo root:  docker build -t sahay .
# Single instance only: the WebSocket manager and device-challenge cache are in memory.

FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
# npm ci fails on Linux: the Windows-made lock file lacks optional @emnapi entries.
RUN npm install --no-audit --no-fund
COPY web/ ./
# Same-origin API and WebSocket (paths, resolved against the page host at runtime).
ENV VITE_API_BASE=/api/v1 VITE_WS_URL=/ws/v1
RUN npm run build:app

FROM python:3.13-slim AS app
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /srv
COPY backend/requirements.txt ./
RUN pip install -r requirements.txt
COPY backend/app ./app
COPY --from=web /web/dist/client /srv/static
RUN useradd --system --create-home sahay && mkdir /data && chown sahay /data
USER sahay
ENV SAHAY_STATIC_DIR=/srv/static SAHAY_DATABASE_URL=sqlite:////data/sahay.db
VOLUME /data
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]
