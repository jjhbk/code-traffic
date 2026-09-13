#!/usr/bin/env bash
set -euo pipefail

repo="jjhbk/code-traffic"
machine="$(uname -m)"
# Under Rosetta, uname reports x86_64 even on Apple Silicon.
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = "1" ]; then
  machine="arm64"
fi
case "$machine" in
  x86_64) architecture="x64" ;;
  arm64) architecture="arm64" ;;
  *) echo "Unsupported macOS architecture: $machine" >&2; exit 1 ;;
esac
echo "Detected macOS architecture: $architecture"

release_json="$(curl -fsSL "https://api.github.com/repos/${repo}/releases/latest")"
asset_url="$(printf '%s\n' "$release_json" \
  | awk -F '"' -v architecture="$architecture" '
      /"browser_download_url"[[:space:]]*:/ {
        url = $4
        if (!found && index(url, "darwin-" architecture) &&
            url ~ ("-" architecture "\\.zip$")) {
          print url
          found = 1
        }
      }
    ')"
if [ -z "$asset_url" ]; then
  echo "No Signal Box macOS ${architecture} release was found." >&2
  exit 1
fi

temporary_directory="$(mktemp -d)"
temporary_zip="$temporary_directory/release.zip"
trap 'rm -rf "$temporary_directory"' EXIT
echo "Downloading Signal Box for macOS ${architecture}..."
curl -fL "$asset_url" -o "$temporary_zip"
ditto -x -k "$temporary_zip" "$temporary_directory"
app_path="$(find "$temporary_directory" -maxdepth 2 -type d \( -name 'Signal Box.app' -o -name 'signal-box.app' \) -print -quit)"
if [ -z "$app_path" ]; then echo "The downloaded release did not contain Signal Box.app or signal-box.app." >&2; exit 1; fi
rm -rf "/Applications/Signal Box.app"
ditto "$app_path" "/Applications/Signal Box.app"
open "/Applications/Signal Box.app"
echo "Signal Box installed successfully."
