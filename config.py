import csv
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WORDS_CSV = os.path.join(BASE_DIR, "english.csv")

# ---------------------------------------------------------------------------
# Load word table from CSV.
# WORD_DATA[row_0][col_0] → word string
# Rows correspond to sets (0-indexed), columns to subsection positions (0-indexed).
# ---------------------------------------------------------------------------
def _load_words() -> list[list[str]]:
    data = []
    with open(WORDS_CSV, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            data.append([row[f"col_{i:02d}"] for i in range(1, 13)])
    return data

WORD_DATA: list[list[str]] = _load_words()
NUM_SETS: int = len(WORD_DATA)       # 50
NUM_SUBSECTIONS: int = 12            # columns per set

# ---------------------------------------------------------------------------
# Audio settings
# ---------------------------------------------------------------------------
SAMPLE_RATE = 16000   # 16 kHz mono, standard for speech research
CHANNELS = 1
