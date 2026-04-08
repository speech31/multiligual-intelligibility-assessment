/**
 * recorder.js — Recording mode (pure client-side).
 *
 * Each session = one subsection = 50 words (one column across all 50 sets).
 * 12 subsections × 50 words = 600 words total per language.
 * Rest between subsections: the completion screen holds until user clicks
 * "Start Next Session".
 *
 * Subsection tracking: localStorage key "sub_{lang}_{speakerId}" → 1..12
 *
 * Folder layout:
 *   {root}/{speaker_id}/sub{N:02}/{speaker_id}-{wordId}.wav
 *
 * Requires: words.js, audio.js
 */

(function () {
  "use strict";

  const HAS_FSA = typeof window.showDirectoryPicker === "function";

  // ----- localStorage helpers -----
  function storageKey(lang, speaker) { return `sub_${lang}_${speaker}`; }

  function getCurrentSubsection(lang, speaker) {
    return parseInt(localStorage.getItem(storageKey(lang, speaker)) || "1", 10);
  }

  function saveNextSubsection(lang, speaker, current) {
    const next = current + 1;
    if (next > NUM_SUBSECTIONS) {
      localStorage.removeItem(storageKey(lang, speaker));
    } else {
      localStorage.setItem(storageKey(lang, speaker), String(next));
    }
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
  const saveFolderNote   = document.getElementById("save-folder-note");

  const recordBtn     = document.getElementById("record-btn");
  const stopBtn       = document.getElementById("stop-btn");
  const reviewSection = document.getElementById("review-section");
  const previewAudio  = document.getElementById("preview-audio");
  const rerecordBtn   = document.getElementById("rerecord-btn");
  const uploadBtn     = document.getElementById("upload-btn");
  const uploadStatus  = document.getElementById("upload-status");

  const doneSection    = document.getElementById("done-section");
  const doneTitle      = document.getElementById("done-title");
  const doneDetail     = document.getElementById("done-detail");
  const doneFolderEl   = document.getElementById("done-folder");
  const nextSessionBtn = document.getElementById("next-session-btn");

  // ----- State -----
  let lang          = "en";
  let speakerId     = "";
  let safeSpeaker   = "";
  let subsection    = 1;
  let sessionId     = "";
  let words         = [];
  let currentIdx    = 0;
  let audioBlob     = null;
  let mimeType      = "audio/webm";
  let mediaRecorder = null;
  let chunks        = [];
  let stream        = null;
  let saveDirHandle = null;
  let rootFolderName = "";

  // ----- Helpers -----
  function showError(el, msg) { el.textContent = msg; el.classList.remove("hidden"); }
  function hideError(el)      { el.classList.add("hidden"); }
  function sanitize(s)        { return String(s).replace(/[^a-zA-Z0-9_\-]/g, ""); }

  function updateSubsectionHint() {
    const safe = sanitize(speakerIdInput.value.trim());
    const l    = languageSelect.value;
    if (!safe) { subsectionInfo.classList.add("hidden"); return; }
    const sub  = getCurrentSubsection(l, safe);
    subsectionInfo.textContent = sub > NUM_SUBSECTIONS
      ? `All ${NUM_SUBSECTIONS} subsections complete for this speaker.`
      : `Next: subsection ${sub} of ${NUM_SUBSECTIONS}`;
    subsectionInfo.classList.remove("hidden");
  }

  speakerIdInput.addEventListener("input", updateSubsectionHint);
  languageSelect.addEventListener("change", updateSubsectionHint);

  function setIdle() {
    recordBtn.classList.remove("hidden");
    stopBtn.classList.add("hidden");
    reviewSection.classList.add("hidden");
    uploadStatus.textContent = "";
    audioBlob = null;
    if (previewAudio.src.startsWith("blob:")) URL.revokeObjectURL(previewAudio.src);
    previewAudio.src = "";
  }

  function showWord(idx) {
    wordIndexEl.textContent = idx + 1;
    wordDisplay.textContent = getCanonical(words[idx], lang);
    setIdle();
  }

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

  // ----- Start session -----
  startBtn.addEventListener("click", async () => {
    lang        = languageSelect.value;
    speakerId   = speakerIdInput.value.trim();
    safeSpeaker = sanitize(speakerId);

    if (!safeSpeaker) {
      showError(setupError, "Speaker ID required (letters, digits, - or _)."); return;
    }
    hideError(setupError);

    subsection = getCurrentSubsection(lang, safeSpeaker);
    if (subsection > NUM_SUBSECTIONS) {
      showError(setupError,
        `All ${NUM_SUBSECTIONS} subsections for "${safeSpeaker}" (${LANGUAGES[lang]}) are already complete.`);
      return;
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

    try { words = getSessionWords(subsection, lang); }
    catch (e) { showError(setupError, e.message); return; }

    sessionId = `${safeSpeaker}/sub${String(subsection).padStart(2, "0")}`;

    if (rootHandle) {
      try {
        const speakerDir = await rootHandle.getDirectoryHandle(safeSpeaker, { create: true });
        saveDirHandle    = await speakerDir.getDirectoryHandle(
          `sub${String(subsection).padStart(2, "0")}`, { create: true }
        );
      } catch (e) {
        showError(setupError, "Could not create session folder: " + e.message); return;
      }
    }

    wordTotalEl.textContent = words.length;
    setupSection.classList.add("hidden");
    recordingSection.classList.remove("hidden");
    sessionIdLabel.textContent =
      `${safeSpeaker} · ${LANGUAGES[lang]} · sub${String(subsection).padStart(2, "0")} (${subsection}/${NUM_SUBSECTIONS})`;
    saveFolderNote.textContent = HAS_FSA && saveDirHandle
      ? `Saving to: ${rootFolderName}/${sessionId}/`
      : "Files will be downloaded to your Downloads folder.";

    currentIdx = 0;
    showWord(0);
  });

  // ----- Record -----
  recordBtn.addEventListener("click", async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      alert("Microphone access denied. Please allow microphone access and try again."); return;
    }
    chunks   = [];
    mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/ogg";
    mediaRecorder = new MediaRecorder(stream, { mimeType });

    mediaRecorder.ondataavailable = (e) => { if (e.data?.size > 0) chunks.push(e.data); };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      audioBlob = new Blob(chunks, { type: mimeType });
      previewAudio.src = URL.createObjectURL(audioBlob);
      reviewSection.classList.remove("hidden");
      recordBtn.classList.add("hidden");
      stopBtn.classList.add("hidden");
    };

    mediaRecorder.start(100);
    recordBtn.classList.add("hidden");
    stopBtn.classList.remove("hidden");
  });

  stopBtn.addEventListener("click", () => {
    if (mediaRecorder?.state !== "inactive") mediaRecorder.stop();
  });

  rerecordBtn.addEventListener("click", setIdle);

  // ----- Save & Next -----
  uploadBtn.addEventListener("click", async () => {
    if (!audioBlob) return;
    uploadBtn.disabled = rerecordBtn.disabled = true;
    uploadStatus.textContent = "Converting to WAV…";

    const wordId   = words[currentIdx];
    const fileName = `${safeSpeaker}-${wordId}.wav`;

    try {
      const wavBuffer = await blobToWav(audioBlob);
      uploadStatus.textContent = "Saving…";

      if (HAS_FSA && saveDirHandle) {
        await saveLocalFSA(fileName, wavBuffer);
        uploadStatus.textContent = `Saved: ${fileName}`;
      } else {
        downloadFallback(fileName, wavBuffer);
        uploadStatus.textContent = `Downloaded: ${fileName}`;
      }

      setTimeout(() => {
        currentIdx++;
        if (currentIdx >= words.length) {
          finishSession();
        } else {
          showWord(currentIdx);
        }
      }, 700);

    } catch (err) {
      uploadStatus.textContent = "";
      alert("Error saving WAV: " + err.message);
    } finally {
      uploadBtn.disabled = rerecordBtn.disabled = false;
    }
  });

  // ----- Subsection complete -----
  function finishSession() {
    saveNextSubsection(lang, safeSpeaker, subsection);
    const nextSub = subsection + 1;
    const allDone = nextSub > NUM_SUBSECTIONS;

    recordingSection.classList.add("hidden");
    doneSection.classList.remove("hidden");

    doneFolderEl.textContent = HAS_FSA && saveDirHandle
      ? `${rootFolderName}/${sessionId}/`
      : "your Downloads folder";

    if (allDone) {
      doneTitle.textContent  = "All done!";
      doneDetail.textContent =
        `All ${NUM_SUBSECTIONS} subsections for "${safeSpeaker}" (${LANGUAGES[lang]}) are complete.`;
      nextSessionBtn.classList.add("hidden");
    } else {
      doneTitle.textContent  = "Subsection complete — take a rest!";
      doneDetail.textContent =
        `Subsection ${subsection} of ${NUM_SUBSECTIONS} done. ` +
        `When you're ready, click below to start subsection ${nextSub}.`;
      nextSessionBtn.classList.remove("hidden");
    }
  }
})();
