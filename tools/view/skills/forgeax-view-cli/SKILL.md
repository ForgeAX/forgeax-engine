---
name: forgeax-view-cli
description: >-
  Use the authoritative View workspace API through its CLI clients. Use when
  inspecting or changing View project bindings, opening assets, selecting scene
  entities, or checking whether a CLI request affects an open View page.
---

# ForgeaX View API and CLI

> [!IMPORTANT]
> The resident workspace API is authoritative. The browser and CLI are clients
> of the same owner; the CLI does not implement project, asset, scene, or camera
> behavior. Engine owns project and target execution. View owns workspace
> bindings, selection, and presentation requests.

## Find the live contract

Public ToolApi IDs are also CLI paths: `view.workspace.pack.reveal` becomes
`forgeax view workspace pack reveal`; pass its argument object through `--input`.
`view.workspace.summary.get` reads bounded workspace facts. The running Engine
backend discovers these current owner descriptors without mounting new plugins.
The standalone workspace client uses relative IDs (`pack.reveal`, `summary.get`).

Read `@forgeax/view/workspace/contract` for operation names and request shape
(`packages/view-workspace-core/src/contract.ts` in this repository). For
programmatic clients, call
`connectViewWorkspace(...).capabilities()` to see what the connected owner can
execute. The contract's operation list alone does not prove that a provider is
installed and callable. Use `tabs.get` for the current project, tab, and exact
target identities; obtain asset GUIDs from `assets.list`. Keep the returned
`projectId`, `targetId`, and `targetGeneration` with subsequent requests instead
of guessing from paths, names, or a previous target.

| Need | Owner and entry |
|:--|:--|
| Backend or optional View lifecycle | `forgeax backend ...` and `forgeax view start\|status\|stop`; use [View startup](../forgeax-view-start/SKILL.md) |
| Allocate an Editor project on the running View | `forgeax view project open --root <backend-root> --project <project-root> --json`; open the returned headed URL |
| Call one resident workspace operation through Engine CLI | `forgeax view workspace call --root <backend-root> --operation <id> --args <json> --json`; requires the selected View host Pack and running View owner |
| Call the resident View workspace API | `forgeax-view workspace --operation <id> --args <json>` with the issued endpoint and token |
| List pages and reveal a Pack | `forgeax view workspace call --operation pages.list --args '{}' --json`, then `--operation pack.reveal --args '{"projectId":"...","sourcePath":"assets/example.pack.ts","revision":"...","connectionId":"..."}' --json` |
| Author assets or control an independent AI run | Engine CLI; use the installed `forgeax-engine-cli` skill when available |

`forgeax help view --tree --json` discovers declarations from the running
backend's selected host Pack. A listed command does not prove its plugin
is mounted or its provider is callable. The `forgeax-view workspace --help`
operation list describes its client grammar; an unavailable operation fails at
the connected owner. The workspace CLI accepts `--endpoint` and `--token`, or
`FORGEAX_VIEW_WORKSPACE_ENDPOINT` and `FORGEAX_VIEW_WORKSPACE_TOKEN`. Treat
these credentials as connection secrets; do not paste them into reports.
The resident View registers `view.workspace.*` on ToolApi; the frontend
transport and both CLI entries reach the same View owner. The Engine CLI
entry uses the backend's existing authentication. Select the package host
with `backend start --host-pack`; a downloaded View package alone
does not make this command discoverable.
`pages.list` exposes a bounded page inventory; `pack.reveal` waits for the
addressed frontend to show the Pack. With multiple pages, select the exact
`connectionId`; a stale page or source revision returns a non-action result.

## Open a scene through the API

With an Editor project already open, call `tabs.get`, then `assets.list` for its
`projectId`. Choose the scene asset's exact GUID. The Content Browser's double
click and the following CLI call both submit `asset.open` with the same
workspace tab and project identity:

```sh
forgeax-view workspace --operation asset.open \
  --args '{"projectId":"<project-id>","guid":"<scene-guid>","tabId":"forgeax-user-workspace"}'
```

After success, read `tabs.get` again and check its `openRequest` and Editor
target. If an already connected frontend has the scene PageType, it observes
the new request and focuses the Editor page. A frontend that connects later
baselines the retained request; the CLI response alone does not prove a page
is visible or that a rendered frame exists. Verify the browser and target when
the requested outcome is visual.

Use `scene.select`, `scene.pick`, or `scene.clear` for View selection; direct
Engine `target.pick` only returns query facts. Page layout, Content Browser
filters, and other local UI interactions are frontend policy and need not have
workspace CLI operations. Keep multi-call camera transactions on one client
connection with `--batch`; a single CLI call closes its connection after the
API response.
