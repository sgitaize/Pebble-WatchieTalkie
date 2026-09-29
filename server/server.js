/**
 * WatchieTalkie2 – Server für die Pebble-App (Walkie-Talkie mit Textnachrichten, Ende-zu-Ende-verschlüsselt)
 *
 * Der Server sieht nur verschlüsselte Nachrichten (NaCl box/secretbox, verschlüsselt auf dem Handy) und Metadaten
 * (wer mit wem, wann). Öffentliche Schlüssel der Nutzer verteilt er an Kontakte und Gruppenmitglieder.
 *
 * Ohne Abhängigkeiten (nur Node-Standardmodule, Node ≥ 18). Daten liegen als JSON in data/db.json.
 * Jeder kann seinen eigenen Server betreiben; die App lässt die Server-Adresse in den Einstellungen ändern.
 *
 * Umgebungsvariablen (alle optional):
 *   PORT              Port ohne Passenger (Standard 3000)
 *   REGISTER_CODE     wenn gesetzt: Registrierung nur mit diesem Code (privater Server für Freunde)
 *   MAX_USERS         Obergrenze Konten (Standard 1000)
 *   HISTORY_MAX       Nachrichten je Chat (Standard 50)
 *   HISTORY_DAYS      Nachrichten älter als … Tage werden gelöscht (Standard 30)
 *   TIMELINE_API      Timeline-Dienst für Benachrichtigungen (Standard https://timeline-api.rebble.io, "off" = aus)
 *   NTFY_URL          vorgeschlagener ntfy-Server für Handy-Benachrichtigungen (Standard https://ntfy.sh, "off" = ntfy aus)
 *   PUSHOVER_TOKEN    Pushover-Anwendungstoken des Servers (optional; sonst trägt jeder Nutzer sein eigenes ein)
 *   SERVER_NAME       Anzeigename des Servers (Standard "WatchieTalkie2")
 *   DONATE_URL        Spendenlink auf der Info-Seite (Standard: Projekt-Spendenlink, "off" = ausblenden)
 *   ADMIN_KEY         Schlüssel für die Betreiber-Seite /admin (alternativ SHA-256 davon in data/admin-key; ohne = keine Admin-Seite)
 */
'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* Log-Datei für Hosting ohne Shell (per FTP lesbar): logs/app.log, höchstens 120 Zeilen/min, ab 2 MB rotiert */
const LOG_FILE = path.join(__dirname, 'logs', 'app.log');
let logMin = 0, logCount = 0;
function logLine(level, args) {
  const min = Math.floor(Date.now() / 60000);
  if (min !== logMin) { logMin = min; logCount = 0; }
  if (++logCount > 120) return;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    try { if (fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch (e) { /* neu */ }
    const text = args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + level + ' ' + text + '\n');
  } catch (e) { /* Log ist Nebensache */ }
}
const origLog = console.log, origErr = console.error;
console.log = (...a) => { logLine('INFO', a); origLog(...a); };
console.error = (...a) => { logLine('ERROR', a); origErr(...a); };

const VERSION = '1.8.0';
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA, 'db.json');
const PORT = Number(process.env.PORT) || 3000;
const REGISTER_CODE = process.env.REGISTER_CODE || '';
const MAX_USERS = Number(process.env.MAX_USERS) || 1000;
const HISTORY_MAX = Math.min(500, Number(process.env.HISTORY_MAX) || 50);
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS) || 30;
const TIMELINE_API = process.env.TIMELINE_API || 'https://timeline-api.rebble.io';
const NTFY_URL = process.env.NTFY_URL || 'https://ntfy.sh';
const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN || '';
const SERVER_NAME = (process.env.SERVER_NAME || 'WatchieTalkie2').slice(0, 40);
const DONATE_URL = process.env.DONATE_URL === 'off' ? '' : (process.env.DONATE_URL || 'https://www.paypal.com/donate/?hosted_button_id=LGAZB9PR4YV5L');
const POLL_WAIT_MAX = 25;      // Sekunden, die /v1/poll auf Neues wartet (Long-Polling spart Akku)

const TEXT_MAX = 300;          // Zeichen je Nachricht
const GROUP_MAX = 20;          // Mitglieder je Gruppe
const GROUPS_PER_USER = 20;
const CONTACTS_MAX = 200;
const ALIASES_MAX = 3;                // Zweitnamen je Konto (Einladungen an einen Zweitnamen landen beim Hauptkonto)
const BODY_MAX = 32768;
const NAME_RE = /^[a-z0-9][a-z0-9_]{2,15}$/;
const RESERVED = new Set(['admin', 'administrator', 'root', 'system', 'support', 'server', 'watchietalkie', 'watchietalkie2', 'psst', 'pebble', 'rebble',
  'null', 'undefined', 'constructor', 'prototype', 'hasownproperty', 'tostring', 'valueof']);
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const DEFAULT_CFG = { qr: ['OK', 'On my way', 'Call me', 'Later', 'Yes', 'No', 'Thanks!'], vibe: true, notify: true, beep: true };

/* ------------------------------------------------------------ Speicher -- */
/* Alle Nachschlage-Tabellen ohne Prototyp: Namen wie "constructor" oder "__proto__" können nichts manipulieren */
const dict = (o) => Object.assign(Object.create(null), o || {});
function loadDb() {
  const d = { seq: 0, users: dict(), groups: dict(), chats: dict(), stats: { messages: 0, voice: 0, since: Date.now() } };
  try {
    const j = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    d.seq = Number(j.seq) || 0;
    if (j.stats) d.stats = { messages: Number(j.stats.messages) || 0, voice: Number(j.stats.voice) || 0, since: Number(j.stats.since) || Date.now() };
    for (const n of Object.keys(j.users || {})) { const u = j.users[n]; u.contacts = dict(u.contacts); u.read = dict(u.read); d.users[n] = u; }
    d.groups = dict(j.groups); d.chats = dict(j.chats);
  } catch (e) { if (e.code !== 'ENOENT') console.error('db.json nicht lesbar', e.message); }
  return d;
}
let db = loadDb();
const byToken = new Map();            // Token-Hash → Name
const byAlias = new Map();            // Zweitname → Hauptname
function reindex() {
  byToken.clear(); byAlias.clear();
  for (const n in db.users) { byToken.set(db.users[n].th, n); for (const a of db.users[n].aliases || []) byAlias.set(a, n); }
}
reindex();
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(flush, 500);
}
function flush() {
  clearTimeout(saveTimer); saveTimer = null;
  try {
    fs.mkdirSync(DATA, { recursive: true });
    const tmp = DB_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) { console.error('Speichern fehlgeschlagen', e.message); }
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { if (saveTimer) flush(); process.exit(0); });
process.on('uncaughtException', (e) => { console.error('Unerwarteter Fehler', e); if (saveTimer) flush(); process.exit(1); });

const now = () => Date.now();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const dmKey = (a, b) => 'd:' + (a < b ? a + '|' + b : b + '|' + a);
/* System-Chat "WatchieTalkie": nur lesbar, enthält Testnachrichten des Servers (fester Klartext, keine Nutzerdaten) */
const SYSTEM = 'watchietalkie';
const SYS_CID = 'u.' + SYSTEM;
const sysKey = (name) => 's:' + name;
const cleanText = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max);

function newUser(name, token) {
  return { name, th: sha(token), created: now(), seen: now(), cfg: JSON.parse(JSON.stringify(DEFAULT_CFG)),
    contacts: dict(), blocked: [], groups: [], ginv: [], read: dict(), tl: '', pk: '' };
}
function userByToken(req) {
  const m = /^Bearer\s+([a-f0-9]{64})$/i.exec(req.headers.authorization || '');
  if (!m) return null;
  const n = byToken.get(sha(m[1].toLowerCase()));
  return n ? db.users[n] || null : null;
}
/* Chat-IDs nach außen: "u.<name>" (Direktchat) oder "g.<gruppe>" */
function chatAccess(u, cid) {
  const m = /^([ug])\.([a-z0-9_]{3,16})$/.exec(String(cid || ''));
  if (!m) return null;
  if (m[1] === 'u') {
    if (m[2] === SYSTEM) return db.chats[sysKey(u.name)] ? { key: sysKey(u.name), to: [], cid, sys: true } : null;
    if (u.contacts[m[2]] !== 'ok') return null;
    return { key: dmKey(u.name, m[2]), to: [m[2]], cid };
  }
  const g = db.groups[m[2]];
  if (!g || !g.members.includes(u.name)) return null;
  return { key: 'g:' + g.id, to: g.members.filter((x) => x !== u.name), cid, group: g };
}
function chatOf(key) { return db.chats[key] || (db.chats[key] = { msgs: [] }); }
function chatTitle(u, cid) {
  if (cid === SYS_CID) return 'WatchieTalkie';
  if (cid[0] === 'u') return cid.slice(2);
  const g = db.groups[cid.slice(2)];
  return g ? g.title : cid;
}
function chatList(u) {
  const out = [];
  for (const n in u.contacts) if (u.contacts[n] === 'ok') out.push('u.' + n);
  for (const gid of u.groups) if (db.groups[gid]) out.push('g.' + gid);
  if (db.chats[sysKey(u.name)]) out.push(SYS_CID);
  return out.map((cid) => {
    const a = chatAccess(u, cid);
    const msgs = (a && db.chats[a.key] && db.chats[a.key].msgs) || [];
    const last = msgs[msgs.length - 1];
    const rd = u.read[a ? a.key : ''] || 0;
    return { id: cid, title: chatTitle(u, cid), group: cid[0] === 'g', unread: msgs.filter((x) => x.id > rd && x.f !== u.name).length,
      last: last ? msgView(last, u.name) : null };
  }).sort((x, y) => ((y.last ? y.last.ts : 0) - (x.last ? x.last.ts : 0)) || x.title.localeCompare(y.title));
}
function meView(u) {
  const c = { ok: [], out: [], in: [] };
  for (const n in u.contacts) c[u.contacts[n]].push(n);
  return { name: u.name, aliases: (u.aliases || []).slice(), cfg: u.cfg, contacts: c.ok.sort(), invitesOut: c.out.sort(), invitesIn: c.in.sort(), blocked: u.blocked.slice().sort(),
    groups: u.groups.filter((g) => db.groups[g]).map((g) => groupView(db.groups[g])),
    groupInvites: u.ginv.filter((g) => db.groups[g]).map((g) => groupView(db.groups[g])),
    timeline: !!u.tl, pubKey: u.pk || '', server: serverInfo() };
}
/* Nachricht für einen Leser: nur sein eigener Schlüsselumschlag */
function msgView(m, reader) {
  const v = { id: m.id, f: m.f, ts: m.ts, e: m.e ? { v: m.e.v, n: m.e.n, c: m.e.c, k: m.e.k[reader] || null } : null };
  if (m.t) v.t = m.t;                        // nur Systemnachrichten haben Klartext
  return v;
}
/* Verschlüsselte Nachricht prüfen: {v:1, n:Nonce, c:Chiffretext, k:{name: Umschlag}} – Klartext wird nicht angenommen */
function cleanEnc(e, names) {
  if (!e || typeof e !== 'object' || e.v !== 1) fail(400, 'Nachricht muss verschlüsselt sein – bitte App aktualisieren');
  const ok = (s, min, max) => typeof s === 'string' && s.length >= min && s.length <= max && B64.test(s);
  if (!ok(e.n, 32, 32) || !ok(e.c, 24, 2400) || !e.k || typeof e.k !== 'object') fail(400, 'Ungültige verschlüsselte Nachricht');
  const k = dict();
  for (const n of names) if (Object.prototype.hasOwnProperty.call(e.k, n) && ok(e.k[n], 60, 140)) k[n] = e.k[n];
  if (!Object.keys(k).length) fail(400, 'Nachricht ohne Empfänger-Schlüssel');
  return { v: 1, n: e.n, c: e.c, k };
}
function groupView(g) { return { id: g.id, title: g.title, owner: g.owner, members: g.members.slice(), invited: g.invited.slice() }; }
function serverInfo() {
  return { donate: DONATE_URL, name: SERVER_NAME, version: VERSION, registration: REGISTER_CODE ? 'code' : 'open', historyMax: HISTORY_MAX, historyDays: HISTORY_DAYS, textMax: TEXT_MAX,
    ntfy: NTFY_URL === 'off' ? '' : NTFY_URL, pushoverToken: !!PUSHOVER_TOKEN };
}

/* Nachricht speichern und Empfänger benachrichtigen */
function postMessage(u, a, e, voice) {
  const ch = chatOf(a.key);
  const msg = { id: ++db.seq, f: u.name, e, ts: now() };
  ch.msgs.push(msg);
  if (ch.msgs.length > HISTORY_MAX) ch.msgs.splice(0, ch.msgs.length - HISTORY_MAX);
  u.read[a.key] = msg.id;
  if (!u.test) { db.stats.messages++; if (voice) db.stats.voice++; }
  save();
  for (const n of a.to) wake(n);
  for (const n of a.to) {
    const r = db.users[n];
    if (r && !r.blocked.includes(u.name)) notifyClosed(r, u, a, msg);
  }
  return msg;
}

/* ------------------------------------------------ Timeline-Benachrichtigung -- */
/* Die Pebble-App liefert je Nutzer einen Timeline-Token (nur bei Installation über den App-Store).
   Damit legt der Server einen Pin mit Benachrichtigung an – die Uhr meldet sich auch bei geschlossener App. */
let pushesSent = [];
function pushBudget() {                        // Notbremse gegen Fluten: höchstens 120 Pushes/min
  const t = now();
  pushesSent = pushesSent.filter((x) => t - x < 60000);
  if (pushesSent.length > 120) return false;
  pushesSent.push(t);
  return true;
}
/* Benachrichtigung bei geschlossener App: Timeline-Pin (nur Rebble-App) und/oder Handy-Benachrichtigung
   (ntfy, Telegram-Bot oder Pushover – der Nutzer wählt in den Einstellungen). Die Core-App holt keine
   Timeline-Pins vom Server ab. Inhalt immer nur „New message: <Absender>“ bzw. Kontaktanfrage, nie der Nachrichtentext. */
function notifyClosed(r, u, a, msg) {
  if (r.cfg.notify === false) return;
  const title = a.group ? a.group.title + ': ' + u.name : u.name;
  if (r.tl) pushPin(r, title, msg);
  pushPhone(r, 'New message: ' + title);
}
/* Nur Handy-Benachrichtigung (z. B. Kontaktanfrage) über den gewählten Dienst */
function pushPhone(r, text) {
  if (r.cfg.notify === false) return;
  const c = r.cfg;
  const push = c.push !== undefined ? c.push : (c.ntfy ? 'ntfy' : '');   // Konten aus 1.3.0 kannten nur ntfy
  if (push === 'ntfy' && c.ntfy && NTFY_URL !== 'off')
    httpsPost('ntfy', r, (c.ntfyUrl || NTFY_URL) + '/' + c.ntfy, text,
      { 'Content-Type': 'text/plain; charset=utf-8', Title: 'WatchieTalkie2', Tags: 'speech_balloon' });
  else if (push === 'telegram' && c.tgBot && c.tgChat)
    httpsPost('Telegram', r, 'https://api.telegram.org/bot' + c.tgBot + '/sendMessage',
      JSON.stringify({ chat_id: c.tgChat, text: '\ud83d\udcac WatchieTalkie2 \u2013 ' + text }), { 'Content-Type': 'application/json' });
  else if (push === 'pushover' && c.poUser && (c.poToken || PUSHOVER_TOKEN))
    httpsPost('Pushover', r, 'https://api.pushover.net/1/messages.json',
      new URLSearchParams({ token: c.poToken || PUSHOVER_TOKEN, user: c.poUser, title: 'WatchieTalkie2', message: text }).toString(),
      { 'Content-Type': 'application/x-www-form-urlencoded' });
}
function httpsPost(what, r, url, body, headers) {
  if (!pushBudget()) return;
  try {
    const req = https.request(new URL(url), { method: 'POST', timeout: 10000,
      headers: Object.assign({ 'Content-Length': Buffer.byteLength(body) }, headers) }, (res) => {
      res.resume();
      if (res.statusCode >= 300) console.error(what, res.statusCode, 'für', r.name);
    });
    req.on('error', (e) => console.error(what, e.message));
    req.on('timeout', () => req.destroy());
    req.end(body);
  } catch (e) { console.error(what, e.message); }
}
/* Telegram: Chat-ID aus der letzten Nachricht an den eigenen Bot holen (Nutzer schreibt dem Bot vorher „/start“) */
function telegramChat(bot) {
  return new Promise((resolve) => {
    const req = https.get('https://api.telegram.org/bot' + bot + '/getUpdates?limit=20', { timeout: 10000 }, (res) => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', (x) => { if (d.length < 200000) d += x; });
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (!j.ok) return resolve({ error: 'bot' });
          const m = j.result.map((x) => x.message || x.edited_message).filter((x) => x && x.chat).pop();
          resolve(m ? { chat: String(m.chat.id) } : { error: 'nochat' });
        } catch (e) { resolve({ error: 'bot' }); }
      });
    });
    req.on('error', () => resolve({ error: 'net' }));
    req.on('timeout', () => req.destroy());
  });
}
function pushPin(r, title, msg) {
  if (TIMELINE_API === 'off' || !pushBudget()) return;
  const layout = { type: 'genericPin', title, body: 'New message', tinyIcon: 'system://images/GENERIC_EMAIL' };
  const pin = { id: 'wt-' + msg.id + '-' + r.name, time: new Date(msg.ts).toISOString(), layout,
    createNotification: { layout: { type: 'genericNotification', title, body: 'New message', tinyIcon: 'system://images/GENERIC_EMAIL' } },
    actions: [{ title: 'Reply', type: 'openWatchApp', launchCode: 1 }] };
  const body = JSON.stringify(pin);
  try {
    const url = new URL(TIMELINE_API.replace(/\/$/, '') + '/v1/user/pins/' + encodeURIComponent(pin.id));
    const req = https.request(url, { method: 'PUT', timeout: 10000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-User-Token': r.tl } }, (res) => {
      res.resume();
      if (res.statusCode === 410 || res.statusCode === 403) { r.tl = ''; save(); }   // Token ungültig → nicht weiter versuchen
      console.log('Timeline', res.statusCode, 'für', r.name);
    });
    req.on('error', (e) => console.error('Timeline', e.message));
    req.on('timeout', () => req.destroy());
    req.end(body);
  } catch (e) { console.error('Timeline', e.message); }
}

/* Testnachricht: kommt über denselben Weg wie echte Nachrichten (Polling + Timeline-Pin).
   Mit Verzögerung kann man die App vorher schließen und so die Benachrichtigung prüfen. */
function systemMessage(u, text) {
  const a = { key: sysKey(u.name), to: [], cid: SYS_CID, sys: true };
  const ch = chatOf(a.key);
  const msg = { id: ++db.seq, f: SYSTEM, t: text, ts: now() };
  ch.msgs.push(msg);
  if (ch.msgs.length > 10) ch.msgs.splice(0, ch.msgs.length - 10);
  save();
  wake(u.name);
  notifyClosed(u, { name: 'WatchieTalkie' }, a, msg);
  return msg;
}

/* ------------------------------------------------------------- Grenzen -- */
const buckets = new Map();
function limited(key, max, windowMs, peek) {     // peek: nur prüfen, nicht mitzählen
  const t = now();
  const l = (buckets.get(key) || []).filter((x) => t - x < windowMs);
  if (l.length >= max) { buckets.set(key, l); return true; }
  if (peek) return false;
  l.push(t); buckets.set(key, l);
  return false;
}
setInterval(() => { const t = now(); for (const [k, l] of buckets) if (!l.length || t - l[l.length - 1] > 3600000) buckets.delete(k); }, 600000).unref();
const PRIVATE_IP = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80:|::ffff:127\.|unix|$)/i;
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  for (let i = xf.length - 1; i >= 0; i--) if (!PRIVATE_IP.test(xf[i])) return xf[i].slice(0, 64);
  const xr = String(req.headers['x-real-ip'] || '').trim();
  if (xr && !PRIVATE_IP.test(xr)) return xr.slice(0, 64);
  return String((req.socket && req.socket.remoteAddress) || '');
}

/* Aufräumen: alte Nachrichten, verwaiste Chats, lange unbeantwortete Einladungen */
function cleanup() {
  const cut = now() - HISTORY_DAYS * 86400000;
  for (const k in db.chats) {
    const ch = db.chats[k];
    ch.msgs = ch.msgs.filter((m) => m.ts >= cut).slice(-HISTORY_MAX);
    if (!ch.msgs.length) delete db.chats[k];
  }
  save();
}
setInterval(cleanup, 3600000).unref();

/* ----------------------------------------------------------------- API -- */
class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new ApiError(status, msg); };
function needName(n) {
  n = String(n || '').trim().toLowerCase();
  if (!NAME_RE.test(n)) fail(400, 'Ungültiger Name (3–16 Zeichen: a–z, 0–9, _)');
  return n;
}
/* Name oder Zweitname → Konto */
function userByName(n) { return db.users[n] || db.users[byAlias.get(n)] || null; }
const nameTaken = (n) => RESERVED.has(n) || !!db.users[n] || byAlias.has(n);
function otherUser(n) { const r = userByName(needName(n)); if (!r) fail(404, 'Nutzer nicht gefunden'); return r; }
function unlinkContact(a, b) { delete a.contacts[b.name]; delete b.contacts[a.name]; }

const routes = [];
const route = (method, re, auth, fn) => routes.push({ method, re, auth, fn });

route('GET', /^\/v1\/info$/, false, () => serverInfo());

route('POST', /^\/v1\/register$/, false, (req, b) => {
  if (limited('reg:' + clientIp(req), 20, 3600000) || limited('reg', 100, 3600000)) fail(429, 'Zu viele Registrierungen, bitte später');
  if (REGISTER_CODE && String(b.code || '') !== REGISTER_CODE) fail(403, 'Registrierungscode falsch');
  const name = needName(b.name);
  if (RESERVED.has(name)) fail(400, 'Dieser Name ist reserviert');
  if (nameTaken(name)) fail(409, 'Name schon vergeben');
  if (Object.keys(db.users).length >= MAX_USERS) fail(403, 'Server ist voll');
  const token = crypto.randomBytes(32).toString('hex');
  db.users[name] = newUser(name, token);
  if (b.test === true) db.users[name].test = true;      // Testkonten zählen nicht in der Statistik
  byToken.set(db.users[name].th, name);
  save();
  return { name, token };
});

route('GET', /^\/v1\/me$/, true, (req, b, u) => meView(u));

route('PUT', /^\/v1\/me$/, true, (req, b, u) => {
  if (b.cfg && typeof b.cfg === 'object') {
    const c = b.cfg;
    if (Array.isArray(c.qr)) u.cfg.qr = c.qr.map((x) => cleanText(x, 40)).filter(Boolean).slice(0, 10);
    if (typeof c.vibe === 'boolean') u.cfg.vibe = c.vibe;
    if (typeof c.notify === 'boolean') u.cfg.notify = c.notify;
    if (typeof c.beep === 'boolean') u.cfg.beep = c.beep;
    if (typeof c.push === 'string') {
      if (!['', 'ntfy', 'telegram', 'pushover'].includes(c.push)) fail(400, 'Unbekannter Benachrichtigungsdienst');
      u.cfg.push = c.push;
    }
    if (typeof c.poUser === 'string') {         // Pushover: Nutzerschlüssel + (falls der Server keinen hat) Anwendungstoken
      if (c.poUser && !/^[A-Za-z0-9]{30}$/.test(c.poUser)) fail(400, 'Ungültiger Pushover-Nutzerschlüssel (30 Zeichen)');
      u.cfg.poUser = c.poUser;
    }
    if (typeof c.poToken === 'string') {
      if (c.poToken && !/^[A-Za-z0-9]{30}$/.test(c.poToken)) fail(400, 'Ungültiges Pushover-Anwendungstoken (30 Zeichen)');
      u.cfg.poToken = c.poToken;
    }
    if (c.push === 'pushover' && (!u.cfg.poUser || (!u.cfg.poToken && !PUSHOVER_TOKEN))) fail(400, 'Pushover: Schlüssel fehlt');
    if (c.push === 'telegram' && !u.cfg.tgChat) fail(400, 'Telegram: erst verbinden');
    if (c.push === 'ntfy' && !(typeof c.ntfy === 'string' ? c.ntfy : u.cfg.ntfy)) fail(400, 'ntfy: Thema fehlt');
    if (typeof c.ntfy === 'string') {           // ntfy-Thema (wie ein Passwort: wer es kennt, liest mit); leer = aus
      if (c.ntfy && !/^[A-Za-z0-9_-]{12,64}$/.test(c.ntfy)) fail(400, 'Ungültiges ntfy-Thema (12–64 Zeichen A–Z, 0–9, _ -)');
      u.cfg.ntfy = c.ntfy;
    }
    if (typeof c.ntfyUrl === 'string') {        // eigener ntfy-Server (nur https, kein localhost/IP → kein Zugriff aufs interne Netz)
      let v = c.ntfyUrl.trim().replace(/\/+$/, '');
      if (v) {
        let h; try { const x = new URL(v); h = x.protocol === 'https:' && !x.search && !x.hash && x.hostname; } catch (e) { h = ''; }
        if (!h || v.length > 200 || net.isIP(h.replace(/^\[|\]$/g, '')) || /^localhost$|\.local$|\.internal$/i.test(h) || !h.includes('.'))
          fail(400, 'Ungültiger ntfy-Server (https://…)');
        if (v === NTFY_URL) v = '';
      }
      u.cfg.ntfyUrl = v;
    }
  }
  if (typeof b.timelineToken === 'string') {
    const tl = cleanText(b.timelineToken, 128).replace(/[^A-Za-z0-9_-]/g, '');
    if (tl !== u.tl) console.log('Timeline-Token', tl ? 'gesetzt' : 'entfernt', 'für', u.name);
    u.tl = tl;
  }
  if (typeof b.pubKey === 'string') {
    if (!B64.test(b.pubKey) || b.pubKey.length !== 44) fail(400, 'Ungültiger öffentlicher Schlüssel');
    if (b.pubKey !== u.pk) { u.pk = b.pubKey; u.pkTs = now(); }
  }
  save();
  return meView(u);
});

/* Telegram verbinden: eigener Bot (Token von @BotFather), Chat-ID holt der Server über getUpdates.
   {bot: ''} trennt die Verbindung. */
route('POST', /^\/v1\/me\/telegram$/, true, async (req, b, u) => {
  if (limited('tg:' + u.name, 10, 600000)) fail(429, 'Zu viele Versuche, bitte später');
  const bot = typeof b.bot === 'string' ? b.bot.trim() : '';
  if (!bot) { u.cfg.tgBot = ''; u.cfg.tgChat = ''; if (u.cfg.push === 'telegram') u.cfg.push = ''; save(); return meView(u); }
  if (!/^\d{5,15}:[A-Za-z0-9_-]{30,50}$/.test(bot)) fail(400, 'Ungültiges Bot-Token');
  const r = await telegramChat(bot);
  if (r.error === 'bot') fail(400, 'Telegram kennt dieses Bot-Token nicht');
  if (r.error === 'nochat') fail(400, 'Schreib deinem Bot zuerst /start in Telegram');
  if (r.error) fail(502, 'Telegram nicht erreichbar');
  u.cfg.tgBot = bot; u.cfg.tgChat = r.chat; u.cfg.push = 'telegram';
  save();
  return meView(u);
});

function deleteUser(u) {
  for (const n in u.contacts) if (db.users[n]) delete db.users[n].contacts[u.name];
  for (const gid of u.groups.concat(u.ginv)) leaveGroup(u, db.groups[gid]);
  for (const k in db.chats) if (k.startsWith('d:') && k.slice(2).split('|').includes(u.name)) delete db.chats[k];
  delete db.chats[sysKey(u.name)];
  byToken.delete(u.th);
  for (const a of u.aliases || []) byAlias.delete(a);
  delete db.users[u.name];
  save();
}
route('DELETE', /^\/v1\/me$/, true, (req, b, u) => { deleteUser(u); return { ok: true }; });
/* Betreiber: Konten löschen ohne deren Token – Namen (je Zeile) in data/delete-users.txt, Neustart; Datei wird danach umbenannt */
try {
  const f = path.join(path.dirname(DB_FILE), 'delete-users.txt');
  const names = fs.readFileSync(f, 'utf8').split(/\s+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  for (const n of names) { const u = db.users[n]; console.log('Betreiber-Löschung', n, u ? 'gelöscht' : 'nicht gefunden'); if (u) deleteUser(u); }
  fs.renameSync(f, f + '.done');
} catch (e) { if (e.code !== 'ENOENT') console.error('delete-users.txt', e.message); }

/* Zweitnamen: unter weiteren Namen erreichbar sein (z. B. Entwickler- und Privatname); Kontakte sehen danach den Hauptnamen */
route('POST', /^\/v1\/me\/aliases$/, true, (req, b, u) => {
  const name = needName(b.name);
  if (RESERVED.has(name)) fail(400, 'Dieser Name ist reserviert');
  if (name === u.name || (u.aliases || []).includes(name)) return meView(u);
  if (nameTaken(name)) fail(409, 'Name schon vergeben');
  if ((u.aliases || []).length >= ALIASES_MAX) fail(400, 'Zu viele Zweitnamen');
  if (limited('alias:' + u.name, 10, 3600000)) fail(429, 'Zu viele Versuche, bitte später');
  u.aliases = (u.aliases || []).concat(name);
  byAlias.set(name, u.name);
  save();
  return meView(u);
});
route('DELETE', /^\/v1\/me\/aliases\/([a-z0-9_]{3,16})$/, true, (req, b, u, m) => {
  if (!(u.aliases || []).includes(m[1])) fail(404, 'Nicht gefunden');
  u.aliases = u.aliases.filter((x) => x !== m[1]);
  byAlias.delete(m[1]);
  save();
  return meView(u);
});

/* Kontakte: Einladung schicken; hat der andere mich schon eingeladen, ist es damit angenommen */
route('POST', /^\/v1\/contacts$/, true, (req, b, u) => {
  const r = otherUser(b.name);
  if (r === u) fail(400, 'Das bist du selbst');
  if (u.blocked.includes(r.name)) fail(400, 'Du hast diesen Nutzer blockiert');
  if (Object.keys(u.contacts).length >= CONTACTS_MAX) fail(400, 'Zu viele Kontakte');
  if (limited('inv:' + u.name, 30, 3600000)) fail(429, 'Zu viele Einladungen, bitte später');
  const st = u.contacts[r.name];
  if (st === 'ok' || st === 'out') return meView(u);
  if (st === 'in') { u.contacts[r.name] = 'ok'; r.contacts[u.name] = 'ok'; pushPhone(r, u.name + ' accepted your contact request'); }
  else if (!r.blocked.includes(u.name)) { u.contacts[r.name] = 'out'; r.contacts[u.name] = 'in'; wake(r.name); pushPhone(r, 'Contact request from ' + u.name); }
  else u.contacts[r.name] = 'out';             // Blockiert: sieht für den Absender aus wie eine offene Einladung
  save();
  return meView(u);
});
route('POST', /^\/v1\/contacts\/([a-z0-9_]{3,16})\/accept$/, true, (req, b, u, m) => {
  const r = otherUser(m[1]);
  if (u.contacts[r.name] !== 'in') fail(404, 'Keine Einladung von ' + r.name);
  u.contacts[r.name] = 'ok'; r.contacts[u.name] = 'ok';
  save();
  pushPhone(r, u.name + ' accepted your contact request');
  return meView(u);
});
route('DELETE', /^\/v1\/contacts\/([a-z0-9_]{3,16})$/, true, (req, b, u, m) => {   // entfernen, ablehnen, zurückziehen
  const r = db.users[m[1]];
  if (r) unlinkContact(u, r); else delete u.contacts[m[1]];
  save();
  return meView(u);
});
route('POST', /^\/v1\/blocks$/, true, (req, b, u) => {
  const r = otherUser(b.name);
  if (r === u) fail(400, 'Das bist du selbst');
  unlinkContact(u, r);
  if (!u.blocked.includes(r.name)) u.blocked.push(r.name);
  if (u.blocked.length > 500) u.blocked.shift();
  save();
  return meView(u);
});
route('DELETE', /^\/v1\/blocks\/([a-z0-9_]{3,16})$/, true, (req, b, u, m) => {
  u.blocked = u.blocked.filter((x) => x !== m[1]);
  save();
  return meView(u);
});

/* Gruppen: Ersteller lädt Kontakte ein, Eingeladene nehmen an; jeder kann austreten, der Besitzer kann Mitglieder entfernen */
function needGroup(id) { const g = db.groups[id]; if (!g) fail(404, 'Gruppe nicht gefunden'); return g; }
function leaveGroup(u, g) {
  if (!g) return;
  g.members = g.members.filter((x) => x !== u.name);
  g.invited = g.invited.filter((x) => x !== u.name);
  u.groups = u.groups.filter((x) => x !== g.id);
  u.ginv = u.ginv.filter((x) => x !== g.id);
  if (!g.members.length) {
    for (const n of g.invited) if (db.users[n]) db.users[n].ginv = db.users[n].ginv.filter((x) => x !== g.id);
    delete db.groups[g.id]; delete db.chats['g:' + g.id];
  } else if (g.owner === u.name) g.owner = g.members[0];
}
function inviteToGroup(u, g, name) {
  const r = otherUser(name);
  if (u.contacts[r.name] !== 'ok') fail(400, r.name + ' ist nicht in deinen Kontakten');
  if (g.members.includes(r.name) || g.invited.includes(r.name)) return;
  if (g.members.length + g.invited.length >= GROUP_MAX) fail(400, 'Gruppe ist voll');
  if (r.blocked.includes(u.name)) return;
  g.invited.push(r.name);
  if (!r.ginv.includes(g.id)) r.ginv.push(g.id);
  wake(r.name);
}
route('POST', /^\/v1\/groups$/, true, (req, b, u) => {
  const title = cleanText(b.title, 24);
  if (!title) fail(400, 'Gruppenname fehlt');
  if (u.groups.length >= GROUPS_PER_USER) fail(400, 'Zu viele Gruppen');
  const members = Array.isArray(b.members) ? b.members.slice(0, GROUP_MAX - 1).map(needName) : [];
  for (const n of members) if (u.contacts[n] !== 'ok') fail(400, n + ' ist nicht in deinen Kontakten');
  if (limited('grp:' + u.name, 20, 3600000)) fail(429, 'Zu viele neue Gruppen, bitte später');
  let id;
  do id = 'g' + crypto.randomBytes(5).toString('hex'); while (db.groups[id]);
  const g = db.groups[id] = { id, title, owner: u.name, members: [u.name], invited: [], created: now() };
  u.groups.push(id);
  for (const n of members) inviteToGroup(u, g, n);
  save();
  return meView(u);
});
route('POST', /^\/v1\/groups\/(g[a-f0-9]{10})\/invite$/, true, (req, b, u, m) => {
  const g = needGroup(m[1]);
  if (!g.members.includes(u.name)) fail(403, 'Kein Mitglied');
  inviteToGroup(u, g, b.name);
  save();
  return meView(u);
});
route('POST', /^\/v1\/groups\/(g[a-f0-9]{10})\/accept$/, true, (req, b, u, m) => {
  const g = needGroup(m[1]);
  if (!g.invited.includes(u.name)) fail(404, 'Keine Einladung');
  if (u.groups.length >= GROUPS_PER_USER) fail(400, 'Zu viele Gruppen');
  g.invited = g.invited.filter((x) => x !== u.name);
  g.members.push(u.name);
  u.ginv = u.ginv.filter((x) => x !== g.id);
  u.groups.push(g.id);
  save();
  return meView(u);
});
route('PUT', /^\/v1\/groups\/(g[a-f0-9]{10})$/, true, (req, b, u, m) => {
  const g = needGroup(m[1]);
  if (!g.members.includes(u.name)) fail(403, 'Kein Mitglied');
  const title = cleanText(b.title, 24);
  if (title) g.title = title;
  save();
  return meView(u);
});
route('DELETE', /^\/v1\/groups\/(g[a-f0-9]{10})\/members\/([a-z0-9_]{3,16})$/, true, (req, b, u, m) => {   // Mitglied entfernen / Einladung zurückziehen
  const g = needGroup(m[1]);
  if (g.owner !== u.name) fail(403, 'Nur der Besitzer der Gruppe darf das');
  const r = db.users[m[2]];
  if (!r || r.name === u.name || (!g.members.includes(r.name) && !g.invited.includes(r.name))) fail(404, 'Nutzer nicht gefunden');
  leaveGroup(r, g);
  wake(r.name);
  save();
  return meView(u);
});
route('DELETE', /^\/v1\/groups\/(g[a-f0-9]{10})$/, true, (req, b, u, m) => {   // austreten bzw. Einladung ablehnen
  leaveGroup(u, db.groups[m[1]]);
  save();
  return meView(u);
});

/* Öffentliche Schlüssel aller Kontakte und Gruppenmitglieder (nur an diese, kein Verzeichnis für Fremde) */
route('GET', /^\/v1\/keys$/, true, (req, b, u) => {
  const names = new Set([u.name]);
  for (const n in u.contacts) if (u.contacts[n] === 'ok') names.add(n);
  for (const gid of u.groups) if (db.groups[gid]) db.groups[gid].members.forEach((n) => names.add(n));
  const keys = {};
  for (const n of names) if (db.users[n] && db.users[n].pk) keys[n] = db.users[n].pk;
  return { keys };
});

/* Chats und Nachrichten */
route('GET', /^\/v1\/chats$/, true, (req, b, u) => ({ seq: db.seq, chats: chatList(u), invites: meView(u).invitesIn.length + u.ginv.length }));
route('GET', /^\/v1\/chats\/([ug]\.[a-z0-9_]{3,16})\/messages$/, true, (req, b, u, m, q) => {
  const a = chatAccess(u, m[1]);
  if (!a) fail(404, 'Chat nicht gefunden');
  const limit = Math.max(1, Math.min(HISTORY_MAX, Number(q.get('limit')) || HISTORY_MAX));
  const msgs = ((db.chats[a.key] || {}).msgs || []).slice(-limit).map((x) => msgView(x, u.name));
  return { chat: a.cid, title: chatTitle(u, a.cid), read: u.read[a.key] || 0, msgs };
});
route('POST', /^\/v1\/chats\/([ug]\.[a-z0-9_]{3,16})\/messages$/, true, (req, b, u, m) => {
  const a = chatAccess(u, m[1]);
  if (!a) fail(404, 'Chat nicht gefunden');
  if (a.sys) fail(403, 'Dieser Chat ist schreibgeschützt');
  const e = cleanEnc(b.e, [u.name].concat(a.to));
  if (limited('msg:' + u.name, 30, 60000) || limited('msgh:' + u.name, 600, 3600000)) fail(429, 'Zu viele Nachrichten, bitte kurz warten');
  return { msg: msgView(postMessage(u, a, e, b.voice === true), u.name) };
});
/* Eigene Nachricht löschen: verschwindet für alle; die Chat-Nummer "del" meldet es beim Polling */
route('DELETE', /^\/v1\/chats\/([ug]\.[a-z0-9_]{3,16})\/messages\/(\d{1,12})$/, true, (req, b, u, m) => {
  const a = chatAccess(u, m[1]);
  const ch = a && db.chats[a.key];
  const i = ch ? ch.msgs.findIndex((x) => x.id === Number(m[2])) : -1;
  if (i < 0) fail(404, 'Nachricht nicht gefunden');
  if (ch.msgs[i].f !== u.name) fail(403, 'Nur eigene Nachrichten können gelöscht werden');
  ch.msgs.splice(i, 1);
  ch.del = ++db.seq;
  save();
  for (const n of a.to) wake(n);
  return { ok: true };
});
route('POST', /^\/v1\/chats\/([ug]\.[a-z0-9_]{3,16})\/read$/, true, (req, b, u, m) => {
  const a = chatAccess(u, m[1]);
  if (!a) fail(404, 'Chat nicht gefunden');
  const upTo = Math.min(db.seq, Number(b.upTo) || db.seq);
  if (upTo > (u.read[a.key] || 0)) { u.read[a.key] = upTo; save(); }
  return { ok: true };
});
route('POST', /^\/v1\/test$/, true, (req, b, u) => {
  if (limited('test:' + u.name, 5, 600000)) fail(429, 'Zu viele Anfragen');
  const delay = Math.max(0, Math.min(60, Math.round(Number(b.delay) || 0)));
  const name = u.name;
  const text = 'Test message received - WatchieTalkie2 works!' + (delay ? ' (sent with ' + delay + ' s delay)' : '');
  if (!delay) return { ok: true, delay, msg: msgView(systemMessage(u, text), name) };
  setTimeout(() => { if (db.users[name]) systemMessage(db.users[name], text); }, delay * 1000);
  return { ok: true, delay };
});
/* Alles Neue seit "since" (Nachrichten-Nummer) – ein Aufruf reicht fürs Polling */
/* Öffentliche Statistik für die Info-Seite (nur Zähler, nichts Persönliches) */
route('GET', /^\/v1\/stats$/, false, () => ({ users: Object.values(db.users).filter((x) => !x.test).length, groups: Object.keys(db.groups).length,
  messages: db.stats.messages, voice: db.stats.voice, since: db.stats.since, version: VERSION, name: SERVER_NAME }));

/* ------------------------------------------------------------------ Admin -- */
/* Betreiber-Seite /admin. Schlüssel: ADMIN_KEY (Umgebung) oder SHA-256 des Schlüssels in data/admin-key.
   Ohne Schlüssel gibt es keine Admin-Routen (404). Zeigt nur Metadaten – nie Token, Schlüssel oder Push-Zugänge. */
function adminHash() {
  if (process.env.ADMIN_KEY) return sha(process.env.ADMIN_KEY);
  try { const h = fs.readFileSync(path.join(DATA, 'admin-key'), 'utf8').trim().toLowerCase(); return /^[0-9a-f]{64}$/.test(h) ? h : ''; } catch (e) { return ''; }
}
function needAdmin(req) {
  const h = adminHash();
  if (!h) fail(404, 'Nicht gefunden');
  const ip = clientIp(req);
  if (limited('admfail:' + ip, 10, 600000, true)) fail(429, 'Zu viele Anfragen');
  const m = /^Admin (.+)$/.exec(String(req.headers.authorization || ''));
  const got = Buffer.from(sha(m ? m[1] : ''), 'hex'), want = Buffer.from(h, 'hex');
  if (!crypto.timingSafeEqual(got, want)) { limited('admfail:' + ip, 10, 600000); fail(401, 'Admin-Schlüssel falsch'); }
}
function adminUser(u) {
  const c = { ok: 0, in: 0, out: 0 };
  for (const n in u.contacts) c[u.contacts[n]]++;
  const c2 = u.cfg || {};
  return { name: u.name, aliases: (u.aliases || []).slice(), created: u.created, seen: u.seen, pubKey: !!u.pk, test: !!u.test,
    contacts: c.ok, invitesIn: c.in, invitesOut: c.out, groups: u.groups.length, blocked: u.blocked.length,
    push: c2.push !== undefined ? c2.push : (c2.ntfy ? 'ntfy' : ''), timeline: !!u.tl };
}
route('GET', /^\/v1\/admin\/users$/, false, (req) => {
  needAdmin(req);
  const us = Object.values(db.users);
  return { version: VERSION, users: us.map(adminUser).sort((a, b) => b.created - a.created),
    stats: { users: us.filter((x) => !x.test).length, test: us.filter((x) => x.test).length, groups: Object.keys(db.groups).length,
      chats: Object.keys(db.chats).length, messages: db.stats.messages, voice: db.stats.voice, since: db.stats.since } };
});
route('DELETE', /^\/v1\/admin\/users\/([a-z0-9_]{3,16})$/, false, (req, b, u, m) => {
  needAdmin(req);
  const r = db.users[m[1]];
  if (!r) fail(404, 'Nicht gefunden');
  deleteUser(r);
  console.log('Admin-Löschung', m[1]);
  return { ok: true };
});

/* Long-Polling: Wartende Abfragen je Nutzer; neue Nachrichten/Einladungen wecken sie sofort */
const waiters = new Map();            // Name → Set von Weck-Funktionen
let waiterCount = 0;
function wake(name) {
  const set = waiters.get(name);
  if (!set) return;
  waiters.delete(name);
  for (const fn of set) fn();
}
function pollResult(u, since) {
  const out = [], del = [];
  if (since < db.seq) {
    for (const cid of chatList(u).map((c) => c.id)) {
      const a = chatAccess(u, cid);
      if (db.chats[a.key] && db.chats[a.key].del > since) del.push(cid);
      for (const msg of (db.chats[a.key] || { msgs: [] }).msgs) if (msg.id > since && msg.f !== u.name) out.push(Object.assign({ chat: cid }, msgView(msg, u.name)));
    }
  }
  out.sort((x, y) => x.id - y.id);
  return { seq: db.seq, msgs: out.slice(-50), del, invites: meView(u).invitesIn.length + u.ginv.length };
}
route('GET', /^\/v1\/poll$/, true, (req, b, u, m, q) => {
  const since = Number(q.get('since')) || 0;
  const wait = Math.max(0, Math.min(POLL_WAIT_MAX, Number(q.get('wait')) || 0));
  const invites = Number(q.get('invites'));
  const first = pollResult(u, since);
  const changed = first.msgs.length || first.del.length || (q.has('invites') && invites !== first.invites);
  const set = waiters.get(u.name);
  if (!wait || changed || waiterCount >= 2000 || (set && set.size >= 3)) return first;
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return; done = true; waiterCount--; clearTimeout(timer);
      const s = waiters.get(u.name); if (s) { s.delete(finish); if (!s.size) waiters.delete(u.name); }
      resolve(db.users[u.name] ? pollResult(u, since) : { seq: db.seq, msgs: [], del: [], invites: 0 });
    };
    const timer = setTimeout(finish, wait * 1000);
    waiterCount++;
    if (!waiters.has(u.name)) waiters.set(u.name, new Set());
    waiters.get(u.name).add(finish);
    if (req.wtRes) req.wtRes.on('close', finish);
  });
});

/* --------------------------------------------------------------- HTTP -- */
const STATIC = { '/admin': 'admin.html', '/': 'index.html', '/index.html': 'index.html', '/impressum.html': 'impressum.html', '/favicon.svg': 'favicon.svg', '/icon.svg': 'icon.svg' };
const TYPES = { html: 'text/html; charset=utf-8', svg: 'image/svg+xml' };
/* Fehlermeldungen auf Englisch, wenn der Client nicht Deutsch spricht (Accept-Language) */
const EN_ERR = { 'Ungültiges ntfy-Thema (12–64 Zeichen A–Z, 0–9, _ -)': 'Invalid ntfy topic (12–64 characters A–Z, 0–9, _ -)',
  'Ungültiger ntfy-Server (https://…)': 'Invalid ntfy server (https://…)', 'ntfy: Thema fehlt': 'ntfy: topic missing',
  'Unbekannter Benachrichtigungsdienst': 'Unknown notification service', 'Telegram: erst verbinden': 'Telegram: connect first',
  'Ungültiger Pushover-Nutzerschlüssel (30 Zeichen)': 'Invalid Pushover user key (30 characters)',
  'Ungültiges Pushover-Anwendungstoken (30 Zeichen)': 'Invalid Pushover API token (30 characters)', 'Pushover: Schlüssel fehlt': 'Pushover: user key or API token missing',
  'Ungültiges Bot-Token': 'Invalid bot token', 'Telegram kennt dieses Bot-Token nicht': 'Telegram does not know this bot token',
  'Schreib deinem Bot zuerst /start in Telegram': 'Send /start to your bot in Telegram first', 'Telegram nicht erreichbar': 'Telegram not reachable',
  'Zu viele Versuche, bitte später': 'Too many attempts, please try later', 'Chat nicht gefunden': 'Chat not found', 'Dieser Chat ist schreibgeschützt': 'This chat is read-only', 'Das bist du selbst': 'That is you', 'Dieser Name ist reserviert': 'This name is reserved',
  'Du hast diesen Nutzer blockiert': 'You blocked this user', 'Gruppe ist voll': 'Group is full', 'Gruppe nicht gefunden': 'Group not found',
  'Gruppenname fehlt': 'Group name missing', 'Kein Mitglied': 'Not a member', 'Keine Einladung': 'No invitation',
  'Nachricht muss verschlüsselt sein – bitte App aktualisieren': 'Message must be encrypted – please update the app',
  'Nachricht ohne Empfänger-Schlüssel': 'Message without recipient key', 'Name schon vergeben': 'Name already taken',
  'Nicht angemeldet': 'Not logged in', 'Nutzer nicht gefunden': 'User not found', 'Registrierungscode falsch': 'Wrong registration code',
  'Server ist voll': 'Server is full', 'Ungültige verschlüsselte Nachricht': 'Invalid encrypted message',
  'Ungültiger Name (3–16 Zeichen: a–z, 0–9, _)': 'Invalid name (3–16 characters: a–z, 0–9, _)', 'Ungültiger öffentlicher Schlüssel': 'Invalid public key',
  'Ungültiges JSON': 'Invalid JSON', 'Zu viele Einladungen, bitte später': 'Too many invitations, please try later', 'Zu viele Gruppen': 'Too many groups',
  'Zu viele Kontakte': 'Too many contacts', 'Zu viele Zweitnamen': 'Too many aliases', 'Zu viele Nachrichten, bitte kurz warten': 'Too many messages, please wait a moment',
  'Zu viele Registrierungen, bitte später': 'Too many registrations, please try later', 'Zu viele neue Gruppen, bitte später': 'Too many new groups, please try later',
  'Ungültige Adresse': 'Invalid address', 'Nicht gefunden': 'Not found', 'Zu viele Anfragen': 'Too many requests', 'Nur der Besitzer der Gruppe darf das': 'Only the group owner can do that',
  'Nachricht nicht gefunden': 'Message not found', 'Nur eigene Nachrichten können gelöscht werden': 'You can only delete your own messages', 'Zu groß': 'Too large', 'Serverfehler': 'Server error', 'Admin-Schlüssel falsch': 'Wrong admin key' };
function english(msg) {
  if (EN_ERR[msg]) return EN_ERR[msg];
  let m = /^Keine Einladung von (.*)$/.exec(msg); if (m) return 'No invitation from ' + m[1];
  m = /^(.*) ist nicht in deinen Kontakten$/.exec(msg); if (m) return m[1] + ' is not in your contacts';
  return msg;
}
function send(res, status, obj) {
  if (obj && obj.error && res.lang === 'en') obj = Object.assign({}, obj, { error: english(obj.error) });
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(body);
}
function handleReq(req, res) {
  const al = String(req.headers['accept-language'] || '');
  res.lang = !al || /^de/i.test(al) ? 'de' : 'en';
  let url;
  try { url = new URL(req.url, 'http://x'); } catch (e) { return send(res, 400, { error: 'Ungültige Adresse' }); }
  const p = url.pathname.replace(/^\/api(?=\/)/, '');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '86400' });
    return res.end();
  }
  if (req.method === 'GET' && STATIC[p]) {
    const f = STATIC[p];
    return fs.readFile(path.join(ROOT, 'pages', f), (e, data) => {
      if (e) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': TYPES[f.split('.').pop()], 'Cache-Control': 'max-age=300', 'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'" });
      res.end(data);
    });
  }
  req.wtRes = res;
  const r = routes.find((x) => x.method === req.method && x.re.test(p));
  if (!r) return send(res, 404, { error: 'Nicht gefunden' });
  if (limited('ip:' + clientIp(req), 600, 60000)) return send(res, 429, { error: 'Zu viele Anfragen' });
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > BODY_MAX) { send(res, 413, { error: 'Zu groß' }); req.destroy(); } else chunks.push(c); });
  req.on('error', () => { /* egal */ });
  req.on('end', () => {
    if (size > BODY_MAX) return;
    try {
      let body = {};
      if (size) { try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { fail(400, 'Ungültiges JSON'); } }
      if (!body || typeof body !== 'object') body = {};
      let u = null;
      if (r.auth) {
        u = userByToken(req);
        if (!u) fail(401, 'Nicht angemeldet');
        if (now() - u.seen > 60000) { u.seen = now(); save(); }
      }
      const out = r.fn(req, body, u, r.re.exec(p), url.searchParams);
      if (out && typeof out.then === 'function') out.then((x) => { if (!res.writableEnded && !res.destroyed) send(res, 200, x); }).catch((e) => { if (res.writableEnded) return; if (e instanceof ApiError) return send(res, e.status, { error: e.message }); console.error('Fehler', p, e); send(res, 500, { error: 'Serverfehler' }); });
      else send(res, 200, out);
    } catch (e) {
      if (e instanceof ApiError) return send(res, e.status, { error: e.message });
      console.error('Fehler', req.method, p, e);
      send(res, 500, { error: 'Serverfehler' });
    }
  });
}

/* ------------------------------------------------ Nur eine Instanz führt -- */
/* Passenger startet unter Last manchmal weitere Prozesse. Jeder hätte seinen eigenen Stand im Speicher.
   Deshalb: Der erste Prozess öffnet tmp/leader.sock und bedient alles; weitere reichen nur dorthin durch. */
const LEADER_SOCK = process.env.PSST_LEADER_SOCK || path.join(ROOT, 'tmp', 'leader.sock');
let isLeader = false;
function tryLead(cb) {
  try { fs.mkdirSync(path.dirname(LEADER_SOCK), { recursive: true }); } catch (e) { /* egal */ }
  const s = http.createServer(handleReq);
  s.once('error', (e) => {
    if (e.code !== 'EADDRINUSE') { console.error('leader', e.message); isLeader = true; return cb(true); }
    const probe = net.connect(LEADER_SOCK);
    probe.once('connect', () => { probe.destroy(); cb(false); });
    probe.once('error', () => { try { fs.unlinkSync(LEADER_SOCK); } catch (x) { /* egal */ } tryLead(cb); });
  });
  s.listen(LEADER_SOCK, () => { isLeader = true; cb(true); });
}
function proxyReq(req, res) {
  const pr = http.request({ socketPath: LEADER_SOCK, path: req.url, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode, r.headers); r.pipe(res);
  });
  pr.on('error', () => tryLead((ok) => { if (ok) { db = loadDb(); reindex(); handleReq(req, res); } else { try { res.writeHead(503); res.end(); } catch (e) { /* egal */ } } }));
  req.pipe(pr);
}
const server = http.createServer((req, res) => (isLeader ? handleReq(req, res) : proxyReq(req, res)));
server.headersTimeout = 20000;
server.requestTimeout = 30000;
server.keepAliveTimeout = 10000;
server.on('clientError', (e, sock) => { try { sock.destroy(); } catch (x) { /* egal */ } });
const PP = typeof PhusionPassenger !== 'undefined' ? PhusionPassenger : null;   // eslint-disable-line no-undef
if (PP) { try { PP.configure({ autoInstall: false }); } catch (e) { console.error('Passenger', e.message); } }
cleanup();
tryLead((ok) => {
  if (!ok) console.log('Weitere Instanz (pid ' + process.pid + ') – reicht an die führende weiter');
  server.listen(PP ? 'passenger' : PORT, () => console.log('WatchieTalkie2-Server ' + VERSION + ' läuft ' + (PP ? 'unter Passenger' : 'auf Port ' + PORT)));
});
