#!/bin/sh
# Install casefile (ADR 23). CI publishes this with each release, with __REPO__ filled in:
#   curl -fsSL https://github.com/OWNER/REPO/releases/latest/download/install.sh | sh
# Downloaded with curl, the app carries no quarantine flag, so macOS opens it without asking for
# a developer signature. Later versions arrive as signed patches inside the app.
set -eu
REPO="__REPO__"
DEST="${CASEFILE_INSTALL_DIR:-$HOME/Applications}"
URL="https://github.com/$REPO/releases/latest/download/casefile-macos-arm64.zip"

if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo "casefile needs a Mac with Apple silicon." >&2
  exit 1
fi
if pgrep -f "$DEST/casefile.app/Contents/MacOS/" >/dev/null 2>&1; then
  echo "casefile is running. Quit it (it locks the case) and run this again." >&2
  exit 1
fi
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$URL" -o "$TMP/casefile.zip"
ditto -x -k "$TMP/casefile.zip" "$TMP"
mkdir -p "$DEST"
rm -rf "$DEST/casefile.app"
mv "$TMP/casefile.app" "$DEST/"
xattr -dr com.apple.quarantine "$DEST/casefile.app" 2>/dev/null || true
echo "Installed $DEST/casefile.app"
open "$DEST/casefile.app"
