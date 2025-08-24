import csv
import json
import os

abspath = os.path.abspath(__file__)
dname = os.path.dirname(abspath)
os.chdir(dname)

# Les CSV
with open('_data/letters.csv', 'r', encoding='utf-8') as f:
    reader = csv.DictReader(f)
    letters = list(reader)

# Del opp i chunks på 1000 brev hver
chunk_size = 1000
chunks = [letters[i:i+chunk_size] for i in range(0, len(letters), chunk_size)]

# Lagre chunks
os.makedirs('data/chunks', exist_ok=True)

for i, chunk in enumerate(chunks):
    filename = f'data/chunks/letters-chunk-{i:02d}.json'
    with open(filename, 'w', encoding='utf-8') as f:
        json.dump(chunk, f, ensure_ascii=False, separators=(',', ':'))
    print(f"Lagret {filename} med {len(chunk)} brev")

# Lag også en metadata-fil
metadata = {
    'total_letters': len(letters),
    'chunks': len(chunks),
    'chunk_size': chunk_size,
    'fields': list(letters[0].keys()) if letters else []
}

with open('data/metadata.json', 'w') as f:
    json.dump(metadata, f)

print(f"\nTotalt: {len(letters)} brev delt i {len(chunks)} filer")