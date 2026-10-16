# Storage maintenance

Demo build size is controlled by the authored Pack roots in each `vite.config.ts`.
Use an explicit `.meta.json` source when a demo needs one imported asset; keep its
referenced sources and the demo's own Pack root. A directory root publishes every
source beneath it, even when the demo never loads most of that catalogue.

| Data | Existing owner / reclamation rule |
|---|---|
| Demo `dist/` | Rebuild with `pnpm build:app <app-path>`. CI's `--retain-artifact-only` mode retains the roster's required closure; a distributable build still needs its full authored closure. |
| Worktrees | Use `bun fx worktree` for shallow/reference asset initialization. Both bootstrap and ordinary `pnpm install` mount the primary Harness. Remove only clean, idle, merged worktrees through their actual Git owner. |
| Harness evidence | Preserve paths, readable bytes and receipts. Hydrate LFS only for required paths; do not fetch all captures by default. |
| DDC / build caches | Disposable producer outputs; remove only exact idle targets and rebuild from source. |
| Git objects | Preserve all published and unpublished refs. Inspect `git count-objects -vH`; an abandoned `tmp_pack_*` is distinct from a live object pack. |

Both repository and CI shared-input producers retain only `shaders/manifest.json`.
It contains every source, variant and binding used by their consumers. The
compiler's standalone WGSL/GLSL/bindings sidecars stay outside this shared
publication; direct Vite builds can still emit their own diagnostic files.

Harness mounting has one owner in `scripts/lib/shared-harness.mjs`. A linked
Engine worktree uses its native Git common directory to find the primary clone;
ordinary installation mounts the shared store and does not fetch or modify an
existing owner. When the primary clone is absent, it initializes that owner once
before mounting; linked worktrees never fall back to an independent clone. Native
gate. A primary checkout without Harness still creates the shallow floating
clone, and explicit CI sparse-docs mode stays scoped to its requested files.
Existing independent clones are rejected without touching their data; consolidate
them through a separate ownership and reachability check before installation.

## Preserve evidence with filesystem compression

On macOS, APFS/HFS+ transparent compression can reduce allocated space without
changing evidence paths, readable file bytes or SHA-256 digests. Existing readers
need no decompression step. This does not shrink a Git blob or an uploaded artifact.

```sh
# Read-only scan of an exact evidence directory.

# Compress verified, idle files older than 24 hours; write a JSONL receipt.

python3 -m unittest discover -s scripts/storage -p 'test_*.py' -v
```

> [!IMPORTANT]
> Select evidence roots, not live build outputs or Git stores. The command skips
> symlinks, hardlinks, open files, recent files, small files and already compressed
> files. It stages a compressed copy in the same directory, verifies its size and
> hash, rechecks the source identity and open handles, then replaces it atomically.
> A failed copy or a changed source leaves the original in place.

The receipt reports per-file allocated-byte reductions. Measure logical bytes
with `stat`, allocations with `st_blocks` / `du`, and actual volume availability
with `df`: APFS clones, snapshots and concurrent builds can make these totals
differ. A large apparent worktree total does not prove the same number of unique
physical blocks can be reclaimed.

## Repack Git without expiring recovery state

After confirming no other maintenance owns the repository, Git can deduplicate
objects across existing packs while retaining recovery refs and unreachable data:

```sh
git -c gc.reflogExpire=never \
    -c gc.reflogExpireUnreachable=never \
    -c gc.worktreePruneExpire=never \
    -c pack.threads=2 gc --no-prune
git fsck --connectivity-only --no-dangling
git count-objects -vH
```

Do not remove an object store used as a Git alternate. Repacking changes storage,
not commit history; cleanup of branches, archives or published evidence is a
separate decision with its own ownership and reachability checks.
