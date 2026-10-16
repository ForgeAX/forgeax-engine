# Q1-Q12 Trace Map — feat-20260513-guid-asset-package-system

Human reviewer: use this table to confirm that all 12 clarification answers (Q1-Q12, AC-16) have a corresponding requirement anchor in `requirements.md`.

| Q# | Question summary | `requirements.md` anchor | AC / section |
|:--|:--|:--|:--|
| Q1 | UUID version for GUID serialization — UUIDv7 (time-ordered, random-node) for new GUIDs | §3.1 GUID serialization shape (lines 58-69) | AC-12 (`builtin namespace → UUIDv5`; new GUIDs → UUIDv7) |
| Q2 | Two-layer model: runtime `Handle<T>` over disk GUID — dual-layer architecture | §1.1 terminology disambiguation (lines 18-27) + §2.1 three-layer model (lines 31-39) | §2.1 layer diagram |
| Q3 | Sub-asset independent GUID — each sub-asset inside a source file gets its own GUID, not a derived index | §3.2 `.meta.json` shape `subAssets[]` (lines 70-94) | AC-11 (`subAssets[].guid` unique per entry) |
| Q4 | `PackErrorCode` closed union — dedicated 8-member domain separate from `AssetErrorCode` | §6.1 new closed union `PackErrorCode` (lines 193-211) | AC-05 (PackErrorCode 8-member exhaustive list) |
| Q5 | Multiple roots — the build host passes explicit roots to one scanner; no package-level asset registry participates | §3.4 asset directory configuration | AC-03 (scanner accepts explicit roots) |
| Q6 | Fail-fast on GUID collision — scanner aborts on first collision, never merges duplicates | §5 Scanner behavior (lines 171-189) + §6.1 `pack-guid-collision` | AC-06 (6-step fail-fast chain; collision is step 3) |
| Q7 | New package `@forgeax/engine-pack` — dedicated package, not folded into `engine-runtime` or `engine-types` | §1 overview (lines 8-16) + §7.1 CLI (lines 232-240) | §1 + §7.1 package scope |
| Q8 | Builtin GUIDs via UUIDv5 — `BUILTIN_HANDLE_CUBE` and `BUILTIN_HANDLE_TRIANGLE` derived from a fixed namespace + name | §3.1 GUID serialization shape builtin namespace (lines 58-69) | AC-12 (builtin UUIDv5 fixture in `.pack.json`) |
| Q9 | `.forgeax-asset-cache/` blacklist — scanner skips this directory by default | §3.4 asset directory configuration blacklist entry (lines 123-137) | §3.4 (`forgeax-asset-cache` default blacklist) |
| Q10 | Cycle fail-fast — `pack-cyclic-reference` terminates scanner immediately; no partial index emitted | §5 Scanner behavior step 5 cycle detection (lines 171-189) | AC-06 (cycle is step 5 of 6-step fail-fast chain) |
| Q11 | CLI + Inspector dual surface — `forgeax asset` subcommand + `inspect packs` RPC both expose pack data | §7.1 CLI `forgeax asset` (lines 232-240) + §7.2 Inspector subcommand (lines 242-256) | §7.1 + §7.2 |
| Q12 | Engine source: only schema + protocol, no business logic — `@forgeax/engine-pack` owns schema; no logic in types or runtime | §1 overview constraint (lines 8-16) + §14 constraints (lines 430-436) | §14 (`English-only source`; Result-only; no throws) |
