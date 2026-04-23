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
 *
 * Chrome / Edge (File System Access API, HAS_FSA): unchanged behavior — directory
 * picker, `saveLocalFSA` for each take, `handles` in IndexedDB for the last chosen
 * folder. No in-memory ZIP queue, no per-WAV `fbFiles` / recovery UI / partial ZIP.
 *
 * Safari / Firefox (and any browser without a folder picker): all ZIP, IndexedDB
 * per-take backup, recovery UI, and interrupt `pagehide` download — see `ZIP_FALLBACK` only.
 */

(function () {
  "use strict";

  const HAS_FSA = typeof window.showDirectoryPicker === "function";
  /** `true` only in Safari, Firefox, etc. (no File System Access API). All ZIP+IDB+recovery+interrupt code is behind this, not in Chrome. */
  const ZIP_FALLBACK = !HAS_FSA;
  const LEAD_IN_MS = 500;  // silence gap after press; word shown + recording starts together
  const WORD_SHOW_MS = 250;  // delay after showing the word before TTS starts, so the word lands first
  const SAVE_FOLDER_NAME = "CHMIT";  // default subfolder created inside the user-picked location
  /** Only when `ZIP_FALLBACK`: in-memory list for the final ZIP. */
  let fallbackZipEntries = new Map();
  /** Only when `ZIP_FALLBACK`: last built ZIP for `pagehide` interrupt download. */
  let lastUnloadZipBlob = null;

  // ----- IndexedDB: (1) save folder handle (Chrome/Edge) (2) Safari/FF only: per-
  // take WAVs + metadata for recovery before the final ZIP.
  const IDB_NAME = "chmit";
  const IDB_VERSION = 2;
  const IDB_STORE = "handles";
  const IDB_KEY = "saveRoot";
  const FB_FILES = "fbFiles";
  const FB_META  = "fbMeta";
  const FB_KEY_META = "meta";

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = (ev) => {
        const db = ev.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
        if (ev.oldVersion < 2) {
          if (!db.objectStoreNames.contains(FB_FILES)) db.createObjectStore(FB_FILES);
          if (!db.objectStoreNames.contains(FB_META))  db.createObjectStore(FB_META);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }
  async function idbGet(key) {
    try {
      const db = await idbOpen();
      return await new Promise((resolve, reject) => {
        const req = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
      });
    } catch { return null; }
  }
  async function idbSet(key, value) {
    try {
      const db = await idbOpen();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror    = () => reject(tx.error);
      });
    } catch {}
  }
  async function idbDel(key) {
    try {
      const db = await idbOpen();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror    = () => reject(tx.error);
      });
    } catch {}
  }

  async function idbFallbackFileCount() {
    if (!ZIP_FALLBACK) return 0; // Chrome/Edge only; never touch fbFiles.
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
      const st = tx.objectStore(FB_FILES);
      const req = st.openCursor();
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

  function makePartLabelForMeta() {
    if (mode === "default") return "default";
    return `sub${String(subsection).padStart(2, "0")}`;
  }

  function makeFallbackMetaObject(fileCount) {
    return {
      v: 1,
      lang, mode, subsection, safeSpeaker, sessionId,
      part: makePartLabelForMeta(),
      fileCount,
      updatedAt: Date.now(),
    };
  }

  /**
   * After each queued WAV, persist a copy in IndexedDB so a crash/refresh
   * does not lose completed takes (Safari / Firefox fallback).
   */
  async function idbAppendFallbackWav(relativePath, arrayBuffer) {
    if (!ZIP_FALLBACK) return;
    const db = await idbOpen();
    const meta = makeFallbackMetaObject(fallbackZipEntries.size);
    await new Promise((resolve, reject) => {
      const tx = db.transaction([FB_FILES, FB_META], "readwrite");
      tx.objectStore(FB_FILES).put(arrayBuffer, relativePath);
      tx.objectStore(FB_META).put(meta, FB_KEY_META);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  }

  function zipNameFromState({ recovered = false, partial = false, stamp = 0 } = {}) {
    const pl = makePartLabelForMeta();
    const base = `${SAVE_FOLDER_NAME}_${lang}_${safeSpeaker}_${pl}`;
    if (recovered) return `${base}_RECOVERED.zip`;
    if (partial)  return `${base}_partial-${stamp || Date.now()}.zip`;
    return `${base}.zip`;
  }

  function zipNameFromRecoveredMeta(meta) {
    if (meta && meta.lang && meta.safeSpeaker && meta.part) {
      return `${SAVE_FOLDER_NAME}_${meta.lang}_${meta.safeSpeaker}_${meta.part}_RECOVERED.zip`;
    }
    return `${SAVE_FOLDER_NAME}_RECOVERED_${Date.now()}.zip`;
  }

  async function zipBlobFromMap(map) {
    const JSZip = window.JSZip;
    if (!JSZip) throw new Error("JSZip not loaded (check static/js/vendor/jszip.min.js).");
    if (map.size === 0) return null;
    const zip = new JSZip();
    for (const [p, ab] of map) zip.file(p, ab);
    return zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  }

  /**
   * Refreshes the in-memory copy used when the user leaves the tab (Safari/FF). Does not
   * download. Chrome: no-op. If a save just finished, the very next `pagehide` can still
   * miss a race if the tab closes before this async work completes — IndexedDB still has.
   */
  async function refreshUnloadZipBlob() {
    if (!ZIP_FALLBACK) return;
    if (fallbackZipEntries.size === 0) {
      lastUnloadZipBlob = null;
      return;
    }
    try {
      lastUnloadZipBlob = await zipBlobFromMap(fallbackZipEntries);
    } catch {
      // leave lastUnloadZipBlob as previous value, or null
    }
  }

  /**
   * New Safari/FF session: clear any leftover rows (safe when recovery was cleared or consumed).
   */
  async function idbBeginNewZipSession() {
    if (!ZIP_FALLBACK) return;
    await idbClearAllFallback();
  }

  async function verifyPermission(handle) {
    const opts = { mode: "readwrite" };
    if ((await handle.queryPermission(opts)) === "granted")   return true;
    if ((await handle.requestPermission(opts)) === "granted") return true;
    return false;
  }

  // Chrome blocks picking well-known folders (Downloads, Desktop, home, …)
  // directly, so the user must pick a regular subfolder. If they pick a
  // folder already named CHMIT, use it as-is; otherwise try to create a
  // CHMIT subfolder inside. Falls back to the picked folder if creating
  // a subfolder isn't allowed.
  async function pickSaveRoot() {
    const picked = await window.showDirectoryPicker({
      mode: "readwrite",
      startIn: "downloads",
    });
    if (picked.name === SAVE_FOLDER_NAME) return picked;
    try {
      return await picked.getDirectoryHandle(SAVE_FOLDER_NAME, { create: true });
    } catch {
      return picked;
    }
  }

  // Use the stored handle if still granted; otherwise prompt the picker.
  async function resolveSaveRoot({ forcePicker = false } = {}) {
    if (!forcePicker) {
      const stored = await idbGet(IDB_KEY);
      if (stored && await verifyPermission(stored)) return stored;
    }
    const handle = await pickSaveRoot();
    await idbSet(IDB_KEY, handle);
    return handle;
  }

  // Map our language codes to BCP-47 tags for speechSynthesis.
  const TTS_LANG = {
    en: "en-US", ko: "ko-KR", fr: "fr-FR", de: "de-DE", es: "es-ES",
    fi: "fi-FI", sv: "sv-SE", et: "et-EE", da: "da-DK",
    hi: "hi-IN", ru: "ru-RU", ar: "ar-SA",
  };

  // ----- sessionStorage helpers (cleared when the browser/tab closes, so
  // the same speaker can re-record after reopening; matters on shared
  // clinical devices where a persistent "already complete" flag would
  // wrongly block new sessions). -----
  const sessionStore = window.sessionStorage;
  function storageKey(lang, speaker)      { return `sub_${lang}_${speaker}`; }
  function defaultSubKey(lang, speaker)   { return `defaultSub_${lang}_${speaker}`; }
  function defaultDoneKey(lang, speaker)  { return `defaultDone_${lang}_${speaker}`; }

  function getCurrentSubsection(lang, speaker) {
    return parseInt(sessionStore.getItem(storageKey(lang, speaker)) || "1", 10);
  }

  function saveNextSubsection(lang, speaker, current) {
    const next = current + 1;
    if (next > getLangConfig(lang).numSubsections) {
      sessionStore.removeItem(storageKey(lang, speaker));
    } else {
      sessionStore.setItem(storageKey(lang, speaker), String(next));
    }
  }

  function getDefaultSubsection(lang, speaker) {
    const stored = parseInt(sessionStore.getItem(defaultSubKey(lang, speaker)) || "0", 10);
    if (stored >= 1 && stored <= getLangConfig(lang).numSubsections) return stored;
    const n = getLangConfig(lang).numSubsections;
    const picked = Math.floor(Math.random() * n) + 1;
    sessionStore.setItem(defaultSubKey(lang, speaker), String(picked));
    return picked;
  }

  function isDefaultDone(lang, speaker) {
    return sessionStore.getItem(defaultDoneKey(lang, speaker)) === "1";
  }

  function markDefaultDone(lang, speaker) {
    sessionStore.setItem(defaultDoneKey(lang, speaker), "1");
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
  const zipFallbackHint  = document.getElementById("zip-fallback-hint");
  if (ZIP_FALLBACK && zipFallbackHint) zipFallbackHint.classList.remove("hidden");
  const previewAudio     = document.getElementById("preview-audio");
  const uploadStatus     = document.getElementById("upload-status");

  const doneSection    = document.getElementById("done-section");
  const doneTitle      = document.getElementById("done-title");
  const doneDetail     = document.getElementById("done-detail");
  const doneFolderEl   = document.getElementById("done-folder");
  const nextSessionBtn = document.getElementById("next-session-btn");

  const saveFolderRow     = document.getElementById("save-folder-row");
  const saveFolderDisplay = document.getElementById("save-folder-display");
  const changeFolderBtn   = document.getElementById("change-folder-btn");
  const chromeFolderHint  = document.getElementById("chrome-folder-hint");
  if (HAS_FSA && chromeFolderHint) chromeFolderHint.classList.remove("hidden");
  const saveZipNowBtn     = document.getElementById("save-zip-now-btn");
  const recoveryBox       = document.getElementById("fallback-recovery");
  const recoveryTextEl    = document.getElementById("fallback-recovery-text");
  const recoveryDownloadBtn = document.getElementById("fallback-recovery-download");
  const recoveryDiscardBtn  = document.getElementById("fallback-recovery-discard");
  const privacyTools        = document.getElementById("privacy-tools");
  const clearLocalDataBtn   = document.getElementById("clear-local-data-btn");
  const clearLocalDataStatus = document.getElementById("clear-local-data-status");

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
      const synth = window.speechSynthesis;
      const needCancel = synth.speaking || synth.pending;
      if (needCancel) synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = TTS_LANG[langCode] || langCode;
      u.rate = 0.9;
      u.onend   = () => resolve();
      u.onerror = () => resolve();
      // Chrome has a long-standing bug where speak() called immediately after
      // cancel() is silently dropped; a tiny delay avoids it. If nothing was
      // speaking, we can speak straight away.
      if (needCancel) setTimeout(() => synth.speak(u), 60);
      else            synth.speak(u);
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

  // ----- Save-folder UI -----
  function updateSaveFolderDisplay(handle) {
    if (!saveFolderDisplay) return;
    if (handle) {
      saveFolderDisplay.textContent = `Saving to: ${handle.name}/`;
    } else {
      saveFolderDisplay.textContent = `Default: ~/Downloads/${SAVE_FOLDER_NAME}/ (chosen on first start)`;
    }
  }

  (async function initSaveFolderDisplay() {
    if (ZIP_FALLBACK) {
      if (saveFolderRow) saveFolderRow.classList.add("hidden");
      return;
    }
    const stored = await idbGet(IDB_KEY);
    // Show the remembered folder name without prompting for permission here;
    // permission will be re-confirmed when the user clicks Start Session.
    updateSaveFolderDisplay(stored || null);
  })();

  if (changeFolderBtn) {
    changeFolderBtn.addEventListener("click", async () => {
      try {
        const handle = await resolveSaveRoot({ forcePicker: true });
        updateSaveFolderDisplay(handle);
      } catch (e) {
        if (e.name !== "AbortError") {
          showError(setupError, "Could not change folder: " + e.message);
        }
      }
    });
  }

  async function saveLocalFSA(fileName, arrayBuffer) {
    const fh = await saveDirHandle.getFileHandle(fileName, { create: true });
    const wr = await fh.createWritable();
    await wr.write(arrayBuffer);
    await wr.close();
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement("a");
    a.href = url; a.download = fileName; a.click();
    URL.revokeObjectURL(url);
  }

  /** Path inside the session ZIP, mirroring the on-disk FSA layout under CHMIT/. */
  function zipPathForWav(fileName) {
    const rel = [SAVE_FOLDER_NAME, sessionId, fileName].join("/")
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean)
      .join("/");
    return rel;
  }

  async function queueForZip(fileName, arrayBuffer) {
    const p = zipPathForWav(fileName);
    fallbackZipEntries.set(p, arrayBuffer);
    if (ZIP_FALLBACK) {
      await idbAppendFallbackWav(p, arrayBuffer);
      void refreshUnloadZipBlob().catch(() => {});
    }
  }

  function tryDownloadInterruptSnapshotZip() {
    if (!ZIP_FALLBACK) return;
    if (!lastUnloadZipBlob || fallbackZipEntries.size === 0) return;
    try {
      downloadBlob(
        lastUnloadZipBlob,
        zipNameFromState({ partial: true, stamp: "interrupt-" + Date.now() })
      );
    } catch { /* e.g. popup policy */ }
  }

  async function buildSessionZip() {
    if (!ZIP_FALLBACK) return; // End-of-session ZIP for Safari/FF only; Chrome uses disk.
    const blob = await zipBlobFromMap(fallbackZipEntries);
    if (!blob) return;
    downloadBlob(blob, zipNameFromState());
    fallbackZipEntries = new Map();
    lastUnloadZipBlob = null;
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
      downloadBlob(blob, zipNameFromState({ partial: true }));
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
          // Chrome/Edge: write WAV directly; same as before (no in-memory zip queue or per-take IDB in this path).
          await saveLocalFSA(fileName, wavBuffer);
          uploadStatus.textContent = `Saved: ${fileName}`;
        } else {
          await queueForZip(fileName, wavBuffer);
          uploadStatus.textContent =
            "Saved: " + fileName + ".";
        }
      })();
      await Promise.all([saveWork, delay]);                   // silence covers save
      currentIdx++;
      if (currentIdx >= words.length) {
        if (ZIP_FALLBACK && fallbackZipEntries.size) {
          uploadStatus.textContent = "Preparing ZIP…";
          try {
            await buildSessionZip();
          } catch (e) {
            alert("Could not build ZIP: " + e.message);
            uploadStatus.textContent = "";
            busy = false;
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
  const fullscreenBtn = document.getElementById("fullscreen-btn");

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
    } catch {
      // user-gesture or permission errors — silently ignore
    }
  }

  function updateFullscreenBtnLabel() {
    if (!fullscreenBtn) return;
    fullscreenBtn.textContent = isFullscreen() ? "Exit fullscreen" : "Fullscreen";
  }

  if (fullscreenBtn) fullscreenBtn.addEventListener("click", toggleFullscreen);
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
    speakerId     = speakerIdInput.value.trim();
    safeSpeaker   = sanitize(speakerId);
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
          "This browser still has " + pending + " recording(s) from a session that was not completed. " +
          "Use “Download recovered ZIP” or “Discard” above, then start a new session.");
        return;
      }
    }

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
    fallbackZipEntries = new Map();
    lastUnloadZipBlob = null;

    if (HAS_FSA) {
      try {
        // Always prompt for the save folder on Start Session. This makes the
        // participant/session boundary explicit for the researcher and avoids
        // silently writing into a folder from a previous patient.
        rootHandle     = await resolveSaveRoot({ forcePicker: true });
        rootFolderName = rootHandle.name;
        updateSaveFolderDisplay(rootHandle);
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
      // Warn if a folder for this speaker already exists — typically means the
      // researcher reused a Speaker ID by accident. Check before creating so
      // the user can cancel cleanly.
      let speakerFolderExists = false;
      try {
        await rootHandle.getDirectoryHandle(safeSpeaker, { create: false });
        speakerFolderExists = true;
      } catch (e) {
        if (e.name !== "NotFoundError" && e.name !== "TypeMismatchError") {
          console.warn("Speaker folder existence check failed:", e);
        }
      }
      if (speakerFolderExists) {
        const msg =
          `A folder named "${safeSpeaker}" already exists in:\n` +
          `${rootFolderName}/\n\n` +
          `Continuing may overwrite existing recordings with the same filename.\n\n` +
          `Continue anyway?`;
        if (!confirm(msg)) {
          showError(setupError,
            `Cancelled. Change the Speaker ID or move the existing "${safeSpeaker}" folder before starting.`);
          return;
        }
      }

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

    if (ZIP_FALLBACK) {
      try {
        await idbBeginNewZipSession();
      } catch (e) {
        stream.getTracks().forEach(t => t.stop());
        stream = null;
        showError(setupError, "Could not back up to browser storage: " + e.message);
        return;
      }
    }

    wordTotalEl.textContent = words.length;
    setupSection.classList.add("hidden");
    recordingSection.classList.remove("hidden");
    sessionIdLabel.textContent = mode === "default"
      ? `${safeSpeaker} · ${LANGUAGES[lang]}`
      : `${safeSpeaker} · ${LANGUAGES[lang]} · ${subLabel} (${subsection}/${NUM_SUBSECTIONS})`;
    // Top-of-session label: only the concrete save path for FSA browsers;
    // Safari/FF get nothing here (the ZIP-flow explanation already lives on
    // the setup page, next to the Mode selector).
    saveFolderNote.textContent = HAS_FSA && saveDirHandle
      ? `Saving to: ${rootFolderName}/${sessionId}/`
      : "";

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
    const { numSubsections } = getLangConfig(lang);
    cancelTTS();
    closeStream();

    recordingSection.classList.add("hidden");
    doneSection.classList.remove("hidden");

    doneFolderEl.textContent = HAS_FSA && saveDirHandle
      ? `${rootFolderName}/${sessionId}/`
      : "your Downloads folder — unzip the CHMIT_… .zip; inside you’ll see CHMIT/…/ with the same folder layout as a direct save.";

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

  (async function initRecoveryUi() {
    if (!ZIP_FALLBACK || !recoveryBox) return;
    try {
      const n = await idbFallbackFileCount();
      if (n > 0 && recoveryTextEl) {
        recoveryTextEl.textContent =
          "We found " + n + " saved take(s) in this browser from a session that did not finish (tab closed, refresh, or crash). " +
          "Download a ZIP (same CHMIT/… layout as a completed session) or discard.";
        recoveryBox.classList.remove("hidden");
      }
    } catch { /* IDB may be unavailable in private mode with strict settings */ }
  })();

  if (saveZipNowBtn) {
    saveZipNowBtn.addEventListener("click", () => {
      exportProgressZip().catch(e => { alert("Could not save progress: " + e.message); });
    });
  }
  if (recoveryDownloadBtn) {
    recoveryDownloadBtn.addEventListener("click", async () => {
      try {
        recoveryDownloadBtn.disabled = true;
        const map = await idbMapFromFallbackStore();
        if (map.size === 0) { recoveryBox?.classList.add("hidden"); return; }
        const meta    = await idbGetFallbackMeta();
        const blob    = await zipBlobFromMap(map);
        if (blob) {
          downloadBlob(blob, zipNameFromRecoveredMeta(meta));
          await idbClearAllFallback();
          recoveryBox?.classList.add("hidden");
          if (recoveryTextEl) {
            recoveryTextEl.textContent = "Recovered ZIP downloaded. Temporary audio cache in this browser has been cleared.";
            recoveryBox?.classList.remove("hidden");
          }
        }
      } catch (e) {
        alert("Recovery download failed: " + e.message);
      } finally {
        recoveryDownloadBtn.disabled = false;
      }
    });
  }
  if (recoveryDiscardBtn) {
    recoveryDiscardBtn.addEventListener("click", async () => {
      try {
        await idbClearAllFallback();
        if (recoveryTextEl) {
          recoveryTextEl.textContent = "Discarded. Temporary audio cache in this browser has been cleared.";
        }
        // Keep the banner visible briefly so the user can see the confirmation.
        setTimeout(() => recoveryBox?.classList.add("hidden"), 2500);
      } catch (e) {
        alert("Could not discard: " + e.message);
      }
    });
  }

  // ----- Manual "Clear all cached audio" control (Safari/FF only).
  // Lets a researcher wipe between patients without waiting for a session
  // to complete. On Chrome the temporary cache doesn't exist, so hide it.
  async function refreshPrivacyToolsVisibility() {
    if (!privacyTools) return;
    if (HAS_FSA) { privacyTools.classList.add("hidden"); return; }
    const n = await idbFallbackFileCount();
    // Always visible on Safari/FF — shows count when non-zero, otherwise
    // still provides a way for cautious researchers to confirm 0 cached.
    privacyTools.classList.remove("hidden");
    if (clearLocalDataBtn) {
      clearLocalDataBtn.textContent = n > 0
        ? `Clear all cached audio in this browser (${n} file${n === 1 ? "" : "s"})`
        : "Clear all cached audio in this browser";
    }
  }
  refreshPrivacyToolsVisibility();

  if (clearLocalDataBtn) {
    clearLocalDataBtn.addEventListener("click", async () => {
      if (!confirm("Erase all temporary audio stored in this browser? This cannot be undone.")) return;
      try {
        await idbClearAllFallback();
        fallbackZipEntries = new Map();
        lastUnloadZipBlob = null;
        if (clearLocalDataStatus) {
          clearLocalDataStatus.textContent = " ✓ Cleared.";
        }
        if (recoveryBox) recoveryBox.classList.add("hidden");
        await refreshPrivacyToolsVisibility();
      } catch (e) {
        alert("Could not clear: " + e.message);
      }
    });
  }

  // Safari / Firefox: immediate ZIP on leave. Chrome: ZIP_FALLBACK is false, no-op.
  window.addEventListener("pagehide", (e) => {
    if (!ZIP_FALLBACK) return;
    if (e.persisted) return; // bfcache; do not duplicate a download
    tryDownloadInterruptSnapshotZip();
  });
})();
