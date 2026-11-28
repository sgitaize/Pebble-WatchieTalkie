# WatchieTalkie2 for Apple Watch

Standalone watchOS app (watchOS 10+, no iPhone app needed) that talks to the same server as the Pebble app – Apple Watch and Pebble users chat with each other.

- **End-to-end encrypted**, byte-compatible with the Pebble app: TweetNaCl in C (`WatchieTalkie/NaCl`, public domain), same envelope format and safety numbers. The secret key and token stay in the watch's keychain.
- **Speak** (dictation / Scribble / keyboard), quick replies and emoji, **voice messages** (record up to 30 s, play through the speaker; same 8 kHz IMA-ADPCM format as the Pebble), direct chats and groups, contact requests and group invitations.
- **Report and block**: swipe a message → Report, or ⓘ in a chat → Report / Block. Reports go to `POST /v1/report` → ntfy push to the operator and the `/admin` page. Feedback from Settings uses the same path.
- **Notifications while closed** via ntfy (Settings → Notifications sets up a random topic; the ntfy iPhone app mirrors it to the watch).

Build: `xcodegen generate` (project.yml), then Xcode. Upload to TestFlight from the Mac mini: `./upload.sh [build number]` (unsigned archive + cloud signing on export).

Debug builds accept `WT_SERVER`, `WT_TOKEN`, `WT_SK`, `WT_OPEN`, `WT_SEND`, `WT_AUDIOTEST`, `WT_TOP` as launch environment (simulator tests); release builds ignore them.
