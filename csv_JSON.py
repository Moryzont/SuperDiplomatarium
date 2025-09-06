import csv
import json
import os
from pathlib import Path

# Work relative to this script
abspath = os.path.abspath(__file__)
dname = os.path.dirname(abspath)
os.chdir(dname)

SRC_PATH = Path('_data/letters.csv')   # your source file (any delim)
JEKYLL_DATA_PATH = Path('_data/letters.csv')  # we will overwrite as comma CSV
BACKUP_SC_PATH = Path('assets/data/letters.scsv')  # semicolon copy for download
CHUNKS_DIR = Path('data/chunks')
META_PATH = Path('data/metadata.json')

CHUNK_SIZE = 1000

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
            # Fallback to comma
            dialect = csv.excel
            dialect.delimiter = ','
        reader = csv.DictReader(f, dialect=dialect)
        rows = list(reader)
        fieldnames = reader.fieldnames or []
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
        )
        writer.writeheader()
        for r in rows:
            writer.writerow(r)

def main():
    rows, (fieldnames, detected_delim) = read_any_csv_dicts(SRC_PATH)
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

    # 2) If the source wasn't comma, also write a semicolon copy outside _data (safe for download)
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

    # 4) Metadata
    META_PATH.parent.mkdir(parents=True, exist_ok=True)
    with META_PATH.open('w', encoding='utf-8') as f:
        json.dump({
            'total_letters': len(rows),
            'chunks': len(chunks),
            'chunk_size': CHUNK_SIZE,
            'fields': fieldnames,
            'source_delimiter_detected': detected_delim
        }, f, ensure_ascii=False)

    print(f"\nTotalt: {len(rows)} brev delt i {len(chunks)} filer")
    print(f"Jekyll-data oppdatert (komma-CSV): {JEKYLL_DATA_PATH}")

if __name__ == '__main__':
    main()
