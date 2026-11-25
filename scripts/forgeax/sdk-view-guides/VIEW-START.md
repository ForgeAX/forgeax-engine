---
name: forgeax-view-start
description: Open the View bundled with Engine, inspect its selected project, and recover startup.
---

# Open ForgeaX View

[Simplified Chinese](SKILL.zh-CN.md)

Use the installed Engine CLI. Run from the game root or pass its absolute path.

```sh
forgeax project view --json
forgeax project view --root /absolute/game --json
```

Open the URL in the result. Check the selected project, its readiness and the
visible scene. For Play acceptance, start Play and check a completed game frame.
The View footer shows the hosting Engine version.

The response provides the backend root. Use that root for lifecycle controls
and for live [View operations](../forgeax-view-cli/SKILL.md).

```sh
forgeax backend status --root /absolute/game --json
forgeax backend stop --root /absolute/game --json
```

Keep the first failure diagnostic. Check backend status and the page's project
preparation details before retrying. An available service and a rendered scene
have separate readiness evidence. Report the URL and project on handoff.
Existing projects keep their copied skill files when Engine is upgraded.
Review local edits before refreshing those files.
