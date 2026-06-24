#!/bin/bash
set -e

# Resolve the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 1. Check if uv is installed, install if missing
if ! command -v uv &> /dev/null; then
  echo "uv is not installed. Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

# 2. Execute the Python deployment script, forwarding all arguments
exec uv run "$SCRIPT_DIR/bin/deploy.py" "$@"
