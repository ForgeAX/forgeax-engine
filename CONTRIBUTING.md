# Contributing to forgeax-engine

Thanks for your interest! This monorepo runs **two package managers in parallel**: every PR must be green under both `pnpm` and `bun`. This document spells out the local SOPs that keep the dual pipeline healthy.

## Prerequisites

- **Node.js ≥ 22.13.0** (active LTS; `.nvmrc` pins the exact patch — currently `22.22.3`)
- **pnpm** — `package.json#packageManager` pins the Corepack-managed version (currently `12.10.1`)
- **Bun ≥ 1.2.0** (`.bun-version` is checked into the repo)

If you use `corepack enable`, pnpm comes bundled with the right version automatically.

## Basic initialization and optional GPU tests

For a contributor checkout, `bun fx setup` initializes pinned submodules,
installs dependencies and builds. Public SDK source skips private submodules and
uses `build:engine`. Neither path builds native Dawn. Basic feedback is:

```bash
pnpm build:engine
pnpm test               # Default tests include DevKit browser journeys; no Dawn carrier
```

Dawn tests are an explicit local opt-in. Their CMake, Go, Python and platform C++
toolchain requirements apply only when rebuilding that GPU carrier:

```bash
pnpm --filter @forgeax/engine-dawn-node build:native
pnpm test:dawn
```

See [the carrier contract](packages/dawn-node/README.md) for platform prerequisites.
`pnpm test:browser` separately selects browser GPU tests; `pnpm test:all` selects
the complete acceptance surface. Maintainer/CI rendering gates keep their full
roster and thresholds; they do not make native Dawn a basic onboarding requirement.
Hardware Ray Query uses the independent
[native wgpu backend](packages/rhi-wgpu-native/README.md#node-binding-napi-rs),
with Rust/Cargo and MSVC C++ Build Tools (including C++ ATL) plus Windows SDK for Windows source
builds. Dawn is not a dependency of that backend.

## Performance investigations

Use the [performance skill](skills/forgeax-engine-performance/SKILL.md) to select
evidence and the [contribution route](skills/forgeax-engine-performance/references/contributing.md)
to retain reusable methods. Keep dated measurements in a scoped case and verify
the complete affected owner before claiming savings from fewer allocations.

## Linux Emscripten 6.0.2 without external xz

This is a Linux-only CI path for Emscripten `6.0.2`. It uses the Python standard
library `lzma` reader and a controlled lane `PATH` that preserves the required
Node, pnpm, Python, and Git launchers while hiding `xz`, `unxz`, `xz-utils`,
`xzcat`, `xzdec`, and `pixz`. It never installs or falls back to an external xz
tool. macOS and Windows keep the upstream `emscripten-core/setup-emsdk@v16`
path and their existing step order.

The single provisioning entry point is
[`scripts/ci/setup-emscripten-no-xz.py`](scripts/ci/setup-emscripten-no-xz.py).
Its cache is an acceleration layer, not a correctness input. A ready cache must
match these five fingerprint fields:

| Field | Meaning |
|:--|:--|
| `emscriptenVersion` | The locked Emscripten version: `6.0.2`. |
| `releaseIdentity` | The direct Linux x86_64 release tool identity. |
| `runnerOs` | The observed runner OS: `Linux`. |
| `runnerArch` | The observed runner architecture: `x86_64`. |
| `bootstrapInputDigest` | The normalized digest of the lock, helper, and `.nvmrc` inputs. |

The workflow prepares the `.nvmrc` Node first. The helper records the expected
version, actual version, normalized executable path, `EMSDK_NODE`, executable
SHA-256, and bundled-Node exclusions. This keeps the system Node as the only
Node authority.

For a Linux cold bootstrap, prepare the archive from the repository lock before
calling the bootstrap helper. The preparation script validates the lock-derived
URL, SHA-256, and content length with Python's standard library. The bootstrap
helper then receives the archive, release metadata, and lock-derived digest:

### Short verification path

Run these checks from the repository root:

```bash
node --test scripts/ci/__tests__/setup-emscripten-no-xz.test.mjs scripts/ci/__tests__/emscripten-no-xz-evidence.test.mjs
pnpm run lint
pnpm test:layout
pnpm ci:paths-check
pnpm ci:channel-align
python3 -m py_compile scripts/ci/setup-emscripten-no-xz.py scripts/ci/prepare-emscripten-no-xz-archive.py
actionlint -shellcheck='' .github/workflows/ci.yml .github/workflows/nightly.yml .github/workflows/emscripten-no-xz-evidence.yml
python3 scripts/forgeax/check_english_only.py --code scripts/ci/setup-emscripten-no-xz.py scripts/ci/prepare-emscripten-no-xz-archive.py scripts/ci/evidence/emscripten-no-xz.mjs scripts/ci/__tests__/setup-emscripten-no-xz.test.mjs scripts/ci/__tests__/emscripten-no-xz-evidence.test.mjs
python3 scripts/forgeax/check_english_only.py CONTRIBUTING.md
git diff --check
```

The direct cold bootstrap command used by Linux jobs is:

```bash
archive_dir="${RUNNER_TEMP:-/tmp}/emscripten-no-xz"
archive="$archive_dir/wasm-binaries.tar.xz"
mkdir -p "$archive_dir"
python3 scripts/ci/prepare-emscripten-no-xz-archive.py \
  --lock scripts/ci/emscripten-no-xz.lock.json \
  --archive "$archive"
python3 scripts/ci/setup-emscripten-no-xz.py \
  --version 6.0.2 \
  --lock scripts/ci/emscripten-no-xz.lock.json \
  --archive "$archive" \
  --release-metadata scripts/ci/emscripten-no-xz.lock.json \
  --archive-sha256 "$(python3 -c 'import json; print(json.load(open("scripts/ci/emscripten-no-xz.lock.json"))["archiveSha256"])')" \
  --cache-dir emsdk-cache \
  --evidence-output artifacts/emscripten-bootstrap.json
```

After an exact cache restore, the warm path does not download the archive. It
must validate the cache fingerprint explicitly:

```bash
python3 scripts/ci/setup-emscripten-no-xz.py --version 6.0.2 --lock scripts/ci/emscripten-no-xz.lock.json --validate-cache --cache-dir emsdk-cache
```

Warm exact-cache validation is not cold archive proof; a cache miss must return
to the preparation command above.

This command requires a real Linux x86_64 runner. A Darwin arm64 checkout can
run the static, schema, helper, layout, lint, path, channel, and English-only
checks, but it cannot prove Linux cold/warm compilation or macOS/Windows
nightly acceptance. Those results must remain `unproven` until the matching
runner executes them.

### Cold and warm evidence

The independent workflow is
[`emscripten-no-xz-evidence.yml`](.github/workflows/emscripten-no-xz-evidence.yml).
It clears Emscripten cache state, consumer outputs, consumer caches, and release
hydration sources before each consumer lane. The existing `fbx` and `codec`
build entry points then invoke `emcc`; no consumer flags, public APIs, or
generated `pkg/` files are changed or committed.

| Lane | Required result | Evidence artifact |
|:--|:--|:--|
| Cold | `status=ready`, `mode=cold`, `cache.status=cold-created` | `artifacts/emscripten/cold/evidence.json` |
| Warm | `status=ready`, `mode=warm`, `cache.status=exact-valid`, `comparison.equivalent=true` | `artifacts/emscripten/warm/evidence.json` |

Each envelope records the source SHA, runner identity, controlled xz facts,
cache fingerprint, Node identity, compiler identity, both consumer invocations,
the complete six-file output set, per-file SHA-256 values, and consumer gate
results. The schema is
[`scripts/ci/evidence/emscripten-no-xz.schema.json`](scripts/ci/evidence/emscripten-no-xz.schema.json).

The known Linux evidence is workflow run `31685331312`, with cold job run
`94399940428` and warm job run `94402063505`. The Darwin host has no real
macOS or Windows nightly run IDs; their platform acceptance is intentionally
not claimed by local checks.

<details>
<summary>Troubleshooting by stage</summary>

| Stage | Symptom | Recovery |
|:--|:--|:--|
| `node-authority` | Version, path, or `EMSDK_NODE` mismatch | Re-run the workflow Node setup from `.nvmrc`; do not select an emsdk-bundled Node. |
| `archive` | Python `lzma` is unavailable or archive validation fails | Use a Python build with stdlib `lzma`; fix the pinned archive or unsafe member. Do not install xz as a fallback. |
| `cache` | `partial`, `invalid`, `mismatch`, or `unavailable` status | Delete the disposable cache and rerun the cold lane. A cache miss must not change the result. |
| `compiler` | `emcc` is missing or fingerprint fields differ | Discard the cache, verify the locked release identity and runner architecture, then rerun cold. |
| `consumer` | `fbx` or `codec` invocation/gate fails | Keep consumer outputs and hydration sources cleared, inspect the stage diagnostic, and rerun only the failed consumer after fixing its prerequisite. |
| `comparison` | Warm output set or SHA-256 values differ | Confirm the same source SHA, exact cache key, Node executable SHA, and six fresh output files before rerunning warm. |
| `platform` | A local Darwin check is being treated as Linux or nightly proof | Stop and label the remote result `unproven`; use the matching Linux, macOS, or Windows runner. |

</details>

## Rust toolchain (optional Rust source rebuilds)

`@forgeax/engine-wgpu-wasm` is the merged wasm-bindgen crate for `wgpu 29` (RHI raw bindings) and `naga 29` (three-phase shader pipeline), produced by `feat-20260511-naga-rhi-wgpu-merge`. It replaced the two earlier crates (`naga-wasm-shim` + `rhi-wgpu/crate`), which are archived. Two TS-only thin shells consume its raw bindings: `@forgeax/engine-rhi-wgpu` (RHI) and `@forgeax/engine-naga` (shader tooling) — neither contains Rust anymore. The independent native Ray Query owner is [`packages/rhi-wgpu-native`](packages/rhi-wgpu-native/README.md); its Rust build is opt-in.

**Rust is required when rebuilding a Rust source producer or the optional native backend.** Most contributors consume prepared WASM: the prebuilt `pkg/` bundle (`*.wasm` + `*.d.ts` + `*.js` glue) is **not** committed to git (ufbx-style release, mirroring `packages/fbx/`), and the package's `postinstall` hydrates it automatically by downloading the content-keyed bundle from the `wasm-artifacts` GitHub Release (`packages/wgpu-wasm/scripts/ensure-wasm.mjs` → `fetch-wasm`, shared with `packages/fbx` + `packages/codec` via `scripts/lib/ensure-wasm-lib.mjs`). The fetch is non-fatal: offline or unauthenticated, `install` still succeeds and you build `pkg/` locally when you next need it.

### One-time install

```bash
rustup install 1.93                         # Rust >= 1.93 (wgpu 29 MSRV)
rustup target add wasm32-unknown-unknown    # required for wasm-pack build --target web
cargo install wasm-pack                     # wasm-pack 0.14+
```

`packages/wgpu-wasm/rust-toolchain.toml` already pins `channel = "1.93"` + `targets = ["wasm32-unknown-unknown"]`, so once `rustup` is installed it auto-fetches the right toolchain on the first `cargo` invocation inside the crate.

### Rebuild after Rust changes

```bash
bash packages/wgpu-wasm/build.sh            # -> wasm-pack build --target web --out-dir pkg
# or equivalently via the pnpm workspace script:
pnpm -F @forgeax/engine-wgpu-wasm build     # tsc -b + tsup (rebuilds the JS shim around prebuilt pkg/)
```

`build.sh` asserts `rustc >= 1.93` explicitly with a structured error message (charter proposition 4 explicit failure) so a missing toolchain pin surfaces at the `.sh` entry rather than as an opaque `cargo` error. Commit **only** `packages/wgpu-wasm/src/...` (+ `Cargo.toml` / `Cargo.lock` if changed) — `pkg/` is gitignored and never committed. On the next main push, the `publish-wgpu-wasm-release` CI job rebuilds `pkg/` and publishes the content-keyed bundle so non-Rust contributors' `fetch-wasm` picks it up. The content key (`scripts/content-key.mjs`) hashes `src/**/*.rs` + `Cargo.{toml,lock}` + `rust-toolchain.toml` + `build.sh`, so any source change yields a fresh bundle name and stale `pkg/` can no longer be served.

> [!NOTE]
> wasm-pack's bundled binaryen is too old to parse wgpu 29's multi-table WASM, so `Cargo.toml` sets `wasm-opt = false`. CI installs a system `binaryen` (>= 116) and `build.sh` runs an extra `wasm-opt -Oz` pass when one is on `PATH`; local builds without binaryen skip that pass silently (dev-only size penalty).

### When the toolchain is unavailable

- CI builds the wasm crate from scratch via `dtolnay/rust-toolchain@stable` + `taiki-e/install-action` (`wasm-pack@0.14.0`) in `.github/workflows/ci.yml`, so a fork PR without Rust locally still verifies cleanly.
- Locally, if you need to run `pnpm test` on a machine without Rust, `pnpm install` does **not** invoke `cargo` / `wasm-pack` — its `postinstall` fetches the prebuilt `pkg/` bundle from the `wasm-artifacts` release instead. The `@forgeax/engine-rhi-wgpu` and `@forgeax/engine-naga` shells then resolve the hydrated `wgpu_wasm_bg.wasm` directly. If the fetch could not run (offline / private repo without `GITHUB_TOKEN` / bundle not yet published), run `pnpm -F @forgeax/engine-wgpu-wasm fetch-wasm` once connectivity returns, or `build:wasm` if you have the Rust toolchain.

`packages/wgpu-wasm/Cargo.lock` is committed (applications-tier crate convention) and is **not** part of the dual-lockfile sync — `pnpm-lock.yaml` and `bun.lock` describe the npm side; `Cargo.lock` is owned by `cargo` alone. The pre-commit `check-staged-lockfiles.mjs` guard does not touch it. See `packages/rhi-wgpu/README.md` and AGENTS.md §Packages for the dual-impl / auto-select-facade rationale.

## FBX SDK 2020.3.7 toolchain (only when modifying `packages/fbx/`)

`@forgeax/engine-fbx` is a native Node.js addon (via `node-addon-api`) that wraps the Autodesk FBX SDK to import `.fbx` assets at build time. **You only need the FBX SDK if you are editing `packages/fbx/src/native/binding.cc` or `packages/fbx/binding.gyp`.** Most contributors never need the SDK because `.fbx` import runs at asset cook time (CI/dev sidecar generation), not at runtime.

### Get the SDK

Download FBX SDK 2020.3.7 from the [Autodesk APS FBX SDK portal](https://aps.autodesk.com/developer/overview/fbx-sdk). The macOS build uses the clang variant: `fbx202037_fbxsdk_clang_mac.pkg.tgz`.

### One-time install (macOS)

```bash
curl -L -o /tmp/fbxsdk.tgz "https://damassets.autodesk.net/content/dam/autodesk/www/files/fbx202037_fbxsdk_clang_mac.pkg.tgz"
mkdir -p /tmp/fbxsdk && tar -xzf /tmp/fbxsdk.tgz -C /tmp/fbxsdk
pkgutil --expand /tmp/fbxsdk/fbx202037_fbxsdk_clang_macos.pkg /tmp/fbxsdk/expanded
mkdir -p $HOME/.local/fbxsdk && cd $HOME/.local/fbxsdk
cat /tmp/fbxsdk/expanded/Root.pkg/Payload | gunzip -dc | cpio -i
```

### Symlink workaround (macOS arm64)

The SDK installs under `Applications/Autodesk/FBX SDK/2020.3.7/` (paths with spaces). `node-gyp` and `make` can choke on space-in-path. Create a symlink to avoid this:

```bash
ln -s "$HOME/.local/fbxsdk/Applications/Autodesk/FBX SDK/2020.3.7" "$HOME/.local/fbxsdk/current"
```

### Required header patch

FBX SDK 2020.3.7 ships a typo in `fbxredblacktree.h` that breaks clang compilation:

```bash
sed -i.bak 's/mLefttChild/mLeftChild/g' "$HOME/.local/fbxsdk/current/include/fbxsdk/core/base/fbxredblacktree.h"
```

### Set environment and build

```bash
export FBX_SDK_ROOT="$HOME/.local/fbxsdk/current"
pnpm rebuild @forgeax/engine-fbx
```

The postinstall script of `@forgeax/engine-fbx` auto-detects `FBX_SDK_ROOT`. When it is unset or points to a missing directory, `pnpm install` prints a warning and exits 0 (graceful degrade) — the workspace installs cleanly without the SDK.

### CI

An opt-in `smoke-fbx-macos-arm64` job in `.github/workflows/ci.yml` runs on `macos-latest` when a PR has the `fbx` label. The job installs FBX SDK via cache then runs `hello-fbx-cube` and `hello-fbx-skin` dawn smokes. It is `continue-on-error: true` — failure does not block PR merge.

### When the toolchain is unavailable

- CI runs the FBX smoke job only when the `fbx` label is present on the PR; all other jobs run without the SDK.
- Locally, `pnpm install` exits 0 even without the SDK — `@forgeax/engine-fbx` gracefully degrades and all non-FBX workspaces are unaffected.

## Local development workflow

```bash
# fresh clone setup
pnpm install           # generates / updates pnpm-lock.yaml
pnpm exec simple-git-hooks   # registers the pre-commit hook (idempotent)

# day-to-day
pnpm test               # CPU unit tests (no Dawn/browser)
pnpm test:watch         # vitest in watch mode (TTY)
pnpm typecheck          # tsc -b across composite project graph (also (re)emits .d.ts SSOT)
pnpm lint               # biome ci .
pnpm format             # biome check --write . (local fixup; CI never writes)
pnpm build              # pnpm -r build (.mjs via tsup) + tsc -b (.d.ts) — chained

# Hello Triangle demo
pnpm dev                # vite dev server at localhost:5173
```

When you switch branches or merge, run `pnpm run sync` to keep `pnpm-lock.yaml` and `bun.lock` in lockstep. The pre-commit hook will reject commits that stage only one of them.

## Dual-lockfile sync SOP

If you encounter a merge conflict in **either** `pnpm-lock.yaml` **or** `bun.lock`:

```bash
# 1. accept whichever lockfile is upstream's, then re-derive both:
git checkout --theirs pnpm-lock.yaml bun.lock

# 2. let the workspace resolver write fresh lockfiles atop:
pnpm run sync           # = pnpm install && bun install (non-frozen)

# 3. stage BOTH lockfiles together (pre-commit guards this invariant):
git add pnpm-lock.yaml bun.lock
git commit -m "chore: sync lockfiles"
```

`.gitattributes` already marks both lockfiles as `merge=ours linguist-generated=true`, which (a) makes git auto-pick "ours" during merge so you don't have to hand-edit, (b) collapses lockfile diffs in GitHub PR view.

## ⚠ Use `bun run test` — never `bun test`

> [!CAUTION]
> **Always invoke the test script through `bun run test`**, which delegates to `vitest run` via `package.json#scripts.test`. Bun's built-in `bun test` is a Jest-subset runner: it does **not** read `vitest.config.ts`, does **not** recognize `vi.mock` / `vi.fn` / `expectTypeOf`, and silently ignores type-test files (`*.test-d.ts`).
>
> If you run `bun test`, you'll see a green output that has not actually exercised the forgeax-engine test suite. CI's `bun` job specifically calls `bun run test`, never `bun test`, for this reason.

The same warning lives in [README.md](./README.md). If you ever wonder "why are CI and my local results different?" — check whether you typed `bun run test` or `bun test`.

## Commit conventions

Each task in our planning system maps to one commit; commit messages take the form:

```
<type>(<scope>): <title> [<taskId>]
```

## Pull requests

- The CI workflow runs **two independent jobs** (`pnpm` and `bun`) plus a `report` job that posts a sticky comment on the PR with bundle size and fps medians (both **non-blocking**).
- Both `pnpm` and `bun` jobs must pass; the `report` job runs `if: always()` and surfaces metrics regardless.
- Your branch must be rebased on `main` before merge (squash or merge commit, decided per PR).

## Architecture invariants

- The monorepo is a layered graph of focused `@forgeax/engine-*` owner packages (`packages/<pkg>/` ↔ `@forgeax/engine-<pkg>`). The generated `@forgeax/engine-runtime` package is the public install and CLI umbrella; its `@forgeax/engine-runtime/<pkg>` subpaths forward to those owners rather than replacing their boundaries. Each `packages/<pkg>/README.md` is the SSOT for that package's API, error codes, and capability gates — see AGENTS.md §Packages. Cross-level imports that violate the dependency direction break the build.
- `tsup` emits `.mjs` only (`format: ['esm']`); declarations come from `tsc -b` composite mode (`dts: false` in tsup, `emitDeclarationOnly: true` in tsconfig). `pnpm -r build` alone leaves `.d.ts` stale — run `pnpm build` (chains `tsc -b`).
- All runtime diagnostics use `console.warn` / `console.error` (Biome's `noConsole` rule allows only these levels in source).
- Source and entry docs are **English-only** (ASCII + math/Greek), enforced by `scripts/forgeax/check_english_only.py`.

