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
 *   - "default":   numSets words (one per set, random column).
 *   - "full" (dev): every (set × column) cell — e.g. 12 × 50 = 600 words.
 *
 * Completion flag (per language + speaker + mode), in sessionStorage so
 * shared clinical devices reset on browser/tab close:
 *   "done_{mode}_{lang}_{speakerId}" → "1"
 *
 * Folder layout:  {root}/{speaker_id}/{speaker_id}-{wordId}.wav
 *
 * Chrome / Edge (HAS_FSA): folder picker, write each WAV to disk via FSA.
 * Safari / Firefox (ZIP_FALLBACK = !HAS_FSA): per-take WAV cached in IndexedDB
 *   so a crash/refresh doesn't lose progress, plus a recovery banner on
 *   reload, manual partial-ZIP export, and a best-effort `pagehide` ZIP
 *   download. Final session ZIP downloads when all words are recorded.
 *
 * Requires: words.js, audio.js, jszip (only used when ZIP_FALLBACK).
 */

(function () {
  "use strict";

  const HAS_FSA = typeof window.showDirectoryPicker === "function";
  const ZIP_FALLBACK = !HAS_FSA;
  console.info(`[recorder] v=17 mode=${HAS_FSA ? "FSA (folder picker)" : "ZIP fallback (browser cache + ZIP at end)"}`);
  const LEAD_IN_MS = 500;
  const WORD_SHOW_MS = 250;
  const ZIP_NAME_PREFIX = "CHMIT";

  // Map our language codes to BCP-47 tags for speechSynthesis.
  const TTS_LANG = {
    en: "en-US", ko: "ko-KR", fr: "fr-FR", de: "de-DE", es: "es-ES",
    fi: "fi-FI", sv: "sv-SE", et: "et-EE", da: "da-DK",
    hi: "hi-IN", ru: "ru-RU", ar: "ar-SA", el: "el-GR", ja: "ja-JP",
  };

  // ----- Done flag (sessionStorage so clinical devices reset between users) -----
  const sessionStore = window.sessionStorage;
  const doneKey  = (lang, speaker, mode) => `done_${mode}_${lang}_${speaker}`;
  const isDone   = (lang, speaker, mode) => sessionStore.getItem(doneKey(lang, speaker, mode)) === "1";
  const markDone = (lang, speaker, mode) => sessionStore.setItem(doneKey(lang, speaker, mode), "1");

  // ----- IndexedDB (Safari/Firefox only) -----
  // Caches each finished WAV plus session metadata so a tab close, refresh, or
  // crash does not lose work. Cleared after a successful final or recovery ZIP.
  const IDB_NAME    = "chmit";
  // Older builds (78b489d) created this DB at version 2 with extra stores.
  // Bumping past that lets us reuse existing DBs without VersionError.
  const IDB_VERSION = 3;
  const FB_FILES    = "fbFiles";
  const FB_META     = "fbMeta";
  const FB_KEY_META = "meta";

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = (ev) => {
        const db = ev.target.result;
        if (!db.objectStoreNames.contains(FB_FILES)) db.createObjectStore(FB_FILES);
        if (!db.objectStoreNames.contains(FB_META))  db.createObjectStore(FB_META);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  async function idbFallbackFileCount() {
    if (!ZIP_FALLBACK) return 0;
    try {
      const db = await idbOpen();
      return await new Promise((resolve, reject) => {
        const req = db.transaction(FB_FILES, "readonly").objectStore(FB_FILES).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
      });
    } catch { return 0; }
  }

  async function idbGetFallbackMeta() {
    try {
      const db = await idbOpen();
      return await new Promise((resolve, reject) => {
        const req = db.transaction(FB_META, "readonly").objectStore(FB_META).get(FB_KEY_META);
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
      });
    } catch { return null; }
  }

  async function idbMapFromFallbackStore() {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const m = new Map();
      const tx = db.transaction(FB_FILES, "readonly");
      const req = tx.objectStore(FB_FILES).openCursor();
      req.onsuccess = (e) => {
        const c = e.target.result;
        if (!c) { resolve(m); return; }
        m.set(c.key, c.value);
        c.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function idbClearAllFallback() {
    if (!ZIP_FALLBACK) return;
    try {
      const db = await idbOpen();
      await new Promise((resolve, reject) => {
        const tx = db.transaction([FB_FILES, FB_META], "readwrite");
        tx.objectStore(FB_FILES).clear();
        tx.objectStore(FB_META).clear();
        tx.oncomplete = () => resolve();
        tx.onerror    = () => reject(tx.error);
      });
    } catch {}
  }

  // IDB persistence is best-effort: it gives crash recovery, but if it fails
  // we still keep the WAV in `fallbackZipEntries` and the final ZIP is fine.
  async function idbAppendFallbackWav(relativePath, arrayBuffer) {
    if (!ZIP_FALLBACK) return;
    try {
      const db = await idbOpen();
      const meta = {
        v: 1, lang, mode, safeSpeaker,
        fileCount: fallbackZipEntries.size,
        updatedAt: Date.now(),
      };
      await new Promise((resolve, reject) => {
        const tx = db.transaction([FB_FILES, FB_META], "readwrite");
        tx.objectStore(FB_FILES).put(arrayBuffer, relativePath);
        tx.objectStore(FB_META).put(meta, FB_KEY_META);
        tx.oncomplete = () => resolve();
        tx.onerror    = () => reject(tx.error);
      });
    } catch (e) {
      console.warn("IndexedDB backup unavailable; session will rely on in-memory ZIP only.", e);
    }
  }

  // ----- ZIP helpers (Safari/Firefox only) -----
  let fallbackZipEntries = new Map();
  let lastUnloadZipBlob  = null;       // refreshed after each take for pagehide

  function zipNameFor({ recovered = false, partial = false, meta = null } = {}) {
    const l = meta?.lang || lang;
    const s = meta?.safeSpeaker || safeSpeaker;
    const m = meta?.mode || mode;
    const base = `${ZIP_NAME_PREFIX}_${l}_${s}_${m}`;
    if (recovered) return `${base}_RECOVERED.zip`;
    if (partial)   return `${base}_partial-${Date.now()}.zip`;
    return `${base}.zip`;
  }

  function zipPathFor(fileName) {
    return `${safeSpeaker}/${fileName}`;
  }

  async function zipBlobFromMap(map) {
    const JSZip = window.JSZip;
    if (!JSZip) throw new Error("JSZip not loaded (check static/js/vendor/jszip.min.js).");
    if (map.size === 0) return null;
    const zip = new JSZip();
    for (const [p, ab] of map) zip.file(p, ab);
    return zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  }

  async function refreshUnloadZipBlob() {
    if (!ZIP_FALLBACK) return;
    if (fallbackZipEntries.size === 0) { lastUnloadZipBlob = null; return; }
    try { lastUnloadZipBlob = await zipBlobFromMap(fallbackZipEntries); }
    catch { /* keep previous */ }
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement("a");
    a.href = url; a.download = fileName; a.click();
    URL.revokeObjectURL(url);
  }

  // ----- DOM -----
  const setupSection    = document.getElementById("setup-section");
  const startBtn        = document.getElementById("start-btn");
  const languageSelect  = document.getElementById("language");
  const speakerIdInput  = document.getElementById("speaker-id");
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

  const fullscreenBtn  = document.getElementById("fullscreen-btn");
  const saveZipNowBtn  = document.getElementById("save-zip-now-btn");

  const doneSection    = document.getElementById("done-section");
  const doneTitle      = document.getElementById("done-title");
  const doneDetail     = document.getElementById("done-detail");
  const doneFolderEl   = document.getElementById("done-folder");

  const zipFallbackHint  = document.getElementById("zip-fallback-hint");
  const chromeFolderHint = document.getElementById("chrome-folder-hint");

  const recoveryBox          = document.getElementById("fallback-recovery");
  const recoveryTextEl       = document.getElementById("fallback-recovery-text");
  const recoveryDownloadBtn  = document.getElementById("fallback-recovery-download");
  const recoveryDiscardBtn   = document.getElementById("fallback-recovery-discard");

  const privacyTools         = document.getElementById("privacy-tools");
  const clearLocalDataBtn    = document.getElementById("clear-local-data-btn");
  const clearLocalDataStatus = document.getElementById("clear-local-data-status");

  // ----- State -----
  let lang           = "en";
  let safeSpeaker    = "";
  let mode           = "default";
  let headphoneMode  = "with";
  let words          = [];
  let currentIdx     = 0;
  let saveDirHandle  = null;
  let rootFolderName = "";

  let stream        = null;
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

  // Where bundled reference recordings live, keyed by language. Naming
  // conventions differ per language; languages not listed fall back to TTS.
  //   subdir: true  → files grouped under `List {setNum}/`
  //   case: "upper" → word part of filename is UPPERCASE (English); else lowercase
  const REFERENCE_AUDIO = {
    en: { dir: "CHMIT-English", subdir: false, case: "upper" },
    fi: { dir: "CHMIT-Finnish", subdir: false, case: "lower" },
    el: { dir: "CHMIT-Greek",   subdir: true,  case: "lower" },
    es: { dir: "CHMIT-Spanish", subdir: true,  case: "lower" },
    ru: { dir: "CHMIT-Russian", subdir: false, case: "lower" },
  };

  function referenceAudioUrl(wordId, langCode) {
    const cfg = REFERENCE_AUDIO[langCode];
    if (!cfg) return null;
    const word = getCanonical(wordId, langCode);
    if (!word || word === wordId) return null;
    const m = /^set(\d+)_col\d+$/.exec(wordId);
    if (!m) return null;
    const setNum = parseInt(m[1], 10);
    const wordPart = cfg.case === "upper" ? word.toUpperCase() : word.toLowerCase();
    const fileName = `${wordId}_${wordPart}.wav`;
    const segments = cfg.subdir
      ? ["data", cfg.dir, `List ${setNum}`, fileName]
      : ["data", cfg.dir, fileName];
    // Encode each segment for spaces / non-ASCII (Greek, etc.) without touching slashes.
    return segments.map(encodeURIComponent).join("/");
  }

  let currentRefAudio = null;   // active <audio> element so we can cancel mid-playback
  function playFile(url) {
    return new Promise((resolve, reject) => {
      const a = new Audio(url);
      currentRefAudio = a;
      a.onended = () => { if (currentRefAudio === a) currentRefAudio = null; resolve(); };
      a.onerror = () => { if (currentRefAudio === a) currentRefAudio = null; reject(new Error("audio load/play error")); };
      a.play().catch(err => { if (currentRefAudio === a) currentRefAudio = null; reject(err); });
    });
  }

  function playTTS(text, langCode) {
    return new Promise(resolve => {
      if (!("speechSynthesis" in window)) { resolve(); return; }
      const synth = window.speechSynthesis;
      const needCancel = synth.speaking || synth.pending;
      if (needCancel) synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = TTS_LANG[langCode] || langCode;
      u.rate = 0.9;
      u.onend   = () => resolve();
      u.onerror = () => resolve();
      // Chrome drops speak() called immediately after cancel(); a tiny delay avoids it.
      if (needCancel) setTimeout(() => synth.speak(u), 60);
      else            synth.speak(u);
    });
  }

  // Try the bundled recording first; if missing or it errors, fall back to TTS.
  // In developer mode we pass fileOnly=true to skip the TTS fallback (TTS for
  // 600 words is too slow), so a missing/broken file just means silence.
  async function playWordAudio(wordId, text, langCode, fileOnly = false) {
    const url = referenceAudioUrl(wordId, langCode);
    if (url) {
      try { await playFile(url); return; }
      catch (e) { console.warn(`[playWordAudio] no reference audio for ${wordId}${fileOnly ? "" : "; using TTS"}`); }
    }
    if (!fileOnly) await playTTS(text, langCode);
  }

  function cancelAudio() {
    if (currentRefAudio) {
      try { currentRefAudio.pause(); } catch {}
      currentRefAudio = null;
    }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }
  // Back-compat alias for older call sites; also stops any reference audio.
  const cancelTTS = cancelAudio;

  const headphoneRow = document.getElementById("headphone-row");

  function updateHeadphoneVisibility() {
    // Headphone choice always applies in default mode (audio = file or TTS).
    headphoneRow.classList.toggle("hidden", getSelectedMode() === "full");
  }

  languageSelect.addEventListener("change", updateHeadphoneVisibility);
  document.querySelectorAll('input[name="mode"]').forEach(el => {
    el.addEventListener("change", updateHeadphoneVisibility);
  });
  updateHeadphoneVisibility();

  // Show the right tip in the setup form based on browser capability.
  if (chromeFolderHint) chromeFolderHint.classList.toggle("hidden", !HAS_FSA);
  if (zipFallbackHint)  zipFallbackHint.classList.toggle("hidden",  !ZIP_FALLBACK);

  // ----- Per-take save -----
  async function saveLocalFSA(fileName, arrayBuffer) {
    const fh = await saveDirHandle.getFileHandle(fileName, { create: true });
    const wr = await fh.createWritable();
    await wr.write(arrayBuffer);
    await wr.close();
  }

  async function queueForZip(fileName, arrayBuffer) {
    const p = zipPathFor(fileName);
    fallbackZipEntries.set(p, arrayBuffer);
    await idbAppendFallbackWav(p, arrayBuffer);
    void refreshUnloadZipBlob().catch(() => {});
  }

  function tryDownloadInterruptSnapshotZip() {
    if (!ZIP_FALLBACK) return;
    if (!lastUnloadZipBlob || fallbackZipEntries.size === 0) return;
    try { downloadBlob(lastUnloadZipBlob, zipNameFor({ partial: true })); }
    catch { /* popup policy may block on pagehide */ }
  }

  async function buildSessionZip() {
    if (!ZIP_FALLBACK) return;
    const blob = await zipBlobFromMap(fallbackZipEntries);
    if (!blob) return;
    downloadBlob(blob, zipNameFor());
    fallbackZipEntries = new Map();
    lastUnloadZipBlob  = null;
    await idbClearAllFallback();
    if (uploadStatus) {
      uploadStatus.textContent = "ZIP downloaded. Temporary audio cache in this browser has been cleared.";
    }
  }

  async function exportProgressZip() {
    if (!ZIP_FALLBACK || fallbackZipEntries.size === 0) return;
    const prev = uploadStatus.textContent;
    uploadStatus.textContent = "Preparing progress ZIP…";
    try {
      const blob = await zipBlobFromMap(fallbackZipEntries);
      if (!blob) return;
      downloadBlob(blob, zipNameFor({ partial: true }));
      uploadStatus.textContent =
        `Progress ZIP ready (${fallbackZipEntries.size} file(s)). A copy is still in the browser if this tab closes.`;
    } catch (e) {
      uploadStatus.textContent = prev;
      throw e;
    }
  }

  function blankWord() {
    wordDisplay.textContent = "";
    modeInstruction.textContent = "";
  }

  async function showAndRecord(idx) {
    wordIndexEl.textContent = idx + 1;
    const wordId = words[idx];
    // Japanese is stored as "kanji|reading"; getCanonical returns kanji only.
    const text = getCanonical(wordId, lang);
    wordDisplay.textContent = text;
    uploadStatus.textContent = "";
    currentBlob = null;

    // Developer mode skips TTS (600 words → too slow) but still plays the
    // reference audio file when one exists for this language.
    const devFileOnly = mode === "full";
    const hasPrompt   = mode !== "full" || !!REFERENCE_AUDIO[lang];

    if (!hasPrompt) {
      startRecording();
    } else if (headphoneMode === "with") {
      // Record while the prompt plays.
      startRecording();
      await new Promise(r => setTimeout(r, WORD_SHOW_MS));
      playWordAudio(wordId, text, lang, devFileOnly);   // fire-and-forget
    } else {
      // Wait for the prompt to finish, then start recording.
      await new Promise(r => setTimeout(r, WORD_SHOW_MS));
      await playWordAudio(wordId, text, lang, devFileOnly);
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
      blankWord();
      const delay = new Promise(r => setTimeout(r, LEAD_IN_MS));
      await ensureStopped();
      if (!currentBlob) {
        await delay;
        await showAndRecord(currentIdx);
        return;
      }
      const wordId   = words[currentIdx];
      // Speaker is already in the folder path; filename only carries the word.
      // Developer mode appends the canonical word so reviewers can read filenames at a glance.
      const fileName = mode === "full"
        ? `${wordId}_${getCanonical(wordId, lang)}.wav`
        : `${wordId}.wav`;
      const saveWork = (async () => {
        const wavBuffer = await blobToWav(currentBlob);
        if (HAS_FSA && saveDirHandle) {
          await saveLocalFSA(fileName, wavBuffer);
          uploadStatus.textContent = `Saved: ${fileName}`;
        } else {
          await queueForZip(fileName, wavBuffer);
          uploadStatus.textContent = `Saved: ${fileName} (cached in browser; ZIP downloads at end).`;
        }
      })();
      await Promise.all([saveWork, delay]);
      currentIdx++;
      if (currentIdx >= words.length) {
        if (ZIP_FALLBACK && fallbackZipEntries.size) {
          uploadStatus.textContent = "Preparing ZIP…";
          try { await buildSessionZip(); }
          catch (e) {
            alert("Could not build ZIP: " + e.message);
            uploadStatus.textContent = "";
            return;
          }
        }
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

  // ----- Fullscreen -----
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  async function toggleFullscreen() {
    try {
      if (!isFullscreen()) {
        const el = document.documentElement;
        const req = el.requestFullscreen || el.webkitRequestFullscreen;
        if (req) await req.call(el);
      } else {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) await exit.call(document);
      }
    } catch { /* user-gesture or permission errors */ }
  }

  function updateFullscreenBtnLabel() {
    if (!fullscreenBtn) return;
    fullscreenBtn.textContent = isFullscreen() ? "Exit fullscreen" : "Fullscreen";
  }

  fullscreenBtn?.addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", updateFullscreenBtnLabel);
  document.addEventListener("webkitfullscreenchange", updateFullscreenBtnLabel);

  // ----- Keyboard shortcuts -----
  document.addEventListener("keydown", (e) => {
    if (recordingSection.classList.contains("hidden")) return;
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const k = e.key.toLowerCase();
    if (k === "x")                                 { e.preventDefault(); handleSaveAndNext(); }
    else if (k === "z")                            { e.preventDefault(); handleBack(); }
    else if (k === "c")                            { e.preventDefault(); handleReRecord(); }
    else if (k === "f")                            { e.preventDefault(); toggleFullscreen(); }
    else if (e.key === " " || e.code === "Space")  { e.preventDefault(); handleReplay(); }
  });

  // ----- Start session -----
  startBtn.addEventListener("click", async () => {
    lang          = languageSelect.value;
    safeSpeaker   = sanitize(speakerIdInput.value.trim());
    mode          = getSelectedMode();
    headphoneMode = getSelectedHeadphone();

    if (!safeSpeaker) {
      showError(setupError, "Speaker ID required (letters, digits, - or _)."); return;
    }
    hideError(setupError);

    if (ZIP_FALLBACK) {
      const pending = await idbFallbackFileCount();
      if (pending > 0) {
        showError(setupError,
          `This browser still has ${pending} recording(s) from a session that was not completed. ` +
          `Use "Download recovered ZIP" or "Discard" above, then start a new session.`);
        return;
      }
    }

    if (isDone(lang, safeSpeaker, mode)) {
      const label = mode === "full" ? "Developer" : "Default";
      showError(setupError,
        `${label} session for "${safeSpeaker}" (${LANGUAGES[lang]}) is already complete.`);
      return;
    }

    let rootHandle = null;
    rootFolderName = "";
    saveDirHandle  = null;
    fallbackZipEntries = new Map();
    lastUnloadZipBlob  = null;

    if (HAS_FSA) {
      try {
        rootHandle     = await window.showDirectoryPicker({ mode: "readwrite" });
        rootFolderName = rootHandle.name;
      } catch (e) {
        if (e.name === "AbortError") return;
        showError(setupError, "Could not open folder: " + e.message); return;
      }
    }

    words = getSessionWords(lang, mode);

    if (rootHandle) {
      try {
        saveDirHandle = await rootHandle.getDirectoryHandle(safeSpeaker, { create: true });
      } catch (e) {
        showError(setupError, "Could not create session folder: " + e.message); return;
      }
    }

    try {
      // Speech-research recordings: keep raw audio. Browsers default these
      // processors ON for video-call use, but they can attenuate the speaker's
      // voice when it overlaps the reference prompt (echoCancellation in
      // particular over-cancels). Turn them all off for a clean signal.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch {
      showError(setupError, "Microphone access denied. Please allow microphone and try again.");
      return;
    }

    if (ZIP_FALLBACK) {
      try { await idbClearAllFallback(); }
      catch (e) {
        closeStream();
        showError(setupError, "Could not back up to browser storage: " + e.message);
        return;
      }
    }

    wordTotalEl.textContent = words.length;
    setupSection.classList.add("hidden");
    recordingSection.classList.remove("hidden");
    sessionIdLabel.textContent = `${safeSpeaker} · ${LANGUAGES[lang]}`;
    saveFolderNote.textContent = HAS_FSA && saveDirHandle
      ? `Saving to: ${rootFolderName}/${safeSpeaker}/`
      : `Each take is backed up in this browser. If you close this tab mid-session, we try to download a partial ZIP. The final ZIP downloads when you finish all words.`;

    if (saveZipNowBtn) saveZipNowBtn.classList.toggle("hidden", !ZIP_FALLBACK);

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
    cancelTTS();
    closeStream();

    recordingSection.classList.add("hidden");
    doneSection.classList.remove("hidden");

    doneFolderEl.textContent = HAS_FSA && saveDirHandle
      ? `${rootFolderName}/${safeSpeaker}/`
      : "your Downloads folder (open the ZIP to find the speaker folder).";

    markDone(lang, safeSpeaker, mode);
    const label = mode === "full" ? "developer" : "default";
    doneTitle.textContent  = "All done!";
    doneDetail.textContent =
      `${words.length}-word ${label} session for "${safeSpeaker}" (${LANGUAGES[lang]}) is complete.`;
  }

  // ----- Recovery banner (Safari/Firefox only): if pending IDB takes from
  // an interrupted previous session exist, prompt to download or discard.
  (async function initRecoveryUi() {
    if (!ZIP_FALLBACK || !recoveryBox) return;
    try {
      const n = await idbFallbackFileCount();
      if (n > 0 && recoveryTextEl) {
        recoveryTextEl.textContent =
          `We found ${n} saved take(s) in this browser from a session that did not finish (tab closed, refresh, or crash). ` +
          `Download a ZIP or discard.`;
        recoveryBox.classList.remove("hidden");
      }
    } catch { /* IDB may be unavailable in private mode */ }
  })();

  saveZipNowBtn?.addEventListener("click", () => {
    exportProgressZip().catch(e => { alert("Could not save progress: " + e.message); });
  });

  recoveryDownloadBtn?.addEventListener("click", async () => {
    try {
      recoveryDownloadBtn.disabled = true;
      const map  = await idbMapFromFallbackStore();
      if (map.size === 0) { recoveryBox?.classList.add("hidden"); return; }
      const meta = await idbGetFallbackMeta();
      const blob = await zipBlobFromMap(map);
      if (blob) {
        downloadBlob(blob, zipNameFor({ recovered: true, meta }));
        await idbClearAllFallback();
        if (recoveryTextEl) recoveryTextEl.textContent =
          "Recovered ZIP downloaded. Temporary audio cache in this browser has been cleared.";
        setTimeout(() => recoveryBox?.classList.add("hidden"), 2500);
      }
    } catch (e) {
      alert("Recovery download failed: " + e.message);
    } finally {
      recoveryDownloadBtn.disabled = false;
    }
  });

  recoveryDiscardBtn?.addEventListener("click", async () => {
    try {
      await idbClearAllFallback();
      if (recoveryTextEl) recoveryTextEl.textContent =
        "Discarded. Temporary audio cache in this browser has been cleared.";
      setTimeout(() => recoveryBox?.classList.add("hidden"), 2500);
    } catch (e) {
      alert("Could not discard: " + e.message);
    }
  });

  // ----- Privacy tools (Safari/Firefox only): manual cache wipe between
  // patients on shared clinical devices, with current count visible. -----
  async function refreshPrivacyToolsVisibility() {
    if (!privacyTools) return;
    if (HAS_FSA) { privacyTools.classList.add("hidden"); return; }
    const n = await idbFallbackFileCount();
    privacyTools.classList.remove("hidden");
    if (clearLocalDataBtn) {
      clearLocalDataBtn.textContent = n > 0
        ? `Clear all cached audio in this browser (${n} file${n === 1 ? "" : "s"})`
        : "Clear all cached audio in this browser";
    }
  }
  refreshPrivacyToolsVisibility();

  clearLocalDataBtn?.addEventListener("click", async () => {
    if (!confirm("Erase all temporary audio stored in this browser? This cannot be undone.")) return;
    try {
      await idbClearAllFallback();
      fallbackZipEntries = new Map();
      lastUnloadZipBlob  = null;
      if (clearLocalDataStatus) clearLocalDataStatus.textContent = " ✓ Cleared.";
      recoveryBox?.classList.add("hidden");
      await refreshPrivacyToolsVisibility();
    } catch (e) {
      alert("Could not clear: " + e.message);
    }
  });

  // Best-effort partial-ZIP download when the user closes/reloads the tab
  // mid-session (Safari/Firefox only). IDB still has the takes either way.
  window.addEventListener("pagehide", (e) => {
    if (!ZIP_FALLBACK) return;
    if (e.persisted) return;        // bfcache; do not duplicate a download
    tryDownloadInterruptSnapshotZip();
  });
})();
