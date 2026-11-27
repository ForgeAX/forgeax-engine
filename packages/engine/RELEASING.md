# Engine npm releases

Engine releases publish one npm package, `@forgeax/engine`, with development
builds under `next` and test builds under `rc`. The tarball contains the runtime,
CLI, View, templates and authoring skills. Its compressed size must be at most
64,000,000 bytes.

| Where | Entry point |
|:--|:--|
| Local Linux | `NPM_TOKEN_FILE=/secure/npm-token node scripts/forgeax/local-sdk-release.mjs --stage all` |
| GitHub Actions, development | `gh workflow run engine-development-release.yml --ref main` |
| GitHub Actions, RC | `gh workflow run engine-rc-release.yml --ref main -f version=<rc-version> -f source_sha=<full-rc-sha>` |
| Package a build for local inspection | `pnpm engine:pack --output <directory>` |

Both release entry points use the same producer and consumer checks. Provide
`--source-sha <full-sha>` locally or `-f source_sha=<full-sha>` with GitHub to
select an existing `main` commit. Omitting the SHA selects the current `main`
tip once. The release lock records the version, source and working directories.
Local releases read version allocation exclusively from `@forgeax/engine`.
An RC needs an explicit version and full source SHA belonging to `rc` and
containing the current `stable` tip. Locally, add `--version <rc-version>
--source-sha <full-rc-sha>` to the Linux entry point.

The Candidate builds one tarball and records its digest. An isolated registry
serves those bytes for a clean global install. The installed CLI creates and
builds Empty and Game 3D, checks their Engine dependency and installed guides,
and opens View. Promotion publishes the same tarball under `candidate`, compares
the downloaded bytes, and repeats the clean install from public npm. It records
the package and checksum on GitHub, advances `next`, and syncs the public source
mirror when `ENGINE_SOURCE_MIRROR_ENABLED` is enabled. RC Promotion uses
`rc-candidate` during publication, repeats the public consumer check, publishes an
Engine-only GitHub prerelease and advances the `rc` tag. RC sources are private
to the test branch and skip the source mirror.

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
