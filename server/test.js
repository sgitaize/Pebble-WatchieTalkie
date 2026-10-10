/**
 * API-Test: startet den Server auf einem freien Port mit leerem Datenordner und spielt die Abläufe durch.
 * Nutzung: node test.js            (gegen lokalen Server)
 *          node test.js https://…  (gegen laufenden Server – legt Testkonten an und löscht sie wieder)
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let base = process.argv[2];
let child = null, checks = 0, failed = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failed++; console.log('✗ ' + msg); } };
async function api(method, p, body, token) {
  const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) { /* leer */ }
  return { status: r.status, body: j };
}

const rnd = (n) => require('crypto').randomBytes(n).toString('base64');
/* Verschlüsselte Nachricht simulieren (Server prüft nur die Form): Umschlag je Empfänger */
const enc = (names) => ({ v: 1, n: rnd(24), c: rnd(40), k: Object.fromEntries(names.map((x) => [x, rnd(72)])) });

async function main() {
  if (!base) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
    for (const f of ['server.js', 'pages']) fs.cpSync(path.join(__dirname, f), path.join(dir, f), { recursive: true });
    const port = 30000 + Math.floor(Math.random() * 20000);
    child = spawn(process.execPath, [path.join(dir, 'server.js')], { env: Object.assign({}, process.env, { PORT: port, TIMELINE_API: 'off', ADMIN_KEY: 'test-admin-key' }), stdio: 'inherit' });
    base = 'http://127.0.0.1:' + port;
    for (let i = 0; i < 50; i++) { try { await fetch(base + '/v1/info'); break; } catch (e) { await new Promise((r) => setTimeout(r, 100)); } }
  }
  base = base.replace(/\/$/, '');
  const sfx = Math.random().toString(36).slice(2, 7);
  const [A, B, C] = ['ta_' + sfx, 'tb_' + sfx, 'tc_' + sfx];

  const info = await api('GET', '/v1/info');
  ok(info.status === 200 && info.body.name, 'info');
  ok((await api('POST', '/v1/register', { name: 'X' })).status === 400, 'Name zu kurz abgelehnt');
  const ra = await api('POST', '/v1/register', { name: A , test: true });
  const rb = await api('POST', '/v1/register', { name: B.toUpperCase() , test: true });
  const rc = await api('POST', '/v1/register', { name: C , test: true });
  ok(ra.status === 200 && /^[a-f0-9]{64}$/.test(ra.body.token), 'Registrierung A');
  ok(rb.status === 200 && rb.body.name === B, 'Registrierung B (klein geschrieben)');
  ok((await api('POST', '/v1/register', { name: A })).status === 409, 'Doppelter Name abgelehnt');
  const [ta, tb, tc] = [ra.body.token, rb.body.token, rc.body.token];
  ok((await api('GET', '/v1/me')).status === 401, 'ohne Token 401');
  ok((await api('GET', '/v1/me', null, 'f'.repeat(64))).status === 401, 'falscher Token 401');

  // Einladung A → B, B nimmt an
  let r = await api('POST', '/v1/contacts', { name: B }, ta);
  ok(r.status === 200 && r.body.invitesOut.includes(B), 'Einladung verschickt');
  ok((await api('POST', '/v1/chats/u.' + B + '/messages', { e: enc([A, B]) }, ta)).status === 404, 'Nachricht vor Annahme abgelehnt');
  r = await api('GET', '/v1/me', null, tb);
  ok(r.body.invitesIn.includes(A), 'Einladung bei B sichtbar');
  r = await api('GET', '/v1/poll?since=0', null, tb);
  ok(r.body.invites === 1, 'Poll meldet Einladung');
  r = await api('POST', '/v1/contacts/' + A + '/accept', null, tb);
  ok(r.body.contacts.includes(A), 'Einladung angenommen');

  // Nachrichten
  const e1 = enc([A, B]);
  r = await api('POST', '/v1/chats/u.' + B + '/messages', { e: Object.assign({}, e1, { k: Object.assign({ fremd_x: rnd(72) }, e1.k) }) }, ta);
  ok(r.status === 200 && r.body.msg.e.c === e1.c && r.body.msg.e.k === e1.k[A] && !r.body.msg.t, 'verschlüsselte Nachricht gesendet, nur eigener Umschlag');
  const firstId = r.body.msg.id;
  r = await api('GET', '/v1/chats', null, tb);
  ok(r.body.chats.length === 1 && r.body.chats[0].unread === 1 && r.body.chats[0].id === 'u.' + A, 'Chatliste mit Ungelesen');
  r = await api('GET', '/v1/poll?since=' + (firstId - 1), null, tb);
  ok(r.body.msgs.length === 1 && r.body.msgs[0].chat === 'u.' + A && r.body.msgs[0].e.k === e1.k[B], 'Poll liefert neue Nachricht mit Bs Umschlag');
  r = await api('GET', '/v1/poll?since=' + firstId, null, tb);
  ok(r.body.msgs.length === 0, 'Poll danach leer');
  await api('POST', '/v1/chats/u.' + A + '/read', { upTo: firstId }, tb);
  r = await api('GET', '/v1/chats', null, tb);
  ok(r.body.chats[0].unread === 0, 'gelesen markiert');
  ok((await api('POST', '/v1/chats/u.' + A + '/messages', { text: 'Klartext' }, tb)).status === 400, 'Klartext abgelehnt');
  ok((await api('POST', '/v1/chats/u.' + A + '/messages', { e: Object.assign(enc([A, B]), { n: 'kurz' }) }, tb)).status === 400, 'kaputte Verschlüsselung abgelehnt');
  ok((await api('POST', '/v1/chats/u.' + A + '/messages', { e: enc(['niemand']) }, tb)).status === 400, 'ohne gültigen Empfänger abgelehnt');
  let lastId = 0;
  for (let i = 0; i < 25; i++) lastId = (await api('POST', '/v1/chats/u.' + B + '/messages', { e: enc([A, B]) }, ta)).body.msg.id;
  r = await api('GET', '/v1/chats/u.' + A + '/messages?limit=10', null, tb);
  ok(r.body.msgs.length === 10 && r.body.msgs[9].id === lastId, 'Historie mit Limit');
  ok((await api('GET', '/v1/chats/u.' + A + '/messages', null, tc)).status === 404, 'Fremder Chat gesperrt');

  // Long-Polling: ohne Neues wartet die Abfrage, eine neue Nachricht weckt sie sofort
  const st0 = (await api('GET', '/v1/stats')).body;
  let t0 = Date.now();
  r = await api('GET', '/v1/poll?wait=2&since=' + lastId, null, tb);
  ok(r.body.msgs.length === 0 && Date.now() - t0 >= 1800, 'Long-Poll wartet ohne Neues');
  t0 = Date.now();
  const pending = api('GET', '/v1/poll?wait=15&since=' + lastId, null, tb);
  await new Promise((res) => setTimeout(res, 300));
  await api('POST', '/v1/chats/u.' + B + '/messages', { e: enc([A, B]), voice: true }, ta);
  r = await pending;
  ok(r.body.msgs.length === 1 && Date.now() - t0 < 3000, 'Long-Poll wird durch neue Nachricht sofort geweckt');
  ok(r.body.msgs[0].v === 1 && typeof r.body.msgs[0].ts === 'number', 'Diktierte Nachricht trägt Markierung v und Zeit ts');
  lastId = r.body.seq;
  const st1 = (await api('GET', '/v1/stats')).body;
  ok(st1.messages === st0.messages && st1.voice === st0.voice, 'Testkonten zählen nicht in der Statistik');
  // nur lokal: echte Konten würden die Live-Statistik verändern
  if (child) { const rx = await api('POST', '/v1/register', { name: 'tx_' + sfx }); const rz = await api('POST', '/v1/register', { name: 'tz_' + sfx });
    await api('POST', '/v1/contacts', { name: 'tz_' + sfx }, rx.body.token); await api('POST', '/v1/contacts/tx_' + sfx + '/accept', null, rz.body.token);
    await api('POST', '/v1/chats/u.tz_' + sfx + '/messages', { e: enc(['tx_' + sfx, 'tz_' + sfx]), voice: true }, rx.body.token);
    const st2 = (await api('GET', '/v1/stats')).body;
    ok(st2.messages === st0.messages + 1 && st2.voice === st0.voice + 1 && st2.users === st0.users + 2, 'Statistik zählt echte Nachrichten, Sprache und Nutzer');
    await api('DELETE', '/v1/me', null, rx.body.token); await api('DELETE', '/v1/me', null, rz.body.token); }
  ok(typeof info.body.donate === 'string', 'Spendenlink in /v1/info');

  // Schlüssel: nur für Kontakte sichtbar, nicht für Fremde
  const pkA = rnd(32), pkC = rnd(32);
  ok((await api('PUT', '/v1/me', { pubKey: 'kaputt' }, ta)).status === 400, 'kaputter Schlüssel abgelehnt');
  await api('PUT', '/v1/me', { pubKey: pkA }, ta); await api('PUT', '/v1/me', { pubKey: pkC }, tc);
  r = await api('GET', '/v1/keys', null, tb);
  ok(r.body.keys[A] === pkA && !r.body.keys[C], 'Schlüssel nur von Kontakten');

  // Manipulation über Namen
  for (const n of ['__proto__', 'constructor', 'admin', '_abc']) ok((await api('POST', '/v1/register', { name: n })).status === 400, 'Name abgelehnt: ' + n);
  for (const n of ['constructor', '__proto__', 'hasOwnProperty']) {
    const s = (await api('POST', '/v1/contacts', { name: n }, ta)).status;
    ok(s === 400 || s === 404, 'Kontakt ' + n + ' → ' + s + ' (kein Absturz)');
  }
  ok((await api('POST', '/v1/chats/u.constructor/messages', { e: enc([A]) }, ta)).status === 404, 'Chat u.constructor gesperrt');
  ok((await api('GET', '/v1/info')).status === 200, 'Server läuft nach Manipulationsversuchen');

  // Einstellungen
  r = await api('PUT', '/v1/me', { cfg: { qr: ['Ja', '', 'Nein', 'x'.repeat(60)], vibe: false }, timelineToken: 'abc-123' }, ta);
  ok(r.body.cfg.qr.length === 3 && r.body.cfg.qr[2].length === 40 && r.body.cfg.vibe === false && r.body.timeline === true, 'Einstellungen gespeichert');

  // Gruppe: A erstellt mit B; C ist kein Kontakt → Fehler
  ok((await api('POST', '/v1/groups', { title: 'Team', members: [C] }, ta)).status === 400, 'Gruppe nur mit Kontakten');
  r = await api('POST', '/v1/groups', { title: 'Team', members: [B] }, ta);
  const gid = r.body.groups[0].id;
  ok(r.status === 200 && r.body.groups[0].invited.includes(B), 'Gruppe erstellt, B eingeladen');
  ok((await api('POST', '/v1/chats/g.' + gid + '/messages', { e: enc([A, B]) }, tb)).status === 404, 'Gruppe vor Annahme gesperrt');
  r = await api('POST', '/v1/groups/' + gid + '/accept', null, tb);
  ok(r.body.groups.length === 1, 'Gruppe angenommen');
  await api('POST', '/v1/chats/g.' + gid + '/messages', { e: enc([A, B]) }, tb);
  r = await api('GET', '/v1/chats', null, ta);
  ok(r.body.chats[0].id === 'g.' + gid && r.body.chats[0].unread === 1 && r.body.chats[0].title === 'Team', 'Gruppenchat oben mit Ungelesen');
  await api('PUT', '/v1/groups/' + gid, { title: 'Crew' }, tb);
  r = await api('GET', '/v1/me', null, ta);
  ok(r.body.groups[0].title === 'Crew', 'Gruppe umbenannt');

  // Eigene Nachricht löschen: nur Absender, Polling meldet den Chat in "del"
  const mid = (await api('POST', '/v1/chats/g.' + gid + '/messages', { e: enc([A, B]) }, tb)).body.msg.id;
  ok((await api('DELETE', '/v1/chats/g.' + gid + '/messages/' + mid, null, ta)).status === 403, 'fremde Nachricht nicht löschbar');
  const seqD = (await api('GET', '/v1/chats', null, ta)).body.seq;
  ok((await api('DELETE', '/v1/chats/g.' + gid + '/messages/' + mid, null, tb)).status === 200, 'eigene Nachricht gelöscht');
  r = await api('GET', '/v1/poll?since=' + seqD, null, ta);
  ok(r.body.del.includes('g.' + gid) && !r.body.msgs.length, 'Löschung per Polling gemeldet');
  r = await api('GET', '/v1/chats/g.' + gid + '/messages', null, ta);
  ok(!r.body.msgs.some((x) => x.id === mid), 'Nachricht für alle weg');
  ok((await api('DELETE', '/v1/chats/g.' + gid + '/messages/' + mid, null, tb)).status === 404, 'doppelt löschen → 404');

  // Besitzer entfernt Mitglieder bzw. zieht Einladungen zurück
  ok((await api('DELETE', '/v1/groups/' + gid + '/members/' + A, null, tb)).status === 403, 'nur Besitzer darf entfernen');
  r = await api('DELETE', '/v1/groups/' + gid + '/members/' + B, null, ta);
  ok(r.status === 200 && !r.body.groups[0].members.includes(B), 'Mitglied entfernt');
  ok((await api('GET', '/v1/me', null, tb)).body.groups.length === 0, 'Entfernter sieht die Gruppe nicht mehr');
  ok((await api('POST', '/v1/chats/g.' + gid + '/messages', { e: enc([A, B]) }, tb)).status === 404, 'Entfernter kann nicht mehr schreiben');
  await api('POST', '/v1/groups/' + gid + '/invite', { name: B }, ta);
  r = await api('DELETE', '/v1/groups/' + gid + '/members/' + B, null, ta);
  ok(!r.body.groups[0].invited.includes(B) && !(await api('GET', '/v1/me', null, tb)).body.groupInvites.length, 'Einladung zurückgezogen');
  ok((await api('DELETE', '/v1/groups/' + gid + '/members/' + A, null, ta)).status === 404, 'Besitzer kann sich nicht selbst entfernen');
  await api('POST', '/v1/groups/' + gid + '/invite', { name: B }, ta);
  ok((await api('POST', '/v1/groups/' + gid + '/accept', null, tb)).body.groups.length === 1, 'wieder eingeladen und beigetreten');

  // Blockieren: C lädt A ein, A blockiert C → C kann nicht erneut sichtbar einladen
  await api('POST', '/v1/contacts', { name: A }, tc);
  r = await api('POST', '/v1/blocks', { name: C }, ta);
  ok(r.body.blocked.includes(C) && !r.body.invitesIn.includes(C), 'blockiert, Einladung weg');
  await api('POST', '/v1/contacts', { name: A }, tc);
  r = await api('GET', '/v1/me', null, ta);
  ok(!r.body.invitesIn.includes(C), 'Blockierter kann nicht einladen');
  r = await api('DELETE', '/v1/blocks/' + C, null, ta);
  ok(!r.body.blocked.includes(C), 'Blockierung aufgehoben');

  // Testnachricht vom Server (System-Chat, nur lesbar, kommt übers Polling)
  const seqT = (await api('GET', '/v1/chats', null, tc)).body.seq;
  r = await api('POST', '/v1/test', { delay: 0 }, tc);
  ok(r.status === 200 && r.body.msg && r.body.msg.t, 'Testnachricht sofort');
  r = await api('GET', '/v1/poll?since=' + seqT, null, tc);
  ok(r.body.msgs.some((x) => x.chat === 'u.watchietalkie' && x.f === 'watchietalkie' && x.t), 'Testnachricht per Polling');
  r = await api('GET', '/v1/chats', null, tc);
  ok(r.body.chats.some((x) => x.id === 'u.watchietalkie' && x.title === 'WatchieTalkie' && x.unread === 1), 'System-Chat in der Liste');
  ok((await api('GET', '/v1/chats/u.watchietalkie/messages', null, tc)).body.msgs.length === 1, 'System-Chat lesbar');
  ok((await api('POST', '/v1/chats/u.watchietalkie/messages', { e: {} }, tc)).status === 403, 'System-Chat schreibgeschützt');
  ok(!(await api('GET', '/v1/chats', null, ta)).body.chats.some((x) => x.id === 'u.watchietalkie'), 'System-Chat nur beim Anfordernden');
  r = await api('POST', '/v1/test', { delay: 1 }, tc);
  ok(r.status === 200 && r.body.delay === 1 && !r.body.msg, 'Testnachricht verzögert angenommen');
  r = await api('GET', '/v1/poll?wait=5&since=' + (seqT + 1), null, tc);
  ok(r.body.msgs.some((x) => x.chat === 'u.watchietalkie'), 'verzögerte Testnachricht weckt Long-Poll');

  // ntfy (optional): Thema + eigener Server prüfen
  r = await api('PUT', '/v1/me', { cfg: { ntfy: 'zu-kurz' } }, tc);
  ok(r.status === 400, 'ntfy: zu kurzes Thema abgelehnt');
  r = await api('PUT', '/v1/me', { cfg: { ntfyUrl: 'https://127.0.0.1' } }, tc);
  ok(r.status === 400, 'ntfy: IP-Adresse als Server abgelehnt');
  r = await api('PUT', '/v1/me', { cfg: { ntfyUrl: 'http://ntfy.example.org' } }, tc);
  ok(r.status === 400, 'ntfy: http abgelehnt');
  r = await api('PUT', '/v1/me', { cfg: { ntfy: 'wt-abcdefghijkl', ntfyUrl: 'https://ntfy.example.org/' } }, tc);
  ok(r.status === 200 && r.body.cfg.ntfy === 'wt-abcdefghijkl' && r.body.cfg.ntfyUrl === 'https://ntfy.example.org', 'ntfy: Thema + Server gespeichert');
  r = await api('PUT', '/v1/me', { cfg: { push: 'ntfy', ntfy: 'wt-abcdefghijkl' } }, tc);
  ok(r.status === 200 && r.body.cfg.push === 'ntfy', 'Dienst ntfy gewählt');
  r = await api('PUT', '/v1/me', { cfg: { push: 'sms' } }, tc);
  ok(r.status === 400, 'unbekannter Dienst abgelehnt');
  r = await api('PUT', '/v1/me', { cfg: { push: 'telegram' } }, tc);
  ok(r.status === 400, 'Telegram ohne Verbindung abgelehnt');
  r = await api('POST', '/v1/me/telegram', { bot: 'kaputt' }, tc);
  ok(r.status === 400, 'Telegram: ungültiges Bot-Token abgelehnt');
  r = await api('PUT', '/v1/me', { cfg: { push: 'pushover', poUser: 'x'.repeat(29) } }, tc);
  ok(r.status === 400, 'Pushover: ungültiger Schlüssel abgelehnt');
  r = await api('PUT', '/v1/me', { cfg: { push: 'pushover', poUser: 'u'.repeat(30) } }, tc);
  ok(r.status === 400 && !r.body.server, 'Pushover ohne Anwendungstoken abgelehnt');
  r = await api('PUT', '/v1/me', { cfg: { push: 'pushover', poUser: 'u'.repeat(30), poToken: 'a'.repeat(30) } }, tc);
  ok(r.status === 200 && r.body.cfg.push === 'pushover' && r.body.cfg.poUser.length === 30, 'Pushover gespeichert');
  r = await api('PUT', '/v1/me', { cfg: { push: '', ntfy: '', ntfyUrl: '', poUser: '', poToken: '' } }, tc);
  ok(r.status === 200 && r.body.cfg.push === '' && r.body.cfg.ntfy === '' && r.body.cfg.ntfyUrl === '', 'Handy-Benachrichtigung ausgeschaltet');
  // Ruhefenster + Pause per Uhr-Taste
  r = await api('PUT', '/v1/me', { cfg: { pushGap: 10, pauseMin: 30 } }, tc);
  ok(r.status === 200 && r.body.cfg.pushGap === 10 && r.body.cfg.pauseMin === 30 && r.body.pauseLeft === 0, 'Ruhefenster + Pausendauer gespeichert');
  r = await api('PUT', '/v1/me', { cfg: { pushGap: 9999, pauseMin: -5 } }, tc);
  ok(r.body.cfg.pushGap === 240 && r.body.cfg.pauseMin === 1, 'Ruhefenster/Pause begrenzt');
  await api('PUT', '/v1/me', { cfg: { pauseMin: 30 } }, tc);
  r = await api('POST', '/v1/me/pause', { on: true }, tc);
  ok(r.status === 200 && r.body.pauseLeft === 30, 'Push-Pause gestartet (Standarddauer)');
  r = await api('POST', '/v1/me/pause', { on: true, min: 5 }, tc);
  ok(r.body.pauseLeft === 5, 'Push-Pause mit eigener Dauer');
  r = await api('POST', '/v1/me/pause', { on: false }, tc);
  ok(r.body.pauseLeft === 0, 'Push-Pause beendet');
  r = await api('POST', '/v1/me/pause', { on: true });
  ok(r.status === 401, 'Push-Pause nur mit Token');

  // Austritt, Kontakt entfernen, Konto löschen
  r = await api('DELETE', '/v1/groups/' + gid, null, tb);
  ok(r.body.groups.length === 0, 'Gruppe verlassen');
  r = await api('DELETE', '/v1/contacts/' + A, null, tb);
  ok(!r.body.contacts.includes(A), 'Kontakt entfernt');
  r = await api('GET', '/v1/me', null, ta);
  ok(!r.body.contacts.includes(B), 'Kontakt beidseitig entfernt');

  // Zweitnamen: Einladung an den Zweitnamen landet beim Hauptkonto
  const X = 'tx_' + sfx;
  r = await api('POST', '/v1/me/aliases', { name: X }, ta);
  ok(r.status === 200 && r.body.aliases.includes(X), 'Zweitname angelegt');
  ok((await api('POST', '/v1/me/aliases', { name: B }, ta)).status === 409, 'Zweitname = fremder Name abgelehnt');
  ok((await api('POST', '/v1/me/aliases', { name: X }, tb)).status === 409, 'Zweitname doppelt abgelehnt');
  ok((await api('POST', '/v1/me/aliases', { name: 'admin' }, ta)).status === 400, 'reservierter Zweitname abgelehnt');
  ok((await api('POST', '/v1/register', { name: X, test: true })).status === 409, 'Registrierung mit Zweitname abgelehnt');
  await api('POST', '/v1/contacts', { name: X }, tb);
  r = await api('GET', '/v1/me', null, ta);
  ok(r.body.invitesIn.includes(B), 'Einladung an Zweitname kommt beim Hauptkonto an');
  r = await api('POST', '/v1/contacts/' + B + '/accept', null, ta);
  ok(r.body.contacts.includes(B), 'Einladung über Zweitname angenommen');
  r = await api('GET', '/v1/me', null, tb);
  ok(r.body.contacts.includes(A) && !r.body.contacts.includes(X), 'Kontakt sieht Hauptnamen');
  await api('DELETE', '/v1/contacts/' + A, null, tb);
  r = await api('DELETE', '/v1/me/aliases/' + X, null, ta);
  ok(r.status === 200 && !r.body.aliases.includes(X), 'Zweitname entfernt');
  ok((await api('POST', '/v1/contacts', { name: X }, tb)).status === 404, 'entfernter Zweitname nicht mehr erreichbar');
  await api('POST', '/v1/me/aliases', { name: X }, ta);
  for (const t of [ta, tb, tc]) ok((await api('DELETE', '/v1/me', null, t)).status === 200, 'Konto gelöscht');
  ok((await api('GET', '/v1/me', null, ta)).status === 401, 'Token nach Löschung ungültig');
  r = await api('POST', '/v1/register', { name: X, test: true });
  ok(r.status === 200, 'Zweitname nach Kontolöschung wieder frei');
  if (r.body && r.body.token) await api('DELETE', '/v1/me', null, r.body.token);

  // CORS + Robustheit
  const pre = await fetch(base + '/v1/me', { method: 'OPTIONS' });
  ok(pre.status === 204 && pre.headers.get('access-control-allow-origin') === '*', 'CORS-Preflight');
  const bad = await fetch(base + '/v1/register', { method: 'POST', body: '{kaputt' });
  ok(bad.status === 400, 'kaputtes JSON → 400');
  const big = await fetch(base + '/v1/register', { method: 'POST', body: 'x'.repeat(40000) }).catch(() => ({ status: 413 }));
  ok(big.status === 413, 'zu großer Body → 413');
  ok((await fetch(base + '/')).status === 200 && (await fetch(base + '/impressum.html')).status === 200, 'Startseite + Impressum');
  ok((await fetch(base + '/admin')).status === 200, 'Admin-Seite erreichbar');
  // Admin (nur lokal, Schlüssel aus der Umgebung)
  if (child) {
    const adm = (method, p, key) => fetch(base + p, { method, headers: { Authorization: 'Admin ' + key } }).then(async (r) => ({ status: r.status, body: await r.json() }));
    ok((await adm('GET', '/v1/admin/users', 'falsch')).status === 401, 'Admin: falscher Schlüssel → 401');
    ok((await fetch(base + '/v1/admin/users')).status === 401, 'Admin: ohne Schlüssel → 401');
    const ro = await api('POST', '/v1/register', { name: 'to_' + sfx });
    const l = await adm('GET', '/v1/admin/users', 'test-admin-key');
    const o = l.body.users && l.body.users.find((x) => x.name === 'to_' + sfx);
    ok(l.status === 200 && o && o.pubKey === false && typeof l.body.stats.users === 'number', 'Admin: Liste mit ungespeichertem Konto');
    const raw = JSON.stringify(l.body);
    ok(!raw.includes(ro.body.token) && !/"th"|"cfg"|"pk"|"tl"|ntfy"/.test(raw), 'Admin: keine Token/Schlüssel/Push-Zugänge');
    ok((await adm('DELETE', '/v1/admin/users/to_' + sfx, 'test-admin-key')).status === 200 && (await api('GET', '/v1/me', null, ro.body.token)).status === 401, 'Admin: Konto gelöscht');
    ok((await adm('DELETE', '/v1/admin/users/to_' + sfx, 'test-admin-key')).status === 404, 'Admin: unbekanntes Konto → 404');
    // Konto zurücksetzen: neuer Token, alter ungültig, Kontakte bleiben, Hinweis im Direktchat und in der Gruppe
    const ra = await api('POST', '/v1/register', { name: 'ra_' + sfx }), rb = await api('POST', '/v1/register', { name: 'rb_' + sfx });
    await api('PUT', '/v1/me', { pubKey: 'A'.repeat(43) + '=' }, ra.body.token);
    await api('POST', '/v1/contacts', { name: 'rb_' + sfx }, ra.body.token);
    await api('POST', '/v1/contacts/ra_' + sfx + '/accept', null, rb.body.token);
    const rg = await api('POST', '/v1/groups', { title: 'Reset' }, ra.body.token);
    const gid = rg.body.groups[0].id;
    await api('POST', '/v1/groups/' + gid + '/invite', { name: 'rb_' + sfx }, ra.body.token);
    await api('POST', '/v1/groups/' + gid + '/accept', null, rb.body.token);
    ok((await adm('POST', '/v1/admin/users/ra_' + sfx + '/reset', 'falsch')).status === 401, 'Reset: falscher Schlüssel → 401');
    ok((await adm('POST', '/v1/admin/users/xx_' + sfx + '/reset', 'test-admin-key')).status === 404, 'Reset: unbekanntes Konto → 404');
    const rs = await adm('POST', '/v1/admin/users/ra_' + sfx + '/reset', 'test-admin-key');
    ok(rs.status === 200 && /^[a-f0-9]{64}$/.test(rs.body.token) && rs.body.token !== ra.body.token && rs.body.chats === 2, 'Reset: neuer Token, 2 Chats');
    ok((await api('GET', '/v1/me', null, ra.body.token)).status === 401, 'Reset: alter Token ungültig');
    const me2 = await api('GET', '/v1/me', null, rs.body.token);
    ok(me2.status === 200 && me2.body.pubKey === '' && me2.body.contacts.includes('rb_' + sfx) && me2.body.groups.length === 1, 'Reset: Konto mit Kontakten/Gruppe, Schlüssel verworfen');
    const dm = await api('GET', '/v1/chats/u.ra_' + sfx + '/messages', null, rb.body.token);
    const gm = await api('GET', '/v1/chats/g.' + gid + '/messages', null, rb.body.token);
    const note = (r) => (r.body.msgs || r.body.messages || []).some((x) => x.f === 'watchietalkie' && x.t === 'ra_' + sfx + ' reset their account');
    ok(note(dm) && note(gm), 'Reset: Hinweis im Direktchat und in der Gruppe');
    await adm('DELETE', '/v1/admin/users/ra_' + sfx, 'test-admin-key'); await adm('DELETE', '/v1/admin/users/rb_' + sfx, 'test-admin-key');
  }
}

main().catch((e) => { failed++; console.log('✗ Abbruch: ' + e.stack); }).finally(() => {
  if (child) child.kill();
  console.log((failed ? '✗ ' : '✓ ') + (checks - failed) + '/' + checks + ' Prüfungen');
  process.exit(failed ? 1 : 0);
});
