/**
 * Einrichtung/Prüfung für Plesk: Node.js → „Run script" → setup
 * Prüft Node-Version, Dateien und Schreibrechte und startet die App neu (tmp/restart.txt).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let ok = true;
const say = (good, msg) => { console.log((good ? '[OK]     ' : '[FEHLER] ') + msg); if (!good) ok = false; };

const major = Number(process.versions.node.split('.')[0]);
say(major >= 18, 'Node ' + process.version + (major >= 18 ? '' : ' – bitte Node 18 oder neuer wählen'));
for (const f of ['server.js', 'pages/index.html', 'pages/impressum.html']) say(fs.existsSync(path.join(ROOT, f)), 'Datei vorhanden: ' + f);
for (const d of ['data', 'tmp']) {
  try {
    const dir = path.join(ROOT, d);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.write-test'), 'ok');
    fs.unlinkSync(path.join(dir, '.write-test'));
    say(true, 'Ordner beschreibbar: ' + d + '/');
  } catch (e) { say(false, 'Ordner ' + d + '/ nicht beschreibbar: ' + e.message); }
}
say(true, 'REGISTER_CODE ' + (process.env.REGISTER_CODE ? 'gesetzt (private Registrierung)' : 'nicht gesetzt (offene Registrierung)'));
try {
  const f = path.join(ROOT, 'tmp', 'restart.txt');
  fs.closeSync(fs.openSync(f, 'a'));
  fs.utimesSync(f, new Date(), new Date());
  say(true, 'Neustart angestoßen (tmp/restart.txt)');
} catch (e) { say(false, 'Neustart: ' + e.message); }
process.exit(ok ? 0 : 1);
