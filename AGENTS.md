# Engine working rules

AI-first TypeScript game engine; AI is the primary user. Reduce the concepts a reader must hold, not line count. Prefer one authority, derived state and closed unions. Fix the owning subsystem rather than adding a demo workaround or parallel registry. Prefer the better API over compatibility shims; published wire/API changes retain their versioning rules.

## Start with the task

- Read the affected package README and implemented contract. `@forgeax/engine` is the public runtime/CLI umbrella; `packages/<owner>` retains implementation ownership. Do not infer APIs from architecture summaries.
- Never switch the primary checkout's branch. Commit in an isolated `.worktrees/<branch>` worktree; preserve unrelated changes, active sessions and shared resources. Remove your clean worktree after delivery.

## Implementation

- ESM-only TypeScript, strict flags from `tsconfig.base.json`. Schemas declare components/resources/events. Expected failures return structured `Result`; closed error-code unions and discriminated details remain source-owned and exhaustively handled.
- Runtime modules consume explicit host inputs and engine-owned diagnostics; they do not infer development mode from bundler metadata or ambient process environment. Tool and platform adapters own those inputs. Run `pnpm check:runtime-boundaries` and its built-output counterpart before delivery.
- English-only source and agent guidance. Follow Biome, package naming and `packages/runtime/README.md` naming rules. Avoid redundant wrappers, state copies and compatibility paths; wire/error-code compatibility follows the documented version boundary.
- Tests belong in the nearest owning `__tests__/`; runner-specific filenames and `bench/*.bench.ts` follow the reference. Add a same-path regression gate for a reproducible bug; reproduce it red, fix its owner, then pass relevant checks.
- Fix vulnerabilities in the owning manifest/version policy and lockfiles, not installed/cache artifacts; verify a fresh consumer. Keep `pnpm-lock.yaml` and `bun.lock` synchronized; use `pnpm sync:check` and channel-alignment checks when those inputs change.

## Evidence and checks

> [!IMPORTANT]
> A blocked required check stays unverified. Preserve its failure, attempt supported recovery, and report missing evidence. Never substitute a weaker mock or CPU result for runtime, pixel, GPU, browser or device acceptance.

- Difficult rendering failures start with [RHI Debug](skills/forgeax-engine-rhi-debug/SKILL.md): capture the actual failing frame before speculative shader edits. Explicit startup/asset/schema errors go to their named owner.
- Basic initialization, `pnpm build:engine` and CPU tests need no Dawn toolchain. Engine/RHI/hello changes retain the maintained **60 completed-frame** core smokes, `pnpm test:browser` and `pnpm test:dawn`; browser-path failures need browser evidence. Longer soaks are opt-in. See [CI operations](scripts/ci/README.md) and `scripts/ci/dawn-smoke-roster.json`.
- Chromium launches must set `chromiumSandbox: true`; repair an unprivileged runner rather than passing sandbox-disabling flags. Use the user's exact SSH endpoint for a runner target, without guessing a nested container.
- CI keeps approximately 80% core validation, at most four actual jobs per matrix, and a 30-minute execution target (queueing reported separately). For CI repairs, validate the final candidate locally with relevant `pnpm ci:focus` checks before publishing it, then qualify the final PR commit and obtain protected review before normal merge. A separate Linux test host is not a publication prerequisite; required Linux execution remains in PR CI. Never push directly to main, use administrator merge bypass, or disable rulesets to merge. Retry only failed jobs for proven external transport failures. CI changes update the operating guide and affected skill routes.
- **Every subsequent PR update must use the [PR CI repair workflow](skills/forgeax-engine-debug/SKILL.md#pr-ci-repair-workflow). The required `ci-repair-policy` status is published by the existing `ci-core` job before expensive preparation; old workflow successes without this status cannot qualify for merge.** The initial CI revision establishes the baseline. Before each subsequent push, set exactly one `CI-Repair-From:` line in the PR description to the completed preceding CI run, reusing qualified successful checks. Missing, invalid or stale declarations and unavailable history block CI and normal merge; no change type, purpose, size, label or additional approval exempts an update. Keep the declaration when individual checks cannot reuse evidence; those checks execute fresh under CI qualification rules. Follow the skill for baseline preparation, qualified manual recovery, fresh checks, artifacts and provenance. Final-commit CI qualification includes valid inherited successes and retains protected review and normal merge.
- Start with relevant build/type/unit/lint checks; shortcuts do not replace required acceptance. Use `pnpm test:layout` for moved/added tests. Metrics follow `schemas/forgeax-metrics.schema.json`; quality ratchets and full commands live in the CI guide/reference.

## Read details only when needed

| Task | Contract |
|:--|:--|
| Package ownership or lifecycle change | Module design map, then owning README |
| Asset authoring / publication | [Asset authority schema](schemas/asset-authority.schema.json), Pack README and [asset skill](skills/forgeax-engine-assets/SKILL.md) |
| SDK / npm release | Release contract and [SDK skill](skills/forgeax-engine-sdk/SKILL.md): Candidate -> Promotion; promotion consumes sealed bytes and never rebuilds or pre-creates version tags |
| Public SDK source | `.forgeax-public-distribution`: no private asset/submodule requirement; checked WASM payloads and `pnpm build:engine` remain sufficient for source build; see source-mode details |
| View / tool integration | View source contract; View is a fixed gitlink, Harness floats; runtime packages do not depend on View/React |
| Game / CLI work | [CLI skill](skills/forgeax-engine-cli/SKILL.md); `forgeax` is the public entry, required templates target a directory outside the SDK root |
| Build setup / commands / test naming | Contributor reference and CONTRIBUTING |
