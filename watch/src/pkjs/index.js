/*
 * psst – Handy-Teil (PebbleKit JS). Spricht mit dem psst-Server und reicht alles an die Uhr weiter.
 * Server-Adresse und Geräte-Token liegen im localStorage; eingestellt wird über die Einstellungsseite.
 */
var DEFAULT_SERVER = 'https://watchietalkie.aize-it.de';
var CONFIG_URL = 'https://sgitaize.github.io/Pebble-WatchieTalkie/config/';
var C = { LIST_ITEM: 2, MSG_ITEM: 5, NEW_MSG: 7, QR_ITEM: 8, STATUS: 9, SENT: 10,
  READY: 20, OPEN: 21, SEND: 22, CLOSE: 23, ACCEPT: 24, DECLINE: 25 };
var K = { CHAT: 0, CONTACT_INVITE: 1, GROUP_INVITE: 2 };

var server = localStorage.getItem('psst.server') || DEFAULT_SERVER;
var token = localStorage.getItem('psst.token') || '';
var me = null;               // Antwort von /v1/me
var seq = -1;                // höchste bekannte Nachrichten-Nummer
var lastInvites = 0;
var openChat = '';
var lastActivity = Date.now();
var pollTimer = null;

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
var EMO = { '👍': '(y)', '👎': '(n)', '😀': ':D', '😃': ':D', '😄': ':D', '😁': ':D', '😂': 'xD', '🤣': 'xD', '😊': ':)', '🙂': ':)',
  '😉': ';)', '😍': '<3', '❤': '<3', '😘': ':*', '😢': ":'(", '😭': ":'(", '😮': ':O', '😛': ':P', '😜': ';P', '🙁': ':(',
  '😞': ':(', '😡': '>:(', '🤔': '(?)', '👋': 'o/', '🎉': '\\o/', '🙏': '(danke)', '👌': '(ok)' };
function plain(s) {
  s = String(s || '');
  for (var k in EMO) s = s.split(k).join(EMO[k]);
  return s.replace(/[\uFE0F\u200D]/g, '').replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '(emoji)');
}
/* Text auf eine Byte-Länge (UTF-8) kürzen, ohne Zeichen zu zerschneiden */
function trunc(s, bytes) {
  s = plain(s);
  if (unescape(encodeURIComponent(s)).length <= bytes) return s;
  while (s.length && unescape(encodeURIComponent(s + '…')).length > bytes) s = s.slice(0, -1);
  return s + '…';
}
function status(text) { toWatch({ CMD: C.STATUS, TEXT: trunc(text, 60) }); }

/* ---------------------------------------------------------------- Server -- */
function api(method, path, body, cb) {
  var x = new XMLHttpRequest();
  x.open(method, server.replace(/\/$/, '') + path, true);
  x.setRequestHeader('Content-Type', 'application/json');
  if (token) x.setRequestHeader('Authorization', 'Bearer ' + token);
  x.timeout = 15000;
  x.onload = function () {
    var j = null;
    try { j = JSON.parse(x.responseText); } catch (e) { /* leer */ }
    if (x.status >= 200 && x.status < 300) cb(null, j || {});
    else cb({ status: x.status, message: (j && j.error) || ('Fehler ' + x.status) });
  };
  x.onerror = x.ontimeout = function () { cb({ status: 0, message: 'Server nicht erreichbar' }); };
  x.send(body ? JSON.stringify(body) : null);
}

function sendQuickReplies() {
  var qr = (me && me.cfg && me.cfg.qr) || [];
  var vibe = !me || !me.cfg || me.cfg.vibe !== false ? 1 : 0;
  if (!qr.length) { toWatch({ CMD: C.QR_ITEM, IDX: 0, COUNT: 0, FLAGS: vibe }); return; }
  for (var i = 0; i < qr.length && i < 10; i++) toWatch({ CMD: C.QR_ITEM, IDX: i, COUNT: qr.length, TEXT: trunc(qr[i], 60), FLAGS: vibe });
}

function loadChats() {
  if (!token) {
    toWatch({ CMD: C.LIST_ITEM, IDX: 0, COUNT: 0 });
    status('Noch nicht eingerichtet. Öffne in der Pebble-App die Einstellungen von psst.');
    return;
  }
  api('GET', '/v1/me', null, function (err, m) {
    if (err) {
      toWatch({ CMD: C.LIST_ITEM, IDX: 0, COUNT: 0 });
      return status(err.status === 401 ? 'Anmeldung ungültig. Bitte in den Einstellungen neu einrichten.' : err.message);
    }
    me = m;
    sendQuickReplies();
    api('GET', '/v1/chats', null, function (err2, c) {
      if (err2) return status(err2.message);
      if (seq < 0) seq = c.seq;
      var items = [];
      m.invitesIn.forEach(function (n) { items.push({ id: 'u.' + n, title: n, kind: K.CONTACT_INVITE, unread: 0, text: '' }); });
      m.groupInvites.forEach(function (g) { items.push({ id: 'g.' + g.id, title: g.title, kind: K.GROUP_INVITE, unread: 0, text: '' }); });
      c.chats.forEach(function (ch) {
        var prev = ch.last ? (ch.group && ch.last.f !== m.name ? ch.last.f + ': ' : (ch.last.f === m.name ? 'Du: ' : '')) + ch.last.t : (ch.group ? 'Gruppe' : '');
        items.push({ id: ch.id, title: ch.title, kind: K.CHAT, unread: Math.min(ch.unread, 99), text: prev });
      });
      lastInvites = c.invites;
      var max = platform() === 'aplite' ? 12 : 20;
      items = items.slice(0, max);
      if (!items.length) {
        toWatch({ CMD: C.LIST_ITEM, IDX: 0, COUNT: 0 });
        return status('Hallo ' + m.name + '! Noch keine Kontakte – lade Freunde in den Einstellungen ein.');
      }
      items.forEach(function (it, i) {
        toWatch({ CMD: C.LIST_ITEM, IDX: i, COUNT: items.length, CHAT: it.id, TITLE: trunc(it.title, 25), TEXT: trunc(it.text, 43), UNREAD: it.unread, KIND: it.kind });
      });
    });
  });
}

function loadMessages(cid) {
  api('GET', '/v1/chats/' + cid + '/messages?limit=' + maxMsgs(), null, function (err, r) {
    if (openChat !== cid) return;
    if (err) return status(err.message);
    var msgs = r.msgs || [];
    if (!msgs.length) { toWatch({ CMD: C.MSG_ITEM, CHAT: cid, IDX: 0, COUNT: 0 }); return; }
    var bytes = platform() === 'aplite' ? 200 : 400;
    msgs.forEach(function (msg, i) {
      toWatch({ CMD: C.MSG_ITEM, CHAT: cid, IDX: i, COUNT: msgs.length, FROM: msg.f, TEXT: trunc(msg.t, bytes), FLAGS: msg.f === (me && me.name) ? 1 : 0 });
    });
    api('POST', '/v1/chats/' + cid + '/read', { upTo: msgs[msgs.length - 1].id }, function () {});
  });
}

function sendMessage(cid, text) {
  api('POST', '/v1/chats/' + cid + '/messages', { text: text }, function (err) {
    toWatch(err ? { CMD: C.SENT, FLAGS: 0, TEXT: trunc(err.message, 60) } : { CMD: C.SENT, FLAGS: 1 });
  });
}

function answerInvite(cid, accept) {
  var n = cid.slice(2);
  var done = function (err) { if (err) status(err.message); loadChats(); };
  if (cid.charAt(0) === 'u') api(accept ? 'POST' : 'DELETE', '/v1/contacts/' + n + (accept ? '/accept' : ''), null, done);
  else api(accept ? 'POST' : 'DELETE', '/v1/groups/' + n + (accept ? '/accept' : ''), null, done);
}

/* ---------------------------------------------------------------- Polling -- */
/* Nur solange die App offen ist: erst alle 5 s, nach 3 min Ruhe alle 15 s, nach 10 min alle 30 s. */
function schedulePoll() {
  clearTimeout(pollTimer);
  var idle = Date.now() - lastActivity;
  pollTimer = setTimeout(poll, idle < 180000 ? 5000 : (idle < 600000 ? 15000 : 30000));
}
var polling = false;
function poll() {
  if (polling) return;
  if (!token || seq < 0) return schedulePoll();
  polling = true;
  api('GET', '/v1/poll?since=' + seq, null, function (err, r) {
    polling = false;
    if (!err && r.seq >= seq) {
      var fresh = r.msgs || [];
      fresh = fresh.filter(function (msg) { return msg.id > seq; });
      fresh.forEach(function (msg) {
        toWatch({ CMD: C.NEW_MSG, CHAT: msg.chat, FROM: msg.f, TEXT: trunc(msg.t, platform() === 'aplite' ? 200 : 400) });
        if (msg.chat === openChat) api('POST', '/v1/chats/' + msg.chat + '/read', { upTo: msg.id }, function () {});
      });
      seq = Math.max(seq, r.seq);
      if (fresh.length) lastActivity = Date.now();
      if (fresh.length || r.invites !== lastInvites) loadChats();
    }
    schedulePoll();
  });
}

/* ---------------------------------------------------------- Timeline-Token -- */
function registerTimeline() {
  if (!token || typeof Pebble.getTimelineToken !== 'function') return;
  Pebble.getTimelineToken(function (tl) {
    if (!tl || tl === localStorage.getItem('psst.tl.' + token.slice(0, 8))) return;
    api('PUT', '/v1/me', { timelineToken: tl }, function (err) {
      if (!err) localStorage.setItem('psst.tl.' + token.slice(0, 8), tl);
    });
  }, function () { /* kein Timeline-Token (z. B. nicht aus dem Store installiert) */ });
}

/* ---------------------------------------------------------------- Ereignisse -- */
Pebble.addEventListener('ready', function () {
  loadChats();
  registerTimeline();
  schedulePoll();
});

Pebble.addEventListener('appmessage', function (e) {
  var p = e.payload || {};
  var cmd = p.CMD, cid = p.CHAT || '';
  lastActivity = Date.now();
  if (cmd === C.READY) loadChats();
  else if (cmd === C.OPEN) { openChat = cid; loadMessages(cid); }
  else if (cmd === C.CLOSE) { openChat = ''; loadChats(); }
  else if (cmd === C.SEND && p.TEXT) sendMessage(cid, p.TEXT);
  else if (cmd === C.ACCEPT) answerInvite(cid, true);
  else if (cmd === C.DECLINE) answerInvite(cid, false);
  schedulePoll();
});

Pebble.addEventListener('showConfiguration', function () {
  var data = { server: server, token: token, platform: platform() };
  Pebble.openURL(CONFIG_URL + '#' + encodeURIComponent(JSON.stringify(data)));
});

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) return;
  var d;
  try { d = JSON.parse(decodeURIComponent(e.response)); } catch (x) { try { d = JSON.parse(e.response); } catch (y) { return; } }
  if (!d || typeof d !== 'object') return;
  if (typeof d.server === 'string' && /^https?:\/\//.test(d.server)) { server = d.server.replace(/\/$/, ''); localStorage.setItem('psst.server', server); }
  if (typeof d.token === 'string' && (d.token === '' || /^[a-f0-9]{64}$/.test(d.token))) { token = d.token; localStorage.setItem('psst.token', token); }
  seq = -1; me = null;
  loadChats();
  registerTimeline();
});
