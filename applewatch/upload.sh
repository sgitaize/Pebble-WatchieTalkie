#!/bin/zsh
# Headless (per SSH auf dem Mac mini, ohne Schlüsselbund/Passwort): Archiv unsigniert bauen, beim Export per
# Cloud-Signing (Apple-ID in Xcode) signieren und direkt zu App Store Connect hochladen.
# Nutzung: ./upload.sh [Build-Nummer]   (Standard: Datum+Uhrzeit, damit jede Nummer neu ist)
set -euo pipefail
cd "$(dirname "$0")"
BUILD="${1:-$(date +%Y%m%d%H%M)}"
xcodegen generate -q
rm -rf build/WT.xcarchive build/export
xcodebuild -project WatchieTalkie.xcodeproj -scheme WatchieTalkie -configuration Release \
  -destination "generic/platform=iOS" -archivePath build/WT.xcarchive archive \
  CODE_SIGNING_ALLOWED=NO CURRENT_PROJECT_VERSION="$BUILD" -quiet
# Unsigniert archiviert trägt die Hülle noch die Kennung von Apples Stub – ad-hoc mit den richtigen IDs vorsignieren,
# der Export signiert danach richtig nach (Kennung bleibt erhalten)
APP=build/WT.xcarchive/Products/Applications/WatchieTalkie.app
codesign -f -s - -i de.sgitaize.watchietalkie.watchkitapp "$APP/Watch/WatchieTalkie Watch App.app"
codesign -f -s - -i de.sgitaize.watchietalkie "$APP"
xcodebuild -exportArchive -archivePath build/WT.xcarchive -exportOptionsPlist ExportOptions.plist \
  -exportPath build/export -allowProvisioningUpdates 2>&1 | grep -E "error|EXPORT|Upload" || true
echo "Build $BUILD"
