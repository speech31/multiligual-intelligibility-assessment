from config import WORD_DATA, NUM_SETS, NUM_SUBSECTIONS


def get_session_words(subsection: int) -> list[str]:
    """
    Return the list of word_ids for a given subsection (1-indexed, 1–12).

    Each word_id encodes its position as "set{row:02d}_col{col:02d}", e.g.
    "set01_col03".  This keeps filenames opaque (canonical word not visible)
    while still allowing lookup via get_canonical().

    A full session covers all 50 sets at the given column → 50 words.
    12 subsections × 50 sets = 600 words = full word list.
    """
    if not 1 <= subsection <= NUM_SUBSECTIONS:
        raise ValueError(f"subsection must be between 1 and {NUM_SUBSECTIONS}")
    return [f"set{row + 1:02d}_col{subsection:02d}" for row in range(NUM_SETS)]


def get_canonical(word_id: str) -> str:
    """
    Look up the canonical word text for a word_id like "set01_col03".
    Falls back to returning word_id itself if parsing fails.
    """
    try:
        set_part, col_part = word_id.split("_")
        row = int(set_part[3:]) - 1    # "set01" → 0
        col = int(col_part[3:]) - 1    # "col03" → 2
        return WORD_DATA[row][col]
    except (ValueError, IndexError, AttributeError):
        return word_id
