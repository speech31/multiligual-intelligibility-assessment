import os
import sys

from flask import Flask, Response, jsonify, render_template, request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from utils.audio import convert_to_wav_bytes
from utils.session import sanitize
from utils.words import get_canonical, get_session_words

app = Flask(__name__)


# ---------------------------------------------------------------------------
# Index
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------------------
# Recording mode
# ---------------------------------------------------------------------------

@app.route("/record")
def record():
    return render_template("record.html")


@app.route("/record/start", methods=["POST"])
def record_start():
    """Return the word list for a given speaker + subsection. No files are created."""
    from config import NUM_SUBSECTIONS
    data = request.get_json(force=True)
    speaker_id = sanitize(str(data.get("speaker_id", "")).strip())
    subsection_raw = data.get("subsection", "")
    try:
        subsection = int(subsection_raw)
        if not 1 <= subsection <= NUM_SUBSECTIONS:
            raise ValueError
    except (ValueError, TypeError):
        return jsonify({"error": f"subsection must be between 1 and {NUM_SUBSECTIONS}"}), 400

    if not speaker_id:
        return jsonify({"error": "speaker_id is required"}), 400

    try:
        words = get_session_words(subsection)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    session_id = f"{speaker_id}/sub{subsection:02d}"
    return jsonify({"session_id": session_id, "words": words, "subsection": subsection})


@app.route("/record/convert", methods=["POST"])
def record_convert():
    """
    Receive a raw browser audio blob, convert it to 16kHz mono WAV, and return
    the WAV bytes to the client. Nothing is saved on the server.
    """
    audio_file = request.files.get("audio")
    if not audio_file:
        return jsonify({"error": "No audio file in request"}), 400

    raw_bytes = audio_file.read()
    mime_type = audio_file.content_type or "audio/webm"

    try:
        wav_bytes = convert_to_wav_bytes(raw_bytes, mime_type)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.error("Audio conversion failed: %s", e)
        return jsonify({"error": "Audio conversion failed. Is ffmpeg installed?"}), 500

    return Response(wav_bytes, mimetype="audio/wav")


# ---------------------------------------------------------------------------
# Transcription mode
# ---------------------------------------------------------------------------

@app.route("/transcribe")
def transcribe():
    return render_template("transcribe.html")


@app.route("/transcribe/score", methods=["POST"])
def transcribe_score():
    """
    Score a list of transcriptions against canonical words.
    Returns scored rows; the client is responsible for saving the CSV locally.
    """
    data = request.get_json(force=True)
    results = data.get("results", [])

    if not results:
        return jsonify({"error": "No results provided"}), 400

    rows = []
    for item in results:
        file_name = item.get("file_name", "")
        transcription = item.get("transcription", "").strip()

        # Extract word_id from filename: "s001-set01_col03.wav" → "set01_col03"
        base = os.path.splitext(file_name)[0]   # "s001-set01_col03"
        parts = base.split("-", 1)
        word_id = parts[1] if len(parts) == 2 else base

        canonical = get_canonical(word_id)
        correct = int(transcription.lower() == canonical.lower())
        rows.append({
            "file_name": file_name,
            "canonical": canonical,
            "transcription": transcription,
            "correct": correct,
        })

    total = len(rows)
    num_correct = sum(r["correct"] for r in rows)
    score = round(num_correct / total, 4) if total else 0.0

    return jsonify({"score": score, "correct": num_correct, "total": total, "rows": rows})


# ---------------------------------------------------------------------------

if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)
