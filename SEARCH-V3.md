# Search v3 — Pagefind-backed static search

Replaces the v2 "load 64 MB, scan linearly" search with prebuilt static indexes.
Everything runs client-side; works on GitHub Pages with no server.

## Architecture

```
data/chunks/letters-chunk-*.json      input (synced from backend via scripts/sync-from-backend.js)
        │
        ▼  node scripts/build-search-v3.mjs        (~9 min for 107K letters)
data/v3/
├── pagefind-main/        index over sammendrag/regest — every letter (61 MB)
├── pagefind-fulltext/    index over brevtekst — 49,738 letters with body text (115 MB)
├── pagefind-place/       index over place-name fields — 69,418 letters (35 MB)
└── core.json             compact table for ID search + related-source lookups (1.5 MB gzipped)

data/optimized/full-XX.json           full records for the detail view (unchanged from v2)
```

- **Filters** (source databases, year range) and **sorting** (date asc/desc,
  completeness) are resolved inside the Pagefind index — no records are scanned
  in the browser.
- Year coverage is extracted at build time from `date_start`/`date_end`, with a
  fallback parse of `original_date`/`DN_dato`/`RN_dato` (including SDHK's
  8-digit `YYYYMMDD` tokens). This nearly doubles date-filter coverage vs v2.
- A letter's array position in `core.json` is its global index; full record =
  `data/optimized/full-{floor(idx/500)}.json`. The build reads the chunk files
  in name order, the same order `optimize-data.js` uses — **if you regenerate
  the chunks, rebuild both `data/optimized` and `data/v3`.**
- Place search matches *all* place fields (normalized + per-source), so
  "Nidaros" also finds letters displayed under their normalized name
  ("Trondheim") — intentional.
- Deep links: `/sok/?id=SD20010813` and `/sok/?q=...&felt=text|place|fulltext|id`.

## Behavior changes vs v2

- Fulltext search actually searches `brevtekst` (v2 silently searched summaries).
- Letters without any parseable date are **excluded** when a date filter is
  active (v2 included them).
- Word-based matching with Norwegian stemming + prefix matching instead of raw
  substring matching.

## Build & test locally

See `../PIPELINE.md` for the full backend-to-site chain.

```bash
npm install            # pagefind + puppeteer-core (dev only)
./build.sh             # rebuild all site data artifacts from data/chunks
./build.sh --sync      # ...refreshing data/chunks from the backend first
./build.sh --smoke     # quick dev build (first 3000 letters)

# Serve like production (baseurl /SuperDiplomatarium), without copying data into _site:
jekyll build --config _config.yaml,_config_local.yaml
ln -sfn "$PWD/data" _site/data
mkdir -p /tmp/sd_serve && ln -sfn "$PWD/_site" /tmp/sd_serve/SuperDiplomatarium
(cd /tmp/sd_serve && python3 -m http.server 8731)

node tests/test-search-v3.mjs                 # search e2e tests (headless Chrome)
node tests/test-map-v3.mjs                    # map e2e tests
node tests/perf-search-v3.mjs                 # payload/latency measurements
```

Note on ordering: the global letter index is defined by enumerating
`data/chunks/letters-chunk-*.json` in **numeric** chunk order. Every artifact
(`core.json`, `map.json`, Pagefind metadata, `optimized/full-*.json`) is
generated from that single enumeration in one build, so they can never drift —
but always rebuild all artifacts together (plain `./build.sh`, no `ONLY=`)
after a sync.

`_config_local.yaml` is for local builds only — deployment must serve `data/`.

## Measured (local, 106,997 letters)

| | v2 | v3 |
|---|---|---|
| Payload before first search | 64 MB, 54 serial fetches | ~1.5 MB gzipped (core.json) |
| Typical query | full scan of 107K records | 150–250 ms, 50–60 KB fetched |
| Worst case (12.7K hits) | multi-second scan, UI jank | ~1.1 s |
| Fulltext search | fake (summaries only) | real, over 49,738 brevtekster |

## Map

`kart.html` loads `data/v3/map.json` (46,496 geo-tagged letters, ~1 MB gzipped;
rebuild with `ONLY=map`). Popups, the area-selection detail view and exports
fetch full records on demand from `data/optimized/full-XX.json`.
Tests: `node tests/test-map-v3.mjs`.

## Data inventory after cleanup

- `data/chunks/` — build input (synced from backend); not used at runtime.
- `data/optimized/full-*.json` — runtime detail store for search and map.
- `data/v3/` — search indexes + core.json + map.json (generated, gitignored).
- Removed: `all_letters.json`, `optimized/search-*`, `letters-light-*`,
  `fulltext/`, `trigrams-*`, `assets/js/search.js`, `search-v2.js`, `main.js`.

## Not yet done

- CI build-and-deploy workflow (GitHub Actions) — planned, not pushed yet.
  When deploying, exclude `data/chunks/` from the published site.
