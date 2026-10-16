# Engine single-package release migration

> [!IMPORTANT]
> This is delivery implementation and local diagnostic evidence. The user authorized
> merging without waiting for remote CI. Initial implementation diagnostics below
> precede publication. Stable 0.4.0 is now public and its three `latest` tags and
> fresh public SDK consumers are verified; the final receipt follows. Complete
> release Candidate gates remain in place; this direct release does not claim
> complete CI or sealed Candidate qualification.

## Delivered contract

| Concern | Result |
|:--|:--|
| Partial Engine publication | One standard npm bundle contains all physical Engine modules and locked common dependencies; unpatched, single-version platform leaves use exact optional dependencies |
| Source ownership | Modular packages, independent ESM subpaths, declarations, Workers and WASM remain available |
| Public publication roster | Engine, independent View tool, SDK carrier; no focused Engine package publication |
| Stable | `stable`, `x.y.z`, explicit publication, npm `latest` |
| Development | `main`, `x.y.z-dev.sequence.sha12`, green current-main CI triggers Candidate, successful Candidate triggers Promotion, npm `next` |
| Mutable tags | Exact public metadata and downloaded SHA-512 plus fresh external SDK consumers precede tag writes; promotions serialize and reject regression |
| Transport recovery | Retry the same sealed bytes and occupied version after npm validation or previously staged responses |
| Stable baseline | User selected the migrated main commit as the first single-package source baseline; retain old stable and selected main history in a merge with the selected main source tree; the old stable tip has independent commits |

The executable owners and operating procedure are linked from
[Engine release channels](../../packages/engine/RELEASING.md).

## Local evidence

Diagnostic source base: `48ca087c37af520d3f6f5ff020c0e1f7933b726e`.
Pinned View source: `44e8d81aee23f75d94e95ed813349d1b6483d573`.
Local-only probe identity: `0.0.0-dev.1.48ca087c37af`.

| Gate | Evidence |
|:--|:--|
| Engine production | `pnpm build:engine` completed inside the SDK producer |
| SDK diagnostic production | `sdk:build --version 0.0.0-dev.1.48ca087c37af --allow-dirty` returned `ok:true` |
| Real Engine installation | Both npm and pnpm installed with registry unavailable; runtime, math and ECS imports and the forgeax CLI loaded |
| Bundle regressions | Actual offline npm/pnpm installation, transitive and duplicate versions, unsupported-platform optional payload, deterministic repeated packing, missing required dependency rejection |
| Release regressions | Source/channel identity, ordered promotion, validating npm unit and consumer failures preserve channel tags, regression rejection |
| SDK contracts | 44 Vitest tests passed; launcher reproducer was red before its repair |
| SDK update discovery | 5 DevKit unit tests passed; stable and development discover separate tags |
| Workflow contracts | 26 SDK workflow contract tests passed; actionlint passed for all affected release/preflight workflows |
| Documentation/layout | Changed Mermaid blocks parsed; repository test layout and workspace equivalence checks passed |
| Fresh carrier/template consumer | Publisher check-only returned `ok:true`; SDK install/init and both empty/game-3d new/check/test/typecheck/build/package/dev HTTP lifecycles passed with isolated caches |

The Engine probe includes 337 installed dependency graph nodes. Its archive is
275,956,740 bytes (263.17 MiB); the initial diagnostic SDK ZIP is 784,758,528 bytes
(748.40 MiB). These are measured sizes, not performance acceptance or npm upload
receipts. Build duration and transfer cost need future release measurements.

## Failures retained and repaired

| Reproducer | Owning repair |
|:--|:--|
| Published View still resolved focused Engine packages | Project copied View modules onto Engine public subpaths and depend only on exact-version Engine |
| Cold local registry returned 404 for locked canonical View tarball URL | Serve staged canonical owned URLs as well as explicit local tarball URLs |
| Online npm carrier boot created a partial `store/pnpm`; project creation then failed with `ERR_PNPM_NO_OFFLINE_TARBALL` for Vite | Launcher uses the normal online package-manager cache; reserved `store/pnpm` remains the shipped ZIP closure |

The original diagnostic ZIP predates the launcher repair. For the final fresh
carrier probe, its unsealed local carrier was repacked through the standard
archive writer with the regenerated launcher and updated manifest digest. This
is diagnostic execution, not an immutable production Candidate or proof of the
final Git commit's reproducible ZIP.

## Acceptance boundary

- [x] Delivery/channel implementation and focused local regression evidence.
- [x] Actual complete Engine offline installation and CLI imports.
- [x] Fresh carrier installation, initialization and both external template lifecycles.
- [ ] Full final-commit CI, Browser/Dawn/smoke fleet and independent Candidate reproducibility.
- [x] Public npm visibility and public registry consumer acceptance for stable 0.4.0.
- [ ] First qualified stable publication after the selected source baseline.

Engine, View and SDK tags remain individual npm writes. Complete bundling prevents
partial internal Engine closure; it cannot guarantee gameplay/API correctness or
make separate product tag writes atomic. Existing pinned bad versions are not
rewritten by this source migration.

## Stable 0.4.0 publication

The [Shader delivery audit](shader-delivery-audit-2026-10-10.md#production-publication-receipt)
records the exact source, archive bytes and public consumer receipt. Engine is
117,415,600 bytes (111.98 MiB), down from the failed 267.24 MiB production attempt.
Its 306 bundled dependency graph nodes retain every Engine owner; 31 eligible
third-party platform leaves are exact optional dependencies.

Engine, View and SDK 0.4.0 became publicly downloadable with matching local
SHA-512 bytes before `latest` advanced. Fresh anonymous registry consumers passed
both empty and game-3d installation/init/check/test/typecheck/build/package/dev
start/stop. The AI download guide
uses exact matching channel versions and the current project-scoped CLI.

Stable source is `13dbf4a4c96ae848885bf4e68dd42ce6a12d62d1`, whose tree equals
merged main `e12493e58215d303b58d7b7140ffa4a5dac91e24`, preserving both histories.
Remote CI was waived explicitly. This direct npm release is not a sealed Candidate
or complete Browser/Dawn/fleet qualification; the unchecked qualification gates
above remain honest. Legacy incomplete `next` tags remain unavailable through
the guide's matching-version contract pending a complete development promotion.
