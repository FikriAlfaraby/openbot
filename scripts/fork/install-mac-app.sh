#!/bin/sh
# Fork: builds "OpenBot Fork" for this Mac and installs it in /Applications, pointed at the community
# account service. macOS keys privacy grants (Full Disk Access) to the signature, so sign with a stable
# identity: an ad-hoc signature changes with each build and loses the grants.
#
#   OPENBOT_FORK_SIGN_IDENTITY="Apple Development: name (TEAMID)" scripts/fork/install-mac-app.sh
#
# Settings (environment):
#   OPENBOT_FORK_SIGN_IDENTITY  codesign identity; "-" (ad-hoc) when unset
#   OPENBOT_AUTH_API_URL        default https://ob-api.fikrialfaraby.com
#   OPENBOT_REMOTE_SIGNAL_URL   default wss://ob-signal.fikrialfaraby.com/v1/signal
#   SKIP_BUILD=1                install the last build in dist/ again
set -eu

cd "$(dirname "$0")/../.."
NAME="OpenBot Fork"
APP="/Applications/$NAME.app"
BUILT="dist/mac-arm64/$NAME.app"
IDENTITY="${OPENBOT_FORK_SIGN_IDENTITY:--}"
AUTH_URL="${OPENBOT_AUTH_API_URL:-https://ob-api.fikrialfaraby.com}"
SIGNAL_URL="${OPENBOT_REMOTE_SIGNAL_URL:-wss://ob-signal.fikrialfaraby.com/v1/signal}"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

if [ "${SKIP_BUILD:-0}" != 1 ]; then
  bun run package -- --arm64 "--config.productName=$NAME" --config.appId=app.openbot.desktop.fork \
    "--config.extraMetadata.productName=$NAME"
fi
[ -d "$BUILT" ] || { echo "No build at $BUILT" >&2; exit 1; }

osascript -e "quit app \"$NAME\"" || true
i=0
while pgrep -f "$NAME.app/Contents/MacOS/$NAME\$" >/dev/null; do
  i=$((i + 1))
  [ "$i" -le 60 ] || { echo "$NAME did not quit" >&2; exit 1; }
  sleep 0.5
done

# The old copy goes to the Trash, so it can come back.
if [ -d "$APP" ]; then
  mv "$APP" "$HOME/.Trash/$NAME $(date +%Y%m%d-%H%M%S).app"
fi
ditto "$BUILT" "$APP"
PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Delete :LSEnvironment:OPENBOT_AUTH_API_URL" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Delete :LSEnvironment:OPENBOT_REMOTE_SIGNAL_URL" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :LSEnvironment:OPENBOT_AUTH_API_URL string $AUTH_URL" \
  -c "Add :LSEnvironment:OPENBOT_REMOTE_SIGNAL_URL string $SIGNAL_URL" "$PLIST"
codesign --force --deep --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict "$APP"

# Only the installed copy opens openbot: links. A build in dist/ would take them otherwise.
"$LSREGISTER" -u "$BUILT" 2>/dev/null || true
"$LSREGISTER" -f "$APP"
open -a "$APP"
echo "Installed $APP, signed by: $IDENTITY"
