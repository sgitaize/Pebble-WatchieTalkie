# WatchieTalkie2 – Walkie-Talkie for Pebble

<a href="https://www.paypal.com/donate/?hosted_button_id=LGAZB9PR4YV5L"><img src="store/buy-me-a-spezi.svg" alt="Buy me a Spezi" height="40"></a>

Pick a contact on your watch, press SELECT, speak – the message arrives as text on the other side. **End-to-end encrypted**, fully open source, and you can run your own server.

WatchieTalkie2 is a **continuation of the former [Watchie-Talkie](https://apps.repebble.com/55de02ca4374cb08ff000055)**, which has been offline for years. The motivation: everyone should be able to have a just-for-fun chat with friends right on their wrist – and host the server themselves if they want to. Rewritten from scratch, no connection to the original provider.

- **Speech → text** via Pebble dictation (watches with a microphone); the full recognized text is shown for confirmation before sending, dictated messages are marked "dictated"
- **Date and time** under every message
- **Quick replies** (fully customizable, also for watches without a microphone)
- **Usernames, invitations, blocking** – up to 3 aliases per account (e.g. a developer and a private name; invitations to an alias go to the main account, and the contact then sees the main name)
- **Direct chats and groups** (up to 20 members)
- **Chat history:** last 50 messages per chat, at most 30 days
- **End-to-end encryption:** the server operator cannot read messages
- **Notifications while the app is closed (optional)** via [ntfy](https://ntfy.sh) (including your own server), your own Telegram bot, or [Pushover](https://pushover.net) – see [Why a phone notification?](#why-a-phone-notification)
- **All Pebble models:** Pebble / Steel (aplite), Time / Time Steel (basalt), Time Round (chalk), Pebble 2 (diorite), Time 2 (emery), Pebble 2 Duo (flint), Round 2 (gabbro)
- **Adjustable look**: text size (small, large bold, extra large bold), background and text color, backlight stays on while the app is open (optional) – set in the settings, stored per phone
- **Radio beep** for new messages through the speaker (Time 2, Pebble 2 Duo, Round 2; can be turned off – on the watch: long SELECT in the list → Beep on/off; in Quiet Time there is neither beep nor vibration)
- **Battery-friendly:** long polling only while the app is open (a request waits up to 25 s and returns immediately when something new arrives), no background activity otherwise
- **Lightweight server:** Node.js with no dependencies, a single file, JSON storage; info page with statistics (users, messages, how many dictated); Docker supported

## Why a phone notification?
A Pebble app cannot listen for messages while it is closed. In the past a server sent timeline pins for this, but the new Pebble app (Core) does not fetch timeline pins from servers. What remains is a regular phone notification that the Pebble app forwards to the watch. For this, the server sends a short notice ("New message: sender" or "Contact request from name", never the content) to a service of your choice (settings page → "Phone notification"):

| Service | Cost | Setup |
|---|---|---|
| [ntfy](https://ntfy.sh) | free, open source | subscribe to the topic from the settings page in the ntfy app; your own ntfy server (https) is possible |
| Telegram | free | create your own bot with @BotFather, send it "/start", enter the bot token → "Connect" (the server fetches the chat ID) |
| [Pushover](https://pushover.net) | one-time purchase after 30 days | enter your user key + the API token of your own Pushover application (the server operator can provide one for everyone via `PUSHOVER_TOKEN`) |

Optional in the settings: no further notification within X minutes after one, and a pause from the watch (long SELECT in the list or a chat → **Pause push**, e.g. 15 min) – handy when you open the app after the first notification anyway.

Then allow notifications for this app in the Pebble app. **Entirely optional:** without ntfy, messages arrive as soon as the app is open on the watch. For the server it is just one HTTPS request per message, no extra software. Bot tokens and Pushover keys are stored in plain text in `data/db.json` (treat it like credentials).

## Architecture

```
Watch (C) ⇄ AppMessage ⇄ PebbleKit JS (phone, encrypts/decrypts) ⇄ HTTPS/JSON ⇄ Server (Node.js, sees only ciphertext)
                                                                      ▲
                                        Settings page (GitHub Pages) ─┘
```

| Folder | Contents |
|---|---|
| `watch/` | Pebble app: `src/c/main.c` (watch), `src/pkjs/index.js` (phone), `src/pkjs/e2e.js` (encryption), `src/pkjs/nacl-fast.js` (TweetNaCl) |
| `server/` | Server (`server.js`), home page, legal notice/privacy/disclaimer, API test (`test.js`) |
| `docs/` | GitHub Pages: home page and settings page (`docs/config/`) |
| `store/` | Store texts, icons, banners |

## Usage

1. Install WatchieTalkie2 from the Pebble App Store: [apps.repebble.com/5baaf5505dcf4454bdab0478](https://apps.repebble.com/5baaf5505dcf4454bdab0478)
2. In the Pebble app, open **Settings** for WatchieTalkie2: choose a username, invite friends by username, create groups, set up quick replies, **Save**.
3. On the watch: pick a chat → **SELECT** = speak, **long SELECT** = menu: emoji (shown as pictures), delete your own last message, pause push – quick replies below, **up/down** = scroll. Invitations appear at the top of the list and can be accepted right on the watch.
4. New phone: show the **transfer code** in the settings and enter it on the new phone under "I already have an account" (it contains your access and secret key – never share it).

## Security

**Encryption (end-to-end).** Every account has an X25519 key pair; the secret key stays on the phone. Each message is encrypted with a random key (XSalsa20-Poly1305, NaCl `secretbox`), and that key is wrapped separately for each recipient with NaCl `box`. The server only stores and distributes ciphertext and public keys and can neither read nor forge messages. Library: [TweetNaCl-js](https://github.com/dchest/tweetnacl-js) (audited, public domain).

- **Randomness:** the iOS environment of the Pebble app has no `crypto.getRandomValues`. Therefore the settings page (real browser randomness) generates keys and a 32-byte seed; the app derives from it using SHA-512, a counter and – where available – system randomness.
- **Safety numbers:** the settings page shows your own number and those of your contacts. Comparing them once in person rules out a server operator slipping in fake keys. If a contact's key changes, the app warns you.
- **Not encrypted (metadata):** usernames, who is in contact with whom, group names and members, time and approximate length of messages. Notifications (ntfy, Telegram, Pushover, timeline) contain only the sender, never the content; the chosen service therefore sees the sender's name.

**Protection against tampering (server).**
- Access via a random 256-bit device token; the server stores only its SHA-256 hash.
- Messages only between confirmed contacts or group members; blocked users cannot send invitations.
- Plain text is rejected, encrypted messages are checked for shape and size; only envelopes for actual chat participants are stored, and each reader receives only their own.
- Public keys can only be fetched for contacts and group members (no directory for strangers).
- Names are strictly validated (`a–z 0–9 _`, not starting with `_`, reserved names blocked); all tables have no prototype – `__proto__`/`constructor` tricks don't work.
- Limits on everything: requests per IP, registrations per IP, messages and invitations per account, body size, number of contacts/groups/accounts, history; timeouts against slow connections.
- Static pages with Content-Security-Policy, `X-Frame-Options`, `Referrer-Policy`; the settings page removes tokens/keys from the address bar immediately.
- Multiple Passenger processes: the first one leads, the others forward via Unix socket (no duplicated state).

## Running your own server

The server only needs **Node.js ≥ 18** – no database, no `npm install`. Each user enters their server's address on the settings page; you can chat with everyone on the same server.

```bash
cd server
PORT=3000 node server.js       # then http://localhost:3000
node test.js                   # API test with its own test server
node test.js https://my-server.example   # against a running server (creates test accounts and deletes them)
```

HTTPS is required (reverse proxy such as Caddy/nginx or hosting with Let's Encrypt). At the server address, an info page explains what the server does, with statistics (registered users, messages sent, how many dictated).

**Docker:**

```bash
cd server
docker compose up -d           # port 3000, data in the "data" volume; settings via environment in docker-compose.yml
```

**Plesk (e.g. netcup web hosting):** upload the contents of `server/` to `httpdocs/`, then enable *Node.js* with application root `/httpdocs`, document root `/httpdocs/public` (stays empty – Node serves all pages from `pages/` with security headers), startup file `server.js`, mode `production`. *Run script → setup* checks write permissions and restarts. Errors go to `logs/app.log`.

| Environment variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | Port (without Passenger) |
| `REGISTER_CODE` | – | Registration only with this code (private server for friends) |
| `MAX_USERS` | 1000 | Maximum number of accounts |
| `HISTORY_MAX` | 50 | Messages per chat |
| `HISTORY_DAYS` | 30 | Messages older than … days are deleted |
| `TIMELINE_API` | `https://timeline-api.rebble.io` | Timeline service for notifications (Rebble app only), `off` = disabled |
| `NTFY_URL` | `https://ntfy.sh` | Suggested ntfy server for phone notifications, `off` = ntfy disabled (users can enter their own https server) |
| `PUSHOVER_TOKEN` | – | Pushover application token for all users (otherwise everyone enters their own) |
| `SERVER_NAME` | WatchieTalkie2 | Display name |
| `DONATE_URL` | project donation link | Donate button on the info page, `off` = hidden |
| `ADMIN_KEY` | – | Enables the operator page `/admin` (alternatively put the SHA-256 hex of the key into `server/data/admin-key`). Without it there is no admin page. |

Data is stored in `server/data/db.json` (ciphertext only) – copy the file to back it up. **If you run a public server, you must replace `public/impressum.html` (legal notice) with your own details.**

**Admin page:** `https://<your server>/admin` – log in with the admin key. Shows counters and all accounts (metadata only: names, aliases, created/last seen, contact/group counts, push service; never tokens, keys, push credentials or messages) and lets you delete accounts. **Reset** helps users who lost their phone without a transfer code: the server issues a new token (old phone stops working, public key and timeline token are dropped), the page creates a new secret key in your browser (the server never sees it) and shows a transfer code `WT1:…` for the new phone. Contacts and groups stay; every chat of the account shows "<name> reset their account" and contacts get the key-change warning. Old messages can't be read any more (end-to-end encryption). "Unsaved" accounts were registered but never saved to a phone (nobody can log in to them); a button removes those older than 24 h. Wrong keys are limited to 10 attempts per 10 minutes and IP.

### API (summary)

JSON, authentication with `Authorization: Bearer <device token>`. Chat IDs: `u.<name>` (direct chat) or `g.<group>`. Messages: `e = {v:1, n:<nonce>, c:<ciphertext>, k:{<name>: <envelope>}}` (Base64).

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/info` | Server info |
| GET | `/v1/stats` | Public counters: users, groups, messages, how many dictated |
| POST | `/v1/register` | `{name, code?}` → `{name, token}` |
| GET / PUT / DELETE | `/v1/me` | Profile, settings (`cfg`, incl. `push` = `''`/`ntfy`/`telegram`/`pushover`, `ntfy`, `ntfyUrl`, `poUser`, `poToken`), `pubKey`, `timelineToken`, delete account |
| POST · DELETE | `/v1/me/aliases` · `/v1/me/aliases/:name` | `{name}` add alias (max. 3) / remove |
| GET | `/v1/keys` | Public keys of contacts and group members |
| POST | `/v1/contacts` | `{name}` invite (accepts if the other user has already invited you) |
| POST | `/v1/contacts/:name/accept` | Accept invitation |
| DELETE | `/v1/contacts/:name` | Remove contact / decline / withdraw |
| POST · DELETE | `/v1/blocks` · `/v1/blocks/:name` | Block / unblock |
| POST | `/v1/groups` | `{title, members[]}` create group |
| POST | `/v1/groups/:id/invite` · `/accept` | Invite / accept |
| PUT · DELETE | `/v1/groups/:id` | Rename / leave |
| DELETE | `/v1/groups/:id/members/:name` | Owner only: remove member / withdraw invitation |
| GET | `/v1/chats` | Chat list with unread counters |
| GET · POST | `/v1/chats/:id/messages` | History (`?limit=`) / send `{e, voice?}` (`voice` only counts for statistics) |
| DELETE | `/v1/chats/:id/messages/:msgId` | Delete your own message (for everyone) |
| POST | `/v1/chats/:id/read` | `{upTo}` mark as read |
| GET | `/v1/poll?since=&wait=&invites=` | Everything new since message number (`del` = chats with deleted messages); with `wait` (≤ 25 s) long polling |
| POST | `/v1/me/telegram` | `{bot}` connect Telegram bot (chat ID via getUpdates), `{bot: ''}` disconnects |
| POST | `/v1/test` | `{delay?}` (0–60 s) test message from the server in the read-only chat `u.watchietalkie` (fixed plain text `t`, with phone/timeline notification) – 5 per 10 min |
| GET · DELETE | `/v1/admin/users` · `/v1/admin/users/:name` | Admin only (`Authorization: Admin <key>`): account list + counters / delete account |
| POST | `/v1/admin/users/:name/reset` | Admin only: new token for a lost account (`{ name, token, chats }`), drops public key, notifies all its chats |

## Development

```bash
cd watch
pebble build                                   # builds for all 7 platforms
pebble install --emulator emery build/watch.pbw
```

There is no dictation in the emulator – use quick replies there. The settings page (`docs/config/`) receives server, token and keys in the URL hash and returns them via `pebblejs://close#…`.

## Disclaimer

WatchieTalkie2 is a free hobby project provided **without any warranty** – no guarantee of availability, delivery or storage, not intended for emergencies or important communications. Senders are responsible for the content of their messages. Anyone running the software themselves is responsible for their server, their users and compliance with the law. Details: legal notice (Impressum) of the respective server (public server: [watchietalkie.aize-it.de/impressum.html](https://watchietalkie.aize-it.de/impressum.html)).

## Support

WatchieTalkie2 is a free, ad-free hobby project. If you would like to support the public server and development:

<a href="https://www.paypal.com/donate/?hosted_button_id=LGAZB9PR4YV5L"><img src="store/buy-me-a-spezi.svg" alt="Buy me a Spezi" height="40"></a>

## Voice messages?

The Pebble SDK currently does not allow apps to record audio from the microphone – only the finished dictation as text. Real voice messages are therefore not possible; spoken messages arrive as text (and are counted as "dictated" in the statistics). Playback through the speaker would work – once a recording API becomes available, this can be added.

## License

[MIT](LICENSE) – free to use, including commercially, as long as the copyright notice is retained. TweetNaCl-js: public domain. Emoji images on the watch: rendered from [Noto Color Emoji](https://github.com/googlefonts/noto-emoji) (SIL Open Font License 1.1) with `watch/tools/emoji.py`. Idea and name inspired by the former Watchie-Talkie for Pebble.
