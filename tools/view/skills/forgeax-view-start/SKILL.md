---
name: forgeax-view-start
description: >-
  Optional ForgeaX View startup from an installed SDK. Use when opening View,
  browsing game assets or scenes interactively, or diagnosing View startup.
---

# Open ForgeaX View

[Simplified Chinese](SKILL.zh-CN.md)

View is optional. Open it when requested or when interactive asset/scene review
is needed, including during authoring. Ordinary Engine commands work without it.
This file and [View operations](../forgeax-view-cli/SKILL.md) are maintained by
View and shipped only with the SDK. Game npm dependencies do not include View.

## Installed SDK

Read the game's `AGENTS.md`. From the game's root, run the matching SDK's file:

```sh
node /absolute/forgeax-sdk/tools/view/start.mjs --project .
```

From another directory, use absolute paths for the SDK and game:

```sh
node /absolute/forgeax-sdk/tools/view/start.mjs --project /absolute/game
```

The file resolves its canonical SDK installation and initializes that SDK's
`.forgeax/cli-runtime` through the existing SDK launcher. It selects Engine and
View from that runtime, including pnpm links, independently of cwd and the game's
npm installation. Never silently substitute another SDK. Do not add a launcher,
View dependency or npm script to the game.

Published SDK outputs are built already. Do not run `build:engine`, install a
separate View package, or manually start a Backend for this path. Missing outputs
indicate an incomplete SDK; preserve the diagnostic and repair that installation.
Source contributors use the separate contributor guide.

Omit `--project` for the SDK-wide chooser or to retain the instance's existing
project. The launcher never selects cwd implicitly.

Language priority is the saved user choice, then the primary browser/system
preference, then English. Missing, blocked or unsupported preferences fall back
to English. Automatic detection does not persist a choice; use the language menu
to override the system preference.

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

An SDK upgrade updates its guidance, not the game's copied skills or
`AGENTS.md`. For an older game, read the installed SDK's skill first. When
asked to refresh its guidance, compare the two official View skills with the
game's tracked versions, update unmodified official content and preserve custom
edits. Replace obsolete manual-Backend/build-helper recommendations with the
installed file command; retain valid Engine dev, capture and acceptance routes.
Add only the View route to the game's existing agent guide. Existing skill mount
installation alone does not refresh copied content. Report conflicts explicitly;
do not overwrite the entire guide or introduce another launch wrapper.
