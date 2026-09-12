#!/usr/bin/env bash
set -euo pipefail

repo="jjhbk/code-traffic"
machine="$(uname -m)"
case "$machine" in
  x86_64) architecture="x64" ;;
  arm64) architecture="arm64" ;;
  *) echo "Unsupported macOS architecture: $machine" >&2; exit 1 ;;
esac

asset_url="$(curl -fsSL "https://api.github.com/repos/${repo}/releases/latest" \
  | grep -oE '"browser_download_url": "[^"]+"' \
  | sed -E 's/^"browser_download_url": "([^"]+)"$/\1/' \
  | grep "darwin-${architecture}" \
  | grep "-${architecture}\.zip$" \
  | head -n 1)"
if [ -z "$asset_url" ]; then
  echo "No Signal Box macOS ${architecture} release was found." >&2
  exit 1
fi

temporary_zip="$(mktemp -t signal-box).zip"
temporary_directory="$(mktemp -d)"
trap 'rm -f "$temporary_zip"; rm -rf "$temporary_directory"' EXIT
echo "Downloading Signal Box for macOS ${architecture}..."
curl -fL "$asset_url" -o "$temporary_zip"
ditto -x -k "$temporary_zip" "$temporary_directory"
app_path="$(find "$temporary_directory" -maxdepth 2 -name 'Signal Box.app' -print -quit)"
if [ -z "$app_path" ]; then echo "The downloaded release did not contain Signal Box.app." >&2; exit 1; fi
rm -rf "/Applications/Signal Box.app"
ditto "$app_path" "/Applications/Signal Box.app"
open "/Applications/Signal Box.app"
echo "Signal Box installed successfully."
