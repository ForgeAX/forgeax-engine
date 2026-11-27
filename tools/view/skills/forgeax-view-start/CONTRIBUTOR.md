# View contributor startup and host integration

For installed SDK startup with npm games, use [View startup](SKILL.md). This source-only guide
covers contributor builds and explicit Codex integration. After startup, use
[forgeax-view-cli](../forgeax-view-cli/SKILL.md) for capability discovery and
page/target operations. Verify the resulting presentation in the actual browser.
A project preview is complete when its identity, requested assets and exact
Engine target are visible. A URL or connected empty Shell alone is insufficient.
Play and independent AI execution require their own requested operation.
Editor and Play use separate browser realms on the same project resource server.
The Shell owns the Play document; the editor project document must not create a
second Play frame when it observes the same workspace state.
Play allocates a game page and authenticated connection; Stop releases that page
while editing remains available. A page URL precedes its real World handshake.
Verify both the World and a completed visible game frame before calling it playable.

## Startup contract

Use View's `start.mjs [--project G]` for the independent foreground presentation.
The file resolves its matching Engine and its own Host Pack from its installation,
then calls public `ensureDevKitView` directly. Default backend workspace H is
shared per canonical Engine/View installation in the system temporary directory,
independently of cwd and G. Optional G selects a project; omitted G opens the
chooser or adopts the existing project. `--new-instance` allocates a unique
temporary H. Explicit `--root H` overrides allocation for a caller-managed
instance. Use returned H explicitly for `view status`, `view stop` or
`backend stop`; those low-level commands retain ordinary CLI root selection.

The file publishes a plain URL before asynchronous backend preparation. Keep its
terminal open through browser review and handoff. Ctrl+C closes the presentation
and cancels its ensure caller; H retains backend process ownership. Backend
termination leaves the presentation available for restart from its offline Shell.
Omitting G never selects H as a game. H identifies the backend instance.

Low-level `backend start` and `view start` remain independently usable. The legacy
`view start` CLI requires a compatible backend and still infers H when H contains
`forge.json`; explicit G overrides that fallback. This legacy fallback is separate
from the normal foreground startup contract. Help and catalogue reads do not
start services. Never silently replace a foreign backend.

Engine owns one shared project/session across Shells. Plain-URL connections adopt
that owner; only the selected presenter places the exact Engine document. An
explicit `?project=/path` is an optional switch command guarded by current
session/generation, not the normal startup route. Refresh preserves the accepted
owner and never replays writes, selection, camera, resource opens or Play.

The retained Shell has three states. Offline offers backend startup with optional
G. Connected without a project offers known/recent selection, a shallow Node-visible
folder picker and required Next. A bound Shell shows Engine preparation/readiness
and retains the chooser in the header. DevKit owns the durable canonical catalogue
outside H and G; View reads its structured list/register/browse results.

## Codex MCP App

For a complete built local Engine/View installation, build the App and generate
`tools/forgeax-mcp/codex/create-local-plugin.mjs ENGINE NEW_MARKETPLACE`.
Install the marketplace and `forgeax-view-codex` with Codex plugin commands.
Default global View uses a fixed temporary H per installation. Each chat has
its own fixed temporary H derived from host-provided chat identity. Two chats
opening the same project still use different instances; their authored files
remain shared. On first use, read the initial directory through public
`codex app-server` `thread/read` with `includeTurns: false`. Persist canonical H
and directory under CODEX_HOME. Subsequent pages and business MCP requests read
this authority across restart, without model-supplied IDs or repeated cwd lookup.
Missing/conflicting host identity fails explicitly; never fall back to global H.

To update the current chat's working directory, call
`forgeax_view_workspace_bind({ directory: "/absolute/worktree" })`. H stays
fixed. Existing pages retire before the owning View admits the new project and
pages reopen automatically. A directory without `forge.json` returns to the
project chooser. Other chats and global View retain their selections. Binding
can establish a chat when its initial host cwd is unavailable. Business calls
pause during switching; refresh target identities after a binding revision.
This changes ForgeAX context only; ordinary terminal `forgeax` commands retain
cwd/`--root` routing. It does not change Codex's command cwd. Do not claim that
ordinary CLI commands automatically use the chat instance.
The optional generator `--root H` selects a caller-managed fixed integration
without automatic chat routing or the binding tool.

Native chat instances use client-owned backend lifetime. For a managed native
instance, stop the exact H through `backend stop` when replacement is needed,
then let the installed App's startup action create its replacement. Ordinary
CLI `backend start` selects caller-managed lifetime and cannot replace native
startup; it leaves a daemon that conflicts with the App's ownership contract.
Do not change ownership checks or silently adopt a foreign daemon to hide this.

Pack file activation must wait for the exact Shell-owned project Frame after
presentation transfer, even when the backend still reports the old browser as
running. Cancel inventory reads on session/browser/presenter replacement. The
presentation-only viewport must not duplicate Content Browser's startup inventory.
Native file tabs use per-file host identities; do not claim that sharing H or a
UI resource merges different file tabs into one page.

For native resource buttons, call
`forgeax_view_resource_card({ paths: ["/absolute/project/assets/world.scene.pack.json"] })`.
For three independent single-button cards, call `forgeax_view_resource_card`,
`forgeax_view_resource_card_2` and `forgeax_view_resource_card_3` once each, with
one path per call. Each slot has a distinct static resource URI. Native chat merges
repeated calls to the same slot and retains the latest source; do not claim that
three calls to the same tool display three cards. This MVP provides three slots;
multiple paths instead create grouped buttons in one slot.
The card validates its selected source and routes the action to the existing
fullscreen View presenter through its admitted Host connection. Later cards remain
inline and await an exact source-action reply. Only when no eligible View exists
does the card request fullscreen and mount ordinary View with no resource toolbar.
Returning that App to inline restores its buttons; reopening retains the current
resource instead of replaying the original card source. Connection retirement,
cancellation and binding replacement fence pending actions; never open a second
page after a dispatched action fails. `prepareBackend: true` optionally prepares the same
chat backend before returning the card. `forgeax_view_resource_open({ path })`
returns a separate resource App with initial fullscreen preference.

Qualify native multiple-card placement, per-card selection, collapse/restoration,
reactivation and child-document reuse separately. An App display-mode request does
not promise an independent target tab or a focus operation while already fullscreen.
An MCP receipt, source inspection or reference browser cannot prove native navigation.
Inline resource cards report their natural content height and hide idle/success
status text. Their resource metadata supplies `openai/widgetMinFrameHeight: 0`
and `openai/widgetHeightHint: 48`, consumed by the installed Codex parser and
height owner. Qualify these host-specific fields against the actual native
version; they are not a portable MCP Apps guarantee. The current host cannot
disable manual expansion independently of the button's initial fullscreen
request for local MCP cards. Do not spoof Codex Apps identity to hide controls.
Do not prepare a hidden second App, poll for navigation, toggle display modes to
force focus, or substitute global/file navigation for this interaction. Agent
Browser/Playwright capabilities are not implicit App capabilities.

Pack file entries mount the same offline Shell before waiting for workspace
services. Their file-opening consumer observes service arrival and withdrawal;
it must not add a pending required startup child that can time out and unmount
the Shell while the backend is unavailable.

The registered global/thread entry opens bundled static View HTML first through
MCP. The mounted Shell requests backend startup asynchronously through the same
View service and public `ensureDevKitView`, then presents the chooser or adopted
project. No backend prestart command is required. Scene/Play retain the same
public operations and separate realms on one project resource server. A stopped
backend leaves the static App available for explicit restart.

A mounted App document retains its exact scope/H for bytes, modules, chunks,
sockets and teardown until explicit binding retirement. New pages and business
MCP requests resolve the persisted chat binding. Project switching does not
re-key H; closing a page does not stop another
instance. A fresh chat instance selects cwd initially only when it contains
`forge.json`; an existing backend's selected project takes precedence.

Use `tools/forgeax-mcp/test/app-progressive-startup.mjs G1 G2 EVIDENCE` for the
packaged stdio/sandbox browser path. Report native Codex click/panel acceptance
separately; a reference browser cannot establish actual host support. The local
package requires its recorded built installation to remain available.

## Local Engine checkout: one script

Use the selected Engine checkout's fixed `tools/view` file with prepared outputs:

```sh
node /absolute/path/to/forgeax-engine/tools/view/start.mjs
node /absolute/path/to/forgeax-engine/tools/view/start.mjs --project /absolute/path/to/game
```

For contributor setup, the preparation helper builds missing or stale outputs
before delegating to the same file:

```sh
node tools/view/skills/forgeax-view-start/scripts/start-view.mjs --project /absolute/path/to/game
```

G is optional. Both entries share H derived from the Engine/View installation.
The root file uses built public exports without rebuilding or changing G's Engine
binding. The preparation helper checks local binding and contributor provenance.
The existing workspace marker checks Engine/View ownership and stores no new
project authority. Legacy managed roots remain intact. The helper refuses foreign
Engine/View owners and nonempty unmanaged roots. `--restart` replaces a compatible
managed backend explicitly; it leaves independent AI runs under their own owner.

The helper checks a supplied G's package link and local binding, prepares missing
Engine/View outputs through `build:engine` and integrated `build:tools`, and checks
the requested shader profile. Its final startup uses the same public
`serveView`/`ensureDevKitView` APIs as the root file. It emits one JSON announcement with
the plain URL and `phase: preparing`, then stays in the foreground. Backend/project
errors are observed through the retained Shell; the announcement is not admission
or rendering acceptance. Diagnostics go to stderr.

`--build auto` is the default and rebuilds outputs considered stale by the helper's
Git/provenance checks. `--build always` forces preparation; `--build never` requires
those checks to report fresh outputs. Dirty source checkouts can therefore fail
`never` despite having a manually built candidate. For a coordinated candidate,
use the root `start.mjs` file with already prepared outputs.
`--profile point-ssao` selects point-shadow inputs; the default is `base-ssao`. Do not run
helper preparation concurrently with another integration build or shader owner.
The helper requires contributor Git provenance; SDK consumers use the path above.

For a supplied local G, inspect `project engine status`, resolve its installed
`node_modules/@forgeax/engine` to the selected package, and use public built exports.
`pnpm link /path/to/engine/packages/engine` selects Node-side CLI/Pack imports;
`forgeax project engine use-local /path/to/engine` selects browser workspace
exports. Check the binding and project before accepting them. Do not redirect
exports to source or fabricate SDK metadata. Source `project new` requires an
initialized SDK; maintained source templates are a distinct contributor fixture
materialization path.

## Development Viewer

Start the matching foreground `start.mjs` in one terminal. In another, use:

```sh
pnpm --dir tools/view dev -- --view-host http://127.0.0.1:<view-port>
```

The dev server proxies bootstrap, health and the launcher to that service. It
translates only its own document's launcher origin; foreign origins remain denied.
The View service remains the launcher owner. `dev:ui` starts a private fixture Host
for UI work; fixture responses do not establish production runtime acceptance.
Vite `--host` selects the dev server's bind address, not the backend root.

## Verify and preserve the failing boundary

Open the returned plain URL while the foreground terminal remains alive. Confirm
Shell connection, requested project identity, Engine session progress, requested
assets and the exact headed target. Scene loading, Play readiness and submitted
pixels are separate checks. For GPU evidence, use the repository's maintained
browser configuration and inspect the actual frame; `navigator.gpu`, a mounted
iframe or a black canvas are insufficient.

If a browser tool is unavailable, return the actual URL and report browser/project
acceptance as unverified. Preserve the original failing stage and producer error.
A terminal Pack/catalog failure requires repair and explicit project reopening;
a rendering failure remains separate from Shell availability. Never replace a
failed boundary with a game server, mock catalogue or another target.

Inspect `backend status` and `view status` on the same H. Stop only owned/requested
resources. Foreground Ctrl+C closes the independent presentation; `view stop`
releases resident View resources while preserving Engine and independent runs;
`backend stop` releases H's backend. Stop an AI run through its own operation.
Report selected Engine entry, H, service URL, project identity and the exact
verification boundary. Keep build, DOM, pixel and CI evidence distinct.
