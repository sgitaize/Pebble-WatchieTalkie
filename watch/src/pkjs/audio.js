/*
 * Sprachnachrichten: Mikrofon der Uhr (16 kHz, 16 Bit) → 8 kHz → IMA-ADPCM (4 Bit je Abtastwert = 4000 Byte/s).
 * Die Uhr dekodiert dasselbe Format beim Abspielen (main.c: adpcm_decode). Format der Audiodaten (vor der Verschlüsselung):
 *   Byte 0 = 1 (Version: IMA-ADPCM, 8 kHz, mono, Startwert 0 / Index 0, unteres Halbbyte zuerst), danach die ADPCM-Bytes.
 */
var RATE = 8000;
var STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
  130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282,
  1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493,
  10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
var IDX = [-1, -1, -1, -1, 2, 4, 6, 8];

/* Aufnahme: sammelt die Blöcke vom Mikrofon, rechnet sie auf 8 kHz herunter (1-2-1-Tiefpass, jeder zweite Wert) */
function Recorder(rate, maxSec) {
  this.step = Math.max(1, Math.round((rate || 16000) / RATE));
  this.parts = []; this.len = 0; this.max = maxSec * RATE; this.prev = 0; this.phase = 0;
}
Recorder.prototype.push = function (buf) {
  var v = new DataView(buf), n = Math.floor(buf.byteLength / 2), out = new Int16Array(Math.ceil(n / this.step) + 1), o = 0;
  for (var i = 0; i < n && this.len + o < this.max; i++) {
    var x = v.getInt16(i * 2, true);
    if (this.step === 2) {                     // y = (x[-1] + 2·x[0] + x[+1]) / 4, bei jedem zweiten Wert
      if (this.phase) out[o++] = (this.prev + 2 * this.mid + x) >> 2;
      else this.mid = x;
      if (this.phase) this.prev = x;
      this.phase ^= 1;
    } else if ((this.phase = (this.phase + 1) % this.step) === 0) out[o++] = x;
  }
  if (o) { this.parts.push(out.subarray(0, o)); this.len += o; }
};
Recorder.prototype.seconds = function () { return this.len / RATE; };
/* Fertig: Lautstärke angleichen (Spitze → 90 %, höchstens 8-fach) und kodieren → Uint8Array (mit Versionsbyte) */
Recorder.prototype.finish = function () {
  var pcm = new Int16Array(this.len), o = 0, peak = 1, i;
  for (i = 0; i < this.parts.length; i++) { pcm.set(this.parts[i], o); o += this.parts[i].length; }
  for (i = 0; i < pcm.length; i++) { var a = pcm[i] < 0 ? -pcm[i] : pcm[i]; if (a > peak) peak = a; }
  var gain = Math.min(8, 29490 / peak);
  if (gain > 1.05) for (i = 0; i < pcm.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * gain)));
  return encode(pcm);
};

function encode(pcm) {
  var out = new Uint8Array(1 + Math.ceil(pcm.length / 2)), pred = 0, idx = 0;
  out[0] = 1;
  for (var i = 0; i < pcm.length; i++) {
    var step = STEP[idx], diff = pcm[i] - pred, code = 0;
    if (diff < 0) { code = 8; diff = -diff; }
    var dq = step >> 3;
    if (diff >= step) { code |= 4; diff -= step; dq += step; }
    step >>= 1;
    if (diff >= step) { code |= 2; diff -= step; dq += step; }
    step >>= 1;
    if (diff >= step) { code |= 1; dq += step; }
    pred += code & 8 ? -dq : dq;
    if (pred > 32767) pred = 32767; else if (pred < -32768) pred = -32768;
    idx += IDX[code & 7];
    if (idx < 0) idx = 0; else if (idx > 88) idx = 88;
    if (i & 1) out[1 + (i >> 1)] |= code << 4; else out[1 + (i >> 1)] = code;
  }
  return out;
}
/* Nur für Tests: ADPCM (ohne Versionsbyte) → Int16Array, gleiche Rechnung wie auf der Uhr */
function decode(bytes) {
  var out = new Int16Array(bytes.length * 2), pred = 0, idx = 0;
  for (var i = 0; i < out.length; i++) {
    var code = i & 1 ? bytes[i >> 1] >> 4 : bytes[i >> 1] & 15, step = STEP[idx], dq = step >> 3;
    if (code & 4) dq += step;
    if (code & 2) dq += step >> 1;
    if (code & 1) dq += step >> 2;
    pred += code & 8 ? -dq : dq;
    if (pred > 32767) pred = 32767; else if (pred < -32768) pred = -32768;
    idx += IDX[code & 7];
    if (idx < 0) idx = 0; else if (idx > 88) idx = 88;
    out[i] = pred;
  }
  return out;
}
/* Dauer in Zehntelsekunden aus der Größe der verschlüsselten Daten (Nonce 24 + MAC 16 + Versionsbyte) */
function durationDs(encBytes) { return Math.max(1, Math.round((encBytes - 41) * 2 / RATE * 10)); }
function fmt(ds) { var s = Math.max(1, Math.round(ds / 10)); return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + s % 60; }

module.exports = { Recorder: Recorder, encode: encode, decode: decode, durationDs: durationDs, fmt: fmt, RATE: RATE };
