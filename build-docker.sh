#!/bin/bash
# Build MiBot Docker image
# Stages camofox-browser files into vendor/ for the Docker build context
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Check common locations for camofox-browser
if [ -z "$CAMOFOX_DIR" ]; then
  for candidate in \
    "$(dirname "$SCRIPT_DIR")/camofox-browser" \
    "/root/projects/camofox-browser" \
    "/root/Projects/camofox-browser"; do
    [ -d "$candidate" ] && CAMOFOX_DIR="$candidate" && break
  done
fi
CAMOFOX_DIR="${CAMOFOX_DIR:-$(dirname "$SCRIPT_DIR")/camofox-browser}"

if [ ! -d "$CAMOFOX_DIR" ]; then
  echo "ERROR: camofox-browser not found at $CAMOFOX_DIR"
  echo "Set CAMOFOX_DIR to the camofox-browser project directory"
  exit 1
fi

echo "[build] Staging camofox-browser from $CAMOFOX_DIR..."
mkdir -p "$SCRIPT_DIR/vendor/camofox-browser/lib"
cp "$CAMOFOX_DIR/package.json" "$SCRIPT_DIR/vendor/camofox-browser/"
cp "$CAMOFOX_DIR/package-lock.json" "$SCRIPT_DIR/vendor/camofox-browser/" 2>/dev/null || true
cp "$CAMOFOX_DIR/server.js" "$SCRIPT_DIR/vendor/camofox-browser/"
cp -r "$CAMOFOX_DIR/lib/"* "$SCRIPT_DIR/vendor/camofox-browser/lib/" 2>/dev/null || true

echo "[build] Building Docker image..."
docker build -t mibot "$SCRIPT_DIR"

echo "[build] Cleaning up vendor/..."
rm -rf "$SCRIPT_DIR/vendor"

echo "[build] Done! Run with:"
echo "  docker compose up"
echo "  # or: docker run --rm -v ~/.config/mibot:/root/.config/mibot mibot node dist/index.js join <url>"
