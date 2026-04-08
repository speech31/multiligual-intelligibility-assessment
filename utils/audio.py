import io
import os
import tempfile
from pydub import AudioSegment
from config import SAMPLE_RATE, CHANNELS


def convert_to_wav_bytes(raw_bytes: bytes, mime_type: str) -> bytes:
    """
    Decode browser audio (webm/ogg with opus codec) and return 16kHz mono WAV bytes.
    Nothing is written to the server's filesystem.

    Args:
        raw_bytes: Raw audio bytes from the browser's MediaRecorder.
        mime_type: MIME type reported by the browser (e.g. 'audio/webm').

    Returns:
        WAV-encoded bytes ready to be sent to the client.

    Raises:
        ValueError: If raw_bytes is empty.
        Exception:  Re-raises pydub/ffmpeg errors on decode failure.
    """
    if not raw_bytes:
        raise ValueError("Empty audio data received.")

    if "ogg" in mime_type:
        suffix = ".ogg"
    elif "mp4" in mime_type or "m4a" in mime_type:
        suffix = ".mp4"
    else:
        suffix = ".webm"  # Chrome default

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(raw_bytes)
        tmp_path = tmp.name

    try:
        audio = AudioSegment.from_file(tmp_path)
        audio = audio.set_frame_rate(SAMPLE_RATE).set_channels(CHANNELS).set_sample_width(2)
        buf = io.BytesIO()
        audio.export(buf, format="wav")
        return buf.getvalue()
    finally:
        os.unlink(tmp_path)
