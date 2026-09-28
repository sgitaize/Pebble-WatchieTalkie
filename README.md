# psst – Walkie-Talkie für die Pebble

Kontakt auf der Uhr wählen, SELECT drücken, sprechen – die Nachricht kommt als Text beim anderen an. Ein Nachfolger im Geist des früheren **WatchieTalkie**, komplett Open Source und mit eigenem Server betreibbar.

- **Sprache → Text** über die Diktierfunktion der Pebble (Uhren mit Mikrofon)
- **Schnellantworten** (frei einstellbar, auch für Uhren ohne Mikrofon)
- **Benutzernamen, Einladungen, Blockieren**
- **Direktchats und Gruppen** (bis 20 Mitglieder)
- **Chat-Historie:** letzte 50 Nachrichten je Chat, höchstens 30 Tage
- **Benachrichtigung bei geschlossener App** über Timeline-Pins – ohne zusätzliche Handy-App (wenn psst aus dem Pebble-App-Store installiert ist)
- **Alle Pebble-Modelle:** Pebble / Steel (aplite), Time / Time Steel (basalt), Time Round (chalk), Pebble 2 (diorite), Time 2 (emery), Pebble 2 Duo (flint), Round 2 (gabbro)
- **Eigener Server:** Node.js ohne Abhängigkeiten, eine Datei, JSON-Speicher

## Aufbau

```
Uhr (C) ⇄ AppMessage ⇄ PebbleKit JS (Handy) ⇄ HTTPS/JSON ⇄ psst-Server (Node.js)
                                                  ▲
                    Einstellungsseite (GitHub Pages) ┘
```

| Ordner | Inhalt |
|---|---|
| `watch/` | Pebble-App (C für die Uhr, `src/pkjs/index.js` für das Handy) |
| `server/` | Server (`server.js`), Startseite, Impressum, API-Test (`test.js`) |
| `docs/` | GitHub Pages: Startseite und Einstellungsseite (`docs/config/`) |

## Benutzung

1. psst aus dem Pebble-App-Store installieren.
2. In der Pebble-App bei psst auf **Einstellungen**: Benutzernamen wählen, Freunde per Benutzername einladen, Gruppen anlegen, Schnellantworten festlegen.
3. Auf der Uhr: Chat wählen → **SELECT** = sprechen, **SELECT lang** = Schnellantwort, **hoch/runter** = scrollen. Einladungen erscheinen oben in der Liste und lassen sich direkt auf der Uhr annehmen.

Nachrichten sind auf dem Weg verschlüsselt (HTTPS), liegen auf dem Server aber lesbar – für Geheimes ist psst nicht gedacht.

## Eigenen Server betreiben

Der Server braucht nur **Node.js ≥ 18**, keine Datenbank und kein `npm install`. In der Einstellungsseite trägt jeder Nutzer die Adresse seines Servers ein; chatten kann man mit allen, die auf demselben Server sind.

```bash
cd server
PORT=3000 node server.js       # dann http://localhost:3000
node test.js                   # API-Test mit eigenem Testserver
node test.js https://mein-server.de   # gegen einen laufenden Server (legt Testkonten an und löscht sie)
```

HTTPS ist Pflicht (die Pebble-App und die Einstellungsseite laufen über HTTPS), also einen Reverse-Proxy (Caddy, nginx) oder ein Hosting mit Let's-Encrypt davorsetzen.

**Plesk (z. B. netcup Webhosting):** Inhalt von `server/` nach `httpdocs/` hochladen, dann *Node.js* aktivieren mit Anwendungsstamm `/httpdocs`, Dokumentenstamm `/httpdocs/public`, Startdatei `server.js`, Modus `production`. Mit *Run script → setup* prüft der Server Schreibrechte und startet neu. Mehrere Passenger-Prozesse sind kein Problem: der erste führt, die anderen reichen Anfragen per Unix-Socket weiter.

| Umgebungsvariable | Standard | Bedeutung |
|---|---|---|
| `PORT` | 3000 | Port (ohne Passenger) |
| `REGISTER_CODE` | – | Registrierung nur mit diesem Code (privater Server für Freunde) |
| `MAX_USERS` | 1000 | Obergrenze Konten |
| `HISTORY_MAX` | 50 | Nachrichten je Chat |
| `HISTORY_DAYS` | 30 | Nachrichten älter als … Tage werden gelöscht |
| `TIMELINE_API` | `https://timeline-api.rebble.io` | Timeline-Dienst für Benachrichtigungen, `off` = aus |
| `SERVER_NAME` | psst | Anzeigename |

Daten liegen in `server/data/db.json` – zum Sichern einfach die Datei kopieren. **Wer einen öffentlichen Server betreibt, muss `public/impressum.html` durch eigene Angaben ersetzen.**

### API (Kurzfassung)

Alle Aufrufe JSON, Anmeldung mit `Authorization: Bearer <Geräte-Token>`. Chat-IDs: `u.<name>` (Direktchat) oder `g.<gruppe>`.

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/v1/info` | Server-Infos |
| POST | `/v1/register` | `{name, code?}` → `{name, token}` |
| GET / PUT / DELETE | `/v1/me` | Profil, Einstellungen (`cfg.qr`, `cfg.vibe`, `cfg.notify`), Timeline-Token, Konto löschen |
| POST | `/v1/contacts` | `{name}` einladen (nimmt an, wenn der andere schon eingeladen hat) |
| POST | `/v1/contacts/:name/accept` | Einladung annehmen |
| DELETE | `/v1/contacts/:name` | Kontakt entfernen / ablehnen / zurückziehen |
| POST · DELETE | `/v1/blocks` · `/v1/blocks/:name` | blockieren / freigeben |
| POST | `/v1/groups` | `{title, members[]}` Gruppe anlegen |
| POST | `/v1/groups/:id/invite` · `/accept` | einladen / annehmen |
| PUT · DELETE | `/v1/groups/:id` | umbenennen / verlassen |
| GET | `/v1/chats` | Chatliste mit Ungelesen-Zähler |
| GET · POST | `/v1/chats/:id/messages` | Historie (`?limit=`) / senden `{text}` |
| POST | `/v1/chats/:id/read` | `{upTo}` gelesen markieren |
| GET | `/v1/poll?since=` | alles Neue seit Nachrichten-Nummer |

## Entwicklung

```bash
cd watch
pebble build                                   # baut für alle 7 Plattformen
pebble install --emulator emery build/watch.pbw
```

Im Emulator gibt es kein Diktat – dort Schnellantworten nutzen. Die Einstellungsseite liegt unter `docs/config/` und bekommt Server und Token im URL-Hash; zurück an die Uhr geht es über `pebblejs://close#…`.

## Lizenz

[MIT](LICENSE) – frei verwendbar, auch kommerziell, solange der Copyright-Hinweis erhalten bleibt. Idee angelehnt an das frühere WatchieTalkie für die Pebble.
