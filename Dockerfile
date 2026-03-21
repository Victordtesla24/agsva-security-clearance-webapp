# ─────────────────────────────────────────────────────────────
# AGSVA Clearance Platform — Production Dockerfile
# Node.js 22 + Puppeteer (headless Chromium) + Handlebars
# ─────────────────────────────────────────────────────────────

FROM node:22-bookworm-slim

# ── Chromium / Puppeteer system dependencies ──────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsof \
    wget \
    xdg-utils \
  && rm -rf /var/lib/apt/lists/*

# ── App user (non-root) ───────────────────────────────────────
RUN groupadd --system --gid 1001 agsva \
 && useradd --system --uid 1001 --gid agsva --create-home --home-dir /home/agsva agsva

# ── Puppeteer cache — writable by app user ────────────────────
ENV PUPPETEER_CACHE_DIR=/home/agsva/.cache/puppeteer

# ── Working directory ─────────────────────────────────────────
WORKDIR /app

# ── Install dependencies + download Chromium ──────────────────
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev \
 && npx puppeteer browsers install chrome \
 && chown -R agsva:agsva /home/agsva/.cache

# ── Copy application source ───────────────────────────────────
COPY index.html app-runtime.js firebase-config.js ./
COPY server/ ./server/

# ── Runtime data directory ────────────────────────────────────
RUN mkdir -p /app/data/uploads /app/artifacts/server/ai-validations \
 && chown -R agsva:agsva /app

# ── Drop privileges ───────────────────────────────────────────
USER agsva

# ── Environment defaults ──────────────────────────────────────
ENV NODE_ENV=production \
    LOCAL_APP_HOST=0.0.0.0 \
    LOCAL_APP_PORT=3000 \
    LOCAL_APP_DATA_DIR=/app/data \
    LOCAL_APP_DEFAULT_FILE=index.html \
    LOCAL_APP_DISABLE_DOTENV=1

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:3000/api/health || exit 1

CMD ["node", "--experimental-sqlite", "server/local-app.mjs"]
