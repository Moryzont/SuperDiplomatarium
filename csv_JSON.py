#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import csv
import json
import os
import re
from pathlib import Path
from collections import defaultdict

# ------------------------------------------------------------------------------
# Paths & constants
# ------------------------------------------------------------------------------

# Work relative to this script
abspath = os.path.abspath(__file__)
dname = os.path.dirname(abspath)
os.chdir(dname)

SRC_PATH          = Path('_data/letters.csv')                 # source (any delimiter)
JEKYLL_DATA_PATH  = Path('_data/letters.csv')                 # normalized comma CSV
BACKUP_SC_PATH    = Path('assets/data/letters.scsv')          # semicolon mirror
CHUNKS_DIR        = Path('data/chunks')                       # letters chunks
INDEXES_DIR       = Path('data/indexes')                      # search index chunks live here
META_PATH         = Path('data/metadata.json')                # site metadata
INDEX_MONO_PATH   = Path('data/search-index.json')            # optional single-file index (debug)

CHUNK_SIZE = 1000  # keep at 1000 (JS derives numeric doc ids as chunk*1000 + row)

# Index chunking: number of keys per output file (tune to control output size)
TOKEN_KEYS_PER_CHUNK   = 5000
TRIGRAM_KEYS_PER_CHUNK = 12000
BIGRAM_KEYS_PER_CHUNK  = 16000

# ------------------------------------------------------------------------------
# Search-index helpers
# ------------------------------------------------------------------------------

ALLOWED = r'[^\wæøåäöáéíóúýþðœçàèìòùâêîôûãõüß\s]'

def normalize_for_search(text):
    """Normalize text for consistent searching."""
    if not text:
        return ''
    text = str(text).lower()
    text = text.replace('-', '')
    text = re.sub(ALLOWED, ' ', text)
    return text.strip()

def tokenize(text):
    """Extract tokens from text."""
    normalized = normalize_for_search(text)
    tokens = re.findall(r'[a-zæøåäöáéíóúýþðœçàèìòùâêîôûãõüß]+', normalized)
    return [t for t in tokens if len(t) >= 2]

def generate_trigrams(text):
    """Generate character trigrams for fuzzy matching."""
    s = normalize_for_search(text).replace(' ', '')
    if len(s) < 3:
        return set()
    return {s[i:i+3] for i in range(len(s) - 2)}

def generate_bigrams(text):
    """Generate character bigrams."""
    s = normalize_for_search(text).replace(' ', '')
    if len(s) < 2:
        return set()
    return {s[i:i+2] for i in range(len(s) - 1)}

def build_search_indexes(rows):
    """Build optimized search indexes; doc_id == global row idx (0..N-1)."""
    print("\n=== Building optimized search index ===")
    trigram_index = defaultdict(set)
    bigram_index  = defaultdict(set)
    token_index   = defaultdict(set)

    for idx, row in enumerate(rows):
        # Safe gets
        sammendrag      = str(row.get('sammendrag', '') or '')
        brevtekst       = str(row.get('brevtekst', '') or '')
        sted_dn         = str(row.get('DN_sted', '') or '')
        sted_rn         = str(row.get('RN_sted', '') or '')
        normalized_name = str(row.get('Normalized_name', '') or '')
        dn_source       = str(row.get('DN_source', '') or '')
        rn_source       = str(row.get('RN_source', '') or '')
        kilde           = ' | '.join(filter(None, [dn_source, rn_source]))

        all_text = ' '.join(filter(None, [
            sammendrag, brevtekst, sted_dn, sted_rn, normalized_name, kilde
        ]))

        # Character n-grams
        for tri in generate_trigrams(all_text):
            trigram_index[tri].add(idx)
        for bi in generate_bigrams(all_text):
            bigram_index[bi].add(idx)

        # Tokens + short prefixes (2..5)
        # NOTE: use text from multiple fields to enrich token coverage
        token_fields = (
            tokenize(sammendrag) +
            tokenize(brevtekst) +
            tokenize(f"{sted_dn} {sted_rn} {normalized_name}") +
            tokenize(kilde)
        )
        for tok in token_fields:
            token_index[tok].add(idx)
            # Prefixes to accelerate prefix & near-prefix matches
            max_pref = min(len(tok), 6)
            for i in range(2, max_pref):
                token_index[tok[:i]].add(idx)

    print(f"Generated {len(trigram_index)} trigrams, {len(token_index)} tokens")

    # Convert sets to sorted lists for JSON stability + size
    idx_data = {
        'trigrams': {k: sorted(v) for k, v in trigram_index.items()},
        'bigrams':  {k: sorted(v) for k, v in bigram_index.items()},
        'tokens':   {k: sorted(v) for k, v in token_index.items()},
        'total_docs': len(rows),
    }
    return idx_data

# ------------------------------------------------------------------------------
# CSV I/O
# ------------------------------------------------------------------------------

def read_any_csv_dicts(path: Path):
    """
    Robust CSV reader for 'weird' CSVs:
    - Detects delimiter from the header line (prefers ';' on ties)
    - Uses csv.DictReader directly (no manual record splitting)
    - Opens with newline='' so the csv module can handle embedded newlines in quoted fields
    - UTF-8 with BOM; falls back to latin-1 if needed
    """
    if not path.exists():
        print(f"Finner ikke: {path}")
        return [], ([], ',')

    # 1) Read header once to detect delimiter
    try:
        with path.open('r', encoding='utf-8-sig', newline='') as f:
            header = f.readline()
    except UnicodeDecodeError:
        with path.open('r', encoding='latin-1', newline='') as f:
            header = f.readline()

    candidates = [';', ',', '\t', '|']
    counts = {d: header.count(d) for d in candidates}
    # prefer ';' if there is a tie (common in NO/SE/DK exports)
    delim = max(candidates, key=lambda d: (counts[d], d == ';'))

    # 2) Parse the whole file with the chosen delimiter
    def _parse(enc):
        with path.open('r', encoding=enc, newline='') as f:
            reader = csv.DictReader(
                f,
                delimiter=delim,
                quotechar='"',
                doublequote=True,
                escapechar=None
            )
            rows = list(reader)
            fieldnames = reader.fieldnames or []
            return rows, (fieldnames, delim)

    try:
        rows, meta = _parse('utf-8-sig')
    except UnicodeDecodeError:
        rows, meta = _parse('latin-1')

    return rows, meta

def write_csv(path: Path, rows, fieldnames, delimiter=','):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', encoding='utf-8', newline='') as f:
        writer = csv.DictWriter(
            f,
            fieldnames=fieldnames,
            delimiter=delimiter,
            quotechar='"',
            quoting=csv.QUOTE_MINIMAL,
            lineterminator='\n',
        )
        writer.writeheader()
        for r in rows:
            writer.writerow(r)

# ------------------------------------------------------------------------------
# Index chunking & writing
# ------------------------------------------------------------------------------

def _write_json_minified(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))

def _clean_old_index_chunks():
    if not INDEXES_DIR.exists():
        return
    for pattern in ('trigrams-*.json', 'tokens-*.json', 'bigrams-*.json'):
        for p in INDEXES_DIR.glob(pattern):
            try:
                p.unlink(missing_ok=True)
            except Exception as e:
                print(f"Advarsel: kunne ikke slette {p}: {e}")

def _chunk_mapping(mapping: dict, max_keys: int):
    """Yield small dicts with up to max_keys keys each, preserving key order."""
    keys = list(mapping.keys())
    for i in range(0, len(keys), max_keys):
        part_keys = keys[i:i + max_keys]
        yield {k: mapping[k] for k in part_keys}

def write_chunked_indexes(index_data):
    """Write trigrams/tokens/bigrams as multiple chunk files; return counts."""
    _clean_old_index_chunks()
    INDEXES_DIR.mkdir(parents=True, exist_ok=True)

    # Trigrams
    tri_count = 0
    for i, chunk in enumerate(_chunk_mapping(index_data['trigrams'], TRIGRAM_KEYS_PER_CHUNK)):
        _write_json_minified(INDEXES_DIR / f"trigrams-{i:02d}.json", chunk)
        tri_count += 1

    # Tokens
    tok_count = 0
    for i, chunk in enumerate(_chunk_mapping(index_data['tokens'], TOKEN_KEYS_PER_CHUNK)):
        _write_json_minified(INDEXES_DIR / f"tokens-{i:02d}.json", chunk)
        tok_count += 1

    # Bigrams
    bi_count = 0
    for i, chunk in enumerate(_chunk_mapping(index_data['bigrams'], BIGRAM_KEYS_PER_CHUNK)):
        _write_json_minified(INDEXES_DIR / f"bigrams-{i:02d}.json", chunk)
        bi_count += 1

    return tri_count, tok_count, bi_count

# ------------------------------------------------------------------------------
# Main
# ------------------------------------------------------------------------------

def main():
    rows, (fieldnames, detected_delim) = read_any_csv_dicts(SRC_PATH)
    if not rows:
        # Ensure minimal outputs so site build doesn’t fail
        CHUNKS_DIR.mkdir(parents=True, exist_ok=True)
        _write_json_minified(CHUNKS_DIR / 'letters-chunk-00.json', [])
        META_PATH.parent.mkdir(parents=True, exist_ok=True)
        _write_json_minified(META_PATH, {
            'total_letters': 0,
            'chunks': 0,
            'chunk_size': CHUNK_SIZE,
            'fields': [],
            'has_search_index': False
        })
        print("Ingen rader funnet; skrev tomme ut-filer.")
        return

    # 1) Always write a comma CSV back to _data for Jekyll
    write_csv(JEKYLL_DATA_PATH, rows, fieldnames, delimiter=',')

    # 2) If the source wasn't comma, also write a semicolon copy for download
    if detected_delim != ',':
        write_csv(BACKUP_SC_PATH, rows, fieldnames, delimiter=';')
        print(f"Lagret semikolon-kopi for nedlasting: {BACKUP_SC_PATH}")

    # 3) JSON letter chunks
    CHUNKS_DIR.mkdir(parents=True, exist_ok=True)
    chunks = [rows[i:i + CHUNK_SIZE] for i in range(0, len(rows), CHUNK_SIZE)]
    for i, chunk in enumerate(chunks):
        filename = CHUNKS_DIR / f'letters-chunk-{i:02d}.json'
        _write_json_minified(filename, chunk)
        print(f"Lagret {filename} med {len(chunk)} brev")

    # 4) Build search index (doc_id == global row index; aligns with JS math)
    index_data = build_search_indexes(rows)

    # OPTIONAL: also write a single-file index for debugging (can be large)
    try:
        _write_json_minified(INDEX_MONO_PATH, index_data)
        size_mb = INDEX_MONO_PATH.stat().st_size / (1024 * 1024)
        print(f"(Debug) Monolithic index: {INDEX_MONO_PATH} ({size_mb:.2f} MB)")
    except Exception as e:
        print(f"(Debug) Skipping monolithic index write: {e}")

    # 5) Write chunked indexes for GitHub-friendly payloads
    tri_n, tok_n, bi_n = write_chunked_indexes(index_data)
    print(f"✓ Wrote chunked indexes: trigrams={tri_n}, tokens={tok_n}, bigrams={bi_n}")

    # 6) Metadata (include index_metadata for the JS loader)
    META_PATH.parent.mkdir(parents=True, exist_ok=True)
    meta_obj = {
        'total_letters': len(rows),
        'chunks': len(chunks),
        'chunk_size': CHUNK_SIZE,
        'fields': fieldnames,
        'source_delimiter_detected': detected_delim,
        'has_search_index': True,
        'index_metadata': {
            'total_docs': index_data['total_docs'],
            'trigram_chunks': tri_n,
            'token_chunks': tok_n,
            'bigram_chunks': bi_n
        }
    }
    _write_json_minified(META_PATH, meta_obj)

    print(f"\nTotalt: {len(rows)} brev delt i {len(chunks)} filer")
    print(f"Jekyll-data oppdatert (komma-CSV): {JEKYLL_DATA_PATH}")
    print("✓ Optimized, chunked search index created successfully!")

if __name__ == '__main__':
    main()
