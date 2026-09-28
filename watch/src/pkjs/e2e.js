/*
 * Ende-zu-Ende-Verschlüsselung für WatchieTalkie2 (TweetNaCl, public domain).
 *
 * - Jedes Konto hat ein X25519-Schlüsselpaar; der geheime Schlüssel bleibt auf dem Handy (localStorage).
 * - Jede Nachricht: zufälliger Nachrichtenschlüssel K, Text mit secretbox(K) verschlüsselt,
 *   K für jeden Empfänger (auch sich selbst) mit box(Absender-Geheimschlüssel, Empfänger-Schlüssel) eingepackt.
 *   box authentifiziert den Absender – der Server kann weder mitlesen noch Nachrichten fälschen.
 * - Zufall: crypto.getRandomValues, falls vorhanden (Android). Die iOS-Umgebung hat keins; deshalb mischt ein
 *   SHA-512-Generator zusätzlich einen 32-Byte-Seed aus der Einstellungsseite (echter Browser-Zufall) mit Zähler ein.
 */
var nacl = require('./nacl-fast');

var store = null;                      // { get(k), set(k, v) } – localStorage oder Ersatz im Test
var counter = 0;

function b64enc(u8) {
  var abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', out = '', i;
  for (i = 0; i + 2 < u8.length; i += 3) {
    var n = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
    out += abc[n >> 18] + abc[(n >> 12) & 63] + abc[(n >> 6) & 63] + abc[n & 63];
  }
  if (i < u8.length) {
    var m = u8[i] << 16 | (i + 1 < u8.length ? u8[i + 1] << 8 : 0);
    out += abc[m >> 18] + abc[(m >> 12) & 63] + (i + 1 < u8.length ? abc[(m >> 6) & 63] : '=') + '=';
  }
  return out;
}
function b64dec(s) {
  var abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  s = String(s || '').replace(/=+$/, '');
  if (/[^A-Za-z0-9+/]/.test(s)) return null;
  var out = new Uint8Array(Math.floor(s.length * 3 / 4)), buf = 0, bits = 0, j = 0;
  for (var i = 0; i < s.length; i++) {
    buf = (buf << 6) | abc.indexOf(s[i]); bits += 6;
    if (bits >= 8) { bits -= 8; out[j++] = (buf >> bits) & 255; }
  }
  return out;
}
function utf8(s) {
  var b = unescape(encodeURIComponent(s)), u = new Uint8Array(b.length);
  for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
}
function fromUtf8(u) {
  var s = '';
  for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  try { return decodeURIComponent(escape(s)); } catch (e) { return null; }
}
function concat(list) {
  var len = 0, i; for (i = 0; i < list.length; i++) len += list[i].length;
  var out = new Uint8Array(len), o = 0;
  for (i = 0; i < list.length; i++) { out.set(list[i], o); o += list[i].length; }
  return out;
}
function num8(x) { var u = new Uint8Array(8); for (var i = 0; i < 8; i++) { u[i] = x % 256; x = Math.floor(x / 256); } return u; }

/* Zufallsgenerator: SHA-512(Seed ‖ Zähler ‖ Zeit ‖ Math.random ‖ Systemzufall) */
function randomBytes(n) {
  var seed = (store && b64dec(store.get('wt.seed') || '')) || new Uint8Array(0);
  var out = new Uint8Array(n), o = 0;
  while (o < n) {
    counter++;
    var sys = new Uint8Array(32);
    if (typeof crypto !== 'undefined' && crypto && crypto.getRandomValues) crypto.getRandomValues(sys);
    var mix = new Uint8Array(16);
    for (var i = 0; i < 16; i++) mix[i] = Math.floor(Math.random() * 256);
    var h = nacl.hash(concat([seed, num8(counter), num8(Date.now()), mix, sys]));
    var take = Math.min(32, n - o);             // nur die Hälfte des Hashes ausgeben
    out.set(h.subarray(0, take), o); o += take;
  }
  if (store) store.set('wt.ctr', String(counter));
  return out;
}
nacl.setPRNG(function (x, n) { var r = randomBytes(n); for (var i = 0; i < n; i++) x[i] = r[i]; });

function init(storage) {
  store = storage;
  counter = Number(store.get('wt.ctr')) || 0;
}
function secretKey() { var s = b64dec(store.get('wt.sk') || ''); return s && s.length === 32 ? s : null; }
function ready() { return !!secretKey() && !!store.get('wt.seed'); }
function publicKey() { var sk = secretKey(); return sk ? b64enc(nacl.box.keyPair.fromSecretKey(sk).publicKey) : ''; }
/* Neue Schlüssel übernehmen (von der Einstellungsseite) */
function setKeys(skB64, seedB64) {
  var sk = b64dec(skB64), seed = b64dec(seedB64);
  if (!sk || sk.length !== 32) return false;
  store.set('wt.sk', skB64);
  if (seed && seed.length >= 32) store.set('wt.seed', seedB64);
  return true;
}
/* Kurzer Fingerabdruck zum Vergleichen unter Freunden: 4 Gruppen à 4 Hex-Zeichen */
function fingerprint(pkB64) {
  var pk = b64dec(pkB64); if (!pk) return '';
  var h = nacl.hash(pk), s = '';
  for (var i = 0; i < 8; i++) s += (h[i] < 16 ? '0' : '') + h[i].toString(16) + (i % 2 && i < 7 ? ' ' : '');
  return s;
}

/* text + {name: öffentlicher Schlüssel} → {v, n, c, k} */
function encrypt(text, recipients) {
  var sk = secretKey(); if (!sk) throw new Error('Kein Schlüssel');
  var K = nacl.randomBytes(32), n = nacl.randomBytes(24);
  var e = { v: 1, n: b64enc(n), c: b64enc(nacl.secretbox(utf8(text), n, K)), k: {} };
  for (var name in recipients) {
    var pk = b64dec(recipients[name]);
    if (!pk || pk.length !== 32) continue;
    var nr = nacl.randomBytes(24);
    e.k[name] = b64enc(concat([nr, nacl.box(K, nr, pk, sk)]));
  }
  return e;
}
/* {v, n, c, k: eigener Umschlag} + öffentlicher Schlüssel des Absenders → Text oder null */
function decrypt(e, senderPkB64) {
  try {
    var sk = secretKey(), pk = b64dec(senderPkB64), env = b64dec(e && e.k), n = b64dec(e && e.n), c = b64dec(e && e.c);
    if (!sk || !pk || !env || !n || !c || env.length < 40 || n.length !== 24) return null;
    var K = nacl.box.open(env.subarray(24), env.subarray(0, 24), pk, sk);
    if (!K) return null;
    var m = nacl.secretbox.open(c, n, K);
    return m ? fromUtf8(m) : null;
  } catch (x) { return null; }
}

module.exports = { init: init, ready: ready, publicKey: publicKey, setKeys: setKeys, fingerprint: fingerprint,
  encrypt: encrypt, decrypt: decrypt, b64enc: b64enc, b64dec: b64dec, nacl: nacl };
