#!/usr/bin/env python3
"""Prepare the Linux-only Emscripten release without external xz tools."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import uuid
from pathlib import Path, PurePosixPath
from typing import Any


DEFAULT_VERSION = "6.0.2"
EXPECTED_RELEASE_HASH = "004876f1984e18a9eb0736c5ca417ac86d386fb8"
EXPECTED_RELEASE_IDENTITY = f"releases-{EXPECTED_RELEASE_HASH}-64bit"
EXPECTED_RUNNER_OS = "Linux"
EXPECTED_RUNNER_ARCH = "x86_64"
ROOT = Path(__file__).resolve().parents[2]
FINGERPRINT_FIELDS = (
  "emscriptenVersion",
  "releaseIdentity",
  "runnerOs",
  "runnerArch",
  "bootstrapInputDigest",
)


class ContractError(Exception):
  def __init__(self, reason: str, expected: Any, observed: Any, hint: str, stage: str) -> None:
    super().__init__(reason)
    self.reason = reason
    self.expected = expected
    self.observed = observed
    self.hint = hint
    self.stage = stage

  def payload(self) -> dict[str, Any]:
    return {
      "status": "rejected",
      "stage": self.stage,
      "reason": self.reason,
      "expected": self.expected,
      "observed": self.observed,
      "hint": self.hint,
    }


def _canonical_json(value: Any) -> bytes:
  return json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode("utf-8")


def _fingerprint_value(value: Any) -> str:
  return f"sha256:{hashlib.sha256(_canonical_json(value)).hexdigest()}"


def _normalize_version(value: str) -> str:
  normalized = value.strip()
  if normalized.startswith("v"):
    normalized = normalized[1:]
  if not normalized:
    raise ValueError("empty version")
  return normalized


def _read_json(path: Path, stage: str) -> dict[str, Any]:
  try:
    value = json.loads(path.read_text(encoding="utf-8"))
  except FileNotFoundError as error:
    raise ContractError(
      "release-metadata-missing" if stage == "release-metadata" else "lock-read-failed",
      {"path": str(path)},
      {"path": str(path), "error": "missing"},
      "restore the release metadata or lock file before rerunning the bootstrap",
      stage,
    ) from error
  except (OSError, json.JSONDecodeError) as error:
    raise ContractError(
      "release-metadata-invalid" if stage == "release-metadata" else "lock-read-failed",
      {"path": str(path), "type": "JSON object"},
      {"path": str(path), "error": str(error)},
      "restore valid JSON and rerun the Linux bootstrap",
      stage,
    ) from error
  if not isinstance(value, dict):
    raise ContractError(
      "release-metadata-invalid" if stage == "release-metadata" else "lock-shape-invalid",
      {"type": "object"},
      {"type": type(value).__name__},
      "provide a JSON object containing the fixed release identity",
      stage,
    )
  return value


def _required_lock_string(lock: dict[str, Any], field: str) -> str:
  value = lock.get(field)
  if not isinstance(value, str) or not value.strip():
    raise ContractError(
      "missing-lock-field",
      {"field": field},
      {"field": field, "value": value},
      "restore the missing lowerCamelCase identity field in the lock",
      "release-identity",
    )
  return value.strip()


def _validate_toolchain_layout(lock: dict[str, Any]) -> dict[str, str]:
  layout = lock.get("toolchainLayout")
  fields = (
    "installRoot",
    "toolBinRelativePath",
    "binaryenRootRelativePath",
    "emscriptenCacheRelativePath",
    "compilerRelativePath",
    "releaseMarkerRelativePath",
  )
  if not isinstance(layout, dict):
    raise ContractError(
      "missing-toolchain-layout",
      {"field": "toolchainLayout"},
      {"field": "toolchainLayout", "value": layout},
      "restore the pinned archive install root, compiler path, and cache release marker path",
      "release-identity",
    )
  normalized: dict[str, str] = {}
  for field in fields:
    value = layout.get(field)
    if not isinstance(value, str) or not value.strip():
      raise ContractError(
        "invalid-toolchain-layout",
        {"field": field, "path": "non-empty relative POSIX path"},
        {"field": field, "value": value},
        "restore the relative toolchain layout from the pinned archive contract",
        "release-identity",
      )
    candidate = value.strip().replace("\\", "/")
    if (
      candidate.startswith("/")
      or candidate.startswith("//")
      or re.match(r"^[A-Za-z]:", candidate)
      or not PurePosixPath(candidate).parts
      or ".." in PurePosixPath(candidate).parts
    ):
      raise ContractError(
        "invalid-toolchain-layout",
        {"field": field, "path": "relative POSIX path without .."},
        {"field": field, "value": value},
        "restore a contained relative path in the pinned toolchain layout",
        "release-identity",
      )
    normalized[field] = candidate
  return normalized


def _validate_archive_lock(lock: dict[str, Any], release_hash: str) -> dict[str, Any]:
  archive_url = _required_lock_string(lock, "archiveUrl")
  expected_url = (
    "https://storage.googleapis.com/webassembly/emscripten-releases-builds/"
    f"linux/{release_hash}/wasm-binaries.tar.xz"
  )
  if archive_url != expected_url:
    raise ContractError(
      "archive-url-mismatch",
      {"archiveUrl": expected_url},
      {"archiveUrl": archive_url},
      "use the Linux x86_64 wasm-binaries.tar.xz URL derived from the pinned release hash",
      "release-identity",
    )

  archive_sha256 = _required_lock_string(lock, "archiveSha256")
  if not re.fullmatch(r"sha256:[0-9a-f]{64}", archive_sha256):
    raise ContractError(
      "archive-digest-invalid",
      {"archiveSha256": "sha256:<64 lowercase hex characters>"},
      {"archiveSha256": archive_sha256},
      "record the independently verified SHA-256 for the pinned release archive",
      "release-identity",
    )

  content_length = lock.get("archiveContentLength")
  if not isinstance(content_length, int) or content_length <= 0:
    raise ContractError(
      "archive-length-invalid",
      {"archiveContentLength": "positive integer"},
      {"archiveContentLength": content_length},
      "record the authoritative content length for the pinned release archive",
      "release-identity",
    )

  metadata_urls = {}
  for field in ("emsdkManifestUrl", "emscriptenReleasesTagsUrl"):
    metadata_url = _required_lock_string(lock, field)
    if "/6.0.2/" not in metadata_url or not metadata_url.startswith("https://"):
      raise ContractError(
        "metadata-url-invalid",
        {field: "HTTPS URL pinned to emsdk 6.0.2"},
        {field: metadata_url},
        "use authoritative emsdk 6.0.2 metadata URLs in the repository lock",
        "release-identity",
      )
    metadata_urls[field] = metadata_url

  return {
    "archiveUrl": archive_url,
    "archiveSha256": archive_sha256,
    "archiveContentLength": content_length,
    "toolchainLayout": _validate_toolchain_layout(lock),
    **metadata_urls,
  }


def resolve_release_identity(version: str, lock: dict[str, Any]) -> dict[str, Any]:
  requested_version = _normalize_version(version)
  locked_version = _required_lock_string(lock, "emscriptenVersion")
  if requested_version != DEFAULT_VERSION or locked_version != DEFAULT_VERSION:
    raise ContractError(
      "version-mismatch",
      {"emscriptenVersion": DEFAULT_VERSION},
      {"emscriptenVersion": requested_version, "lockedVersion": locked_version},
      "rerun with Emscripten 6.0.2 and the matching repository lock",
      "release-identity",
    )

  release_hash = _required_lock_string(lock, "releaseHash")
  if release_hash != EXPECTED_RELEASE_HASH:
    raise ContractError(
      "release-hash-mismatch",
      {"releaseHash": EXPECTED_RELEASE_HASH},
      {"releaseHash": release_hash},
      "restore the pinned 6.0.2 release hash; do not select another release",
      "release-identity",
    )

  expected_identity = f"releases-{release_hash}-64bit"
  release_identity = lock.get("releaseIdentity")
  if not isinstance(release_identity, str) or not release_identity.strip():
    raise ContractError(
      "missing-release-identity",
      {"releaseIdentity": expected_identity},
      {"releaseIdentity": release_identity},
      "restore the direct release identity in the lock; sdk-releases aliases are not accepted",
      "release-identity",
    )
  release_identity = release_identity.strip()
  if release_identity != expected_identity or release_identity.startswith("sdk-"):
    raise ContractError(
      "release-identity-mismatch",
      {"releaseIdentity": expected_identity},
      {"releaseIdentity": release_identity},
      "use the direct releases-<hash>-64bit tool, not an sdk-releases alias",
      "release-identity",
    )
  if release_identity != EXPECTED_RELEASE_IDENTITY:
    raise ContractError(
      "release-identity-mismatch",
      {"releaseIdentity": EXPECTED_RELEASE_IDENTITY},
      {"releaseIdentity": release_identity},
      "restore the pinned direct release tool for Emscripten 6.0.2",
      "release-identity",
    )

  runner_os = _required_lock_string(lock, "runnerOs")
  runner_arch = _required_lock_string(lock, "runnerArch")
  if runner_os != EXPECTED_RUNNER_OS or runner_arch != EXPECTED_RUNNER_ARCH:
    raise ContractError(
      "runner-identity-mismatch",
      {"runnerOs": EXPECTED_RUNNER_OS, "runnerArch": EXPECTED_RUNNER_ARCH},
      {"runnerOs": runner_os, "runnerArch": runner_arch},
      "run this helper only from the Linux x86_64 provisioning branch",
      "release-identity",
    )

  bootstrap_input = lock.get("bootstrapInput")
  if not isinstance(bootstrap_input, dict) or not bootstrap_input:
    raise ContractError(
      "missing-bootstrap-input",
      {"field": "bootstrapInput"},
      {"field": "bootstrapInput", "value": bootstrap_input},
      "restore the lock inputs used to derive the bootstrap fingerprint",
      "release-identity",
    )

  archive_input = _validate_archive_lock(lock, release_hash)
  return {
    "emscriptenVersion": DEFAULT_VERSION,
    "releaseIdentity": release_identity,
    "releaseHash": release_hash,
    "runnerOs": runner_os,
    "runnerArch": runner_arch,
    "bootstrapInputDigest": _fingerprint_value({**bootstrap_input, **archive_input}),
  }


def _node_path_is_bundled(path: str, bundled_paths: list[str]) -> bool:
  normalized = os.path.realpath(path)
  bundled = {os.path.realpath(value) for value in bundled_paths}
  if normalized in bundled:
    return True
  parts = {part.lower() for part in Path(normalized).parts}
  return "emsdk" in parts or "emsdk-main" in parts


def validate_node_authority(contract: dict[str, Any]) -> dict[str, str]:
  required = ("nodeExpectedVersion", "nodeVersion", "nodePath", "emsdkNode")
  for field in required:
    value = contract.get(field)
    if not isinstance(value, str) or not value.strip():
      raise ContractError(
        "missing-node-field",
        {"field": field},
        {"field": field, "value": value},
        "provide the .nvmrc version, actual node version, command path, and EMSDK_NODE path",
        "node-authority",
      )

  expected_version = _normalize_version(contract["nodeExpectedVersion"])
  actual_version = _normalize_version(contract["nodeVersion"])
  if actual_version != expected_version:
    raise ContractError(
      "version-mismatch",
      {"nodeExpectedVersion": expected_version},
      {"nodeVersion": actual_version},
      "install or select the .nvmrc Node version before provisioning Emscripten",
      "node-authority",
    )

  node_path = os.path.realpath(contract["nodePath"])
  emsdk_node = os.path.realpath(contract["emsdkNode"])
  bundled_paths = contract.get("bundledNodePaths", [])
  if not isinstance(bundled_paths, list) or not all(isinstance(value, str) for value in bundled_paths):
    raise ContractError(
      "invalid-bundled-node-list",
      {"bundledNodePaths": "array of paths"},
      {"bundledNodePaths": bundled_paths},
      "provide the observed Emscripten bundled Node paths as a string array",
      "node-authority",
    )
  if _node_path_is_bundled(emsdk_node, bundled_paths):
    raise ContractError(
      "bundled-node",
      {"emsdkNode": node_path, "bundledNodePaths": []},
      {"emsdkNode": emsdk_node, "bundledNodePaths": bundled_paths},
      "use the .nvmrc system Node and keep Emscripten bundled Node out of PATH",
      "node-authority",
    )
  if not Path(node_path).is_file():
    raise ContractError(
      "node-path-mismatch",
      {"nodePath": "existing normalized executable"},
      {"nodePath": node_path},
      "use the normalized path returned by command -v node",
      "node-authority",
    )
  if node_path != emsdk_node:
    raise ContractError(
      "emsdk-node-mismatch",
      {"nodePath": node_path},
      {"emsdkNode": emsdk_node},
      "set EMSDK_NODE to the normalized system node path",
      "node-authority",
    )

  return {
    "nodeExpectedVersion": expected_version,
    "nodeVersion": actual_version,
    "nodePath": node_path,
    "emsdkNode": emsdk_node,
  }


def _read_expected_node_version(path: Path) -> str:
  try:
    value = path.read_text(encoding="utf-8").strip()
  except OSError as error:
    raise ContractError(
      "nvmrc-read-failed",
      {"path": str(path)},
      {"error": str(error)},
      "restore .nvmrc before running the Linux Node authority check",
      "node-authority",
    ) from error
  if not value:
    raise ContractError(
      "missing-node-field",
      {"field": "nodeExpectedVersion"},
      {"field": "nodeExpectedVersion", "value": value},
      "set the expected Node version in .nvmrc",
      "node-authority",
    )
  return _normalize_version(value)


def observe_system_node(nvmrc_path: Path, enforce_version: bool) -> tuple[dict[str, str], str]:
  node_command = shutil.which("node")
  if node_command is None:
    raise ContractError(
      "node-missing",
      {"command": "node"},
      {"command": None},
      "run setup-node from .nvmrc before the Linux Emscripten helper",
      "node-authority",
    )
  node_path = os.path.realpath(node_command)
  result = subprocess.run([node_path, "--version"], capture_output=True, text=True, check=False)
  if result.returncode != 0:
    raise ContractError(
      "node-version-failed",
      {"command": [node_path, "--version"]},
      {"exitCode": result.returncode, "stderr": result.stderr.strip()},
      "run the system Node selected by setup-node and retry",
      "node-authority",
    )
  emsdk_node = os.environ.get("EMSDK_NODE") or node_path
  contract = {
    "nodeExpectedVersion": _read_expected_node_version(nvmrc_path),
    "nodeVersion": result.stdout.strip(),
    "nodePath": node_path,
    "emsdkNode": emsdk_node,
    "bundledNodePaths": [],
  }
  expected = contract["nodeExpectedVersion"]
  actual = _normalize_version(contract["nodeVersion"])
  try:
    authority = validate_node_authority(contract)
    return authority, "ready"
  except ContractError as error:
    if enforce_version or error.reason != "version-mismatch":
      raise
    return {
      "nodeExpectedVersion": expected,
      "nodeVersion": actual,
      "nodePath": node_path,
      "emsdkNode": os.path.realpath(emsdk_node),
    }, "version-mismatch"


def _normalize_member_name(name: str) -> str:
  candidate = name.replace("\\", "/")
  if candidate.startswith("/") or re.match(r"^[A-Za-z]:/", candidate) or candidate.startswith("//"):
    raise ContractError(
      "archive-member-unsafe",
      {"path": "relative POSIX path"},
      {"path": name},
      "remove absolute paths and Windows drive or UNC prefixes from the release archive",
      "archive-preflight",
    )
  parts = [part for part in PurePosixPath(candidate).parts if part not in ("", ".")]
  if not parts or ".." in parts:
    raise ContractError(
      "archive-member-unsafe",
      {"path": "relative path without .."},
      {"path": name},
      "rebuild the release archive with members contained below its staging root",
      "archive-preflight",
    )
  return "/".join(parts)


def _link_target(member_name: str, link_name: str) -> str:
  candidate = link_name.replace("\\", "/")
  if candidate.startswith("/") or re.match(r"^[A-Za-z]:", candidate):
    raise ContractError(
      "archive-link-unsafe",
      {"target": "relative target inside staging root"},
      {"member": member_name, "target": link_name},
      "replace the archive link with a relative target inside the release root",
      "archive-preflight",
    )
  base = PurePosixPath(member_name).parent
  parts: list[str] = []
  for part in (base / candidate).parts:
    if part in ("", "."):
      continue
    if part == "..":
      if not parts:
        raise ContractError(
          "archive-link-unsafe",
          {"target": "relative target inside staging root"},
          {"member": member_name, "target": link_name},
          "replace the archive link with a relative target inside the release root",
          "archive-preflight",
        )
      parts.pop()
      continue
    parts.append(part)
  if not parts:
    raise ContractError(
      "archive-link-unsafe",
      {"target": "relative target inside staging root"},
      {"member": member_name, "target": link_name},
      "replace the archive link with a relative target inside the release root",
      "archive-preflight",
    )
  return "/".join(parts)


def _preflight_members(members: list[tarfile.TarInfo]) -> list[tuple[tarfile.TarInfo, str, str | None]]:
  seen: set[str] = set()
  entries: list[tuple[tarfile.TarInfo, str, str | None]] = []
  kinds: dict[str, str] = {}
  for member in members:
    name = _normalize_member_name(member.name)
    if name in seen:
      raise ContractError(
        "archive-duplicate-member",
        {"uniqueMember": name},
        {"member": name},
        "remove duplicate archive members before rerunning the bootstrap",
        "archive-preflight",
      )
    seen.add(name)
    if member.isdir():
      kind = "directory"
    elif member.isreg():
      kind = "file"
    elif member.issym() or member.islnk():
      kind = "link"
    else:
      raise ContractError(
        "archive-special-file",
        {"memberType": "regular, directory, or contained link"},
        {"member": name, "memberType": member.type.hex()},
        "remove device, FIFO, socket, or other special members from the release archive",
        "archive-preflight",
      )
    target = None
    if member.issym() or member.islnk():
      target = _link_target(name, member.linkname)
    kinds[name] = kind
    entries.append((member, name, target))

  for member, name, _target in entries:
    parts = PurePosixPath(name).parents
    for parent in parts:
      parent_name = str(parent)
      if parent_name != "." and kinds.get(parent_name) in ("file", "link"):
        raise ContractError(
          "archive-member-collision",
          {"path": "no file or link ancestor"},
          {"member": name, "ancestor": parent_name},
          "rename colliding archive members so files and directories have distinct paths",
          "archive-preflight",
        )
  for name, kind in kinds.items():
    if kind == "directory":
      continue
    if any(other != name and other.startswith(f"{name}/") for other in kinds):
      raise ContractError(
        "archive-member-collision",
        {"path": "file or link has no descendants"},
        {"member": name},
        "rename colliding archive members so files and directories have distinct paths",
        "archive-preflight",
      )
  return entries


def _ensure_lzma() -> None:
  if os.environ.get("FORGEAX_TEST_DISABLE_LZMA") == "1":
    raise ContractError(
      "lzma-missing",
      {"pythonCapability": "import lzma"},
      {"pythonCapability": "disabled for capability probe"},
      "use a Python build with lzma support; do not install or call external xz tools",
      "archive-decode",
    )
  try:
    import lzma  # noqa: F401
  except ImportError as error:
    raise ContractError(
      "lzma-missing",
      {"pythonCapability": "import lzma"},
      {"pythonCapability": "unavailable"},
      "use a Python build with lzma support; do not install or call external xz tools",
      "archive-decode",
    ) from error


def _write_member(archive: tarfile.TarFile, member: tarfile.TarInfo, destination: Path) -> None:
  if member.isdir():
    destination.mkdir(parents=True, exist_ok=True)
    return
  if member.isreg():
    source = archive.extractfile(member)
    if source is None:
      raise ContractError(
        "archive-member-read-failed",
        {"member": member.name},
        {"member": member.name},
        "restore the complete release archive and rerun the bootstrap",
        "archive-extract",
      )
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("xb") as output:
      shutil.copyfileobj(source, output)
    os.chmod(destination, member.mode & 0o777)


def _write_link(staging: Path, member: tarfile.TarInfo, destination: Path, target: str) -> None:
  destination.parent.mkdir(parents=True, exist_ok=True)
  if member.issym():
    os.symlink(member.linkname, destination)
    return
  source = staging / target
  if not source.is_file():
    raise ContractError(
      "archive-link-target-missing",
      {"target": target},
      {"member": member.name},
      "ensure hard links point to an earlier regular file in the release archive",
      "archive-extract",
    )
  os.link(source, destination)


def _stage_archive(archive_path: Path, staging_path: Path) -> None:
  _ensure_lzma()
  try:
    with tarfile.open(archive_path, mode="r:xz") as archive:
      members = archive.getmembers()
      entries = _preflight_members(members)
      staging_path.mkdir(parents=True, exist_ok=False)
      for member, name, _target in entries:
        if member.isdir() or member.isreg():
          _write_member(archive, member, staging_path / name)
      for member, name, target in entries:
        if member.issym() or member.islnk():
          assert target is not None
          _write_link(staging_path, member, staging_path / name, target)
  except ContractError:
    raise
  except (OSError, tarfile.TarError, EOFError) as error:
    raise ContractError(
      "archive-decode-failed",
      {"archive": str(archive_path), "format": "tar.xz"},
      {"archive": str(archive_path), "error": str(error)},
      "restore a complete tar.xz release archive and rerun without external xz tools",
      "archive-decode",
    ) from error


def _sha256(path: Path) -> str:
  digest = hashlib.sha256()
  try:
    with path.open("rb") as source:
      for block in iter(lambda: source.read(1024 * 1024), b""):
        digest.update(block)
  except OSError as error:
    raise ContractError(
      "archive-read-failed",
      {"path": str(path)},
      {"path": str(path), "error": str(error)},
      "restore the downloaded release archive before retrying its digest check",
      "download-verification",
    ) from error
  return f"sha256:{digest.hexdigest()}"


def _validate_release_download(args: argparse.Namespace) -> None:
  if args.release_metadata is None:
    return
  metadata = _read_json(args.release_metadata, "release-metadata")
  identity = metadata.get("releaseIdentity")
  if identity != EXPECTED_RELEASE_IDENTITY:
    raise ContractError(
      "release-identity-mismatch",
      {"releaseIdentity": EXPECTED_RELEASE_IDENTITY},
      {"releaseIdentity": identity},
      "download the fixed Emscripten 6.0.2 release and use its direct identity",
      "download-verification",
    )
  expected_digest = args.archive_sha256 or metadata.get("archiveSha256")
  if expected_digest is None and isinstance(metadata.get("bootstrapInput"), dict):
    expected_digest = metadata["bootstrapInput"].get("archiveSha256")
  if not isinstance(expected_digest, str) or not expected_digest:
    raise ContractError(
      "archive-digest-missing",
      {"archiveSha256": "sha256:<64 hex characters>"},
      {"archiveSha256": expected_digest},
      "restore the release archive digest in metadata before installing anything",
      "download-verification",
    )
  observed_digest = _sha256(args.archive)
  if observed_digest != expected_digest:
    raise ContractError(
      "archive-digest-mismatch",
      {"archiveSha256": expected_digest},
      {"archiveSha256": observed_digest},
      "redownload the fixed release archive and rerun its digest verification",
      "download-verification",
    )


def _publish_staging(
  staging_path: Path,
  cache_path: Path,
  marker_path: Path,
  fingerprint: dict[str, Any],
  toolchain_layout: dict[str, str],
) -> None:
  cache_path.parent.mkdir(parents=True, exist_ok=True)
  if cache_path.exists():
    raise ContractError(
      "cache-target-exists",
      {"cacheDir": "absent before atomic publish"},
      {"cacheDir": str(cache_path)},
      "remove the disposable cache and rerun the cold bootstrap",
      "cache-publication",
    )
  os.replace(staging_path, cache_path)
  release_marker_path = cache_path / toolchain_layout["releaseMarkerRelativePath"]
  release_marker = {
    "schemaVersion": 1,
    "releaseIdentity": fingerprint["releaseIdentity"],
    "installRoot": toolchain_layout["installRoot"],
    "toolBinRelativePath": toolchain_layout["toolBinRelativePath"],
    "binaryenRootRelativePath": toolchain_layout["binaryenRootRelativePath"],
    "emscriptenCacheRelativePath": toolchain_layout["emscriptenCacheRelativePath"],
    "compilerRelativePath": toolchain_layout["compilerRelativePath"],
  }
  release_marker_temp = release_marker_path.with_name(f".{release_marker_path.name}.{uuid.uuid4().hex}.tmp")
  complete_marker = {"schemaVersion": 1, "complete": True, "compilerFingerprint": fingerprint}
  marker_temp = marker_path.with_name(f".{marker_path.name}.{uuid.uuid4().hex}.tmp")
  try:
    release_marker_path.parent.mkdir(parents=True, exist_ok=True)
    release_marker_temp.write_text(
      json.dumps(release_marker, ensure_ascii=True, sort_keys=True) + "\n",
      encoding="utf-8",
    )
    os.replace(release_marker_temp, release_marker_path)
    marker_path.parent.mkdir(parents=True, exist_ok=True)
    marker_temp.write_text(
      json.dumps(complete_marker, ensure_ascii=True, sort_keys=True) + "\n",
      encoding="utf-8",
    )
    os.replace(marker_temp, marker_path)
  except OSError:
    release_marker_temp.unlink(missing_ok=True)
    marker_temp.unlink(missing_ok=True)
    shutil.rmtree(cache_path, ignore_errors=True)
    raise


def _write_ready_marker(path: Path, payload: dict[str, Any]) -> None:
  path.parent.mkdir(parents=True, exist_ok=True)
  temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
  try:
    temporary.write_text(json.dumps(payload, ensure_ascii=True, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)
  except OSError:
    temporary.unlink(missing_ok=True)
    raise


def _read_cache_marker(path: Path) -> dict[str, Any]:
  try:
    value = json.loads(path.read_text(encoding="utf-8"))
  except FileNotFoundError as error:
    raise ContractError(
      "partial",
      {"marker": str(path)},
      {"marker": "missing"},
      "discard the partial cache and rerun the Linux cold path",
      "cache-validation",
    ) from error
  except (OSError, json.JSONDecodeError) as error:
    raise ContractError(
      "partial",
      {"marker": "complete JSON"},
      {"marker": str(path), "error": str(error)},
      "discard the truncated cache marker and rerun the Linux cold path",
      "cache-validation",
    ) from error
  if not isinstance(value, dict) or value.get("complete") is not True:
    raise ContractError(
      "partial",
      {"complete": True},
      {"complete": value.get("complete") if isinstance(value, dict) else None},
      "discard the incomplete cache and rerun the Linux cold path",
      "cache-validation",
    )
  return value


def _validate_cache_fingerprint(marker: dict[str, Any], fingerprint: dict[str, Any]) -> None:
  observed = marker.get("compilerFingerprint")
  if not isinstance(observed, dict):
    raise ContractError(
      "fingerprint-mismatch",
      {"compilerFingerprint": fingerprint},
      {"compilerFingerprint": observed},
      "discard the cache and rerun cold to derive the five-field compiler fingerprint",
      "cache-validation",
    )
  expected_values = {field: fingerprint.get(field) for field in FINGERPRINT_FIELDS}
  observed_values = {field: observed.get(field) for field in FINGERPRINT_FIELDS}
  if expected_values != observed_values:
    raise ContractError(
      "fingerprint-mismatch",
      expected_values,
      observed_values,
      "discard the cache and rerun cold after restoring the matching runner and release inputs",
      "cache-validation",
    )


def _validate_release_marker(cache_path: Path, toolchain_layout: dict[str, str]) -> None:
  marker_path = cache_path / toolchain_layout["releaseMarkerRelativePath"]
  try:
    marker = json.loads(marker_path.read_text(encoding="utf-8"))
  except FileNotFoundError as error:
    raise ContractError(
      "release-marker-missing",
      {"releaseIdentity": EXPECTED_RELEASE_IDENTITY},
      {"path": str(marker_path)},
      "restore the complete release marker and rerun cache validation",
      "cache-validation",
    ) from error
  except (OSError, json.JSONDecodeError) as error:
    raise ContractError(
      "release-file-truncated",
      {"releaseIdentity": EXPECTED_RELEASE_IDENTITY},
      {"path": str(marker_path), "error": str(error)},
      "discard the truncated release cache and rerun the cold path",
      "cache-validation",
    ) from error
  if (
    not isinstance(marker, dict)
    or marker.get("releaseIdentity") != EXPECTED_RELEASE_IDENTITY
    or marker.get("installRoot") != toolchain_layout["installRoot"]
    or marker.get("toolBinRelativePath") != toolchain_layout["toolBinRelativePath"]
    or marker.get("binaryenRootRelativePath") != toolchain_layout["binaryenRootRelativePath"]
    or marker.get("emscriptenCacheRelativePath") != toolchain_layout["emscriptenCacheRelativePath"]
    or marker.get("compilerRelativePath") != toolchain_layout["compilerRelativePath"]
  ):
    raise ContractError(
      "release-identity-mismatch",
      {"releaseIdentity": EXPECTED_RELEASE_IDENTITY},
      {"releaseIdentity": marker.get("releaseIdentity") if isinstance(marker, dict) else None},
      "discard the cache and rebuild the fixed Emscripten release cold",
      "cache-validation",
    )


def _validate_compiler_file(cache_path: Path, toolchain_layout: dict[str, str]) -> None:
  compiler_path = cache_path / toolchain_layout["installRoot"] / toolchain_layout["compilerRelativePath"]
  try:
    if not compiler_path.is_file():
      raise FileNotFoundError(compiler_path)
    if compiler_path.stat().st_size == 0:
      raise ValueError("empty compiler file")
  except (OSError, ValueError) as error:
    raise ContractError(
      "compiler-missing" if isinstance(error, FileNotFoundError) else "compiler-file-truncated",
      {"compiler": "non-empty emcc file"},
      {"compiler": str(compiler_path), "error": str(error)},
      "discard the incomplete compiler cache and rerun the Linux cold path",
      "cache-validation",
    ) from error


def _validate_cache(
  args: argparse.Namespace,
  fingerprint: dict[str, Any],
  toolchain_layout: dict[str, str],
) -> dict[str, Any]:
  node_authority, node_status = observe_system_node(
    ROOT / ".nvmrc", enforce_version=sys.platform == "linux"
  )
  node_payload = {
    "nodeAuthority": node_authority,
    "nodeAuthorityStatus": node_status,
    "bundledNodePaths": [],
    "bundledNodeExcluded": True,
  }
  no_xz_payload = {
    "noXz": {
      "checkedCommands": ["xz", "unxz", "tar --xz"],
      "fallback": False,
      "pythonLzma": "stdlib",
    },
  }
  if os.environ.get("FORGEAX_TEST_CACHE_SERVICE_FAILURE") == "1":
    return {
      "status": "ready",
      "cacheStatus": "service-unavailable-cold",
      "compilerFingerprint": fingerprint,
      "toolchainLayout": toolchain_layout,
      "cacheKey": _cache_key(fingerprint),
      "expectedCacheKey": _cache_key(fingerprint),
      **node_payload,
      **no_xz_payload,
    }
  cache_path = args.cache_dir
  marker_path = args.complete_marker or cache_path / "complete.json"
  if not cache_path.is_dir():
    raise ContractError(
      "cache-miss",
      {"cacheDir": str(cache_path)},
      {"cacheDir": "missing"},
      "continue with the Linux cold path and save only its complete cache",
      "cache-validation",
    )
  marker = _read_cache_marker(marker_path)
  _validate_cache_fingerprint(marker, fingerprint)
  _validate_release_marker(cache_path, toolchain_layout)
  _validate_compiler_file(cache_path, toolchain_layout)
  payload = {
    "status": "ready",
    "cacheStatus": "exact-valid",
    "compilerFingerprint": fingerprint,
    "toolchainLayout": toolchain_layout,
    "cacheKey": _cache_key(fingerprint),
    "expectedCacheKey": _cache_key(fingerprint),
    **node_payload,
    **no_xz_payload,
  }
  if args.ready_marker is not None:
    _write_ready_marker(args.ready_marker, {"ready": True, "cacheStatus": "exact-valid", "cacheKey": payload["cacheKey"]})
  return payload


def _archive_bootstrap(
  args: argparse.Namespace,
  fingerprint: dict[str, Any],
  toolchain_layout: dict[str, str],
) -> dict[str, Any]:
  if args.archive is None:
    raise ContractError(
      "archive-missing",
      {"argument": "--archive"},
      {"argument": None},
      "provide the fixed Linux Emscripten 6.0.2 archive; do not use an external xz fallback",
      "archive-download",
    )
  if not args.archive.is_file():
    raise ContractError(
      "archive-missing",
      {"archive": str(args.archive)},
      {"archive": str(args.archive)},
      "download the fixed Linux Emscripten release archive before staging it",
      "archive-download",
    )
  _validate_release_download(args)
  staging_path = args.staging_dir or args.cache_dir.with_name(f".{args.cache_dir.name}.staging-{uuid.uuid4().hex}")
  staging_path = Path(staging_path)
  if staging_path.exists():
    shutil.rmtree(staging_path)
  marker_path = args.complete_marker or args.cache_dir / "complete.json"
  try:
    _stage_archive(args.archive, staging_path)
    _publish_staging(staging_path, args.cache_dir, marker_path, fingerprint, toolchain_layout)
  except ContractError:
    shutil.rmtree(staging_path, ignore_errors=True)
    raise
  except OSError as error:
    shutil.rmtree(staging_path, ignore_errors=True)
    raise ContractError(
      "cache-publication-failed",
      {"cacheDir": str(args.cache_dir)},
      {"cacheDir": str(args.cache_dir), "error": str(error)},
      "remove the disposable staging and cache directories before retrying cold",
      "cache-publication",
    ) from error
  return {
    "status": "ready",
    "cacheStatus": "cold-created",
    "compilerFingerprint": fingerprint,
    "cacheKey": _cache_key(fingerprint),
  }


def _cache_key(fingerprint: dict[str, Any]) -> str:
  values = [fingerprint.get(field, "") for field in FINGERPRINT_FIELDS]
  return "emscripten-" + "-".join(str(value).replace("/", "_") for value in values)


def _parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument("--version", default=DEFAULT_VERSION)
  parser.add_argument("--lock", type=Path)
  parser.add_argument("--resolve-identity", action="store_true")
  parser.add_argument("--validate-node-json", type=Path)
  parser.add_argument("--archive", type=Path)
  parser.add_argument("--release-metadata", type=Path)
  parser.add_argument("--archive-sha256")
  parser.add_argument("--cache-dir", type=Path, default=Path("emsdk-cache"))
  parser.add_argument("--staging-dir", type=Path)
  parser.add_argument("--complete-marker", type=Path)
  parser.add_argument("--validate-cache", action="store_true")
  parser.add_argument("--ready-marker", type=Path)
  parser.add_argument("--evidence-output", type=Path)
  parser.add_argument("--github-env", type=Path)
  parser.add_argument("--github-path", type=Path)
  return parser.parse_args()


def _resolve_identity(args: argparse.Namespace) -> dict[str, Any]:
  if args.lock is None:
    raise ContractError(
      "missing-lock",
      {"argument": "--lock"},
      {"argument": None},
      "pass scripts/ci/emscripten-no-xz.lock.json to the identity resolver",
      "release-identity",
    )
  lock = _read_json(args.lock, "release-identity")
  fingerprint = resolve_release_identity(args.version, lock)
  toolchain_layout = _validate_toolchain_layout(lock)
  node_authority, node_status = observe_system_node(ROOT / ".nvmrc", enforce_version=sys.platform == "linux")
  return {
    "status": "ready",
    "compilerFingerprint": fingerprint,
    "toolchainLayout": toolchain_layout,
    "nodeAuthority": node_authority,
    "nodeAuthorityStatus": node_status,
    "bundledNodePaths": [],
    "bundledNodeExcluded": True,
  }


def _bootstrap(args: argparse.Namespace) -> dict[str, Any]:
  if args.lock is None:
    raise ContractError(
      "missing-lock",
      {"argument": "--lock"},
      {"argument": None},
      "pass the repository Emscripten identity lock to the Linux bootstrap",
      "release-identity",
    )
  lock = _read_json(args.lock, "release-identity")
  fingerprint = resolve_release_identity(args.version, lock)
  toolchain_layout = _validate_toolchain_layout(lock)
  if args.validate_cache:
    return _validate_cache(args, fingerprint, toolchain_layout)
  if args.cache_dir.is_dir():
    try:
      return _validate_cache(args, fingerprint, toolchain_layout)
    except ContractError:
      shutil.rmtree(args.cache_dir, ignore_errors=True)
  payload = _archive_bootstrap(args, fingerprint, toolchain_layout)
  payload["toolchainLayout"] = toolchain_layout
  node_authority, node_status = observe_system_node(ROOT / ".nvmrc", enforce_version=sys.platform == "linux")
  payload.update({
    "nodeAuthority": node_authority,
    "nodeAuthorityStatus": node_status,
    "bundledNodePaths": [],
    "bundledNodeExcluded": True,
    "noXz": {
      "checkedCommands": ["xz", "unxz", "tar --xz"],
      "fallback": False,
      "pythonLzma": "stdlib",
    },
  })
  return payload


def _write_evidence(path: Path | None, payload: dict[str, Any]) -> None:
  if path is None:
    return
  path.parent.mkdir(parents=True, exist_ok=True)
  temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
  temporary.write_text(json.dumps(payload, ensure_ascii=True, indent=2, sort_keys=True) + "\n", encoding="utf-8")
  os.replace(temporary, path)


def _write_activation(
  args: argparse.Namespace,
  payload: dict[str, Any],
  toolchain_layout: dict[str, str],
) -> None:
  if args.github_env is None and args.github_path is None:
    return
  cache_dir = args.cache_dir.resolve()
  emscripten_root = cache_dir / toolchain_layout["installRoot"]
  emsdk_root = emscripten_root.parent
  llvm_root = cache_dir / toolchain_layout["toolBinRelativePath"]
  binaryen_root = cache_dir / toolchain_layout["binaryenRootRelativePath"]
  emscripten_cache = cache_dir / toolchain_layout["emscriptenCacheRelativePath"]
  node_path = payload["nodeAuthority"]["emsdkNode"]
  config_path = cache_dir / "forgeax-emscripten-config.py"
  config_path.write_text(
    "".join([
      f"LLVM_ROOT = {json.dumps(str(llvm_root))}\n",
      f"BINARYEN_ROOT = {json.dumps(str(binaryen_root))}\n",
      f"NODE_JS = {json.dumps(node_path)}\n",
      f"CACHE = {json.dumps(str(emscripten_cache))}\n",
    ]),
    encoding="utf-8",
  )
  if args.github_env is not None:
    args.github_env.parent.mkdir(parents=True, exist_ok=True)
    with args.github_env.open("a", encoding="utf-8") as github_env:
      for name, value in [
        ("EMSDK", emsdk_root),
        ("EMSCRIPTEN", emscripten_root),
        ("EMSCRIPTEN_ROOT", emscripten_root),
        ("EMSDK_NODE", node_path),
        ("EM_CONFIG", config_path),
        ("EM_CACHE", emscripten_cache),
        ("EM_LLVM_ROOT", llvm_root),
        ("EM_BINARYEN_ROOT", binaryen_root),
      ]:
        github_env.write(f"{name}={value}\n")
  if args.github_path is not None:
    args.github_path.parent.mkdir(parents=True, exist_ok=True)
    with args.github_path.open("a", encoding="utf-8") as github_path:
      github_path.write(f"{emscripten_root}\n{llvm_root}\n")


def main() -> int:
  args = _parse_args()
  try:
    if args.resolve_identity:
      payload = _resolve_identity(args)
    elif args.validate_node_json is not None:
      payload = {"status": "ready", "nodeAuthority": validate_node_authority(_read_json(args.validate_node_json, "node-authority"))}
    else:
      payload = _bootstrap(args)
      lock = _read_json(args.lock, "release-identity")
      _write_activation(args, payload, _validate_toolchain_layout(lock))
    _write_evidence(args.evidence_output, payload)
  except ContractError as error:
    payload = error.payload()
    try:
      _write_evidence(args.evidence_output, payload)
    except OSError:
      pass
    print(json.dumps(payload, ensure_ascii=True, separators=(",", ":")))
    return 1
  except (OSError, ValueError, RuntimeError) as error:
    payload = {
      "status": "rejected",
      "stage": "bootstrap",
      "reason": "bootstrap-failed",
      "expected": {"operation": "safe Linux Emscripten bootstrap"},
      "observed": {"error": str(error)},
      "hint": "inspect the structured stage failure and rerun cold after fixing its input",
    }
    print(json.dumps(payload, ensure_ascii=True, separators=(",", ":")))
    return 1
  print(json.dumps(payload, ensure_ascii=True, separators=(",", ":")))
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
