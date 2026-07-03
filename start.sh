#!/bin/bash
# COTF Booth — local static file server
# Run this before starting the Cloudflare Tunnel.
# Binds to 127.0.0.1 only (tunnel-safe, not exposed on LAN).
# Auto-restarts if the server dies.

cd "$(dirname "$0")"

echo "Starting COTF Booth server on http://localhost:3000"
echo "Press Ctrl+C to stop."
echo ""

while true; do
  python3 -m http.server 3000 --bind 127.0.0.1
  echo "Server stopped. Restarting in 2s..."
  sleep 2
done
