#!/usr/bin/env sh
# Ad-hoc signing embeds the entitlement TrollStore preserves on installation.
# Run after xcodebuild, before copying the app into Payload. Not App Store signing.
set -eu
APP_PATH=${1:?Usage: sign-ios-trollstore.sh path/to/app.app}
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ ! -d "$APP_PATH" ]; then
    echo "App bundle not found: $APP_PATH" >&2
    exit 1
fi
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT HUP INT TERM
# Keep existing identity, or restore TrollStore's fallback for our unsigned IPAs.
/usr/bin/codesign -d --entitlements :- "$APP_PATH" > "$WORK/existing.plist" 2>/dev/null || true
python3 "$ROOT/scripts/ios-trollstore-entitlements.py" \
    "$WORK/existing.plist" "$ROOT/src-tauri/TrollStore.entitlements" "$WORK/merged.plist"
/usr/bin/codesign --force --sign - --entitlements "$WORK/merged.plist" "$APP_PATH"
/usr/bin/codesign --verify --strict "$APP_PATH"
/usr/bin/codesign -d --entitlements :- "$APP_PATH" > "$WORK/signed.plist" 2>/dev/null
python3 - "$WORK/merged.plist" "$WORK/signed.plist" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'rb') as f:
    expected = plistlib.load(f)
with open(sys.argv[2], 'rb') as f:
    actual = plistlib.load(f)
if any(actual.get(key) != value for key, value in expected.items()):
    raise SystemExit('The signed app is missing required entitlements')
print('TrollStore background entitlement and keychain identity verified in the signed app')
PY
