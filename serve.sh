#!/bin/bash
# Quick local test server for SuperDiplomatarium
# Usage: ./serve.sh [port]

PORT=${1:-4000}
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== SuperDiplomatarium Local Test Server ==="
echo ""

# Check if Jekyll is available
if command -v bundle &> /dev/null && [ -f "$DIR/Gemfile" ]; then
    echo "Starting Jekyll server..."
    cd "$DIR"
    bundle exec jekyll serve --port $PORT --livereload
elif command -v jekyll &> /dev/null; then
    echo "Starting Jekyll server..."
    cd "$DIR"
    jekyll serve --port $PORT --livereload
else
    # Fallback: Python simple server (works without Jekyll processing)
    echo "Jekyll not found. Using Python HTTP server (no template processing)."
    echo "Note: Liquid templates won't be processed. For full test, install Jekyll."
    echo ""

    if command -v python3 &> /dev/null; then
        echo "Server running at http://localhost:$PORT"
        echo "Press Ctrl+C to stop"
        echo ""
        cd "$DIR"
        python3 -m http.server $PORT
    elif command -v python &> /dev/null; then
        echo "Server running at http://localhost:$PORT"
        echo "Press Ctrl+C to stop"
        echo ""
        cd "$DIR"
        python -m SimpleHTTPServer $PORT
    else
        echo "Error: Neither Jekyll nor Python found."
        echo "Install Jekyll: gem install jekyll bundler"
        echo "Or use Python 3"
        exit 1
    fi
fi
