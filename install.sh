#!/usr/bin/env bash
set -euo pipefail

repo="jjhbk/code-traffic"
api="https://api.github.com/repos/${repo}/releases/latest"
machine="$(uname -m)"
case "$machine" in
  x86_64|amd64) deb_arch="amd64"; rpm_arch="x86_64" ;;
  aarch64|arm64) deb_arch="arm64"; rpm_arch="aarch64" ;;
  *) echo "Unsupported architecture: $machine" >&2; exit 1 ;;
esac

if command -v apt-get >/dev/null 2>&1; then
  package_type="deb"
  asset_pattern="_${deb_arch}.deb"
elif command -v dnf >/dev/null 2>&1; then
  package_type="rpm"
  asset_pattern=".${rpm_arch}.rpm"
elif command -v yum >/dev/null 2>&1; then
  package_type="rpm"
  asset_pattern=".${rpm_arch}.rpm"
else
  echo "Signal Box supports apt, dnf, or yum for automatic installation." >&2
  exit 1
fi

asset_url="$(curl -fsSL "$api" \
  | grep -oE '"browser_download_url": "[^"]+"' \
  | sed -E 's/^"browser_download_url": "([^"]+)"$/\1/' \
  | grep "${asset_pattern}" \
  | head -n 1)"
if [ -z "$asset_url" ]; then
  echo "No Signal Box ${package_type} release was found for ${machine}." >&2
  exit 1
fi

temporary_package="$(mktemp --suffix=".${package_type}")"
trap 'rm -f "$temporary_package"' EXIT
echo "Downloading Signal Box for ${machine}..."
curl -fL "$asset_url" -o "$temporary_package"

if [ "$package_type" = "deb" ]; then
  sudo apt-get install -y "$temporary_package"
else
  sudo "$([ "$(command -v dnf || true)" ] && echo dnf || echo yum)" install -y "$temporary_package"
fi

echo "Signal Box installed successfully."
