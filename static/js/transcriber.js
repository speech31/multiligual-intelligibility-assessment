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
  const pickerSection         = document.getElementById("picker-section");
  const languageSelect        = document.getElementById("language");
  const pickFolderBtn         = document.getElementById("pick-folder-btn");
  const fallbackLabel         = document.getElementById("fallback-label");
  const fallbackInput         = document.getElementById("fallback-input");
  const fallbackFolderInput   = document.getElementById("fallback-folder-input");
  const fallbackZipInput      = document.getElementById("fallback-zip-input");
  const fallbackFolderBtn     = document.getElementById("fallback-folder-btn");
  const fallbackZipBtn        = document.getElementById("fallback-zip-btn");
  const fallbackFilesBtn      = document.getElementById("fallback-files-btn");
  const pickerError           = document.getElementById("picker-error");
  const folderNameDisplay     = document.getElementById("folder-name-display");

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

  const resultsSection       = document.getElementById("results-section");
  const resultsNote          = document.getElementById("results-note");
  const scoreDisplay         = document.getElementById("score-display");
  const correctDisplay       = document.getElementById("correct-display");
  const totalDisplay         = document.getElementById("total-display");
  const resultsTbody         = document.querySelector("#results-table tbody");
  const downloadCsvBtn       = document.getElementById("download-csv-btn");
  const scoreNowBtn          = document.getElementById("score-now-btn");
  const backToTranscribeBtn  = document.getElementById("back-to-transcribe-btn");

  // ----- State -----
  let fileEntries = [];    // [{ name, file }]
  let currentIdx  = 0;
  let maxVisited  = 0;     // furthest index ever reached in the current session
  let results     = [];    // [{ file_name, transcription }]
  let scoreData   = null;
  // Manual Correct/Wrong overrides persisted across preview ↔ transcribe
  // cycles. Keyed by file_name. If the transcription later changes, the
  // override is dropped (see computeRows).
  const overrides = {};    // { [file_name]: { correct: 0|1, forTranscription: string } }

  // ----- Helpers -----
  function showError(el, msg) { el.textContent = msg; el.classList.remove("hidden"); }
  function hideError(el)      { el.classList.add("hidden"); }

  function saveCurrentInput() {
    if (!fileEntries.length) return;
    results[currentIdx].transcription = transcriptionInput.value.trim();
  }

  function showFile(idx) {
    maxVisited = Math.max(maxVisited, idx);
    const entry = fileEntries[idx];
    fileIndexEl.textContent  = idx + 1;
    fileNameLabel.textContent = entry.name;

    if (audioPlayer.src?.startsWith("blob:")) URL.revokeObjectURL(audioPlayer.src);
    audioPlayer.src = URL.createObjectURL(entry.file);
    audioPlayer.play().catch(() => {});   // benign AbortError on rapid navigation

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
    maxVisited  = 0;
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
  // Wire the visible buttons to their hidden file inputs. Keeping the
  // input separate (not nested inside a label) avoids a Safari quirk where
  // clicks on a hidden nested input sometimes don't open the picker.
  fallbackFolderBtn?.addEventListener("click", () => fallbackFolderInput?.click());
  fallbackZipBtn?.addEventListener("click",    () => fallbackZipInput?.click());
  fallbackFilesBtn?.addEventListener("click",  () => fallbackInput?.click());

  // Manual-pick (multiple WAV files)
  fallbackInput?.addEventListener("change", async () => {
    hideError(pickerError);
    const files = Array.from(fallbackInput.files).filter(f => f.name.toLowerCase().endsWith(".wav"));
    if (!files.length) { showError(pickerError, "No WAV files selected."); return; }
    const entries = files
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(f => ({ name: f.name, file: f }));
    sessionLabel.textContent = "selected files";
    await loadEntries(entries);
  });

  // Folder-pick (Safari / Firefox): webkitdirectory gives us every file in the
  // chosen directory tree; we keep only the .wav leaves.
  fallbackFolderInput?.addEventListener("change", async () => {
    hideError(pickerError);
    const files = Array.from(fallbackFolderInput.files)
      .filter(f => f.name.toLowerCase().endsWith(".wav"));
    if (!files.length) { showError(pickerError, "No WAV files found in that folder."); return; }
    const entries = files
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(f => ({ name: f.name, file: f }));
    // Root folder name is the first path segment of any file's webkitRelativePath.
    const rootName = (fallbackFolderInput.files[0]?.webkitRelativePath || "").split("/")[0];
    sessionLabel.textContent = rootName || "selected folder";
    await loadEntries(entries);
  });

  // ZIP upload: extract every .wav inside and feed it through loadEntries().
  fallbackZipInput?.addEventListener("change", async () => {
    hideError(pickerError);
    const zipFile = fallbackZipInput.files?.[0];
    if (!zipFile) return;
    if (typeof JSZip === "undefined") {
      showError(pickerError, "ZIP support unavailable (jszip failed to load).");
      return;
    }
    folderNameDisplay.textContent = "Reading ZIP…";
    try {
      const zip    = await JSZip.loadAsync(zipFile);
      const wavs   = Object.values(zip.files).filter(f => !f.dir && /\.wav$/i.test(f.name));
      if (!wavs.length) {
        folderNameDisplay.textContent = "";
        showError(pickerError, "No WAV files found inside that ZIP.");
        return;
      }
      const entries = await Promise.all(wavs.map(async f => {
        const blob = await f.async("blob");
        // Use the basename (strip zip subfolders) so file-name parsing still works.
        const base = f.name.split("/").pop();
        return { name: base, file: new File([blob], base, { type: "audio/wav" }) };
      }));
      entries.sort((a, b) => a.name.localeCompare(b.name));
      folderNameDisplay.textContent = "";
      sessionLabel.textContent = zipFile.name.replace(/\.zip$/i, "");
      await loadEntries(entries);
    } catch (e) {
      folderNameDisplay.textContent = "";
      showError(pickerError, "Could not read ZIP: " + e.message);
    }
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

  // ----- Keyboard shortcuts (capture phase: fires before the input eats the key) -----
  document.addEventListener("keydown", (e) => {
    if (transcribeSection.classList.contains("hidden")) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    // Shift+Space → replay from start. (Plain space still types a character.)
    if ((e.key === " " || e.code === "Space") && e.shiftKey) {
      e.preventDefault();
      audioPlayer.pause();
      audioPlayer.currentTime = 0;
      audioPlayer.play().catch(() => {});
      return;
    }

    // Enter → next / submit. Ignore while a Korean (or any) IME is composing —
    // pressing Enter mid-composition should commit the character, not advance.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      if (!nextBtn.classList.contains("hidden"))        nextBtn.click();
      else if (!submitBtn.classList.contains("hidden")) submitBtn.click();
    }
  }, true);

  // ----- Score (all in JS, no server) -----
  // Build scored rows from the first `limit` entries of `results` (defaults
  // to all). Blank transcriptions are kept as blank rows and auto-score as 0.
  // Any manual Correct/Wrong override whose captured transcription still
  // matches the current one is applied; otherwise the auto-score is used.
  function computeRows(limit) {
    const end = limit == null ? results.length : Math.min(limit, results.length);
    return results.slice(0, end).map(r => {
      const base    = r.file_name.replace(/\.wav$/i, "");
      const m       = /set\d+_col\d+/.exec(base);
      const wordId  = m ? m[0] : base;
      const canonical = getCanonical(wordId, languageSelect.value);
      const trimmed   = r.transcription.trim();
      let correct = trimmed.length > 0 &&
                    trimmed.toLowerCase() === canonical.toLowerCase() ? 1 : 0;
      const o = overrides[r.file_name];
      if (o && o.forTranscription === trimmed) correct = o.correct;
      return { file_name: r.file_name, canonical, transcription: r.transcription, correct };
    });
  }

  // Re-compute score totals from scoreData.rows and repaint the results table.
  // Called on initial scoring and after each manual Correct/Wrong override.
  function renderResults() {
    if (!scoreData) return;
    const total      = scoreData.rows.length;
    const numCorrect = scoreData.rows.reduce((s, r) => s + r.correct, 0);
    const score      = total ? numCorrect / total : 0;
    scoreData.correct = numCorrect;
    scoreData.score   = score;

    scoreDisplay.textContent   = (score * 100).toFixed(1) + "%";
    correctDisplay.textContent = numCorrect;
    totalDisplay.textContent   = total;

    resultsTbody.innerHTML = "";
    scoreData.rows.forEach((row, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${row.file_name}</td>
        <td>${row.canonical}</td>
        <td>${row.transcription || "<em>—</em>"}</td>
        <td>
          <button type="button" class="score-toggle correct-${row.correct}" data-idx="${i}"
                  title="Click to override">
            ${row.correct ? "Correct" : "Wrong"}
          </button>
        </td>
      `;
      resultsTbody.appendChild(tr);
    });
  }

  // Click anywhere on a score button to flip its verdict. The override is
  // captured against the transcription at the moment of override so that a
  // later change to that field correctly drops the override.
  resultsTbody.addEventListener("click", (e) => {
    const btn = e.target.closest(".score-toggle");
    if (!btn || !scoreData) return;
    const idx = parseInt(btn.dataset.idx, 10);
    const row = scoreData.rows[idx];
    row.correct = row.correct ? 0 : 1;
    overrides[row.file_name] = {
      correct: row.correct,
      forTranscription: (row.transcription || "").trim(),
    };
    renderResults();
  });

  // ----- "Score now" preview: score everything up through the furthest
  // word the user has navigated to. Blank entries in that range are kept
  // as blank rows and counted as wrong (0).
  scoreNowBtn.addEventListener("click", () => {
    saveCurrentInput();
    const limit = maxVisited + 1;
    const rows  = computeRows(limit);
    if (!rows.length) {
      transcribeStatus.textContent = "Navigate to at least one word first.";
      return;
    }
    scoreData = { rows, score: 0, correct: 0, total: rows.length, preview: true };
    transcribeSection.classList.add("hidden");
    resultsSection.classList.remove("hidden");
    backToTranscribeBtn.classList.remove("hidden");
    if (resultsNote) {
      resultsNote.textContent = `Preview: results through word ${limit} of ${fileEntries.length}.`;
    }
    renderResults();
  });

  // ----- Back to transcribing (keeps overrides around).
  backToTranscribeBtn.addEventListener("click", () => {
    resultsSection.classList.add("hidden");
    transcribeSection.classList.remove("hidden");
    showFile(currentIdx);
  });

  submitBtn.addEventListener("click", async () => {
    saveCurrentInput();

    const empty = results.filter(r => !r.transcription).length;
    if (empty > 0 && !confirm(`${empty} word(s) have no transcription. Submit anyway?`)) return;

    submitBtn.disabled = true;
    transcribeStatus.textContent = "Scoring…";

    const rows = computeRows();
    scoreData = { rows, score: 0, correct: 0, total: rows.length, preview: false };

    transcribeSection.classList.add("hidden");
    resultsSection.classList.remove("hidden");
    backToTranscribeBtn.classList.remove("hidden");
    if (resultsNote) resultsNote.textContent = "";
    renderResults();

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
