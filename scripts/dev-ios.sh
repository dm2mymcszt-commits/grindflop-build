#!/usr/bin/env sh
set -eu

sh scripts/ensure-dev-port.sh
sh scripts/ensure-ios-scheme.sh

# ios dev does not regenerate the project, but a fresh checkout may not have
# one yet — only lay the launch screen in when there is somewhere to put it.
if [ -d src-tauri/gen/apple/Assets.xcassets ]; then
	sh scripts/apply-ios-launch-screen.sh
fi

SIMULATOR="${IOS_SIMULATOR:-iPhone 17 Pro}"
exec sh scripts/tauri.sh ios dev "$SIMULATOR"
