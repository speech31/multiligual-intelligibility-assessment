/**
 * audio.js — Browser-side WAV encoding using Web Audio API.
 * No server required. Works in Chrome, Edge, Firefox, Safari.
 *
 * blobToWav(blob, targetSampleRate?)
 *   Decodes a MediaRecorder blob (webm/ogg) and returns a 16-bit mono WAV ArrayBuffer.
 */

const WAV_SAMPLE_RATE = 16000;  // 16 kHz mono, standard for speech research

/**
 * Convert a MediaRecorder Blob to a 16kHz mono WAV ArrayBuffer.
 * Uses AudioContext to decode the compressed audio, then OfflineAudioContext
 * to resample to the target rate and mix down to mono.
 */
async function blobToWav(blob, targetSampleRate = WAV_SAMPLE_RATE) {
  const arrayBuffer = await blob.arrayBuffer();

  // Decode compressed audio at its native sample rate
  const decodeCtx  = new AudioContext();
  const audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
  await decodeCtx.close();

  // Resample + mix down to mono via OfflineAudioContext
  const numFrames   = Math.ceil(audioBuffer.duration * targetSampleRate);
  const offlineCtx  = new OfflineAudioContext(1, numFrames, targetSampleRate);
  const source      = offlineCtx.createBufferSource();
  source.buffer     = audioBuffer;
  source.connect(offlineCtx.destination);
  source.start(0);
  const resampled   = await offlineCtx.startRendering();

  return encodeWav(resampled.getChannelData(0), targetSampleRate);
}

/**
 * Encode Float32Array PCM samples as a 16-bit PCM WAV ArrayBuffer.
 */
function encodeWav(samples, sampleRate) {
  const dataBytes  = samples.length * 2;           // 16-bit = 2 bytes per sample
  const buffer     = new ArrayBuffer(44 + dataBytes);
  const view       = new DataView(buffer);

  // RIFF chunk
  writeStr(view, 0,  "RIFF");
  view.setUint32(4,  36 + dataBytes, true);
  writeStr(view, 8,  "WAVE");

  // fmt sub-chunk
  writeStr(view, 12, "fmt ");
  view.setUint32(16, 16, true);             // sub-chunk size (PCM = 16)
  view.setUint16(20, 1,  true);             // PCM format
  view.setUint16(22, 1,  true);             // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (sampleRate × channels × bytesPerSample)
  view.setUint16(32, 2,  true);             // block align
  view.setUint16(34, 16, true);             // bits per sample

  // data sub-chunk
  writeStr(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  // PCM samples: clamp float32 [-1,1] → int16
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }

  return buffer;
}

function writeStr(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
