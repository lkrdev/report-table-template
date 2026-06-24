#!/bin/bash

# Exit immediately if a command exits with a non-zero status,
# but allow the tunnel loop to manage its own lifecycle.
set -e

# ponytail: simple binary download to current directory instead of managing apt/yum/dnf/brew or sudo permissions.
CLOUDFLARED_BIN="cloudflared"

# Check if cloudflared is available in PATH
if ! command -v cloudflared &> /dev/null; then
    # Check if a local binary already exists in the current directory
    if [ -f "./cloudflared" ]; then
        CLOUDFLARED_BIN="./cloudflared"
    else
        echo "cloudflared not found in PATH or current directory. Downloading a local copy..."
        
        # Determine architecture
        ARCH=$(uname -m)
        case "$ARCH" in
            x86_64) BIN_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" ;;
            aarch64|arm64) BIN_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64" ;;
            *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
        esac
        
        # Download the precompiled binary directly to the current directory
        curl -L -o ./cloudflared "$BIN_URL"
        chmod +x ./cloudflared
        CLOUDFLARED_BIN="./cloudflared"
        echo "Downloaded cloudflared to ./cloudflared"
    fi
fi

# Check if the first argument is a port number
PORT_ARG=""
if [[ "$1" =~ ^[0-9]+$ ]]; then
    PORT_ARG="$1"
    shift
fi

# Determine the port to tunnel. Precedence:
# 1. Command line argument (if it was a number)
# 2. PORT environment variable (already present as $PORT)
# 3. PORT from .env file
# 4. Default to 8080
PORT="${PORT_ARG:-$PORT}"
if [ -z "$PORT" ] && [ -f ".env" ]; then
    # Parse PORT from .env file safely without sourcing it
    DOTENV_PORT=$(grep -E '^\s*PORT\s*=' .env | cut -d= -f2- | tr -d '[:space:]' | tr -d '"' | tr -d "'")
    if [ -n "$DOTENV_PORT" ]; then
        PORT=$DOTENV_PORT
    fi
fi
PORT=${PORT:-8080}
echo "Starting Cloudflare tunnel to http://localhost:$PORT..."

# Create a temporary file to capture logs so we can extract the URL
LOG_FILE=$(mktemp)

# Clean up background process and temporary file on exit/interrupt
cleanup() {
    echo -e "\nStopping tunnel..."
    if [ -n "$TUNNEL_PID" ]; then
        kill "$TUNNEL_PID" 2>/dev/null || true
    fi
    rm -f "$LOG_FILE"
}
trap cleanup EXIT INT TERM

# Start the quick tunnel in the background and redirect output to the temp log
$CLOUDFLARED_BIN tunnel --url "http://localhost:$PORT" > "$LOG_FILE" 2>&1 &
TUNNEL_PID=$!

# Poll the log file to extract the trycloudflare.com URL
URL=""
for i in {1..30}; do
    if grep -q "https://[a-zA-Z0-9-]\+\.trycloudflare\.com" "$LOG_FILE"; then
        # Extract only the URL from the log output
        URL=$(grep -o "https://[a-zA-Z0-9-]\+\.trycloudflare\.com" "$LOG_FILE" | head -n 1)
        break
    fi
    sleep 0.5
done

if [ -n "$URL" ]; then
    echo -e "\n========================================"
    echo "Tunnel active!"
    echo "URL: $URL"
    echo "========================================"
    
    # If a command was passed, run it with ACTION_HUB_BASE_URL set to the tunnel URL
    if [ $# -gt 0 ]; then
        export ACTION_HUB_BASE_URL="$URL"
        echo "Running command: $@"
        echo "----------------------------------------"
        "$@"
    else
        echo "Press Ctrl+C to stop the tunnel."
        # Wait for the background tunnel process to terminate (keeps the script running)
        wait "$TUNNEL_PID"
    fi
else
    echo "Error: Failed to retrieve tunnel URL. Logs:"
    cat "$LOG_FILE"
    exit 1
fi
