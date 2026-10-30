#!/usr/bin/env sh
set -eu

# tauri ios init regenerates src-tauri/gen/apple from its templates, and both
# CI workflows delete that directory before running it. So the launch screen
# and the app icon live outside it, and have to be laid back in after every
# init.

SRC="src-tauri/ios-launch"
DEST="src-tauri/gen/apple"

if [ ! -d "$DEST/Assets.xcassets" ]; then
	echo "apply-ios-launch-screen: $DEST/Assets.xcassets is missing; run tauri ios init first" >&2
	exit 1
fi

cp "$SRC/LaunchScreen.storyboard" "$DEST/LaunchScreen.storyboard"
for name in LaunchLogo.imageset LaunchBackground.colorset; do
	rm -rf "$DEST/Assets.xcassets/$name"
	cp -R "$SRC/$name" "$DEST/Assets.xcassets/$name"
done

# init fills AppIcon.appiconset with Tauri's placeholder logo. These carry the
# same file names as init's own Contents.json, so replacing the images in place
# is enough — the catalog needs no other change.
cp "$SRC"/AppIcon.appiconset/*.png "$DEST/Assets.xcassets/AppIcon.appiconset/"

# The decoy icons the app can switch to (Settings > Privacy > App Disguise).
# iOS wants alternate icons as loose files at the top of the app bundle,
# named in Info.plist (CFBundleAlternateIcons, in src-tauri/Info.plist). The
# folder that holds the generated Info.plist is one of the target's sources,
# so a PNG laid there is bundled as a resource without the project being
# told. This feature is optional: if that folder cannot be found the build
# goes on without the icons, and the app then simply reports that the icon
# could not be changed.
APP_PLIST="$(find "$DEST" -maxdepth 2 -name Info.plist | head -n 1)"
if [ -n "$APP_PLIST" ] && [ -d "$SRC/AlternateIcons" ]; then
	cp "$SRC"/AlternateIcons/*.png "$(dirname "$APP_PLIST")/"
	echo "apply-ios-launch-screen: decoy icons laid into $(dirname "$APP_PLIST")"
else
	echo "apply-ios-launch-screen: WARNING: decoy icons not applied (no generated Info.plist under $DEST)" >&2
fi

echo "apply-ios-launch-screen: launch screen and app icon applied to $DEST"
