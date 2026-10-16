#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: with-apt-ubuntu-sources.sh command [arg ...]" >&2
  exit 2
fi

if [ "${RUNNER_OS:-Linux}" != "Linux" ] || [ ! -d /etc/apt ]; then
  exec "$@"
fi

if command -v sudo >/dev/null 2>&1; then
  run_privileged() { sudo "$@"; }
elif [ "$(id -u)" -eq 0 ]; then
  run_privileged() { "$@"; }
else
  echo "[apt-sources] error: Linux apt isolation requires sudo or a root runner" >&2
  exit 1
fi

workspace_temp="${RUNNER_TEMP:-/tmp}"
isolation_dir="$workspace_temp/forgeax-apt-isolation-$$"
apt_config="$isolation_dir/apt.conf"
source_list="$isolation_dir/sources.list"
source_parts="$isolation_dir/sources.list.d"
mkdir -p "$isolation_dir"
run_privileged mkdir -p "$source_parts"

cleanup() {
  set +e
  run_privileged rm -f "/etc/apt/apt.conf.d/99forgeax-isolation-$$"
  run_privileged rm -rf "$isolation_dir"
}
trap cleanup EXIT INT TERM

projected_sources=0
projected_files=()
while IFS= read -r -d '' source_file; do
  source_name="$(basename "$source_file")"
  if [[ "$source_name" =~ (kubernetes|k8s) ]] \
    || run_privileged grep -Eiq 'kubernetes|k8s|packages\.k8s\.io|apt\.kubernetes\.io|prod-cdn\.packages' "$source_file"; then
    echo "[apt-sources] excluded $source_file"
    continue
  fi
  case "$source_file" in
    /etc/apt/sources.list)
      run_privileged cp -L "$source_file" "$source_list"
      projected_file="$source_list"
      ;;
    /etc/apt/sources.list.d/*)
      projected_file="$source_parts/$(basename "$source_file")"
      run_privileged cp -L "$source_file" "$projected_file"
      ;;
    *)
      continue
      ;;
  esac
  projected_files+=("$projected_file")
  projected_sources=$((projected_sources + 1))
  echo "[apt-sources] projected $source_file"
done < <(run_privileged find /etc/apt -maxdepth 3 \( -type f -o -type l \) \( -name '*.list' -o -name '*.sources' \) -print0)

distro_id=""
ubuntu_codename=""
if [ -r /etc/os-release ]; then
  distro_id="$(. /etc/os-release && printf '%s' "${ID:-}")"
  ubuntu_codename="$(. /etc/os-release && printf '%s' "${VERSION_CODENAME:-}")"
fi
has_ubuntu_archive=false
if [ "$distro_id" = ubuntu ] && [ -n "$ubuntu_codename" ]; then
  for projected_file in "${projected_files[@]}"; do
    if run_privileged grep -Eiq \
      "(^[[:space:]]*deb[[:space:]].*[[:space:]]${ubuntu_codename}([[:space:]-]|$))|(^Suites:[[:space:]].*(^|[[:space:]])${ubuntu_codename}([[:space:]-]|$))" \
      "$projected_file"; then
      has_ubuntu_archive=true
      break
    fi
  done
fi

if [ "$distro_id" = ubuntu ] && [ -n "$ubuntu_codename" ] && [ "$has_ubuntu_archive" = false ]; then
  fallback_source="$isolation_dir/forgeax-ubuntu.sources"
  cat > "$fallback_source" <<EOF
Types: deb
URIs: http://archive.ubuntu.com/ubuntu
Suites: $ubuntu_codename ${ubuntu_codename}-updates ${ubuntu_codename}-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: http://security.ubuntu.com/ubuntu
Suites: ${ubuntu_codename}-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF
  projected_file="$source_parts/forgeax-ubuntu.sources"
  run_privileged install -m 0644 "$fallback_source" "$projected_file"
  projected_files+=("$projected_file")
  projected_sources=$((projected_sources + 1))
  echo "[apt-sources] synthesized Ubuntu $ubuntu_codename archive projection"
fi

# Some self-hosted runners can resolve the Ubuntu archive but reject plain HTTP
# with a proxy-level 502. Keep the isolated projection deterministic and secure
# by upgrading only the canonical Ubuntu archive endpoints to HTTPS. Third-party
# sources remain unchanged, and the explicit mirror-list mode below still owns
# its own route selection.
for projected_file in "${projected_files[@]}"; do
  run_privileged sed -Ei \
    's#http://(archive|security)\.ubuntu\.com/ubuntu/?#https://\1.ubuntu.com/ubuntu#g' \
    "$projected_file"
done
echo "[apt-sources] normalized Ubuntu archive endpoints to HTTPS"

case "${FORGEAX_APT_ARCHIVE_MIRROR:-}" in
  '') ;;
  ubuntu-kernel-mirror)
    for projected_file in "${projected_files[@]}"; do
      run_privileged sed -Ei \
        's#https?://(([a-z0-9.-]+\.)?archive|security)\.ubuntu\.com/ubuntu/?#https://mirrors.edge.kernel.org/ubuntu#g' \
        "$projected_file"
    done
    echo "[apt-sources] archive fallback enabled through mirrors.edge.kernel.org"
    ;;
  ubuntu-https)
    for projected_file in "${projected_files[@]}"; do
      run_privileged sed -Ei \
        's#http://(([a-z0-9.-]+\.)?archive|security)\.ubuntu\.com/ubuntu/?#https://\1.ubuntu.com/ubuntu#g' \
        "$projected_file"
    done
    echo "[apt-sources] archive fallback enabled through HTTPS Ubuntu sources"
    ;;
  *)
    echo "[apt-sources] error: unsupported FORGEAX_APT_ARCHIVE_MIRROR value" >&2
    exit 2
    ;;
esac

{
  printf 'Dir::Etc::sourcelist "%s";\n' "$source_list"
  printf 'Dir::Etc::sourceparts "%s";\n' "$source_parts"
  printf '%s\n' 'Acquire::Retries "3";'
  printf '%s\n' 'Acquire::http::Timeout "30";'
  printf '%s\n' 'Acquire::https::Timeout "30";'
} > "$apt_config"
run_privileged install -m 0644 "$apt_config" "/etc/apt/apt.conf.d/99forgeax-isolation-$$"
echo "[apt-sources] isolated source projection active (${projected_sources} file(s)) for: $*"

"$@"
