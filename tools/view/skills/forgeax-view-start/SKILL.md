---
name: forgeax-view-start
description: >-
  Optional ForgeaX View startup from an installed Engine. Use when opening View,
  browsing game assets or scenes interactively, or diagnosing View startup.
---

# Open ForgeaX View

View is optional. Open it when requested or when interactive asset/scene review
is needed, including during authoring. Ordinary Engine commands work without it.
This file and [View operations](../forgeax-view-cli/SKILL.md) are maintained by
View and shipped with the matching Engine; no additional global SDK is required.

## Installed npm game

Read the game's `AGENTS.md`. From that game's root, run its installed View file:

```sh
node ./node_modules/@forgeax/engine/tools/view/start.mjs --project .
```

From another working directory, use absolute paths for both the script and game.
Resolve the game's own `@forgeax/engine` installation; never silently substitute
a global SDK or another game's Engine. pnpm links are supported: the file resolves
its canonical installation. Do not add a launcher or npm script to the game.

```sh
node /absolute/game/node_modules/@forgeax/engine/tools/view/start.mjs --project /absolute/game
```

Published outputs are built already. Do not run `build:engine`, install a separate
View package, or manually start a Backend for this path. A missing startup file
means this installation does not include View: report its package path/version
and use a complete matching distribution. Missing built outputs indicate an
incomplete installation; do not switch to a contributor build helper.

For an explicit SDK-wide chooser, use `node "$SDK_ROOT/tools/view/start.mjs"`.
For a game, prefer its installed Engine and always pass `--project`. Omitting it
opens a chooser or retains that instance's existing project; it does not select cwd.

## Options and lifetime

Run the file with `--help` for its exact flags; it does not start services.
The file emits JSON directly and does not accept the Engine CLI's `--json` flag.

- `--project G` selects the game; paths containing spaces must be quoted.
- `--root H` selects an explicit Backend workspace, not the game directory.
- Default H is a shared system temporary directory derived from the canonical
  Engine/View installation paths. The fingerprint is deterministic, not random.
- `--new-instance` allocates a separate temporary H; explicit `--root` wins.

Keep the foreground terminal open and open the returned plain URL. The launcher
prepares Backend and project asynchronously through Engine's public API. A URL
means the Shell is listening, not that the project or its renderer is ready.
Verify the requested project identity, readiness, assets and actual scene. Play
requires its own action and a completed visible game frame. Do not construct
project query URLs or assume all View features passed from one screenshot.

Ctrl+C closes this presentation and cancels its startup caller. Backend retains
its own lifetime. Use the returned H explicitly for subsequent instance controls;
do not infer it from cwd or G. A stopped Backend leaves the Shell available for
explicit restart. Stop only resources owned by or requested for this task.

The initial JSON identifies `enginePackage`, `viewRoot`, `hostPack`, requested
`project`, URL and H (`root`). Its `phase: preparing` is a startup announcement,
not a live status report; follow the page for the accepted project and readiness.

After readiness, use [View operations](../forgeax-view-cli/SKILL.md) to discover
the selected Host's capabilities. Low-level `view start` requires an already
running compatible Backend; it is a separate advanced operation. Missing View
commands in cold `forgeax help` do not mean the startup file is unavailable.

## Failure and handoff

Preserve the failing stage and original diagnostic. Check Backend/View status
against the returned H using the same installed Engine. Never replace a foreign
Backend, rewrite the game's Engine binding, or retry a terminal project failure
silently. Reopen explicitly after repairing its source. Browser or renderer
failures are separate from Shell availability.

Return the actual URL, H, selected Engine installation and project identity.
If browser verification was not performed, say so. Starting View does not replace
the game's normal build, capture or gameplay acceptance gates. Source contribution
and native host integration require their repository-specific contributor guide.

## Existing game guidance

An npm upgrade updates this package's guidance, not the game's copied skills or
`AGENTS.md`. For an older game, read the installed package's skill first. When
asked to refresh its guidance, compare the two official View skills with the
game's tracked versions, update unmodified official content and preserve custom
edits. Replace obsolete manual-Backend/build-helper recommendations with the
installed file command; retain valid Engine dev, capture and acceptance routes.
Add only the View route to the game's existing agent guide. Existing skill mount
installation alone does not refresh copied content. Report conflicts explicitly;
do not overwrite the entire guide or introduce another launch wrapper.
