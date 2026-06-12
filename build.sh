#!/bin/bash
# SuperDiplomatarium site build — the whole data chain in one command.
#
# Usage: ./build.sh [--sync] [--smoke]
#   --sync   Pull fresh data from the backend first (requires
#            ../data/output/all_letters_with_src.json from run_full_pipeline.py)
#   --smoke  Quick build over the first 3000 letters only (for development)
#
# Chain: backend output ──sync──▶ data/chunks ──build──▶ data/v3 + data/optimized
# See PIPELINE.md for the full picture. Deployment is intentionally NOT part of
# this script.

set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

DO_SYNC=0
SMOKE=""
for arg in "$@"; do
    case $arg in
        --sync)  DO_SYNC=1 ;;
        --smoke) SMOKE="LIMIT=3000" ;;
        *) echo "Unknown option: $arg"; exit 1 ;;
    esac
done

if [ "$DO_SYNC" == "1" ]; then
    echo "=== Step 1/3: Sync from backend (applies corrections.db) ==="
    node scripts/sync-from-backend.js
else
    echo "=== Step 1/3: Skipping sync (use --sync to refresh from backend) ==="
fi

echo ""
echo "=== Step 2/3: Build search indexes, map data and full-record store ==="
env $SMOKE node scripts/build-search-v3.mjs

echo ""
echo "=== Step 3/3: Size check (GitHub hard limit: 100MB per file) ==="
OVERSIZE=$(find data assets -type f -size +95M 2>/dev/null || true)
if [ -n "$OVERSIZE" ]; then
    echo "ERROR: files at/over GitHub's 100MB limit:"
    echo "$OVERSIZE"
    exit 1
fi
echo "All files under 95MB."

echo ""
echo "=== Build complete ==="
echo "Test locally:   see SEARCH-V3.md (jekyll + symlink + tests)"
echo "Run e2e tests:  node tests/test-search-v3.mjs && node tests/test-map-v3.mjs"
