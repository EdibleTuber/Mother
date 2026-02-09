#!/usr/bin/env bash
set -e

# Usage: ./dev.sh <data-dir> [--cli]
# Example: ./dev.sh ./data --cli

if [ -z "$1" ]; then
    echo "Usage: ./dev.sh <data-dir> [--cli]"
    echo "Example: ./dev.sh ./data --cli"
    exit 1
fi

DATA_DIR="$1"
CLI_FLAG="$2"

mkdir -p "$DATA_DIR"

if [ "$CLI_FLAG" = "--cli" ]; then
    echo "Starting mother in CLI mode..."
    npx tsx src/main.ts "$DATA_DIR" --sandbox=host --cli
else
    echo "Starting mother in dev mode..."
    npx tsx --watch-path src --watch src/main.ts "$DATA_DIR" --sandbox=host
fi
