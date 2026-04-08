import os
import re
from config import RECORDINGS_DIR


def sanitize(value: str) -> str:
    """Strip characters that are unsafe in folder/file names."""
    return re.sub(r"[^a-zA-Z0-9_\-]", "", value)


def get_session_path(speaker_id: str, trial: int) -> str:
    """Return the absolute path for a recording session folder."""
    folder = f"{sanitize(speaker_id)}_trial{int(trial)}"
    return os.path.join(RECORDINGS_DIR, folder)


def list_sessions() -> list[str]:
    """Return sorted list of existing session folder names."""
    if not os.path.isdir(RECORDINGS_DIR):
        return []
    entries = []
    for name in os.listdir(RECORDINGS_DIR):
        full = os.path.join(RECORDINGS_DIR, name)
        if os.path.isdir(full) and re.match(r".+_trial\d+$", name):
            entries.append(name)
    return sorted(entries)


def get_wav_files(session_folder: str) -> list[str]:
    """Return sorted list of .wav filenames inside a session folder."""
    folder = os.path.join(RECORDINGS_DIR, sanitize(session_folder))
    if not os.path.isdir(folder):
        return []
    files = [f for f in os.listdir(folder) if f.lower().endswith(".wav")]
    return sorted(files)


def get_transcription_csv_path(session_folder: str) -> str:
    return os.path.join(RECORDINGS_DIR, sanitize(session_folder), "transcriptions.csv")
