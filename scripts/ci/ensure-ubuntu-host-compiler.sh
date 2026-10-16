#!/usr/bin/env bash
set -euo pipefail

if [ ! -r /etc/os-release ]; then
  echo 'Ubuntu host identity is unavailable.' >&2
  exit 1
fi
. /etc/os-release
if [ "${ID:-}" != 'ubuntu' ]; then
  echo "expected Ubuntu host, got ${ID:-unknown}" >&2
  exit 1
fi

if ! command -v cc >/dev/null 2>&1; then
  command -v sudo >/dev/null
  command -v apt-get >/dev/null

  # The persistent image may carry an unrelated third-party source with an
  # expired signing key. Refresh only the Ubuntu source file so that an
  # optional host-compiler bootstrap is not coupled to that source.
  ubuntu_source=''
  for candidate in \
    /etc/apt/sources.list.d/ubuntu.sources \
    /etc/apt/sources.list \
    /etc/apt/sources.list.d/ubuntu.list; do
    if [ -r "$candidate" ] && grep -Eq '^[[:space:]]*(deb([[:space:]]|$)|Types:[[:space:]]*deb([[:space:]]|$))' "$candidate"; then
      ubuntu_source="$candidate"
      break
    fi
  done

  if [ -n "$ubuntu_source" ]; then
    apt_options=(
      -o "Dir::Etc::sourcelist=$ubuntu_source"
      -o 'Dir::Etc::sourceparts=-'
    )
    sudo apt-get "${apt_options[@]}" update
  else
    echo 'Ubuntu APT source file is unavailable.' >&2
    exit 1
  fi
  sudo DEBIAN_FRONTEND=noninteractive apt-get \
    "${apt_options[@]}" \
    install -y --no-install-recommends build-essential
fi

command -v cc
cc --version | head -1
