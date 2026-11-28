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
  -destination "generic/platform=watchOS" -archivePath build/WT.xcarchive archive \
  CODE_SIGNING_ALLOWED=NO CURRENT_PROJECT_VERSION="$BUILD" -quiet
xcodebuild -exportArchive -archivePath build/WT.xcarchive -exportOptionsPlist ExportOptions.plist \
  -exportPath build/export -allowProvisioningUpdates 2>&1 | grep -E "error|EXPORT|Upload" || true
echo "Build $BUILD"
