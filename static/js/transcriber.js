/**
 * transcriber.js — Transcription mode (pure client-side, no server required).
 *
 * Flow:
 *   1. showDirectoryPicker() → user picks local recordings folder
 *      Firefox fallback: <input type="file" multiple>
 *   2. JS reads .wav files directly from the folder
 *   3. One file at a time: <audio> player + text input
 *   4. Back / Next; results accumulate in JS array
 *   5. "Save & Score" → score in JS using getCanonical() from words.js
 *   6. "Download CSV" → CSV generated in JS and downloaded
 *
 * Requires: words.js  (loaded before this script)
 */

(function () {
  "use strict";

  const HAS_FSA = typeof window.showDirectoryPicker === "function";

  // ----- DOM -----
  const pickerSection      = document.getElementById("picker-section");
  const languageSelect     = document.getElementById("language");
  const pickFolderBtn      = document.getElementById("pick-folder-btn");
  const fallbackLabel      = document.getElementById("fallback-label");
  const fallbackInput      = document.getElementById("fallback-input");
  const pickerError        = document.getElementById("picker-error");
  const folderNameDisplay  = document.getElementById("folder-name-display");

  const transcribeSection  = document.getElementById("transcribe-section");
  const sessionLabel       = document.getElementById("session-label");
  const fileIndexEl        = document.getElementById("file-index");
  const fileTotalEl        = document.getElementById("file-total");
  const fileNameLabel      = document.getElementById("file-name-label");
  const audioPlayer        = document.getElementById("audio-player");
  const transcriptionInput = document.getElementById("transcription-input");
  const prevBtn            = document.getElementById("prev-btn");
  const nextBtn            = document.getElementById("next-btn");
  const submitBtn          = document.getElementById("submit-btn");
  const transcribeStatus   = document.getElementById("transcribe-status");

  const resultsSection = document.getElementById("results-section");
  const scoreDisplay   = document.getElementById("score-display");
  const correctDisplay = document.getElementById("correct-display");
  const totalDisplay   = document.getElementById("total-display");
  const resultsTbody   = document.querySelector("#results-table tbody");
  const downloadCsvBtn = document.getElementById("download-csv-btn");

  // ----- State -----
  let fileEntries = [];    // [{ name, file }]
  let currentIdx  = 0;
  let results     = [];    // [{ file_name, transcription }]
  let scoreData   = null;

  // ----- Helpers -----
  function showError(el, msg) { el.textContent = msg; el.classList.remove("hidden"); }
  function hideError(el)      { el.classList.add("hidden"); }

  function saveCurrentInput() {
    if (!fileEntries.length) return;
    results[currentIdx].transcription = transcriptionInput.value.trim();
  }

  function showFile(idx) {
    const entry = fileEntries[idx];
    fileIndexEl.textContent  = idx + 1;
    fileNameLabel.textContent = entry.name;

    if (audioPlayer.src?.startsWith("blob:")) URL.revokeObjectURL(audioPlayer.src);
    audioPlayer.src = URL.createObjectURL(entry.file);
    audioPlayer.load();

    transcriptionInput.value = results[idx]?.transcription || "";
    transcriptionInput.focus();

    prevBtn.disabled = idx === 0;
    const isLast = idx === fileEntries.length - 1;
    nextBtn.classList.toggle("hidden", isLast);
    submitBtn.classList.toggle("hidden", !isLast);
    transcribeStatus.textContent = "";
  }

  async function loadEntries(entries) {
    if (!entries.length) { showError(pickerError, "No WAV files found."); return; }
    fileEntries = entries;
    results     = entries.map(e => ({ file_name: e.name, transcription: "" }));
    currentIdx  = 0;
    fileTotalEl.textContent = entries.length;
    pickerSection.classList.add("hidden");
    transcribeSection.classList.remove("hidden");
    showFile(0);
  }

  // ----- FSA folder picker -----
  if (!HAS_FSA) {
    pickFolderBtn.classList.add("hidden");
    fallbackLabel.classList.remove("hidden");
  }

  pickFolderBtn?.addEventListener("click", async () => {
    hideError(pickerError);
    let handle;
    try {
      handle = await window.showDirectoryPicker({ mode: "read" });
    } catch (e) {
      if (e.name !== "AbortError") showError(pickerError, "Could not open folder: " + e.message);
      return;
    }

    sessionLabel.textContent = handle.name;
    folderNameDisplay.textContent = "Loading files…";

    const entries = [];
    for await (const [name, fh] of handle.entries()) {
      if (fh.kind === "file" && name.toLowerCase().endsWith(".wav")) {
        entries.push({ name, file: await fh.getFile() });
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    folderNameDisplay.textContent = "";
    await loadEntries(entries);
  });

  // ----- Firefox fallback -----
  fallbackInput?.addEventListener("change", async () => {
    const files = Array.from(fallbackInput.files).filter(f => f.name.toLowerCase().endsWith(".wav"));
    const entries = files
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(f => ({ name: f.name, file: f }));
    sessionLabel.textContent = "selected files";
    await loadEntries(entries);
  });

  // ----- Navigation -----
  prevBtn.addEventListener("click", () => {
    saveCurrentInput();
    if (currentIdx > 0) { currentIdx--; showFile(currentIdx); }
  });

  nextBtn.addEventListener("click", () => {
    saveCurrentInput();
    if (currentIdx < fileEntries.length - 1) { currentIdx++; showFile(currentIdx); }
  });

  transcriptionInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); nextBtn.click(); }
  });

  // ----- Score (all in JS, no server) -----
  submitBtn.addEventListener("click", async () => {
    saveCurrentInput();

    const empty = results.filter(r => !r.transcription).length;
    if (empty > 0 && !confirm(`${empty} word(s) have no transcription. Submit anyway?`)) return;

    submitBtn.disabled = true;
    transcribeStatus.textContent = "Scoring…";

    const rows = results.map(r => {
      // Extract word_id: "speaker-set01_col07.wav" → "set01_col07"
      const base    = r.file_name.replace(/\.wav$/i, "");
      const m       = /set\d+_col\d+/.exec(base);
      const wordId  = m ? m[0] : base;
      const canonical = getCanonical(wordId, languageSelect.value);   // words.js
      const correct   = r.transcription.trim().toLowerCase() === canonical.toLowerCase() ? 1 : 0;
      return { file_name: r.file_name, canonical, transcription: r.transcription, correct };
    });

    const total      = rows.length;
    const numCorrect = rows.reduce((s, r) => s + r.correct, 0);
    const score      = total ? (numCorrect / total) : 0;

    scoreData = { rows, score, correct: numCorrect, total };

    transcribeSection.classList.add("hidden");
    resultsSection.classList.remove("hidden");
    scoreDisplay.textContent   = (score * 100).toFixed(1) + "%";
    correctDisplay.textContent = numCorrect;
    totalDisplay.textContent   = total;

    resultsTbody.innerHTML = "";
    rows.forEach(row => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${row.file_name}</td>
        <td>${row.canonical}</td>
        <td>${row.transcription || "<em>—</em>"}</td>
        <td class="correct-${row.correct}">${row.correct ? "Correct" : "Wrong"}</td>
      `;
      resultsTbody.appendChild(tr);
    });

    submitBtn.disabled = false;
    transcribeStatus.textContent = "";
  });

  // ----- Download CSV -----
  downloadCsvBtn.addEventListener("click", () => {
    if (!scoreData) return;
    const header = "file_name,canonical,transcription,correct\n";
    const body   = scoreData.rows.map(r =>
      [r.file_name, r.canonical, r.transcription, r.correct]
        .map(v => `"${String(v).replace(/"/g, '""')}"`)
        .join(",")
    ).join("\n");

    const blob = new Blob(["\uFEFF" + header + body], { type: "text/csv;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = "transcriptions.csv"; a.click();
    URL.revokeObjectURL(url);
  });
})();
