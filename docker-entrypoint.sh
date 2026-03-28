#!/bin/bash
set -e

# Clean up stale lock files from previous runs
rm -f /tmp/.X50-lock /tmp/.X50-unix/X50

# ─── Start Xvfb (virtual display) ──────────────────────────────────
echo "[mibot] Starting Xvfb on $DISPLAY..."
Xvfb $DISPLAY -screen 0 1280x720x24 -ac -nolisten tcp +extension Composite -noreset &
sleep 1

# ─── Start PulseAudio (user mode, no dbus) ─────────────────────────
echo "[mibot] Starting PulseAudio..."
mkdir -p /tmp/pulse /root/.config/pulse

# Write runtime config — user mode, no dbus, anonymous auth
cat > /root/.config/pulse/default.pa <<'EOF'
load-module module-native-protocol-unix auth-anonymous=1 socket=/tmp/pulse/native
load-module module-null-sink sink_name=chromesink sink_properties=device.description="Chrome_Sink"
set-default-sink chromesink
EOF

cat > /root/.config/pulse/daemon.conf <<'EOF'
daemonize = yes
exit-idle-time = -1
flat-volumes = no
use-pid-file = yes
EOF

# Start as regular user (not --system), skip dbus
PULSE_RUNTIME_PATH=/tmp/pulse pulseaudio \
  --start --exit-idle-time=-1 \
  --disallow-module-loading=false \
  --log-level=warn 2>&1 || true
sleep 1

export PULSE_SERVER=unix:/tmp/pulse/native

# Verify PulseAudio
if PULSE_SERVER=$PULSE_SERVER pactl info > /dev/null 2>&1; then
  SINK=$(PULSE_SERVER=$PULSE_SERVER pactl info 2>/dev/null | grep 'Default Sink' | cut -d: -f2 | xargs)
  echo "[mibot] PulseAudio ready — sink: $SINK"
else
  echo "[mibot] WARNING: PulseAudio failed to start, retrying..."
  # Retry without daemon mode for debugging
  PULSE_RUNTIME_PATH=/tmp/pulse pulseaudio \
    --exit-idle-time=-1 --daemonize \
    --log-level=info 2>&1 || true
  sleep 1
  if PULSE_SERVER=$PULSE_SERVER pactl info > /dev/null 2>&1; then
    echo "[mibot] PulseAudio ready on retry"
  else
    echo "[mibot] WARNING: PulseAudio unavailable — audio capture disabled"
  fi
fi

# ─── Start camofox (for Google Meet) ───────────────────────────────
echo "[mibot] Starting camofox..."
cd /camofox
CAMOFOX_PORT=9377 PULSE_SERVER=$PULSE_SERVER DISPLAY=$DISPLAY \
  node server.js &
sleep 2
cd /app

# Verify camofox
if curl -s http://localhost:9377/ | grep -q '"ok"'; then
  echo "[mibot] Camofox ready on :9377"
else
  echo "[mibot] WARNING: Camofox failed to start"
fi

# ─── Run MiBot ──────────────────────────────────────────────────────
echo "[mibot] Starting MiBot..."
exec "$@"
