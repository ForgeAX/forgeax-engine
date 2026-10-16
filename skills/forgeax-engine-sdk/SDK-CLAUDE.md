# SDK archive Claude entrypoint

The distributable archive is rooted at `forgeax-sdk/`. Read [`AGENTS.md`](AGENTS.md), then [`skills/forgeax-engine-sdk/SKILL.md`](skills/forgeax-engine-sdk/SKILL.md), before creating or changing a game. When broader discovery is needed, start the versioned capability catalog at its `sdk-v0.1.4` → `sdk-v0.1.6` delta before using the current snapshot; select the smallest useful capability set rather than enabling every packaged feature.

For direct game authoring, use `bin/forgeax`. Run SDK `init` first, then create games in a sibling or other external directory; the SDK root and its children are protected targets. A full ZIP has the offline template closure, while the smaller npm carrier intentionally omits `store/pnpm/` and installs locked Engine dependencies from the configured registry.

For Engine source work, read [`source/engine/CLAUDE.md`](source/engine/CLAUDE.md) and [`source/engine/AGENTS.md`](source/engine/AGENTS.md). The archive is a source snapshot identified by `sdk-manifest.json#engineCommit`, not a Git checkout. Keep built artifacts and source changes separate, and use the manifest plus exact verification result to establish which bytes were distributed.
