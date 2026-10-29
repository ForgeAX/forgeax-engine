# Inspector Asset Thumbnail Delivery

Date: 2026-10-22. Product commit: `8cae88e` on
`codex/inspector-asset-thumbnails`, based on View main `825f1d3`.

## Delivered Behavior

All explicitly resolved entity asset references consume existing Engine thumbnail
results. Shared controls show 64px contain-fit PNGs and stable fallback states.
Double-click/Enter uses the existing asset-open workflow. Single-click/name
navigation, asset assignment and inline rendering are not introduced.

The Inspector batches up to 32 unique GUIDs, addresses the exact project target,
observes progressive `thumbnailEpoch` results and synchronously fences obsolete
responses. The UI regression covers a batched A-to-B-to-A selection, hidden-panel
read release/recovery, missing identity, unsupported results, image decode failure,
texture-reference navigation and an asset-open failure.

Design: [Inspector Asset Thumbnails](../../2026-10-22-inspector-asset-thumbnails-design.md).
The product AGENTS consensus links this design. Product designs and evidence
travel with this View implementation PR, following the ownership in
View PR #183.

## Verification

| Check | Result |
| --- | --- |
| Product strict TypeScript (`check:packages`) | Passed |
| Components strict TypeScript (`check`) | Passed |
| `check:architecture` | Passed; 0 violations and 53 tests |
| Full Node tests, `--test-concurrency=4` | 605 passed, 0 failed, 0 skipped |
| Product build | Passed; existing Vite/Dockview warnings remain |
| Storybook production build | Passed |
| Changed Inspector browser regression | Passed; light/dark, widths 220/280/360/640 |
| Knowledge-base lint | 0 errors, 0 warnings |
| `git diff --check` | Passed |
| Harness installation `--verify` | Unavailable: new worktree has no local install-manifest.json |

The initial test setup lacked the local Engine App package link; only this
worktree's ignored dependency links were corrected. A high-concurrency full run
then hit the existing 120ms presentation-startup timeout under concurrent build
load. The final four-process run passed the entire suite without changing that
test or startup implementation.

Local dependency verification used `pnpm --config.verify-deps-before-run=false`
to reuse installed dependencies rather than replace them. Full test/build logs
are retained under the product worktree's ignored
`artifacts/inspector-asset-thumbnails/` directory.

## Image and Runtime Evidence

Read-only public calls to the current Game 3D backend returned ready/cache-hit
128px PNGs for `mesh/astral-bloom` and `material/fantasy-azure`. Those exact Engine
bytes are checked in as Storybook/test assets. The new UI verifies natural image
dimensions and `object-fit: contain`; it does not generate substitute previews.

- [Light theme, 360px](light-360.png)
- [Dark theme, 280px](dark-280.png)
- [Browser verification facts](verification.json)
- [User-provided native acceptance screenshot](native-acceptance.png)

The screenshots show the changed Inspector with explicit fixture transport and
actual Engine PNGs. Asset navigation assertions validate the submitted GUID and
source target/generation; they do not claim a newly mounted native viewer target.

After the user requested a plugin restart, the native Codex display artifact
was rebuilt against View `8cae88e` in the View worktree using read-only copies
of the existing Engine App build scripts. Only the installed plugin's generated
display HTML was replaced, with a local backup. Its project binding and Engine
files were preserved. Public `view.stop`/`view.start` retired the old presentation.

The native Codex panel then connected to project `template-game-3d`
at the Engine checkout's `templates/game-3d`, with
`projectPhase: running`. DOM inspection confirmed the loaded artifact includes
`asset-reference-thumbnail` and matches the replacement presentation identity.
The user-provided screenshot shows the native Inspector's mesh and material
previews and is included unchanged for the requested PR comment. It does not
establish automated completed-frame/GPU acceptance. No Play or independent game
run was started.

The optional CPU Profiler/RHI Debug composition rebuild completed in the View
worktree, but its replacement App artifact was not installed before the PR
request interrupted that follow-up. This does not alter the feature source diff;
the currently mounted native preview has the new Inspector controls.

The primary View checkout and all pre-existing changes were preserved. Engine
source, configuration and Git state were not modified; its original modified
lockfile/View pointer and untracked pnpm store remain as found.
