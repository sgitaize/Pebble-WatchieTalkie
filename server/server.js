/**
 * psst – Server für die Pebble-App (Walkie-Talkie mit Textnachrichten)
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
 *   SERVER_NAME       Anzeigename des Servers (Standard "psst")
 */
'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = '1.0.0';
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA, 'db.json');
const PORT = Number(process.env.PORT) || 3000;
const REGISTER_CODE = process.env.REGISTER_CODE || '';
const MAX_USERS = Number(process.env.MAX_USERS) || 1000;
const HISTORY_MAX = Math.min(500, Number(process.env.HISTORY_MAX) || 50);
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS) || 30;
const TIMELINE_API = process.env.TIMELINE_API || 'https://timeline-api.rebble.io';
const SERVER_NAME = (process.env.SERVER_NAME || 'psst').slice(0, 40);

const TEXT_MAX = 300;          // Zeichen je Nachricht
const GROUP_MAX = 20;          // Mitglieder je Gruppe
const GROUPS_PER_USER = 20;
const CONTACTS_MAX = 200;
const BODY_MAX = 8192;
const NAME_RE = /^[a-z0-9_]{3,16}$/;
const DEFAULT_CFG = { qr: ['OK', 'Bin unterwegs', 'Ruf mich an', 'Später', 'Ja', 'Nein', 'Danke!'], vibe: true, notify: true };

/* ------------------------------------------------------------ Speicher -- */
let db = { seq: 0, users: {}, groups: {}, chats: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) { if (e.code !== 'ENOENT') console.error('db.json nicht lesbar', e.message); }
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
const cleanText = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max);

function newUser(name, token) {
  return { name, th: sha(token), created: now(), seen: now(), cfg: JSON.parse(JSON.stringify(DEFAULT_CFG)),
    contacts: {}, blocked: [], groups: [], ginv: [], read: {}, tl: '' };
}
function userByToken(req) {
  const m = /^Bearer\s+([a-f0-9]{64})$/i.exec(req.headers.authorization || '');
  if (!m) return null;
  const th = sha(m[1].toLowerCase());
  for (const n in db.users) if (db.users[n].th === th) return db.users[n];
  return null;
}
/* Chat-IDs nach außen: "u.<name>" (Direktchat) oder "g.<gruppe>" */
function chatAccess(u, cid) {
  const m = /^([ug])\.([a-z0-9_]{3,16})$/.exec(String(cid || ''));
  if (!m) return null;
  if (m[1] === 'u') {
    if (u.contacts[m[2]] !== 'ok') return null;
    return { key: dmKey(u.name, m[2]), to: [m[2]], cid };
  }
  const g = db.groups[m[2]];
  if (!g || !g.members.includes(u.name)) return null;
  return { key: 'g:' + g.id, to: g.members.filter((x) => x !== u.name), cid, group: g };
}
function chatOf(key) { return db.chats[key] || (db.chats[key] = { msgs: [] }); }
function chatTitle(u, cid) {
  if (cid[0] === 'u') return cid.slice(2);
  const g = db.groups[cid.slice(2)];
  return g ? g.title : cid;
}
function chatList(u) {
  const out = [];
  for (const n in u.contacts) if (u.contacts[n] === 'ok') out.push('u.' + n);
  for (const gid of u.groups) if (db.groups[gid]) out.push('g.' + gid);
  return out.map((cid) => {
    const a = chatAccess(u, cid);
    const msgs = (a && db.chats[a.key] && db.chats[a.key].msgs) || [];
    const last = msgs[msgs.length - 1];
    const rd = u.read[a ? a.key : ''] || 0;
    return { id: cid, title: chatTitle(u, cid), group: cid[0] === 'g', unread: msgs.filter((x) => x.id > rd && x.f !== u.name).length,
      last: last ? { id: last.id, f: last.f, t: last.t, ts: last.ts } : null };
  }).sort((x, y) => ((y.last ? y.last.ts : 0) - (x.last ? x.last.ts : 0)) || x.title.localeCompare(y.title));
}
function meView(u) {
  const c = { ok: [], out: [], in: [] };
  for (const n in u.contacts) c[u.contacts[n]].push(n);
  return { name: u.name, cfg: u.cfg, contacts: c.ok.sort(), invitesOut: c.out.sort(), invitesIn: c.in.sort(), blocked: u.blocked.slice().sort(),
    groups: u.groups.filter((g) => db.groups[g]).map((g) => groupView(db.groups[g])),
    groupInvites: u.ginv.filter((g) => db.groups[g]).map((g) => groupView(db.groups[g])),
    timeline: !!u.tl, server: serverInfo() };
}
function groupView(g) { return { id: g.id, title: g.title, owner: g.owner, members: g.members.slice(), invited: g.invited.slice() }; }
function serverInfo() {
  return { name: SERVER_NAME, version: VERSION, registration: REGISTER_CODE ? 'code' : 'open', historyMax: HISTORY_MAX, historyDays: HISTORY_DAYS, textMax: TEXT_MAX };
}

/* Nachricht speichern und Empfänger benachrichtigen */
function postMessage(u, a, text) {
  const ch = chatOf(a.key);
  const msg = { id: ++db.seq, f: u.name, t: text, ts: now() };
  ch.msgs.push(msg);
  if (ch.msgs.length > HISTORY_MAX) ch.msgs.splice(0, ch.msgs.length - HISTORY_MAX);
  u.read[a.key] = msg.id;
  save();
  for (const n of a.to) {
    const r = db.users[n];
    if (r && r.tl && r.cfg.notify !== false && !r.blocked.includes(u.name)) pushPin(r, u, a, msg);
  }
  return msg;
}

/* ------------------------------------------------ Timeline-Benachrichtigung -- */
/* Die Pebble-App liefert je Nutzer einen Timeline-Token (nur bei Installation über den App-Store).
   Damit legt der Server einen Pin mit Benachrichtigung an – die Uhr meldet sich auch bei geschlossener App. */
let pinsSent = [];
function pushPin(r, u, a, msg) {
  if (TIMELINE_API === 'off') return;
  const t = now();
  pinsSent = pinsSent.filter((x) => t - x < 60000);
  if (pinsSent.length > 120) return;          // Notbremse gegen Fluten
  pinsSent.push(t);
  const title = a.group ? a.group.title + ': ' + u.name : u.name;
  const layout = { type: 'genericPin', title, body: msg.t, tinyIcon: 'system://images/GENERIC_EMAIL' };
  const pin = { id: 'psst-' + msg.id + '-' + r.name, time: new Date(msg.ts).toISOString(), layout,
    createNotification: { layout: { type: 'genericNotification', title, body: msg.t, tinyIcon: 'system://images/GENERIC_EMAIL' } },
    actions: [{ title: 'Antworten', type: 'openWatchApp', launchCode: 1 }] };
  const body = JSON.stringify(pin);
  try {
    const url = new URL(TIMELINE_API.replace(/\/$/, '') + '/v1/user/pins/' + encodeURIComponent(pin.id));
    const req = https.request(url, { method: 'PUT', timeout: 10000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-User-Token': r.tl } }, (res) => {
      res.resume();
      if (res.statusCode === 410 || res.statusCode === 403) { r.tl = ''; save(); }   // Token ungültig → nicht weiter versuchen
      else if (res.statusCode >= 300) console.error('Timeline', res.statusCode, 'für', r.name);
    });
    req.on('error', (e) => console.error('Timeline', e.message));
    req.on('timeout', () => req.destroy());
    req.end(body);
  } catch (e) { console.error('Timeline', e.message); }
}

/* ------------------------------------------------------------- Grenzen -- */
const buckets = new Map();
function limited(key, max, windowMs) {
  const t = now();
  const l = (buckets.get(key) || []).filter((x) => t - x < windowMs);
  if (l.length >= max) { buckets.set(key, l); return true; }
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
function otherUser(n) { const r = db.users[needName(n)]; if (!r) fail(404, 'Nutzer nicht gefunden'); return r; }
function unlinkContact(a, b) { delete a.contacts[b.name]; delete b.contacts[a.name]; }

const routes = [];
const route = (method, re, auth, fn) => routes.push({ method, re, auth, fn });

route('GET', /^\/v1\/info$/, false, () => serverInfo());

route('POST', /^\/v1\/register$/, false, (req, b) => {
  if (limited('reg:' + clientIp(req), 10, 3600000) || limited('reg', 100, 3600000)) fail(429, 'Zu viele Registrierungen, bitte später');
  if (REGISTER_CODE && String(b.code || '') !== REGISTER_CODE) fail(403, 'Registrierungscode falsch');
  const name = needName(b.name);
  if (db.users[name]) fail(409, 'Name schon vergeben');
  if (Object.keys(db.users).length >= MAX_USERS) fail(403, 'Server ist voll');
  const token = crypto.randomBytes(32).toString('hex');
  db.users[name] = newUser(name, token);
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
  }
  if (typeof b.timelineToken === 'string') u.tl = cleanText(b.timelineToken, 128).replace(/[^A-Za-z0-9_-]/g, '');
  save();
  return meView(u);
});

route('DELETE', /^\/v1\/me$/, true, (req, b, u) => {
  for (const n in u.contacts) if (db.users[n]) delete db.users[n].contacts[u.name];
  for (const gid of u.groups.concat(u.ginv)) leaveGroup(u, db.groups[gid]);
  for (const k in db.chats) if (k.startsWith('d:') && k.slice(2).split('|').includes(u.name)) delete db.chats[k];
  delete db.users[u.name];
  save();
  return { ok: true };
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
  if (st === 'in') { u.contacts[r.name] = 'ok'; r.contacts[u.name] = 'ok'; }
  else if (!r.blocked.includes(u.name)) { u.contacts[r.name] = 'out'; r.contacts[u.name] = 'in'; }
  else u.contacts[r.name] = 'out';             // Blockiert: sieht für den Absender aus wie eine offene Einladung
  save();
  return meView(u);
});
route('POST', /^\/v1\/contacts\/([a-z0-9_]{3,16})\/accept$/, true, (req, b, u, m) => {
  const r = otherUser(m[1]);
  if (u.contacts[r.name] !== 'in') fail(404, 'Keine Einladung von ' + r.name);
  u.contacts[r.name] = 'ok'; r.contacts[u.name] = 'ok';
  save();
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

/* Gruppen: Ersteller lädt Kontakte ein, Eingeladene nehmen an; jeder kann austreten */
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
route('DELETE', /^\/v1\/groups\/(g[a-f0-9]{10})$/, true, (req, b, u, m) => {   // austreten bzw. Einladung ablehnen
  leaveGroup(u, db.groups[m[1]]);
  save();
  return meView(u);
});

/* Chats und Nachrichten */
route('GET', /^\/v1\/chats$/, true, (req, b, u) => ({ seq: db.seq, chats: chatList(u), invites: meView(u).invitesIn.length + u.ginv.length }));
route('GET', /^\/v1\/chats\/([ug]\.[a-z0-9_]{3,16})\/messages$/, true, (req, b, u, m, q) => {
  const a = chatAccess(u, m[1]);
  if (!a) fail(404, 'Chat nicht gefunden');
  const limit = Math.max(1, Math.min(HISTORY_MAX, Number(q.get('limit')) || HISTORY_MAX));
  const msgs = ((db.chats[a.key] || {}).msgs || []).slice(-limit);
  return { chat: a.cid, title: chatTitle(u, a.cid), read: u.read[a.key] || 0, msgs };
});
route('POST', /^\/v1\/chats\/([ug]\.[a-z0-9_]{3,16})\/messages$/, true, (req, b, u, m) => {
  const a = chatAccess(u, m[1]);
  if (!a) fail(404, 'Chat nicht gefunden');
  const text = cleanText(b.text, TEXT_MAX);
  if (!text) fail(400, 'Nachricht ist leer');
  if (limited('msg:' + u.name, 30, 60000) || limited('msgh:' + u.name, 600, 3600000)) fail(429, 'Zu viele Nachrichten, bitte kurz warten');
  return { msg: postMessage(u, a, text) };
});
route('POST', /^\/v1\/chats\/([ug]\.[a-z0-9_]{3,16})\/read$/, true, (req, b, u, m) => {
  const a = chatAccess(u, m[1]);
  if (!a) fail(404, 'Chat nicht gefunden');
  const upTo = Math.min(db.seq, Number(b.upTo) || db.seq);
  if (upTo > (u.read[a.key] || 0)) { u.read[a.key] = upTo; save(); }
  return { ok: true };
});
/* Alles Neue seit "since" (Nachrichten-Nummer) – ein Aufruf reicht fürs Polling */
route('GET', /^\/v1\/poll$/, true, (req, b, u, m, q) => {
  const since = Number(q.get('since')) || 0;
  const out = [];
  if (since < db.seq) {
    for (const cid of chatList(u).map((c) => c.id)) {
      const a = chatAccess(u, cid);
      for (const msg of (db.chats[a.key] || { msgs: [] }).msgs) if (msg.id > since && msg.f !== u.name) out.push(Object.assign({ chat: cid }, msg));
    }
  }
  out.sort((x, y) => x.id - y.id);
  return { seq: db.seq, msgs: out.slice(-50), invites: meView(u).invitesIn.length + u.ginv.length };
});

/* --------------------------------------------------------------- HTTP -- */
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/impressum.html': 'impressum.html', '/favicon.svg': 'favicon.svg' };
const TYPES = { html: 'text/html; charset=utf-8', svg: 'image/svg+xml' };
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
function handleReq(req, res) {
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
    return fs.readFile(path.join(ROOT, 'public', f), (e, data) => {
      if (e) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': TYPES[f.split('.').pop()], 'Cache-Control': 'max-age=300' });
      res.end(data);
    });
  }
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
      send(res, 200, r.fn(req, body, u, r.re.exec(p), url.searchParams));
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
  pr.on('error', () => tryLead((ok) => { if (ok) { try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) { /* egal */ } handleReq(req, res); } else { try { res.writeHead(503); res.end(); } catch (e) { /* egal */ } } }));
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
  server.listen(PP ? 'passenger' : PORT, () => console.log('psst-Server ' + VERSION + ' läuft ' + (PP ? 'unter Passenger' : 'auf Port ' + PORT)));
});
