FROM node:20-slim

# Pinned Camoufox version (for Google Meet)
ARG CAMOUFOX_VERSION=135.0.1
ARG CAMOUFOX_RELEASE=beta.24
ARG CAMOUFOX_URL=https://github.com/daijro/camoufox/releases/download/v${CAMOUFOX_VERSION}-${CAMOUFOX_RELEASE}/camoufox-${CAMOUFOX_VERSION}-${CAMOUFOX_RELEASE}-lin.x86_64.zip

# ─── System dependencies ───────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Audio
    pulseaudio ffmpeg \
    # Virtual display
    xvfb \
    # Chromium deps (Playwright — for Teams/Zoom)
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2 libx11-xcb1 \
    # Firefox deps (Camoufox — for Google Meet)
    libgtk-3-0 libdbus-glib-1-2 libxt6 libxcursor1 libxi6 \
    libxrender1 libxss1 libxtst6 \
    # Fonts
    fonts-liberation fonts-noto-color-emoji fontconfig \
    # Utils
    ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*

# ─── Install Camoufox browser binary ──────────────────────────────
RUN mkdir -p /root/.cache/camoufox \
    && curl -L -o /tmp/camoufox.zip "${CAMOUFOX_URL}" \
    && (unzip -q /tmp/camoufox.zip -d /root/.cache/camoufox || true) \
    && rm /tmp/camoufox.zip \
    && chmod -R 755 /root/.cache/camoufox

# ─── Install camofox-browser (REST API for Camoufox) ──────────────
# Copy from sibling directory — set build context to parent or use build script
# For standalone build: copy camofox-browser/ into this directory first
WORKDIR /camofox
COPY vendor/camofox-browser/package.json vendor/camofox-browser/package-lock.json ./
RUN npm ci --production
COPY vendor/camofox-browser/server.js ./
COPY vendor/camofox-browser/lib/ ./lib/

# ─── Install MiBot ─────────────────────────────────────────────────
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# Install Playwright Chromium
RUN npx playwright install chromium

COPY tsup.config.ts tsconfig.json ./
COPY src/ ./src/
RUN npx tsup && npm prune --production

# PulseAudio config is created at runtime by docker-entrypoint.sh

# ─── Fake video for Chrome (black screen instead of test pattern) ──
RUN mkdir -p /root/.config/mibot && \
    ffmpeg -f lavfi -i color=c=black:s=640x480:d=1 -pix_fmt yuv420p \
    /root/.config/mibot/black.y4m 2>/dev/null

# ─── Entrypoint ────────────────────────────────────────────────────
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

VOLUME /root/.config/mibot

ENV NODE_ENV=production
ENV PULSE_SERVER=unix:/tmp/pulse/native
ENV DISPLAY=:50
ENV CAMOFOX_URL=http://localhost:9377

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "dist/index.js", "start"]
