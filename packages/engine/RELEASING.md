# Engine development releases

The current development release publishes one npm package, `@forgeax/engine`,
under `next`. The tarball contains the runtime, CLI, View, templates and authoring
skills. Its compressed size must be at most 64,000,000 bytes.

| Where | Entry point |
|:--|:--|
| Local Linux | `NPM_TOKEN_FILE=/secure/npm-token node scripts/forgeax/local-sdk-release.mjs --stage all` |
| GitHub Actions | `gh workflow run engine-development-release.yml --ref main` |
| Package a build for local inspection | `pnpm engine:pack --output <directory>` |

Both release entry points use the same producer and consumer checks. Provide
`--source-sha <full-sha>` locally or `-f source_sha=<full-sha>` with GitHub to
select an existing `main` commit. Omitting the SHA selects the current `main`
tip once. The release lock records the version, source and working directories.
Local releases read version allocation exclusively from `@forgeax/engine`.

The Candidate builds one tarball and records its digest. An isolated registry
serves those bytes for a clean global install. The installed CLI creates and
builds Empty and Game 3D, checks their Engine dependency and installed guides,
and opens View. Promotion publishes the same tarball under `candidate`, compares
the downloaded bytes, and repeats the clean install from public npm. It records
the package and checksum on GitHub, advances `next`, and syncs the public source
mirror when `ENGINE_SOURCE_MIRROR_ENABLED` is enabled.

## Repairing publication after immutable bytes exist

> [!IMPORTANT]
> Resume the same Candidate after a registry or transport failure. Keep the
> version, source and sealed tarball together. The publisher checks existing npm
> bytes before retrying. A digest mismatch stops the release.

Local `--stage candidate`, `--stage preflight` and `--stage promote` can run
separately. The default output is `artifacts/engine-release/<version>/`.
`--output` and `--worktrees` may point to a data disk. Local builds share the
host task gate. The release needs the repository's pinned Node/npm/pnpm versions,
Git/LFS, Xvfb, Chrome Beta, Mesa lavapipe and access to the pinned inputs.

Use a private mode `0600` `NPM_TOKEN_FILE`. GitHub uses `NPM_TOKEN` and its
repository token. Public source mirroring may also need the publisher token via
`FORGEAX_GAMES_GITHUB_TOKEN_FILE` locally or `FORGEAX_GAMES_GITHUB_TOKEN` in Actions.

Earlier SDK releases retain their sealed artifacts and their original Promotion
workflow for recovery. The historical maintainer references describe those
versions. Current game projects install only `@forgeax/engine`.
