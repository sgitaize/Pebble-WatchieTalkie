#!/usr/bin/env bash
# Lädt den aktuellen Build in den Pebble-Appstore und veröffentlicht ihn (--is-published).
# Vorher: pebble login; Release-Check (Version erhöht, pebble clean && pebble build, versionLabel in der .pbw).
# Nutzung: store/publish.sh [weitere pebble-publish-Argumente, z. B. --replace-screenshots]
set -euo pipefail
export PATH=$HOME/.local/bin:$PATH
cd "$(dirname "$0")/../watch"
pebble login --status
pebble publish \
  --non-interactive \
  --is-published \
  --no-gif-all-platforms \
  --name "WatchieTalkie2" \
  --category "daily" \
  --icon-small ../store/icon_small.png \
  --icon-large ../store/icon_large.png \
  --description "$(cat ../store/description.txt)" \
  --source "https://github.com/sgitaize/Pebble-WatchieTalkie" \
  --release-notes "$(cat ../store/release-notes.txt)" \
  --screenshots ../store/screenshots/*.png \
  "$@"
