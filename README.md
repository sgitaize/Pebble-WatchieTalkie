# WatchieTalkie2 – Walkie-Talkie für die Pebble

<a href="https://www.paypal.com/donate/?hosted_button_id=LGAZB9PR4YV5L"><img src="store/buy-me-a-spezi.svg" alt="Buy me a Spezi" height="40"></a>

Kontakt auf der Uhr wählen, SELECT drücken, sprechen – die Nachricht kommt als Text beim anderen an. **Ende-zu-Ende-verschlüsselt**, komplett Open Source und mit eigenem Server betreibbar.

WatchieTalkie2 ist eine **Weiterführung des früheren [Watchie-Talkie](https://apps.repebble.com/55de02ca4374cb08ff000055)**, das seit Jahren offline ist. Die Motivation: Jeder soll einen Just-for-fun-Chat mit Freunden direkt am Handgelenk führen können – und bei Bedarf den Server selbst hosten. Neu geschrieben, keine Verbindung zum ursprünglichen Anbieter.

- **Sprache → Text** über die Diktierfunktion der Pebble (Uhren mit Mikrofon)
- **Schnellantworten** (frei einstellbar, auch für Uhren ohne Mikrofon)
- **Benutzernamen, Einladungen, Blockieren**
- **Direktchats und Gruppen** (bis 20 Mitglieder)
- **Chat-Historie:** letzte 50 Nachrichten je Chat, höchstens 30 Tage
- **Ende-zu-Ende-Verschlüsselung:** der Server-Betreiber kann Nachrichten nicht lesen
- **Benachrichtigung bei geschlossener App** über Timeline-Pins – ohne zusätzliche Handy-App (wenn aus dem Pebble-App-Store installiert)
- **Alle Pebble-Modelle:** Pebble / Steel (aplite), Time / Time Steel (basalt), Time Round (chalk), Pebble 2 (diorite), Time 2 (emery), Pebble 2 Duo (flint), Round 2 (gabbro)
- **Funk-Piep** bei neuen Nachrichten über den Lautsprecher (Time 2, Pebble 2 Duo, Round 2; abschaltbar)
- **Akkuschonend:** Long-Polling nur bei offener App (eine Anfrage wartet bis zu 25 s und kommt sofort bei Neuem zurück), sonst Timeline
- **Leichter Server:** Node.js ohne Abhängigkeiten, eine Datei, JSON-Speicher; Info-Seite mit Statistik (Nutzer, Nachrichten, davon diktiert); auch per Docker

## Aufbau

```
Uhr (C) ⇄ AppMessage ⇄ PebbleKit JS (Handy, ver-/entschlüsselt) ⇄ HTTPS/JSON ⇄ Server (Node.js, sieht nur Chiffretext)
                                                                    ▲
                                  Einstellungsseite (GitHub Pages) ─┘
```

| Ordner | Inhalt |
|---|---|
| `watch/` | Pebble-App: `src/c/main.c` (Uhr), `src/pkjs/index.js` (Handy), `src/pkjs/e2e.js` (Verschlüsselung), `src/pkjs/nacl-fast.js` (TweetNaCl) |
| `server/` | Server (`server.js`), Startseite, Impressum/Datenschutz/Haftung, API-Test (`test.js`) |
| `docs/` | GitHub Pages: Startseite und Einstellungsseite (`docs/config/`) |
| `store/` | Store-Texte, Icons, Banner |

## Benutzung

1. WatchieTalkie2 aus dem Pebble-App-Store installieren: [apps.repebble.com/5baaf5505dcf4454bdab0478](https://apps.repebble.com/5baaf5505dcf4454bdab0478)
2. In der Pebble-App bei WatchieTalkie2 auf **Einstellungen**: Benutzernamen wählen, Freunde per Benutzername einladen, Gruppen anlegen, Schnellantworten festlegen, **Speichern**.
3. Auf der Uhr: Chat wählen → **SELECT** = sprechen, **SELECT lang** = Schnellantwort, **hoch/runter** = scrollen. Einladungen erscheinen oben in der Liste und lassen sich direkt auf der Uhr annehmen.
4. Neues Handy: in den Einstellungen den **Übertragungscode** anzeigen und auf dem neuen Handy unter „Ich habe schon ein Konto“ eingeben (enthält Zugang und geheimen Schlüssel – nie weitergeben).

## Sicherheit

**Verschlüsselung (Ende-zu-Ende).** Jedes Konto hat ein X25519-Schlüsselpaar; der geheime Schlüssel bleibt auf dem Handy. Jede Nachricht wird mit einem zufälligen Schlüssel verschlüsselt (XSalsa20-Poly1305, NaCl `secretbox`), dieser Schlüssel für jeden Empfänger einzeln mit NaCl `box` eingepackt. Der Server speichert und verteilt nur Chiffretext und öffentliche Schlüssel und kann Nachrichten weder lesen noch fälschen. Bibliothek: [TweetNaCl-js](https://github.com/dchest/tweetnacl-js) (auditiert, public domain).

- **Zufall:** Die iOS-Umgebung der Pebble-App hat kein `crypto.getRandomValues`. Deshalb erzeugt die Einstellungsseite (echter Browser-Zufall) Schlüssel und einen 32-Byte-Seed; die App leitet daraus mit SHA-512, Zähler und – wo vorhanden – Systemzufall ab.
- **Sicherheitsnummern:** Die Einstellungsseite zeigt die eigene Nummer und die der Kontakte. Wer sie einmal persönlich vergleicht, schließt aus, dass ein Server-Betreiber falsche Schlüssel unterschiebt. Ändert sich der Schlüssel eines Kontakts, warnt die App.
- **Nicht verschlüsselt (Metadaten):** Benutzernamen, wer mit wem in Kontakt ist, Gruppennamen und Mitglieder, Zeitpunkt und ungefähre Länge von Nachrichten. Timeline-Benachrichtigungen enthalten nur den Absender, nie den Inhalt.

**Schutz vor Manipulation (Server).**
- Zugang per zufälligem 256-Bit-Geräte-Token; der Server speichert nur dessen SHA-256-Hash.
- Nachrichten nur zwischen bestätigten Kontakten bzw. Gruppenmitgliedern; Blockierte können nicht einladen.
- Klartext wird abgelehnt, verschlüsselte Nachrichten werden auf Form und Größe geprüft; nur Umschläge für echte Chat-Teilnehmer werden gespeichert, jeder Leser bekommt nur seinen eigenen.
- Öffentliche Schlüssel nur für Kontakte und Gruppenmitglieder abrufbar (kein Verzeichnis für Fremde).
- Namen streng geprüft (`a–z 0–9 _`, nicht mit `_` beginnend, reservierte Namen gesperrt); alle Tabellen ohne Prototyp – `__proto__`/`constructor`-Tricks greifen nicht.
- Grenzen für alles: Anfragen je IP, Registrierungen je IP, Nachrichten und Einladungen je Konto, Body-Größe, Anzahl Kontakte/Gruppen/Konten, Historie; Timeouts gegen langsame Verbindungen.
- Statische Seiten mit Content-Security-Policy, `X-Frame-Options`, `Referrer-Policy`; die Einstellungsseite entfernt Token/Schlüssel sofort aus der Adresszeile.
- Mehrere Passenger-Prozesse: der erste führt, die anderen reichen per Unix-Socket weiter (kein doppelter Zustand).

## Eigenen Server betreiben

Der Server braucht nur **Node.js ≥ 18** – keine Datenbank, kein `npm install`. In der Einstellungsseite trägt jeder Nutzer die Adresse seines Servers ein; chatten kann man mit allen, die auf demselben Server sind.

```bash
cd server
PORT=3000 node server.js       # dann http://localhost:3000
node test.js                   # API-Test mit eigenem Testserver
node test.js https://mein-server.de   # gegen einen laufenden Server (legt Testkonten an und löscht sie)
```

HTTPS ist Pflicht (Reverse-Proxy wie Caddy/nginx oder Hosting mit Let's Encrypt). Unter der Server-Adresse zeigt eine Info-Seite, was der Server macht, mit Statistik (registrierte Nutzer, verschickte Nachrichten, davon diktiert).

**Docker:**

```bash
cd server
docker compose up -d           # Port 3000, Daten im Volume "data"; Einstellungen per environment in docker-compose.yml
```

**Plesk (z. B. netcup Webhosting):** Inhalt von `server/` nach `httpdocs/` hochladen, dann *Node.js* aktivieren mit Anwendungsstamm `/httpdocs`, Dokumentenstamm `/httpdocs/public` (bleibt leer – alle Seiten liefert Node mit Sicherheits-Headern aus `pages/`), Startdatei `server.js`, Modus `production`. *Run script → setup* prüft Schreibrechte und startet neu. Fehler landen in `logs/app.log`.

| Umgebungsvariable | Standard | Bedeutung |
|---|---|---|
| `PORT` | 3000 | Port (ohne Passenger) |
| `REGISTER_CODE` | – | Registrierung nur mit diesem Code (privater Server für Freunde) |
| `MAX_USERS` | 1000 | Obergrenze Konten |
| `HISTORY_MAX` | 50 | Nachrichten je Chat |
| `HISTORY_DAYS` | 30 | Nachrichten älter als … Tage werden gelöscht |
| `TIMELINE_API` | `https://timeline-api.rebble.io` | Timeline-Dienst für Benachrichtigungen, `off` = aus |
| `SERVER_NAME` | WatchieTalkie2 | Anzeigename |
| `DONATE_URL` | Projekt-Spendenlink | Spendenbutton auf der Info-Seite, `off` = ausblenden |

Daten liegen in `server/data/db.json` (nur Chiffretext) – zum Sichern die Datei kopieren. **Wer einen öffentlichen Server betreibt, muss `public/impressum.html` durch eigene Angaben ersetzen.**

### API (Kurzfassung)

JSON, Anmeldung mit `Authorization: Bearer <Geräte-Token>`. Chat-IDs: `u.<name>` (Direktchat) oder `g.<gruppe>`. Nachrichten: `e = {v:1, n:<Nonce>, c:<Chiffretext>, k:{<name>: <Umschlag>}}` (Base64).

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/v1/info` | Server-Infos |
| GET | `/v1/stats` | öffentliche Zähler: Nutzer, Gruppen, Nachrichten, davon diktiert |
| POST | `/v1/register` | `{name, code?}` → `{name, token}` |
| GET / PUT / DELETE | `/v1/me` | Profil, Einstellungen (`cfg`), `pubKey`, `timelineToken`, Konto löschen |
| GET | `/v1/keys` | öffentliche Schlüssel von Kontakten und Gruppenmitgliedern |
| POST | `/v1/contacts` | `{name}` einladen (nimmt an, wenn der andere schon eingeladen hat) |
| POST | `/v1/contacts/:name/accept` | Einladung annehmen |
| DELETE | `/v1/contacts/:name` | Kontakt entfernen / ablehnen / zurückziehen |
| POST · DELETE | `/v1/blocks` · `/v1/blocks/:name` | blockieren / freigeben |
| POST | `/v1/groups` | `{title, members[]}` Gruppe anlegen |
| POST | `/v1/groups/:id/invite` · `/accept` | einladen / annehmen |
| PUT · DELETE | `/v1/groups/:id` | umbenennen / verlassen |
| GET | `/v1/chats` | Chatliste mit Ungelesen-Zähler |
| GET · POST | `/v1/chats/:id/messages` | Historie (`?limit=`) / senden `{e, voice?}` (`voice` zählt nur für die Statistik) |
| POST | `/v1/chats/:id/read` | `{upTo}` gelesen markieren |
| GET | `/v1/poll?since=&wait=&invites=` | alles Neue seit Nachrichten-Nummer; mit `wait` (≤ 25 s) Long-Polling |

## Entwicklung

```bash
cd watch
pebble build                                   # baut für alle 7 Plattformen
pebble install --emulator emery build/watch.pbw
```

Im Emulator gibt es kein Diktat – dort Schnellantworten nutzen. Die Einstellungsseite (`docs/config/`) bekommt Server, Token und Schlüssel im URL-Hash und gibt sie über `pebblejs://close#…` zurück.

## Haftungsausschluss

WatchieTalkie2 ist ein freies Hobbyprojekt und wird **ohne jede Gewähr** bereitgestellt – keine Zusage für Verfügbarkeit, Zustellung oder Speicherung, nicht für Notfälle oder wichtige Mitteilungen gedacht. Für Nachrichteninhalte sind die Absender verantwortlich. Wer die Software selbst betreibt, ist für seinen Server, seine Nutzer und die Einhaltung der Gesetze selbst verantwortlich. Details: Impressum des jeweiligen Servers (öffentlicher Server: [watchietalkie.aize-it.de/impressum.html](https://watchietalkie.aize-it.de/impressum.html)).

## Unterstützen

WatchieTalkie2 ist ein freies Hobbyprojekt ohne Werbung. Wer den öffentlichen Server und die Entwicklung unterstützen möchte:

<a href="https://www.paypal.com/donate/?hosted_button_id=LGAZB9PR4YV5L"><img src="store/buy-me-a-spezi.svg" alt="Buy me a Spezi" height="40"></a>

## Sprachnachrichten?

Die Pebble-SDK erlaubt Apps derzeit keine Audio-Aufnahme vom Mikrofon – nur das fertige Diktat als Text. Echte Sprachnachrichten sind deshalb nicht möglich; gesprochene Nachrichten kommen als Text an (und werden in der Statistik als „diktiert“ gezählt). Abspielen über den Lautsprecher ginge – sobald eine Aufnahme-Schnittstelle kommt, lässt sich das nachrüsten.

## Lizenz

[MIT](LICENSE) – frei verwendbar, auch kommerziell, solange der Copyright-Hinweis erhalten bleibt. TweetNaCl-js: public domain. Idee und Name angelehnt an das frühere Watchie-Talkie für die Pebble.
