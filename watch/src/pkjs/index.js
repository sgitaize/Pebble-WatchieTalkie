/*
 * WatchieTalkie2 – Handy-Teil (PebbleKit JS). Spricht mit dem Server und reicht alles an die Uhr weiter.
 * Server-Adresse, Geräte-Token und geheimer Schlüssel liegen im localStorage; eingerichtet wird über die Einstellungsseite.
 * Nachrichten werden hier ver- und entschlüsselt (e2e.js) – der Server sieht nur Chiffretext.
 */
var E2E = require('./e2e');
E2E.init({ get: function (k) { return localStorage.getItem(k); }, set: function (k, v) { localStorage.setItem(k, v); } });
var DEFAULT_SERVER = 'https://watchietalkie.aize-it.de';
var CONFIG_URL = 'https://sgitaize.github.io/Pebble-WatchieTalkie/config/';
var C = { LIST_ITEM: 2, MSG_ITEM: 5, NEW_MSG: 7, QR_ITEM: 8, STATUS: 9, SENT: 10,
  READY: 20, OPEN: 21, SEND: 22, CLOSE: 23, ACCEPT: 24, DECLINE: 25, SEND_VOICE: 26, TEST: 27, BEEP: 28, DELETE: 29, PAUSE: 30, PUSH: 11, LOOK: 12 };
var SYS_CID = 'u.watchietalkie';     // System-Chat des Servers (Testnachrichten, nur lesbar)
var K = { CHAT: 0, CONTACT_INVITE: 1, GROUP_INVITE: 2 };

var server = localStorage.getItem('wt.server') || DEFAULT_SERVER;
var token = localStorage.getItem('wt.token') || '';
var keys = {};               // Name → öffentlicher Schlüssel (vom Server, gegen gespeicherte Stände geprüft)
var TEXT_MAX = 300;
var me = null;               // Antwort von /v1/me
var seq = -1;                // höchste bekannte Nachrichten-Nummer
var lastInvites = 0;
var openChat = '';
var pollTimer = null;
var listOk = false;          // Chat-Liste steht (auch leer) auf der Uhr

function platform() {
  try { return Pebble.getActiveWatchInfo().platform; } catch (e) { return 'basalt'; }
}
function maxMsgs() { return platform() === 'aplite' ? 10 : 30; }

/* ---------------------------------------------------------- Uhr-Warteschlange -- */
var queue = [], sending = false;
function toWatch(dict) { queue.push(dict); pump(); }
function pump() {
  if (sending || !queue.length) return;
  sending = true;
  var d = queue[0], tries = 0;
  function attempt() {
    Pebble.sendAppMessage(d, function () { queue.shift(); sending = false; pump(); }, function () {
      if (++tries < 4) setTimeout(attempt, 400);
      else { queue.shift(); sending = false; pump(); }
    });
  }
  attempt();
}
/* Die Uhr-Schriften kennen kaum Emojis → gängige in Text-Smileys umwandeln, übrige als (emoji) */
var EMO = { '\uD83D\uDC4D': '(y)', '\uD83D\uDC4E': '(n)', '\uD83D\uDE00': ':D', '\uD83D\uDE03': ':D', '\uD83D\uDE04': ':D', '\uD83D\uDE01': ':D', '\uD83D\uDE02': 'xD', '\uD83E\uDD23': 'xD', '\uD83D\uDE0A': ':)', '\uD83D\uDE42': ':)',
  '\uD83D\uDE09': ';)', '\uD83D\uDE0D': '<3', '\u2764': '<3', '\uD83D\uDE18': ':*', '\uD83D\uDE22': ":'(", '\uD83D\uDE2D': ":'(", '\uD83D\uDE2E': ':O', '\uD83D\uDE1B': ':P', '\uD83D\uDE1C': ';P', '\uD83D\uDE41': ':(',
  '\uD83D\uDE1E': ':(', '\uD83D\uDE21': '>:(', '\uD83E\uDD14': '(?)', '\uD83D\uDC4B': 'o/', '\uD83C\uDF89': '\\o/', '\uD83D\uDE4F': '(thanks)', '\uD83D\uDC4C': '(ok)' };
function plain(s) {
  s = String(s || '');
  for (var k in EMO) s = s.split(k).join(EMO[k]);
  return s.replace(/[\uFE0F\u200D]/g, '').replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '(emoji)');
}
/* Nachricht nur aus 1–3 Emojis, die die Uhr als Bild hat (EMOJI[] in main.c)? → kanonische Emojis, sonst null.
   Verwandte Emojis werden auf das nächste Bild abgebildet. */
var EMO_IMG = ['\uD83D\uDC4D', '\uD83D\uDE0A', '\uD83D\uDE02', '\u2764', '\uD83D\uDE09', '\uD83D\uDE00', '\uD83D\uDE18', '\uD83D\uDE2E',
  '\uD83D\uDE22', '\uD83D\uDE1E', '\uD83D\uDE21', '\uD83E\uDD14', '\uD83D\uDC4B', '\uD83C\uDF89', '\uD83D\uDE4F', '\uD83D\uDC4C', '\uD83D\uDC4E'];
var EMO_ALIAS = { '\uD83D\uDE03': '\uD83D\uDE00', '\uD83D\uDE04': '\uD83D\uDE00', '\uD83D\uDE01': '\uD83D\uDE00', '\uD83E\uDD23': '\uD83D\uDE02',
  '\uD83D\uDE42': '\uD83D\uDE0A', '\uD83D\uDE2D': '\uD83D\uDE22', '\uD83D\uDE41': '\uD83D\uDE1E', '\uD83D\uDE20': '\uD83D\uDE21' };
function emojiOnly(s) {
  var t = String(s || '').replace(/[\uFE0F\u200D\s]|\uD83C[\uDFFB-\uDFFF]/g, ''), out = [];
  var parts = t.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\s\S]/g) || [];
  if (!parts.length || parts.length > 3) return null;
  for (var i = 0; i < parts.length; i++) {
    var e = EMO_ALIAS[parts[i]] || parts[i];
    if (EMO_IMG.indexOf(e) < 0) return null;
    out.push(e);
  }
  return out.join('');
}
/* Nachrichtentext für die Uhr: reine Emoji-Nachricht als echte Emojis (Uhr zeigt Bilder), sonst Text */
function msgText(s, bytes) { return emojiOnly(s) || trunc(s, bytes); }
/* Text auf eine Byte-Länge (UTF-8) kürzen, ohne Zeichen zu zerschneiden */
function trunc(s, bytes) {
  s = plain(s);
  if (unescape(encodeURIComponent(s)).length <= bytes) return s;
  while (s.length && unescape(encodeURIComponent(s + '…')).length > bytes) s = s.slice(0, -1);
  return s + '…';
}
function status(text) { toWatch({ CMD: C.STATUS, TEXT: trunc(text, 150) }); }

/* ---------------------------------------------------------------- Server -- */
function api(method, path, body, cb) {
  var x = new XMLHttpRequest();
  x.open(method, server.replace(/\/$/, '') + path, true);
  x.setRequestHeader('Content-Type', 'application/json');
  x.setRequestHeader('Accept-Language', 'en');
  if (token) x.setRequestHeader('Authorization', 'Bearer ' + token);
  var ms = path.indexOf('wait=') >= 0 ? 40000 : 15000, done = false;
  x.timeout = ms;
  /* eigene Zeitgrenze zusätzlich zu x.timeout – nicht jede Handy-App löst ontimeout zuverlässig aus */
  var guard = setTimeout(function () { finish({ status: 0, message: 'Server not responding' }); try { x.abort(); } catch (e) { /* egal */ } }, ms + 2000);
  function finish(err, j) { if (done) return; done = true; clearTimeout(guard); cb(err, j); }
  x.onload = function () {
    var j = null;
    try { j = JSON.parse(x.responseText); } catch (e) { /* leer */ }
    if (x.status >= 200 && x.status < 300) finish(null, j || {});
    else finish({ status: x.status, message: (j && j.error) || ('Error ' + x.status) });
  };
  x.onerror = x.ontimeout = function () { finish({ status: 0, message: 'Server unreachable' }); };
  x.send(body ? JSON.stringify(body) : null);
}
/* Vorübergehende Fehler (offline, Server down/überlastet) → automatisch erneut versuchen */
function transient(err) { return !err.status || err.status === 408 || err.status === 429 || err.status >= 500; }
function errText(err) {
  if (!err.status) return err.message;
  return transient(err) ? 'Server busy or down (' + err.status + ')' : err.message;
}
var retries = {};            // Schlüssel → { t: Timer, d: letzte Wartezeit in s }; 5 → 10 → 20 → 40 → 60 s
function retryLater(key, fn) {
  var r = retries[key] || (retries[key] = { t: null, d: 0 });
  if (r.t) return r.d;       // schon geplant (z. B. zwei parallele Anfragen gescheitert)
  r.d = Math.min(r.d ? r.d * 2 : 5, 60);
  r.t = setTimeout(function () { r.t = null; fn(); }, r.d * 1000);
  return r.d;
}
function retryDone(key) { var r = retries[key]; if (r) { clearTimeout(r.t); r.t = null; r.d = 0; } }

function sendQuickReplies() {
  var qr = (me && me.cfg && me.cfg.qr) || [];
  var vibe = (!me || !me.cfg || me.cfg.vibe !== false ? 1 : 0) | (!me || !me.cfg || me.cfg.beep !== false ? 2 : 0);
  if (!qr.length) toWatch({ CMD: C.QR_ITEM, IDX: 0, COUNT: 0, FLAGS: vibe });
  for (var i = 0; i < qr.length && i < 10; i++) toWatch({ CMD: C.QR_ITEM, IDX: i, COUNT: qr.length, TEXT: trunc(qr[i], 60), FLAGS: vibe });
  sendPush();
}
/* Stand der Handy-Benachrichtigung an die Uhr: eingerichtet?, Restminuten der Pause, Pausendauer */
function sendPush() {
  var c = (me && me.cfg) || {};
  var push = c.push !== undefined ? c.push : (c.ntfy ? 'ntfy' : '');
  toWatch({ CMD: C.PUSH, FLAGS: push && c.notify !== false ? 1 : 0, IDX: (me && me.pauseLeft) || 0, COUNT: c.pauseMin || 15 });
}
/* Aussehen auf der Uhr (nur auf diesem Handy gespeichert): Schriftgröße 0–2, Farben '#RRGGBB', Licht an */
function getLook() {
  var l = {}; try { l = JSON.parse(localStorage.getItem('wt.look') || '{}') || {}; } catch (e) { l = {}; }
  var hex = /^#[0-9a-f]{6}$/i;
  return { font: [0, 1, 2].indexOf(l.font) >= 0 ? l.font : 0, bg: hex.test(l.bg) ? l.bg : '#FFFFFF',
    fg: hex.test(l.fg) ? l.fg : '#000000', light: l.light === true };
}
function gcolor(hex) {   // '#RRGGBB' → GColor8 (2 Bit je Kanal)
  var n = parseInt(hex.slice(1), 16);
  return 0xC0 | ((n >> 22) & 3) << 4 | ((n >> 14) & 3) << 2 | ((n >> 6) & 3);
}
function sendLook() {
  var l = getLook();
  toWatch({ CMD: C.LOOK, IDX: l.font, COUNT: gcolor(l.bg) << 8 | gcolor(l.fg), FLAGS: l.light ? 1 : 0 });
}
/* Handy-Benachrichtigungen pausieren/fortsetzen (Menü auf der Uhr) */
function setPause(on) {
  if (!token) return;
  api('POST', '/v1/me/pause', { on: on }, function (err, r) {
    if (err) return status(errText(err));
    me = r;
    sendPush();
  });
}

/* Schlüssel der Kontakte holen; geänderte Schlüssel melden (möglicher Angriff oder neues Handy des Kontakts) */
function loadKeys(cb) {
  api('GET', '/v1/keys', null, function (err, r) {
    if (err) return cb(err);
    var pins = {}, changed = [];
    try { pins = JSON.parse(localStorage.getItem('wt.pins') || '{}'); } catch (e) { pins = {}; }
    keys = r.keys || {};
    for (var n in keys) {
      if (pins[n] && pins[n] !== keys[n] && n !== (me && me.name)) changed.push(n);
      pins[n] = keys[n];
    }
    localStorage.setItem('wt.pins', JSON.stringify(pins));
    if (changed.length) {
      var old = []; try { old = JSON.parse(localStorage.getItem('wt.changed') || '[]'); } catch (e) { old = []; }
      changed.forEach(function (n) { if (old.indexOf(n) < 0) old.push(n); });
      localStorage.setItem('wt.changed', JSON.stringify(old));
      status(('Warning: security key of ' + changed.join(', ') + ' changed. Check in settings.'));
    }
    cb(null);
  });
}
function readable(msg) {
  if (msg && msg.t && msg.f === 'watchietalkie') return msg.t;   // Systemnachricht (Klartext vom Server)
  if (!msg || !msg.e) return '';
  var pk = msg.f === (me && me.name) ? E2E.publicKey() : keys[msg.f];
  var t = pk ? E2E.decrypt(msg.e, pk) : null;
  return t === null ? '[unreadable]' : t;
}
/* Empfänger eines Chats mit Schlüsseln; fehlende Schlüssel werden gemeldet */
function recipients(cid) {
  var names = [];
  if (cid.charAt(0) === 'u') names = [cid.slice(2)];
  else (me && me.groups || []).forEach(function (g) { if ('g.' + g.id === cid) names = g.members.filter(function (n) { return n !== me.name; }); });
  var r = {}, missing = [];
  r[me.name] = E2E.publicKey();
  names.forEach(function (n) { if (keys[n]) r[n] = keys[n]; else missing.push(n); });
  return { keys: r, missing: missing, total: names.length };
}
function changedList() { try { return JSON.parse(localStorage.getItem('wt.changed') || '[]'); } catch (e) { return []; } }

/* Liste konnte nicht geladen werden: bei Server-/Netzproblemen automatisch neu versuchen.
   Steht schon eine Liste auf der Uhr, bleibt sie stehen und es wird still weiter versucht. */
function listFailed(err) {
  if (!transient(err)) {
    retryDone('list');
    toWatch({ CMD: C.LIST_ITEM, IDX: 0, COUNT: 0 });
    listOk = false;
    return status(err.status === 401 ? 'Login invalid. Please set up again in the settings.' : err.message);
  }
  var s = retryLater('list', loadChats);
  if (listOk) return;
  toWatch({ CMD: C.LIST_ITEM, IDX: 0, COUNT: 0 });
  status(errText(err) + '. Retrying in ' + s + ' s ... (SELECT: retry now)');
}

function loadChats() {
  if (!token) {
    toWatch({ CMD: C.LIST_ITEM, IDX: 0, COUNT: 0 });
    status('Not set up yet. Open the WatchieTalkie2 settings in the Pebble app.');
    return;
  }
  if (!listOk) status('Loading chats ...');   // Uhr zeigt bis dahin „Connecting to phone …“
  api('GET', '/v1/me', null, function (err, m) {
    if (err) return listFailed(err);
    me = m;
    sendQuickReplies();
    if (!E2E.ready()) {
      toWatch({ CMD: C.LIST_ITEM, IDX: 0, COUNT: 0 });
      return status('Keys missing. Please open the settings once and save.');
    }
    if (m.pubKey !== E2E.publicKey()) api('PUT', '/v1/me', { pubKey: E2E.publicKey() }, function () {});
    loadKeys(function () { api('GET', '/v1/chats', null, function (err2, c) {
      if (err2) return listFailed(err2);
      retryDone('list');
      listOk = true;
      if (seq < 0) seq = c.seq;
      var items = [];
      m.invitesIn.forEach(function (n) { items.push({ id: 'u.' + n, title: n, kind: K.CONTACT_INVITE, unread: 0, text: '' }); });
      m.groupInvites.forEach(function (g) { items.push({ id: 'g.' + g.id, title: g.title, kind: K.GROUP_INVITE, unread: 0, text: '' }); });
      c.chats.forEach(function (ch) {
        var prev = ch.last ? (ch.group && ch.last.f !== m.name ? ch.last.f + ': ' : (ch.last.f === m.name ? 'You: ' : '')) + readable(ch.last) : (ch.group ? 'Group' : '');
        if (!ch.group && changedList().indexOf(ch.title) >= 0) prev = '! Key changed';
        items.push({ id: ch.id, title: ch.title, kind: K.CHAT, unread: Math.min(ch.unread, 99), text: prev });
      });
      lastInvites = c.invites;
      var max = platform() === 'aplite' ? 12 : 20;
      items = items.slice(0, max);
      if (!items.length) {
        toWatch({ CMD: C.LIST_ITEM, IDX: 0, COUNT: 0 });
        return status(('Hi ' + m.name + '! No contacts yet - invite friends in the settings. Press SELECT for a test message.'));
      }
      items.forEach(function (it, i) {
        toWatch({ CMD: C.LIST_ITEM, IDX: i, COUNT: items.length, CHAT: it.id, TITLE: trunc(it.title, 25), TEXT: trunc(it.text, 43), UNREAD: it.unread, KIND: it.kind });
      });
    }); });
  });
}

function loadMessages(cid) {
  api('GET', '/v1/chats/' + cid + '/messages?limit=' + maxMsgs(), null, function (err, r) {
    if (openChat !== cid) return;
    if (err && !transient(err)) return status(err.message);
    if (err) {
      var s = retryLater('msgs', function () { if (openChat === cid) loadMessages(cid); });
      return status(errText(err) + '. Retrying in ' + s + ' s ...');
    }
    retryDone('msgs');
    var msgs = r.msgs || [];
    if (!msgs.length) { toWatch({ CMD: C.MSG_ITEM, CHAT: cid, IDX: 0, COUNT: 0 }); return; }
    var bytes = platform() === 'aplite' ? 200 : 400;
    msgs.forEach(function (msg, i) {
      toWatch({ CMD: C.MSG_ITEM, CHAT: cid, IDX: i, COUNT: msgs.length, FROM: msg.f, TEXT: msgText(readable(msg), bytes), FLAGS: msg.f === (me && me.name) ? 1 : 0 });
    });
    api('POST', '/v1/chats/' + cid + '/read', { upTo: msgs[msgs.length - 1].id }, function () {});
  });
}

function sendMessage(cid, text, voice) {
  var fail = function (msg) { toWatch({ CMD: C.SENT, FLAGS: 0, TEXT: trunc(msg, 60) }); };
  if (!me || !E2E.ready()) return fail('Not set up');
  if (cid === SYS_CID) return fail('This chat is read-only');
  var r = recipients(cid);
  if (r.total && r.missing.length === r.total) return fail(r.missing.join(', ') + ' must open WatchieTalkie2 first');
  var e;
  try { e = E2E.encrypt(String(text).slice(0, TEXT_MAX), r.keys); } catch (x) { return fail('Encryption failed'); }
  api('POST', '/v1/chats/' + cid + '/messages', { e: e, voice: !!voice }, function (err) {
    toWatch(err ? { CMD: C.SENT, FLAGS: 0, TEXT: trunc(errText(err), 60) } : { CMD: C.SENT, FLAGS: 1 });
  });
}

/* Eigene letzte Nachricht im Chat löschen (verschwindet für alle), danach Chat neu laden */
function deleteLast(cid) {
  var fail = function (msg) { toWatch({ CMD: C.SENT, FLAGS: 0, TEXT: trunc(msg, 60) }); };
  if (!me) return fail('Not set up');
  if (cid === SYS_CID) return fail('This chat is read-only');
  api('GET', '/v1/chats/' + cid + '/messages', null, function (err, r) {
    if (err) return fail(err.message);
    var mine = (r.msgs || []).filter(function (msg) { return msg.f === me.name; }).pop();
    if (!mine) return fail('No message of yours to delete');
    api('DELETE', '/v1/chats/' + cid + '/messages/' + mine.id, null, function (err2) {
      if (err2) return fail(err2.message);
      status('Message deleted');
      if (openChat === cid) loadMessages(cid);
    });
  });
}

/* Testnachricht vom Server anfordern – kommt wie eine echte Nachricht über das Polling */
function requestTest() {
  if (!token) return status('Not set up yet. Open the WatchieTalkie2 settings in the Pebble app.');
  if (!me || !listOk) { status('Loading ...'); return loadChats(); }   // Liste fehlt noch (Serverfehler): SELECT = sofort neu versuchen
  status('Requesting test message ...');
  api('POST', '/v1/test', { delay: 0 }, function (err) { if (err) status(err.message); });
}

function answerInvite(cid, accept) {
  var n = cid.slice(2);
  var done = function (err) { if (err) status(err.message); loadChats(); };
  if (cid.charAt(0) === 'u') api(accept ? 'POST' : 'DELETE', '/v1/contacts/' + n + (accept ? '/accept' : ''), null, done);
  else api(accept ? 'POST' : 'DELETE', '/v1/groups/' + n + (accept ? '/accept' : ''), null, done);
}

/* ---------------------------------------------------------------- Polling -- */
/* Long-Polling, nur solange die App offen ist: eine Anfrage wartet bis zu 25 s auf dem Server und kommt
   sofort zurück, wenn etwas Neues da ist. Spart Funk (Akku) gegenüber festen Intervallen und ist schneller. */
var polling = false;
function schedulePoll(delay) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, delay || 0);
}
function poll() {
  if (polling) return;
  if (!token || seq < 0) return schedulePoll(3000);
  polling = true;
  api('GET', '/v1/poll?wait=25&since=' + seq + '&invites=' + lastInvites, null, function (err, r) {
    polling = false;
    if (err) return schedulePoll(15000);              // offline oder Server weg: in Ruhe erneut versuchen
    var fresh = [];
    if (r.seq >= seq) {
      fresh = (r.msgs || []).filter(function (msg) { return msg.id > seq; });
      fresh.forEach(function (msg) {
        toWatch({ CMD: C.NEW_MSG, CHAT: msg.chat, FROM: msg.f, TEXT: msgText(readable(msg), platform() === 'aplite' ? 200 : 400) });
        if (msg.chat === openChat) api('POST', '/v1/chats/' + msg.chat + '/read', { upTo: msg.id }, function () {});
      });
      seq = Math.max(seq, r.seq);
    }
    var invitesChanged = r.invites !== lastInvites;
    lastInvites = r.invites;
    var del = r.del || [];                               // Chats, in denen jemand eine Nachricht gelöscht hat
    if (openChat && del.indexOf(openChat) >= 0) loadMessages(openChat);
    if (fresh.length || invitesChanged || del.length) loadChats();
    schedulePoll(500);
  });
}

/* Piep an/aus direkt auf der Uhr (langes SELECT in der Liste) – gleiche Einstellung wie auf der Einstellungsseite */
function setBeep(on) {
  if (!token) return;
  api('PUT', '/v1/me', { cfg: { beep: on } }, function (err, r) { if (!err && r) me = r; });
}

/* ---------------------------------------------------------- Timeline-Token -- */
function registerTimeline() {
  if (!token || typeof Pebble.getTimelineToken !== 'function') return;
  Pebble.getTimelineToken(function (tl) {
    if (!tl || tl === localStorage.getItem('wt.tl.' + token.slice(0, 8))) return;
    api('PUT', '/v1/me', { timelineToken: tl }, function (err) {
      if (!err) localStorage.setItem('wt.tl.' + token.slice(0, 8), tl);
    });
  }, function () { /* kein Timeline-Token (z. B. nicht aus dem Store installiert) */ });
}

/* ---------------------------------------------------------------- Ereignisse -- */
Pebble.addEventListener('ready', function () {
  sendLook();
  loadChats();
  registerTimeline();
  schedulePoll();
});

Pebble.addEventListener('appmessage', function (e) {
  var p = e.payload || {};
  var cmd = p.CMD, cid = p.CHAT || '';
  if (cmd === C.READY) loadChats();
  else if (cmd === C.OPEN) { openChat = cid; loadMessages(cid); }
  else if (cmd === C.CLOSE) { openChat = ''; retryDone('msgs'); loadChats(); }
  else if ((cmd === C.SEND || cmd === C.SEND_VOICE) && p.TEXT) sendMessage(cid, p.TEXT, cmd === C.SEND_VOICE);
  else if (cmd === C.ACCEPT) answerInvite(cid, true);
  else if (cmd === C.DECLINE) answerInvite(cid, false);
  else if (cmd === C.TEST) requestTest();
  else if (cmd === C.BEEP) setBeep(p.TEXT === '1');
  else if (cmd === C.DELETE) deleteLast(cid);
  else if (cmd === C.PAUSE) setPause(p.TEXT === '1');
});

Pebble.addEventListener('showConfiguration', function () {
  var pins = {}, fps = {};
  try { pins = JSON.parse(localStorage.getItem('wt.pins') || '{}'); } catch (e) { pins = {}; }
  for (var n in pins) fps[n] = E2E.fingerprint(pins[n]);
  var data = { server: server, token: token, platform: platform(), hasKey: E2E.ready(), sk: localStorage.getItem('wt.sk') || '',
    fp: E2E.ready() ? E2E.fingerprint(E2E.publicKey()) : '', fps: fps, changed: changedList(), look: getLook() };
  Pebble.openURL(CONFIG_URL + '?v=' + Date.now() + '#' + encodeURIComponent(JSON.stringify(data)));
});

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) return;
  var d;
  try { d = JSON.parse(decodeURIComponent(e.response)); } catch (x) { try { d = JSON.parse(e.response); } catch (y) { return; } }
  if (!d || typeof d !== 'object') return;
  if (typeof d.server === 'string' && /^https?:\/\//.test(d.server)) { server = d.server.replace(/\/$/, ''); localStorage.setItem('wt.server', server); }
  if (typeof d.token === 'string' && (d.token === '' || /^[a-f0-9]{64}$/.test(d.token))) { token = d.token; localStorage.setItem('wt.token', token); }
  if (typeof d.sk === 'string' && d.sk) E2E.setKeys(d.sk, d.seed || '');
  if (d.ackChanged) localStorage.removeItem('wt.changed');
  if (d.look && typeof d.look === 'object') { localStorage.setItem('wt.look', JSON.stringify(d.look)); sendLook(); }
  seq = -1; me = null; listOk = false;
  loadChats();
  registerTimeline();
});
