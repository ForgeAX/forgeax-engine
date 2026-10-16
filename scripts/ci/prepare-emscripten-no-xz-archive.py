#!/usr/bin/env python3
"""Download and verify the locked Linux Emscripten release archive."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import uuid
from pathlib import Path
from urllib.request import urlopen


EXPECTED_RELEASE_HASH = "004876f1984e18a9eb0736c5ca417ac86d386fb8"
EXPECTED_RELEASE_IDENTITY = f"releases-{EXPECTED_RELEASE_HASH}-64bit"
EXPECTED_VERSION = "6.0.2"
EXPECTED_URL = (
  "https://storage.googleapis.com/webassembly/emscripten-releases-builds/"
  f"linux/{EXPECTED_RELEASE_HASH}/wasm-binaries.tar.xz"
)


class ContractError(Exception):
  def __init__(self, reason: str, expected: object, observed: object, hint: str) -> None:
    super().__init__(reason)
    self.reason = reason
    self.expected = expected
    self.observed = observed
    self.hint = hint

  def payload(self) -> dict[str, object]:
    return {
      "status": "rejected",
      "stage": "archive-preparation",
      "reason": self.reason,
      "expected": self.expected,
      "observed": self.observed,
      "hint": self.hint,
    }


def read_lock(path: Path) -> dict[str, object]:
  try:
    value = json.loads(path.read_text(encoding="utf-8"))
  except (OSError, json.JSONDecodeError) as error:
    raise ContractError(
      "lock-read-failed",
      {"path": str(path), "type": "JSON object"},
      {"path": str(path), "error": str(error)},
      "restore the repository Emscripten lock before preparing the archive",
    ) from error
  if not isinstance(value, dict):
    raise ContractError(
      "lock-shape-invalid",
      {"type": "object"},
      {"type": type(value).__name__},
      "provide a JSON object containing the pinned release fields",
    )
  return value


def required_string(lock: dict[str, object], field: str) -> str:
  value = lock.get(field)
  if not isinstance(value, str) or not value.strip():
    raise ContractError(
      "missing-lock-field",
      {"field": field},
      {"field": field, "value": value},
      "restore the required lowerCamelCase field in the repository lock",
    )
  return value.strip()


def validate_lock(lock: dict[str, object]) -> tuple[str, str, int]:
  version = required_string(lock, "emscriptenVersion")
  release_hash = required_string(lock, "releaseHash")
  release_identity = required_string(lock, "releaseIdentity")
  if version != EXPECTED_VERSION or release_hash != EXPECTED_RELEASE_HASH:
    raise ContractError(
      "release-identity-mismatch",
      {"emscriptenVersion": EXPECTED_VERSION, "releaseHash": EXPECTED_RELEASE_HASH},
      {"emscriptenVersion": version, "releaseHash": release_hash},
      "use the pinned Linux Emscripten 6.0.2 release",
    )
  if release_identity != EXPECTED_RELEASE_IDENTITY:
    raise ContractError(
      "release-identity-mismatch",
      {"releaseIdentity": EXPECTED_RELEASE_IDENTITY},
      {"releaseIdentity": release_identity},
      "use the direct releases-<hash>-64bit tool identity",
    )
  runner_os = required_string(lock, "runnerOs")
  runner_arch = required_string(lock, "runnerArch")
  if runner_os != "Linux" or runner_arch != "x86_64":
    raise ContractError(
      "runner-identity-mismatch",
      {"runnerOs": "Linux", "runnerArch": "x86_64"},
      {"runnerOs": runner_os, "runnerArch": runner_arch},
      "run archive preparation only in the Linux x86_64 workflow branch",
    )
  archive_url = required_string(lock, "archiveUrl")
  if archive_url != EXPECTED_URL:
    raise ContractError(
      "archive-url-mismatch",
      {"archiveUrl": EXPECTED_URL},
      {"archiveUrl": archive_url},
      "use the archive URL derived from the pinned release hash",
    )
  archive_sha256 = required_string(lock, "archiveSha256")
  if not re.fullmatch(r"sha256:[0-9a-f]{64}", archive_sha256):
    raise ContractError(
      "archive-digest-invalid",
      {"archiveSha256": "sha256:<64 lowercase hex characters>"},
      {"archiveSha256": archive_sha256},
      "use the verified SHA-256 for the locked release archive",
    )
  content_length = lock.get("archiveContentLength")
  if not isinstance(content_length, int) or isinstance(content_length, bool) or content_length <= 0:
    raise ContractError(
      "archive-length-invalid",
      {"archiveContentLength": "positive integer"},
      {"archiveContentLength": content_length},
      "use the verified content length for the locked release archive",
    )
  return archive_url, archive_sha256, content_length


def verify_archive(path: Path, expected_digest: str, expected_length: int) -> dict[str, object]:
  digest = hashlib.sha256()
  observed_length = 0
  try:
    with path.open("rb") as source:
      for block in iter(lambda: source.read(1024 * 1024), b""):
        digest.update(block)
        observed_length += len(block)
  except OSError as error:
    raise ContractError(
      "archive-read-failed",
      {"archive": str(path)},
      {"archive": str(path), "error": str(error)},
      "restore the release archive before retrying verification",
    ) from error
  observed_digest = f"sha256:{digest.hexdigest()}"
  if observed_digest != expected_digest:
    raise ContractError(
      "archive-digest-mismatch",
      {"archiveSha256": expected_digest},
      {"archiveSha256": observed_digest},
      "redownload the locked release archive and retry",
    )
  if observed_length != expected_length:
    raise ContractError(
      "archive-length-mismatch",
      {"archiveContentLength": expected_length},
      {"archiveContentLength": observed_length},
      "redownload the complete locked release archive and retry",
    )
  return {"sha256": observed_digest, "contentLength": observed_length}


def download_archive(url: str, path: Path, expected_digest: str, expected_length: int) -> dict[str, object]:
  path.parent.mkdir(parents=True, exist_ok=True)
  temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
  try:
    with urlopen(url, timeout=120) as source:
      header = source.headers.get("Content-Length")
      if header is None or int(header) != expected_length:
        raise ContractError(
          "archive-length-mismatch",
          {"archiveContentLength": expected_length},
          {"contentLengthHeader": header},
          "refuse an archive response whose locked content length is not proven",
        )
      with temporary.open("wb") as target:
        while True:
          block = source.read(1024 * 1024)
          if not block:
            break
          target.write(block)
  except ContractError:
    temporary.unlink(missing_ok=True)
    raise
  except (OSError, ValueError) as error:
    temporary.unlink(missing_ok=True)
    raise ContractError(
      "archive-download-failed",
      {"archiveUrl": url},
      {"archiveUrl": url, "error": str(error)},
      "retry the locked archive download without adding an external xz dependency",
    ) from error
  try:
    result = verify_archive(temporary, expected_digest, expected_length)
    temporary.replace(path)
    return result
  except ContractError:
    temporary.unlink(missing_ok=True)
    raise


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument("--lock", type=Path, required=True)
  parser.add_argument("--archive", type=Path, required=True)
  parser.add_argument("--github-env", type=Path)
  parser.add_argument("--validate-only", action="store_true")
  parser.add_argument("--verify-only", action="store_true")
  return parser.parse_args()


def main() -> int:
  args = parse_args()
  try:
    lock = read_lock(args.lock)
    url, digest, content_length = validate_lock(lock)
    if args.validate_only:
      payload = {"status": "ready", "archiveUrl": url, "archiveSha256": digest, "archiveContentLength": content_length}
    elif args.verify_only:
      payload = {"status": "ready", "archive": str(args.archive), **verify_archive(args.archive, digest, content_length)}
    else:
      payload = {"status": "ready", "archive": str(args.archive), "archiveUrl": url, **download_archive(url, args.archive, digest, content_length)}
    if args.github_env is not None:
      args.github_env.parent.mkdir(parents=True, exist_ok=True)
      with args.github_env.open("a", encoding="utf-8") as environment:
        environment.write(f"EMSCRIPTEN_NO_XZ_ARCHIVE_SHA256={digest}\n")
    print(json.dumps(payload, ensure_ascii=True, separators=(",", ":")))
    return 0
  except ContractError as error:
    print(json.dumps(error.payload(), ensure_ascii=True, separators=(",", ":")))
    return 1
  except (OSError, ValueError) as error:
    payload = {
      "status": "rejected",
      "stage": "archive-preparation",
      "reason": "archive-preparation-failed",
      "expected": {"operation": "locked Linux Emscripten archive preparation"},
      "observed": {"error": str(error)},
      "hint": "inspect the structured archive preparation failure and retry",
    }
    print(json.dumps(payload, ensure_ascii=True, separators=(",", ":")))
    return 1


if __name__ == "__main__":
  raise SystemExit(main())
