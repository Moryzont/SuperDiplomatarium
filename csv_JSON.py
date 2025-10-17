import csv
import json
import os
from pathlib import Path
from collections import defaultdict
import re

# Work relative to this script
abspath = os.path.abspath(__file__)
dname = os.path.dirname(abspath)
os.chdir(dname)

SRC_PATH = Path('_data/letters.csv')
JEKYLL_DATA_PATH = Path('_data/letters.csv')
BACKUP_SC_PATH = Path('assets/data/letters.scsv')
CHUNKS_DIR = Path('data/chunks')
META_PATH = Path('data/metadata.json')
INDEX_PATH = Path('data/search-index.json')

CHUNK_SIZE = 1000

# ============= OPTIMIZATION: Pre-computed indexes =============

def normalize_for_search(text):
    """Normalize text for consistent searching."""
    if not text:
        return ''
    text = str(text).lower()
    text = text.replace('-', '')  # Remove hyphens for normalization
    # Remove punctuation but keep letters with diacritics
    text = re.sub(r'[^\wæøåäöáéíóúýþðœçàèìòùâêîôûãõüß\s]', ' ', text)
    return text.strip()

def tokenize(text):
    """Extract tokens from text."""
    normalized = normalize_for_search(text)
    tokens = re.findall(r'[a-zæøåäöáéíóúýþðœçàèìòùâêîôûãõüß]+', normalized)
    return [t for t in tokens if len(t) >= 2]  # Skip single chars

def generate_trigrams(text):
    """Generate character trigrams for fuzzy matching."""
    text = normalize_for_search(text)
    text = text.replace(' ', '')  # Remove spaces for trigram generation
    if len(text) < 3:
        return set()
    trigrams = set()
    for i in range(len(text) - 2):
        trigrams.add(text[i:i+3])
    return trigrams

def generate_bigrams(text):
    """Generate character bigrams."""
    text = normalize_for_search(text)
    text = text.replace(' ', '')
    if len(text) < 2:
        return set()
    return set(text[i:i+2] for i in range(len(text) - 1))

def build_search_indexes(rows):
    """Build optimized search indexes."""
    print("Building search indexes...")
    
    # Indexes to build
    trigram_index = defaultdict(set)  # trigram -> set of doc_ids
    bigram_index = defaultdict(set)   # bigram -> set of doc_ids
    token_index = defaultdict(set)    # normalized_token -> set of doc_ids
    field_tokens = {}                 # doc_id -> {field: [tokens]}
    doc_lengths = {}                  # doc_id -> total_token_count
    
    for idx, row in enumerate(rows):
        doc_id = idx
        
        # Fields to index - safely get values, handling None
        sammendrag = str(row.get('sammendrag', '') or '')
        brevtekst = str(row.get('brevtekst', '') or '')
        sted_dn = str(row.get('DN_sted', '') or '')
        sted_rn = str(row.get('RN_sted', '') or '')
        normalized_name = str(row.get('Normalized_name', '') or '')
        
        # Combine source fields safely
        dn_source = str(row.get('DN_source', '') or '')
        rn_source = str(row.get('RN_source', '') or '')
        kilde = ' | '.join(filter(None, [dn_source, rn_source]))
        
        # Combine all fields for indexing
        all_text = ' '.join(filter(None, [sammendrag, brevtekst, sted_dn, sted_rn, normalized_name, kilde]))
        
        # Store tokens by field for targeted searching
        field_tokens[doc_id] = {
            'sammendrag': tokenize(sammendrag),
            'brevtekst': tokenize(brevtekst),
            'sted_all': tokenize(f"{sted_dn} {sted_rn} {normalized_name}"),
            'kilde': tokenize(kilde)
        }
        
        # Calculate document length for relevance scoring
        all_tokens = []
        for tokens in field_tokens[doc_id].values():
            all_tokens.extend(tokens)
        doc_lengths[doc_id] = len(all_tokens)
        
        # Generate trigrams from all text
        trigrams = generate_trigrams(all_text)
        for tri in trigrams:
            trigram_index[tri].add(doc_id)
        
        # Generate bigrams
        bigrams = generate_bigrams(all_text)
        for bi in bigrams:
            bigram_index[bi].add(doc_id)
        
        # Token index for exact and prefix matching
        for token in all_tokens:
            token_index[token].add(doc_id)
            # Also index prefixes for better matching
            for i in range(2, min(len(token), 6)):
                token_index[token[:i]].add(doc_id)
    
    print(f"Generated {len(trigram_index)} trigrams, {len(token_index)} tokens")
    
    # Convert sets to lists for JSON serialization
    index_data = {
        'trigrams': {k: list(v) for k, v in trigram_index.items()},
        'bigrams': {k: list(v) for k, v in bigram_index.items()},
        'tokens': {k: list(v) for k, v in token_index.items()},
        'field_tokens': {str(k): v for k, v in field_tokens.items()},
        'doc_lengths': {str(k): v for k, v in doc_lengths.items()},
        'total_docs': len(rows)
    }
    
    return index_data

def read_any_csv_dicts(path: Path):
    """Read CSV with auto delimiter detection (comma/semicolon/tab)."""
    if not path.exists():
        print(f"Finner ikke: {path}")
        return [], []

    with path.open('r', encoding='utf-8', newline='') as f:
        sample = f.read(65536)
        f.seek(0)
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=[',', ';', '\t'])
        except csv.Error:
            dialect = csv.excel
            dialect.delimiter = ','
        reader = csv.DictReader(f, dialect=dialect)
        raw_rows = list(reader)
        
        # Filter out None keys and clean fieldnames
        fieldnames = [fn for fn in (reader.fieldnames or []) if fn is not None and fn.strip()]
        
        # Clean rows: remove None keys and keys not in fieldnames
        rows = []
        for row in raw_rows:
            clean_row = {k: v for k, v in row.items() if k in fieldnames}
            rows.append(clean_row)
        
        return rows, (fieldnames, dialect.delimiter)

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
            extrasaction='ignore'  # Ignore extra fields not in fieldnames
        )
        writer.writeheader()
        for r in rows:
            # Only write fields that exist in fieldnames
            clean_row = {k: v for k, v in r.items() if k in fieldnames}
            writer.writerow(clean_row)

def main():
    rows, (fieldnames, detected_delim) = read_any_csv_dicts(SRC_PATH)
    
    # Diagnostic info
    print(f"\n=== CSV Loaded ===")
    print(f"Rows: {len(rows)}")
    print(f"Delimiter detected: {repr(detected_delim)}")
    print(f"Field names ({len(fieldnames)}): {', '.join(fieldnames[:10])}{'...' if len(fieldnames) > 10 else ''}")
    
    if not rows:
        # Still make empty outputs so site build doesn't fail
        CHUNKS_DIR.mkdir(parents=True, exist_ok=True)
        with (CHUNKS_DIR / 'letters-chunk-00.json').open('w', encoding='utf-8') as f:
            json.dump([], f, ensure_ascii=False, separators=(',', ':'))
        META_PATH.parent.mkdir(parents=True, exist_ok=True)
        with META_PATH.open('w', encoding='utf-8') as f:
            json.dump({'total_letters': 0, 'chunks': 0, 'chunk_size': CHUNK_SIZE, 'fields': []}, f)
        print("Ingen rader funnet; skrev tomme ut-filer.")
        return

    # 1) Always write a **comma** CSV back to _data for Jekyll
    write_csv(JEKYLL_DATA_PATH, rows, fieldnames, delimiter=',')

    # 2) If the source wasn't comma, also write a semicolon copy
    if detected_delim != ',':
        write_csv(BACKUP_SC_PATH, rows, fieldnames, delimiter=';')
        print(f"Lagret semikolon-kopi for nedlasting: {BACKUP_SC_PATH}")

    # 3) JSON chunks
    CHUNKS_DIR.mkdir(parents=True, exist_ok=True)
    chunks = [rows[i:i + CHUNK_SIZE] for i in range(0, len(rows), CHUNK_SIZE)]
    for i, chunk in enumerate(chunks):
        filename = CHUNKS_DIR / f'letters-chunk-{i:02d}.json'
        with filename.open('w', encoding='utf-8') as f:
            json.dump(chunk, f, ensure_ascii=False, separators=(',', ':'))
        print(f"Lagret {filename} med {len(chunk)} brev")

    # 4) BUILD SEARCH INDEX (NEW!)
    print("\n=== Building optimized search index ===")
    index_data = build_search_indexes(rows)
    INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    with INDEX_PATH.open('w', encoding='utf-8') as f:
        json.dump(index_data, f, ensure_ascii=False, separators=(',', ':'))
    print(f"Search index saved: {INDEX_PATH}")
    index_size_mb = INDEX_PATH.stat().st_size / (1024 * 1024)
    print(f"Index size: {index_size_mb:.2f} MB")

    # 5) Metadata
    META_PATH.parent.mkdir(parents=True, exist_ok=True)
    with META_PATH.open('w', encoding='utf-8') as f:
        json.dump({
            'total_letters': len(rows),
            'chunks': len(chunks),
            'chunk_size': CHUNK_SIZE,
            'fields': fieldnames,
            'source_delimiter_detected': detected_delim,
            'has_search_index': True
        }, f, ensure_ascii=False)

    print(f"\nTotalt: {len(rows)} brev delt i {len(chunks)} filer")
    print(f"Jekyll-data oppdatert (komma-CSV): {JEKYLL_DATA_PATH}")
    print("\n✓ Optimized search index created successfully!")

if __name__ == '__main__':
    main()