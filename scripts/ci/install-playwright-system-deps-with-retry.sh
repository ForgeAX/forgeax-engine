#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: install-playwright-system-deps-with-retry.sh command [arg ...]" >&2
  exit 2
fi

repo_root="${GITHUB_WORKSPACE:-$(git rev-parse --show-toplevel)}"
apt_wrapper="$repo_root/scripts/ci/with-apt-ubuntu-sources.sh"

# A cancelled apt transaction must finish configuring before another install.
# Keep dpkg's native lock and failure; never bypass a failed recovery.
if [ "${RUNNER_OS:-$(uname -s)}" = Linux ] && command -v dpkg >/dev/null 2>&1; then
  privilege=()
  if [ "$(id -u)" -ne 0 ]; then privilege=(sudo -n); fi
  "${privilege[@]}" env DEBIAN_FRONTEND=noninteractive dpkg --force-confold --configure -a
fi

for attempt in 1 2 3; do
  if [ "$attempt" -eq 1 ]; then
    FORGEAX_APT_ARCHIVE_MIRROR=ubuntu-https "$apt_wrapper" "$@" && exit 0
  elif FORGEAX_APT_ARCHIVE_MIRROR=ubuntu-kernel-mirror "$apt_wrapper" "$@"; then
    exit 0
  fi

  if [ "$attempt" -lt 3 ]; then
    delay=$((attempt * 5))
    echo "[playwright-deps] install failed; retrying in ${delay}s with Ubuntu mirror fallback" >&2
    sleep "$delay"
  fi
done

echo "[playwright-deps] install failed after 3 attempts" >&2
exit 1
