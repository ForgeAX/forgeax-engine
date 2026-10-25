# Engine working rules

AI-first TypeScript game engine; AI is the primary user. Reduce the concepts a reader must hold, not line count. Prefer one authority, derived state and closed unions. Fix the owning subsystem rather than adding a demo workaround or parallel registry. Prefer the better API over compatibility shims; published wire/API changes retain their versioning rules.

## Start with the task

- Read the affected package README and implemented contract. `@forgeax/engine` is the public runtime/CLI umbrella; `packages/<owner>` retains implementation ownership. Do not infer APIs from architecture summaries.
- Never switch the primary checkout's branch. Commit in an isolated `.worktrees/<branch>` worktree; preserve unrelated changes, active sessions and shared resources. Remove your clean worktree after delivery.
- Keep this entry brief. Do not append feature history, package inventories or deployment logs. Update the owning README; consult only the relevant section of [the contributor reference](packages/engine/AGENT-REFERENCE.md) when needed. Never auto-import that reference.

## Implementation

- ESM-only TypeScript, strict flags from `tsconfig.base.json`. Schemas declare components/resources/events. Expected failures return structured `Result`; closed error-code unions and discriminated details remain source-owned and exhaustively handled.
- English-only source and agent guidance. Follow Biome, package naming and `packages/runtime/README.md` naming rules. Avoid redundant wrappers, state copies and compatibility paths; wire/error-code compatibility follows the documented version boundary.
- Tests belong in the nearest owning `__tests__/`; runner-specific filenames and `bench/*.bench.ts` follow the reference. Add a same-path regression gate for a reproducible bug; reproduce it red, fix its owner, then pass relevant checks.
- Fix vulnerabilities in the owning manifest/version policy and lockfiles, not installed/cache artifacts; verify a fresh consumer. Keep `pnpm-lock.yaml` and `bun.lock` synchronized; use `pnpm sync:check` and channel-alignment checks when those inputs change.

## Evidence and checks

> [!IMPORTANT]
> A blocked required check stays unverified. Preserve its failure, attempt supported recovery, and report missing evidence. Never substitute a weaker mock or CPU result for runtime, pixel, GPU, browser or device acceptance.

- Difficult rendering failures start with [RHI Debug](skills/forgeax-engine-rhi-debug/SKILL.md): capture the actual failing frame before speculative shader edits. Explicit startup/asset/schema errors go to their named owner.
- Basic initialization, `pnpm build:engine` and CPU tests need no Dawn toolchain. Engine/RHI/hello changes retain the maintained **60 completed-frame** core smokes, `pnpm test:browser` and `pnpm test:dawn`; browser-path failures need browser evidence. Longer soaks are opt-in. See [CI operations](scripts/ci/README.md) and `scripts/ci/dawn-smoke-roster.json`.
- Chromium launches must set `chromiumSandbox: true`; repair an unprivileged runner rather than passing sandbox-disabling flags. Use the user's exact SSH endpoint for a runner target, without guessing a nested container.
- CI keeps approximately 80% core validation, at most four actual jobs per matrix, and a 30-minute execution target (queueing reported separately). Reproduce locally, use `pnpm ci:focus`, then complete CI on the final PR commit. Retry only failed jobs for proven external transport failures. CI changes update the operating guide and affected skill routes.
- Start with relevant build/type/unit/lint checks; shortcuts do not replace required acceptance. Use `pnpm test:layout` for moved/added tests. Metrics follow `schemas/forgeax-metrics.schema.json`; quality ratchets and full commands live in the CI guide/reference.
- Generated reports belong in `packages/<owner>/reports/` or the floating Harness, never root `docs/`. Before committing run `node scripts/ci/check-root-docs.mjs`.

## Read details only when needed

| Task | Contract |
|:--|:--|
| Package ownership or lifecycle change | [Module design map](packages/engine/AGENT-REFERENCE.md#module-design-map--cognitive-injection), then owning README |
| Asset authoring / publication | [Asset authority schema](schemas/asset-authority.schema.json), Pack README and [asset skill](skills/forgeax-engine-assets/SKILL.md) |
| SDK / npm release | [Release contract](packages/engine/RELEASING.md) and [SDK skill](skills/forgeax-engine-sdk/SKILL.md): Candidate -> Promotion; promotion consumes sealed bytes and never rebuilds or pre-creates version tags |
| Public SDK source | `.forgeax-public-distribution`: no private asset/submodule requirement; checked WASM payloads and `pnpm build:engine` remain sufficient for source build; see [source-mode details](packages/engine/AGENT-REFERENCE.md#public-sdk-source-mode) |
| View / tool integration | [View source contract](packages/engine/AGENT-REFERENCE.md#view-source-tool); View is a fixed gitlink, Harness floats; runtime packages do not depend on View/React |
| Game / CLI work | [CLI skill](skills/forgeax-engine-cli/SKILL.md); `forgeax` is the public entry, required templates target a directory outside the SDK root |
| Build setup / commands / test naming | [Contributor reference](packages/engine/AGENT-REFERENCE.md#commands) and [CONTRIBUTING](CONTRIBUTING.md) |
