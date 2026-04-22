/**
 * recorder.js — Recording mode (pure client-side, keyboard-driven).
 *
 * Flow: each word is shown after a brief silence, and recording begins the
 * moment the word appears. Only shortcut keys control progression:
 *   x      — stop, save WAV, advance to next word
 *   z      — stop, go back to the previous word (next save overwrites)
 *   c      — stop, discard, re-record the same word
 *   space  — stop, play back the just-recorded take (preview audio is hidden)
 *
 * Two modes:
 *   - "default": record ONE randomly chosen subsection (50 words) per speaker.
 *   - "full":    record all subsections (e.g. 12 × 50 = 600 words).
 *
 * Full-mode subsection tracking:   "sub_{lang}_{speakerId}"        → 1..N
 * Default-mode chosen subsection:  "defaultSub_{lang}_{speakerId}"  → 1..N
 * Default-mode completion flag:    "defaultDone_{lang}_{speakerId}" → "1"
 *
 * Folder layout:
 *   {root}/{speaker_id}/sub{N:02}/{speaker_id}-{wordId}.wav  (full)
 *   {root}/{speaker_id}/{speaker_id}-{wordId}.wav            (default)
 *
 * Requires: words.js, audio.js
 */

(function () {
  "use strict";

  const HAS_FSA = typeof window.showDirectoryPicker === "function";
  const LEAD_IN_MS = 500;  // silence gap after press; word shown + recording starts together
  const WORD_SHOW_MS = 250;  // delay after showing the word before TTS starts, so the word lands first

  // Map our language codes to BCP-47 tags for speechSynthesis.
  const TTS_LANG = {
    en: "en-US", ko: "ko-KR", fr: "fr-FR", de: "de-DE", es: "es-ES",
    fi: "fi-FI", sv: "sv-SE", et: "et-EE", da: "da-DK",
    hi: "hi-IN", ru: "ru-RU", ar: "ar-SA",
  };

  // ----- localStorage helpers -----
  function storageKey(lang, speaker)      { return `sub_${lang}_${speaker}`; }
  function defaultSubKey(lang, speaker)   { return `defaultSub_${lang}_${speaker}`; }
  function defaultDoneKey(lang, speaker)  { return `defaultDone_${lang}_${speaker}`; }

  function getCurrentSubsection(lang, speaker) {
    return parseInt(localStorage.getItem(storageKey(lang, speaker)) || "1", 10);
  }

  function saveNextSubsection(lang, speaker, current) {
    const next = current + 1;
    if (next > getLangConfig(lang).numSubsections) {
      localStorage.removeItem(storageKey(lang, speaker));
    } else {
      localStorage.setItem(storageKey(lang, speaker), String(next));
    }
  }

  function getDefaultSubsection(lang, speaker) {
    const stored = parseInt(localStorage.getItem(defaultSubKey(lang, speaker)) || "0", 10);
    if (stored >= 1 && stored <= getLangConfig(lang).numSubsections) return stored;
    const n = getLangConfig(lang).numSubsections;
    const picked = Math.floor(Math.random() * n) + 1;
    localStorage.setItem(defaultSubKey(lang, speaker), String(picked));
    return picked;
  }

  function isDefaultDone(lang, speaker) {
    return localStorage.getItem(defaultDoneKey(lang, speaker)) === "1";
  }

  function markDefaultDone(lang, speaker) {
    localStorage.setItem(defaultDoneKey(lang, speaker), "1");
  }

  // ----- DOM -----
  const setupSection    = document.getElementById("setup-section");
  const startBtn        = document.getElementById("start-btn");
  const languageSelect  = document.getElementById("language");
  const speakerIdInput  = document.getElementById("speaker-id");
  const subsectionInfo  = document.getElementById("subsection-info");
  const setupError      = document.getElementById("setup-error");

  const recordingSection = document.getElementById("recording-section");
  const sessionIdLabel   = document.getElementById("session-id-label");
  const wordIndexEl      = document.getElementById("word-index");
  const wordTotalEl      = document.getElementById("word-total");
  const wordDisplay      = document.getElementById("word-display");
  const modeInstruction  = document.getElementById("mode-instruction");
  const saveFolderNote   = document.getElementById("save-folder-note");
  const previewAudio     = document.getElementById("preview-audio");
  const uploadStatus     = document.getElementById("upload-status");

  const doneSection    = document.getElementById("done-section");
  const doneTitle      = document.getElementById("done-title");
  const doneDetail     = document.getElementById("done-detail");
  const doneFolderEl   = document.getElementById("done-folder");
  const nextSessionBtn = document.getElementById("next-session-btn");

  // ----- State -----
  let lang           = "en";
  let speakerId      = "";
  let safeSpeaker    = "";
  let mode           = "default";
  let headphoneMode  = "with";         // "with" | "without"
  let subsection     = 1;
  let sessionId      = "";
  let words          = [];
  let currentIdx     = 0;
  let saveDirHandle  = null;
  let rootFolderName = "";

  let stream        = null;          // persistent mic stream for the whole session
  let mediaRecorder = null;
  let mediaMime     = "audio/webm";
  let chunks        = [];
  let currentBlob   = null;
  let busy          = false;

  // ----- Helpers -----
  function showError(el, msg) { el.textContent = msg; el.classList.remove("hidden"); }
  function hideError(el)      { el.classList.add("hidden"); }
  function sanitize(s)        { return String(s).replace(/[^a-zA-Z0-9_\-]/g, ""); }

  function getSelectedMode() {
    const checked = document.querySelector('input[name="mode"]:checked');
    return checked ? checked.value : "default";
  }

  function getSelectedHeadphone() {
    const checked = document.querySelector('input[name="headphone"]:checked');
    return checked ? checked.value : "with";
  }

  // Speak the given word via the browser TTS. Resolves when playback ends
  // (or immediately if speechSynthesis is unavailable).
  function playWordAudio(text, langCode) {
    return new Promise(resolve => {
      if (!("speechSynthesis" in window)) { resolve(); return; }
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = TTS_LANG[langCode] || langCode;
      u.rate = 0.9;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    });
  }

  function cancelTTS() {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }

  function updateSubsectionHint() {
    const safe = sanitize(speakerIdInput.value.trim());
    const l    = languageSelect.value;
    const m    = getSelectedMode();
    if (!safe) { subsectionInfo.classList.add("hidden"); return; }
    const { numSubsections } = getLangConfig(l);
    if (m === "default") {
      subsectionInfo.textContent = isDefaultDone(l, safe)
        ? `Default 50-word session already complete for this speaker.`
        : `Default mode: 50 words.`;
    } else {
      const sub = getCurrentSubsection(l, safe);
      subsectionInfo.textContent = sub > numSubsections
        ? `All ${numSubsections} subsections complete for this speaker.`
        : `Next: subsection ${sub} of ${numSubsections}`;
    }
    subsectionInfo.classList.remove("hidden");
  }

  const headphoneRow = document.getElementById("headphone-row");

  // TTS reference audio is only available for English right now; other
  // languages skip both the headphone option and the TTS playback.
  function hasReferenceAudio(l) { return l === "en"; }

  function updateHeadphoneVisibility() {
    const hide = getSelectedMode() === "full" || !hasReferenceAudio(languageSelect.value);
    headphoneRow.classList.toggle("hidden", hide);
  }

  speakerIdInput.addEventListener("input", updateSubsectionHint);
  languageSelect.addEventListener("change", updateSubsectionHint);
  languageSelect.addEventListener("change", updateHeadphoneVisibility);
  document.querySelectorAll('input[name="mode"]').forEach(el => {
    el.addEventListener("change", updateSubsectionHint);
    el.addEventListener("change", updateHeadphoneVisibility);
  });
  updateHeadphoneVisibility();

  async function saveLocalFSA(fileName, arrayBuffer) {
    const fh = await saveDirHandle.getFileHandle(fileName, { create: true });
    const wr = await fh.createWritable();
    await wr.write(arrayBuffer);
    await wr.close();
  }

  function downloadFallback(fileName, arrayBuffer) {
    const blob = new Blob([arrayBuffer], { type: "audio/wav" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = fileName; a.click();
    URL.revokeObjectURL(url);
  }

  function blankWord() {
    wordDisplay.textContent = "";
    modeInstruction.textContent = "";
  }

  async function showAndRecord(idx) {
    wordIndexEl.textContent = idx + 1;
    const text = getCanonical(words[idx], lang);
    wordDisplay.textContent = text;
    uploadStatus.textContent = "";
    currentBlob = null;

    if (mode === "full" || !hasReferenceAudio(lang)) {
      // Developer mode, or a language without reference audio — skip TTS.
      startRecording();
    } else if (headphoneMode === "with") {
      startRecording();
      await new Promise(r => setTimeout(r, WORD_SHOW_MS));
      playWordAudio(text, lang);   // fire-and-forget; mic records along with it
    } else {
      await new Promise(r => setTimeout(r, WORD_SHOW_MS));
      await playWordAudio(text, lang);
      startRecording();
    }
  }

  // ----- Recording pipeline -----
  function startRecording() {
    if (!stream) return;
    chunks = [];
    currentBlob = null;
    mediaMime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/ogg";
    mediaRecorder = new MediaRecorder(stream, { mimeType: mediaMime });
    mediaRecorder.ondataavailable = e => { if (e.data?.size > 0) chunks.push(e.data); };
    mediaRecorder.start(100);
  }

  function stopRecordingAndCollect() {
    return new Promise(resolve => {
      if (!mediaRecorder || mediaRecorder.state === "inactive") { resolve(); return; }
      mediaRecorder.onstop = () => {
        currentBlob = new Blob(chunks, { type: mediaMime });
        resolve();
      };
      mediaRecorder.stop();
    });
  }

  async function ensureStopped() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      await stopRecordingAndCollect();
    }
  }

  async function handleSaveAndNext() {
    if (busy) return;
    busy = true;
    try {
      cancelTTS();
      blankWord();                                            // blank immediately
      const delay = new Promise(r => setTimeout(r, LEAD_IN_MS));
      await ensureStopped();
      if (!currentBlob) {
        await delay;
        await showAndRecord(currentIdx);
        return;
      }
      const wordId   = words[currentIdx];
      const fileName = `${safeSpeaker}-${wordId}.wav`;
      const saveWork = (async () => {
        const wavBuffer = await blobToWav(currentBlob);
        if (HAS_FSA && saveDirHandle) {
          await saveLocalFSA(fileName, wavBuffer);
          uploadStatus.textContent = `Saved: ${fileName}`;
        } else {
          downloadFallback(fileName, wavBuffer);
          uploadStatus.textContent = `Downloaded: ${fileName}`;
        }
      })();
      await Promise.all([saveWork, delay]);                   // silence covers save
      currentIdx++;
      if (currentIdx >= words.length) {
        closeStream();
        finishSession();
      } else {
        await showAndRecord(currentIdx);
      }
    } catch (err) {
      alert("Save failed: " + err.message);
    } finally {
      busy = false;
    }
  }

  async function handleBack() {
    if (busy) return;
    if (currentIdx <= 0) return;
    busy = true;
    try {
      cancelTTS();
      blankWord();
      const delay = new Promise(r => setTimeout(r, LEAD_IN_MS));
      await ensureStopped();
      currentIdx--;
      await delay;
      await showAndRecord(currentIdx);
    } finally {
      busy = false;
    }
  }

  async function handleReRecord() {
    if (busy) return;
    busy = true;
    try {
      cancelTTS();
      blankWord();
      const delay = new Promise(r => setTimeout(r, LEAD_IN_MS));
      await ensureStopped();
      await delay;
      await showAndRecord(currentIdx);
    } finally {
      busy = false;
    }
  }

  async function handleReplay() {
    if (busy) return;
    busy = true;
    try {
      await ensureStopped();
      if (!currentBlob) return;
      if (previewAudio.src.startsWith("blob:")) URL.revokeObjectURL(previewAudio.src);
      previewAudio.src = URL.createObjectURL(currentBlob);
      previewAudio.currentTime = 0;
      previewAudio.play().catch(() => {});
    } finally {
      busy = false;
    }
  }

  function closeStream() {
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
  }

  // ----- Keyboard shortcuts -----
  document.addEventListener("keydown", (e) => {
    if (recordingSection.classList.contains("hidden")) return;
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const k = e.key.toLowerCase();
    if (k === "x")                                 { e.preventDefault(); handleSaveAndNext(); }
    else if (k === "z")                            { e.preventDefault(); handleBack(); }
    else if (k === "c")                            { e.preventDefault(); handleReRecord(); }
    else if (e.key === " " || e.code === "Space")  { e.preventDefault(); handleReplay(); }
  });

  // ----- Start session -----
  startBtn.addEventListener("click", async () => {
    lang          = languageSelect.value;
    speakerId     = speakerIdInput.value.trim();
    safeSpeaker   = sanitize(speakerId);
    mode          = getSelectedMode();
    headphoneMode = getSelectedHeadphone();

    if (!safeSpeaker) {
      showError(setupError, "Speaker ID required (letters, digits, - or _)."); return;
    }
    hideError(setupError);

    const NUM_SUBSECTIONS = getLangConfig(lang).numSubsections;

    if (mode === "default") {
      if (isDefaultDone(lang, safeSpeaker)) {
        showError(setupError,
          `Default 50-word session for "${safeSpeaker}" (${LANGUAGES[lang]}) is already complete.`);
        return;
      }
      subsection = getDefaultSubsection(lang, safeSpeaker);
    } else {
      subsection = getCurrentSubsection(lang, safeSpeaker);
      if (subsection > NUM_SUBSECTIONS) {
        showError(setupError,
          `All ${NUM_SUBSECTIONS} subsections for "${safeSpeaker}" (${LANGUAGES[lang]}) are already complete.`);
        return;
      }
    }

    let rootHandle = null;
    rootFolderName = "";
    saveDirHandle  = null;

    if (HAS_FSA) {
      try {
        rootHandle     = await window.showDirectoryPicker({ mode: "readwrite" });
        rootFolderName = rootHandle.name;
      } catch (e) {
        if (e.name === "AbortError") return;
        showError(setupError, "Could not open folder: " + e.message); return;
      }
    }

    try { words = getSessionWords(subsection, lang, safeSpeaker); }
    catch (e) { showError(setupError, e.message); return; }

    const subLabel = `sub${String(subsection).padStart(2, "0")}`;
    sessionId = mode === "default"
      ? safeSpeaker
      : `${safeSpeaker}/${subLabel}`;

    if (rootHandle) {
      try {
        const speakerDir = await rootHandle.getDirectoryHandle(safeSpeaker, { create: true });
        saveDirHandle = mode === "default"
          ? speakerDir
          : await speakerDir.getDirectoryHandle(subLabel, { create: true });
      } catch (e) {
        showError(setupError, "Could not create session folder: " + e.message); return;
      }
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      showError(setupError, "Microphone access denied. Please allow microphone and try again.");
      return;
    }

    wordTotalEl.textContent = words.length;
    setupSection.classList.add("hidden");
    recordingSection.classList.remove("hidden");
    sessionIdLabel.textContent = mode === "default"
      ? `${safeSpeaker} · ${LANGUAGES[lang]}`
      : `${safeSpeaker} · ${LANGUAGES[lang]} · ${subLabel} (${subsection}/${NUM_SUBSECTIONS})`;
    saveFolderNote.textContent = HAS_FSA && saveDirHandle
      ? `Saving to: ${rootFolderName}/${sessionId}/`
      : "Files will be downloaded to your Downloads folder.";

    currentIdx = 0;
    blankWord();
    wordIndexEl.textContent = 1;
    busy = true;
    try {
      await new Promise(r => setTimeout(r, LEAD_IN_MS));
      await showAndRecord(0);
    } finally { busy = false; }
  });

  // ----- Session complete -----
  function finishSession() {
    const { numSubsections } = getLangConfig(lang);
    cancelTTS();
    closeStream();

    recordingSection.classList.add("hidden");
    doneSection.classList.remove("hidden");

    doneFolderEl.textContent = HAS_FSA && saveDirHandle
      ? `${rootFolderName}/${sessionId}/`
      : "your Downloads folder";

    if (mode === "default") {
      markDefaultDone(lang, safeSpeaker);
      doneTitle.textContent  = "All done!";
      doneDetail.textContent =
        `50-word default session for "${safeSpeaker}" (${LANGUAGES[lang]}) is complete.`;
      nextSessionBtn.classList.add("hidden");
      return;
    }

    saveNextSubsection(lang, safeSpeaker, subsection);
    const nextSub = subsection + 1;
    const allDone = nextSub > numSubsections;

    if (allDone) {
      doneTitle.textContent  = "All done!";
      doneDetail.textContent =
        `All ${numSubsections} subsections for "${safeSpeaker}" (${LANGUAGES[lang]}) are complete.`;
      nextSessionBtn.classList.add("hidden");
    } else {
      doneTitle.textContent  = "Subsection complete — take a rest!";
      doneDetail.textContent =
        `Subsection ${subsection} of ${numSubsections} done. ` +
        `When you're ready, click below to start subsection ${nextSub}.`;
      nextSessionBtn.classList.remove("hidden");
    }
  }
})();
