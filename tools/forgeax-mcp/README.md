# Optional ForgeAX MCP adapter

> [!IMPORTANT]
> This package exposes six bounded MCP tools over existing Engine, Pack and View owner APIs. MCP is client-neutral; `codex/create-local-plugin.mjs` is only a Codex distribution wrapper. Browser View remains at its URL. The optional App distribution uses the same View source in isolated MCP-delivered documents. Enable Pack inspection only for a trusted project: a `.pack.ts` source may execute module top-level code.

The owner API is authoritative. Engine and View CLIs are clients of those APIs;
MCP projects the same operations into a small tool set. No MCP tool has a
private business operation. In particular, View page inventory and Pack reveal
are public `pages.list` and `pack.reveal` workspace operations, available from
`forgeax view workspace pages list` and `forgeax view workspace pack reveal`. Pack source inspection uses the Pack authoring
gateway's `asset.inspect`, also available through Engine asset CLI. The MCP
wrapper adds schema, size limits, local authentication and names derived from the public operation IDs.
Hosted dynamic imports retain native package-specifier resolution. Relative and
absolute URL references use the admitted project source graph; optional Node
transport imports keep their native rejection in browser documents rather than
becoming fabricated HTTP paths under the importing package.
The selected View package must provide both public page operations. An older
View checkout will return an owner or operation failure; the adapter does not
fall back to private Broker access.

## Dependency floors

The MCP SDK accepts `@hono/node-server` 2.x. Both workspace package-manager
policies pin 2.1.6, retaining the single static-path decode
([GHSA-rmxm-3fg6-px4f](https://github.com/advisories/GHSA-rmxm-3fg6-px4f)).
It also rejects raw backslashes before URL path normalization
([GHSA-jpvv-r467-5p4w](https://github.com/advisories/GHSA-jpvv-r467-5p4w))
and handles socket resets during asynchronous WebSocket upgrades
([GHSA-qv5m-9pm6-hqp3](https://github.com/advisories/GHSA-qv5m-9pm6-hqp3)).
The real HTTP regression retains public encoded filenames, protected routes and
query backslashes while rejecting malformed request paths.

Both policies also pin Hono 4.13.16, which repairs wildcard middleware admission
for encoded line terminators
([GHSA-h7mg-cq63-vhpq](https://github.com/advisories/GHSA-h7mg-cq63-vhpq)),
mount-prefix normalization, form validation, CSRF ping checks and CSS escaping.
The real HTTP regression requires every encoded line terminator to retain the
protected route's denial before static serving or the not-found handler.

The workspace's npm/Bun and pnpm overrides require Zod 4.6.7, body-parser 2.4.0,
qs 6.16.1 and fast-uri 3.1.9 within their existing major versions. The SDK's Express
dependency accepts the patched body-parser minor; its older locked copy can
crash on trailing compressed request bytes
([GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828)).
The SDK's Ajv resolver also accepts the patched fast-uri version, which preserves
scheme, host and relative-reference identity during normalization.
Express also accepts qs 6.16.1, which fixes comma-array serialization throwing
on elements with a non-callable own `toString`
([GHSA-6pq8-jhm2-2vcw](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw)).
Regenerate both workspace lockfiles when changing these policies. Keep normal
compressed request handling enabled.

## View operating modes

All modes use the same View and public Engine owner APIs. Platform behavior is
supplied by optional plugins through the existing platform boundary.

| Mode | Presentation and transport | Entry | Verification scope |
|:--|:--|:--|:--|
| Platform independent | Ordinary View as the top-level browser document, using browser platform capabilities and the public HTTP/WebSocket transport | [View startup](../view/README.md#start-here), with `tools/view/host.pack.json` | Default for interface development, human review and browser annotations |
| Platform simulation | Browser reference host containing the MCP App carrier and isolated View documents; real stdio MCP transport, with simulated host SDK behavior | `node tools/forgeax-mcp/test/app-browser.mjs "$ENGINE/templates/game-3d" /absolute/path/to/evidence` | Repeatable bridge, resource, Scene, Play and lifecycle regression; host controls exercise theme, draft and reopen behavior |
| Platform native | Installed App inside the actual Codex host, using its SDK bridge and permissions | [Local plugin installation](#install-a-local-codex-plugin) with the [App Host Pack](#optional-native-view-app) | Actual host theme, draft references, permissions, panel lifecycle and presentation |

Use platform independent mode for ordinary View work. Open the returned View URL
or `projectTarget.url` directly when handing a page to the user. The simulation
header and its host controls belong to the test harness; they are not View UI.
Preview and Play may retain their own isolated child documents in each mode.
Top-level View access therefore does not imply annotation access inside every child.

Simulation readiness follows the retained native Host and project-session owners,
not the header status that also describes project restoration. Require the
expected project's target publication within 180 seconds, then lock that target
and wait at most 120 seconds for its running phase and completed restoration.
Starting observations never renew the deadline; failed, lost or replaced targets
reject the wait. Owner-state polling does not depend on animation frames. Retain
the complete Scene, Play and lifecycle gates. Scene/Play progress must be `ready`
and match the latest submitted World and device generation before admitting the
existing 60-frame floor; preparation completions cannot admit capture.

Simulation evidence must record the carrier's `srcdoc`, sandbox and CSP conditions.
Fixed presentations answer the carrier binding heartbeat through the shared View
service with a stable ready revision. Native Codex routing owns per-chat migration
and retiring revisions; the network broker owns neither binding policy.
It qualifies that adapter path; actual Codex behavior still requires native
verification. Here, native means the application host, independently of the GPU
backend. Generic MCP transport remains client-neutral; Codex SDK behavior belongs
to its optional platform plugin.

## Start the combined Host

Use the Engine checkout that built the matching View package. Replace both absolute paths below with your own paths.

```sh
ENGINE=/absolute/path/to/forgeax-engine
PROJECT=/absolute/path/to/trusted/game
cd "$ENGINE"
pnpm install --frozen-lockfile
pnpm build:engine
pnpm build:tools
node tools/forgeax-mcp/codex/build-app.mjs
node packages/devkit/dist/cli.mjs backend start --root "$PROJECT" --host-pack "$ENGINE/tools/forgeax-mcp/host.pack.json" --json
node packages/devkit/dist/cli.mjs view start --root "$PROJECT" --json
codex mcp add forgeax-tools -- node "$ENGINE/tools/forgeax-mcp/src/mcp-stdio.mjs" "$PROJECT"
```

Open the URL returned by `view start`. The last command is the direct MCP probe; start a new Codex session to discover its tools. The server checks the exact project root and active backend on every call. Installing it does not start View or open a project.

## Install a local Codex plugin

Local development retains the original plugin version `0.4.8`. Do not bump
`APP_VERSION` or generated plugin manifests unless the user explicitly requests
a version change. Rebuild and reinstall the same plugin identity to apply edits.

Generate a local [portable plugin](https://developers.openai.com/plugins/build/plugins) and marketplace for the selected Engine/View installation. Game selection belongs to the retained View interface. Choose a **new** output directory; the generator refuses to overwrite an existing package.

```sh
node "$ENGINE/tools/view/scripts/build-tool.mjs"
node "$ENGINE/tools/forgeax-mcp/codex/build-app.mjs"
PLUGIN_MARKETPLACE_ROOT=/absolute/new/forgeax-view-marketplace
PLUGIN_META=$(node "$ENGINE/tools/forgeax-mcp/codex/create-local-plugin.mjs" "$ENGINE" "$PLUGIN_MARKETPLACE_ROOT")
MARKETPLACE_NAME=$(printf '%s' "$PLUGIN_META" | jq -r .marketplaceName)
codex plugin marketplace add "$PLUGIN_MARKETPLACE_ROOT"
codex plugin add "forgeax-view-codex@$MARKETPLACE_NAME"
```

When replacing an existing local installation at the same version, generate the
new package first, then run `codex plugin remove "forgeax-view-codex@$MARKETPLACE_NAME"`
and `codex plugin marketplace remove "$MARKETPLACE_NAME"` before the two add
commands. Adding the same version alone can retain the installed cache, and
adding the same marketplace name from a new source requires removing the old
source first. Keep the generated marketplace identity and hosting binding equal
to the original installation so that existing global and chat roots are retained.
After migrating Engine or View, qualify the installed package with
`FORGEAX_FILE_BROWSER_PLUGIN=/absolute/installed/forgeax-view-codex/0.4.8` in the
file browser gate; a newly generated test package does not verify Desktop's
installed bytes. Retain the frontend revision check: an old App page cannot
assemble against a different rebuilt View backend.

The generated `plugin.json` and `mcp.json` live beside the bundled stdio servers. On macOS and Linux, the package includes a launcher pinned to the Node executable used during generation, so Desktop does not depend on the terminal's `PATH`; regenerate and reinstall after replacing that Node installation. The installed `hosting.json` binds the matching Engine package, View package and App Host Pack. It records the public Codex executable and Codex home used for directory discovery; regenerate after moving either installation. Restart Codex Desktop after adding the local marketplace. Remove the direct MCP probe before installing the plugin to avoid duplicate tools.

Default native entries have separate authorities:

| Entry | Backend workspace H |
|:--|:--|
| Global View | Fixed temporary H per Engine/App Pack installation |
| Chat View and business MCP tools | Fixed temporary H derived from host chat identity and installation |
| Chats with the same project directory | Different H; authored files are still shared |
| A chat moved to a worktree | Same H; explicitly update its working directory |

Host request metadata supplies the chat identity; callers cannot choose another chat through tool arguments. On first use, public `codex app-server` `thread/read` with `includeTurns: false` supplies its initial directory. One atomic durable record under `CODEX_HOME/forgeax/view-bindings` retains the canonical directory and H across App reopen and MCP/Desktop restart. Later requests use this record without looking up cwd or asking the model to pass identifiers. Missing or conflicting identity and unavailable initial metadata fail explicitly. A game directory G never acts as H. A fresh instance selects its working directory initially when it contains `forge.json`; an existing backend's selected project takes precedence.

Call `forgeax_view_workspace_bind({ directory: "/absolute/worktree" })` to explicitly update the current chat's working directory. H remains fixed. The adapter validates the directory and prepares the existing backend, waits for that chat's live App documents to retire, then admits the new project through public View startup and commits the directory/revision. A directory without `forge.json` closes the current project and returns to the chooser. Pages automatically reopen with new document identities and fresh target admission. Global View and other chats retain their own selections and connections. Business calls pause while switching and reject responses crossing the binding revision. Old and foreign target identities remain subject to Engine owner checks.

Rebinding the same directory is idempotent. Explicit binding can establish a chat whose initial host cwd is unavailable. Preparation failure, cancellation before project admission, or missing page retirement acknowledgement preserves the committed directory. The binding store owns cross-process locking and exact document leases. A crashed switch blocks business requests until View recovers the last committed directory on the same backend. No root or project directory is recursively deleted. App/page closure leaves backend process ownership with Engine. Native Codex routes hold process usage for their exact H; Engine stops a client-owned backend after the last MCP user exits and a three-second grace period. PID plus OS process birth time recovers abnormal exits without a separate guardian. Reconnecting during the grace period preserves the backend; reconnecting during disposal waits for its exact owner to retire. Backend shutdown releases View and project resource services. Engine persists only the selected project directory (or an explicit chooser) under H, while chat binding records remain under Codex home. Reopen restores that project with fresh session/target/token identities. Manual backends and explicit `--root` distributions retain caller-managed lifetime; changing ownership requires stopping the prior daemon first. Fresh project preparation can continue after admission, as in progressive startup.

This adapter updates ForgeAX context only. It does not change Codex's terminal cwd, write arbitrary chat metadata, or intercept the ordinary Engine CLI. Ordinary `forgeax` commands retain their documented cwd/`--root` selection; use the chat MCP tools for automatic instance routing. Separate H values isolate presentation/session state, while chats opening the same G still modify the same files.

All App bytes, modules, chunks, sockets and teardown retain their exact scope/H until document retirement. Closed MCP processes release document leases; inactive abandoned documents retire after a bounded grace period. Multiple pages in one chat still use View's existing presenter election. The optional generator `--root H` keeps a caller-managed fixed instance distribution and disables automatic chat routing and the binding tool.

## Optional native View App

### Resource cards

The supported candidate paths use documented static App resources and display
modes. Native chat merges calls sharing a resource URI and lets the latest call
take over that App. Three card slots therefore declare distinct tool/resource
pairs while sharing the same carrier and source action. The host owns placement.

| Candidate | Tool call | Click behavior |
|:--|:--|:--|
| Three independent inline cards | Call `forgeax_view_resource_card`, `forgeax_view_resource_card_2` and `forgeax_view_resource_card_3` once each with `{ paths: [path] }` | Select the source in the existing chat View; expand this card only when none is available |
| Multiple resources in one card | `forgeax_view_resource_card({ paths: [first, second] })` | Select resources in the existing View using the same source operation |
| One resource with backend preparation | `forgeax_view_resource_card({ paths: [path], prepareBackend: true })` | Prepare the chat backend before returning the inline card; clicking uses the same existing View route |
| Direct fullscreen resource | `forgeax_view_resource_open({ path })` | Explicit separate-App diagnostic: prefer initial fullscreen and open the source without a button |

The adapter canonicalizes and validates paths without evaluating Pack code.
Backend preparation is opt-in. Trusted host chat metadata owns instance routing;
resource calls cannot choose another chat or the global instance. Card and direct
resource Apps use the ordinary View through the existing guarded project/asset
operations. Buttons route through trusted chat metadata. The MCP network broker
uses its admitted top-level Host connections and View's authoritative presenter
status to choose the existing fullscreen View. Source actions use that connection's
event queue and await its exact completion reply; the receiver uses the same
source opener as initial file and resource entrypoints. Later cards remain inline.
No receiver opens a second View document. A bounded initial admission prevents
concurrent first clicks from creating duplicate pages. Disconnect, cancellation,
service retirement and binding migration reject pending actions; failures after
delivery never trigger an automatic second-page fallback. Multi-output Packs retain Content Browser reveal. Expanded View hides
the resource buttons. Returning the App to inline restores its buttons and retains
its admitted child document until teardown or binding replacement.

Independent cards require different static slots. Repeating the same slot replaces
its current source; more than three simultaneous independent slots are not yet
provided. Supplying several paths produces grouped buttons within one App.
No tool-result URI override or dynamic tool registry is used. Native tests must
distinguish per-card App identity, right-panel activation,
resource selection, collapse/restoration and child-document reuse. Existing-page
action delivery belongs to the MCP adapter; native tab focus remains host-owned. Asking an
already-fullscreen App for fullscreen does not establish a focus operation.

Inline cards keep natural content height, show each source name once, and report
size changes for status, wrapping, errors and return from fullscreen. Their
resource metadata declares `openai/widgetMinFrameHeight: 0` and
`openai/widgetHeightHint: 48`; the installed Codex resource parser passes these
fields to its height owner, replacing the default 200px floor. This is verified
against the current host source, not a portable MCP Apps guarantee. Other View
resources retain their existing height policy. Native visual acceptance remains
separate from resource metadata and carrier tests.

The current host's manual fullscreen component checks the same available mode
used by `requestDisplayMode`. Removing fullscreen would also prevent the first
resource button from opening View. The separate header-hiding metadata path is
restricted to verified Codex Apps identity; local MCP cards do not qualify. The
adapter retains fullscreen without spoofing that identity or patching the host.

The earlier UI-associated tool callback returned without opening its page. The
withdrawn prepared-App/polling experiment is not part of this implementation.
Global deep links and file entrypoints have their own documented surfaces and do
not implement this chat-card interaction. The App SDK's server-tool bridge is not
an arbitrary Codex context or Playwright bridge. Agent browser APIs do not grant
those capabilities to a card.

Official contracts: [UI display modes](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md#display-modes),
[conversation panels](https://developers.openai.com/plugins/build/extensions), and
[MCP Apps display mode requests](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx#display-modes).

### Pack file links

The native plugin declares `.pack.json` and `.pack.ts` file entrypoints named
`ForgeAX View`. They mount the same full View as the chat entry. The host supplies
the opened file's absolute path on app-only transport calls. The adapter finds
its nearest project, selects it through the existing guarded workspace API, and
opens a single Pack output using `asset.open`. Scriptable Pack outputs come from
the running project catalog rather than another source evaluation. Packs with
multiple outputs are revealed in the existing Content Browser for output selection. File activation
does not rebind the chat's working directory or change global View.

Use an ordinary absolute Markdown file link. On first use, select `ForgeAX View`
from the right file pane's Open menu if the host still prefers its default viewer.
The plugin does not provide a separate source viewer or global resource entry.
Repeated activation and document teardown cancel pending opening work. Codex's
native file tabs are identified by host, file path, server, and tool. Different
files therefore open distinct host tabs; the entrypoint metadata does not provide
a page-reuse option. Sharing a backend or UI resource does not merge those tabs.

The file opener observes the existing workspace and project Frame owner services
after the Shell mounts. Presentation handoff waits for that exact Frame to become
ready before inventory or asset operations. A stale `running` backend snapshot
does not prove that its replacement browser is ready. Content Browser cancels
inventory reads when the browser, session, phase or presenter changes; a viewport
that only presents the canvas does not issue a second startup inventory query.
Backend unavailability or startup failure leaves the Shell and its retry action
visible. Waiting for a workspace service is not a required plugin startup child.
Service withdrawal cancels the old file opening; a replacement service resumes
the retained activation with fresh connection identities.

Build Engine, View and the App before generation. The generator resolves `tools/forgeax-mcp/host.app.pack.json` automatically; normal panel opening requires no backend CLI command. The ordinary `host.pack.json` keeps browser presentation. The generated native package contains six domain tools, the chat opening tool `forgeax_view_start`, the global entry `forgeax_view_global_start`, and app-only `forgeax_view_transport`. Each opening resource embeds its own entry scope.

Source checkouts should prepare the ordinary Engine shader profiles before measuring Preview startup:

```sh
node scripts/forgeax/prepare-shader-release-inputs.mjs --build --shared-input-manifest shared-build-inputs/manifest.json
```

This existing producer verifies source/compiler/profile identity and rebuilds missing inputs. Missing profiles otherwise invoke complete source compilation during Preview startup; that cost is separate from MCP resource transfer. Published Engine SDKs already carry the prepared profiles.

| MCP server | Purpose |
|:--|:--|
| `forgeax-tools` | Six public business tools, available to the model |
| `forgeax-view` | Open the `ForgeAX View` panel and deliver its UI resources and Host messages |

Both servers use stdio and the same generated hosting binding. Opening the App first creates a lightweight independent View presentation service and transfers bundled static HTML through MCP. The mounted Shell then requests asynchronous backend preparation, adopts the existing owner when available, and shows the project chooser or current project. Scene and Play use the existing Engine workspace operations. Backend termination retains the static document with an explicit restart action. Server names, package generation and MCP initialization share [one contract](src/contract.ts). The panel resource, opening tool and HTML document share the display name `ForgeAX View`; the opening operation remains `view.start`.

| Boundary | Contract |
|:--|:--|
| Business startup | `forgeax_view_start` opens the static presentation; its App-only `backend-start` invokes the existing View service and public `ensureDevKitView`. Low-level CLI remains `forgeax view start` |
| Platform transport | App-only Host messages, admitted HTTP bytes, module compilation and chunks; no second business registry |
| Codex behavior | `forgeax.view.platform.codex` adds draft references; generic MCP has no OpenAI extension dependency |
| Resource ownership | Child SDK teardown precedes bridge removal. Each App document owns its sockets and compilation cancellation. Closing an App retires only that document; a vanished reader expires after 10 seconds of a responsive broker. Event-loop stalls grant readers another polling interval. Reopening the same resource identity retains its document; a new public View presentation retires the old subtree, including when it reuses a fixed URL. Healthy backend bootstrap is reused instead of restarted on every mount. |
| Performance | One batched 60 Hz event pump, three foreground/one background slots, gzip level 1 with a level 6 retry for 16–48 KiB compressed inline payloads, bounded resource references, shared concurrent reads; 192 KiB chunks with four reads in flight. The bounded retry leaves room for base64 and resource metadata within gzip's 32 KiB history window across supported Node codecs. Remote module compilation shares four source reads across documents, keeping wide import graphs within the loopback connection budget. A reset source GET retries once within its original 30-second deadline and read slot; HTTP failures remain terminal |
| Document preparation | Presentation-owned compilation returns a pending phase immediately; the document owner polls for the completed byte reference under its existing Scene readiness deadline. Polling shares one compilation, at most 32 tasks remain admitted, document disposal releases its task, and presentation replacement cancels all remaining reads. RPC and individual source-read deadlines remain 30 seconds; source failures stay terminal. The App resource version separates this protocol from older cached carriers. |
| Resource reads | Same-turn GET/HEAD fetches use bounded HTTP batches. Each read retains its status, response bytes and cancellation; mutations are not batched. The 256 MiB resource budget bounds both each decoded HTTP response and the retained wire cache; oversized response streams cancel before full buffering. Batch replies reuse the common compressed byte decoder and origin admission. Gzip buffers feed the native transform directly; concurrent read/write handles backpressure and decode rejection without a Blob storage stream |
| Source URLs | The isolated document exposes its logical base through the platform; sandbox origin and browser security policy remain intact |
| Document frames | `FrontendPlatform.createFrame` carries both Preview and Play through MCP. Play owns its disposable handle; Preview placement borrows its retained document. No child navigates localhost. The game retains the sampled platform preparation without inheriting the Preview root |

The generator includes platform-specific installed Vite/TypeScript runtime dependencies and the built UI resources. MCP server code and presentation resources are bundled. Backend startup still requires the built Engine/View installation and App Host Pack recorded in `hosting.json`; generation currently supports this complete local installation layout. Its launcher and Engine/Host binding are local to the generating machine; regenerate after changing Node or moving to another platform. The backend still uses its explicitly built immutable frontend artifact. UI resource URIs carry the package version so an upgrade cannot reuse an older carrier document.

Runtime Pack generation in an isolated document uses the DevKit frontend's
borrowed `PackProgramHost` capability. The adapter compiles only verified program
modules and namespace getters for that document's actual Engine imports; it does
not navigate to an unisolated page or use CacheStorage. Cycles, lazy entry
execution, shared graph state, defaults and live Engine exports have contracts.
The compiler is bounded to 4 MiB of input, and each document retains at most 128
compiled graphs and 64 MiB of module bytes until platform retirement. Source
compilation failures remain structured program failures. Engine Worker runtime
module delivery and top-level await are not qualified by this document adapter.
The document bootstrap captures native dynamic import before remote module rewriting;
network adapters borrow it instead of recursively importing through themselves.
The program host borrows that physical bootstrap loader and reports a missing loader explicitly.
Admitted graphs compile to one native ESM driver: `import.meta.url` identifies its published Blob,
not the compiler's virtual linking base; relative file resources require Engine asset identity or an admitted absolute URL.
Opaque sandboxes use a classic physical Worker bootstrap that imports the logical
ESM entry. The CPU browser contract covers document and Worker data/blob imports.

The MCP game journey reuses the template's real vase-generation probe, including
parameter changes, invalid-input rejection and recovery.

Native coverage is qualified feature by feature. Content Browser, Scene viewport, camera/picking, guide HTML preview, theme and draft transport have focused evidence. Inline type-preview surface placement remains an additional native presentation boundary; API availability alone is not a surface-coverage claim.

```sh
node tools/forgeax-mcp/codex/build-app.mjs
node --test tools/forgeax-mcp/__tests__/app/*.test.mjs
node tools/forgeax-mcp/test/local-plugin.mjs
node tools/forgeax-mcp/test/app-progressive-startup.mjs /absolute/first-game /absolute/second-game /absolute/evidence
node tools/forgeax-mcp/test/app-reopen-lifecycle.mjs /absolute/existing-game /absolute/evidence
node tools/forgeax-mcp/test/app-instance-routing.mjs /absolute/generated-plugin /absolute/first-game /absolute/second-game /absolute/evidence
node tools/forgeax-mcp/test/app-backend-lifetime.mjs /absolute/generated-plugin /absolute/game /absolute/evidence
node tools/forgeax-mcp/test/app-chat-binding.mjs /absolute/generated-plugin /absolute/game /absolute/worktree-game /absolute/evidence
node tools/forgeax-mcp/test/app-browser.mjs "$ENGINE/templates/game-3d" /absolute/path/to/evidence
```

The progressive probe starts with no backend or bound game, holds startup until the static Shell is visible, then checks project selection, two real scenes, isolated Play/Stop, MCP project routing, and retained-document backend restart. Both outer and inner frames retain their restrictive sandbox; project buttons call the owner directly instead of relying on native form submission.

The instance probe requires host-provided `CODEX_THREAD_ID` and uses the recorded public Codex executable to read the actual working directory. It verifies different global/chat H values, project switching, business MCP routing, 60 completed frames and scene pixels in both pages, and closing the global page without retiring the workspace page. It runs before native activation and stops its exact probe-owned backends. Keep the built installation and its source inputs fixed throughout browser acceptance; rebuilding or editing captured inputs invalidates resident source snapshots. Native entry clicks remain a separate acceptance boundary.

The restart probe checks its HTTP result before awaiting a replacement URL,
within the existing 60-second bound. Failed CLI records retain the command,
elapsed time, exit code/signal and redacted stderr. A control failure must not
be hidden by parsing an HTTP error body as JSON or by a later URL timeout.

The browser gate creates its own disposable game-3d copy and backend, exercises the installed stdio package, nested SDK bridges, real Scene and repeated Play rendering (at least 60 completed frames each), Stop during preparation, theme, guide HTML preview and teardown. Its carrier enforces `frame-src 'none'` to reject URL navigation while admitting isolated srcdoc delivery. Its reference-host image is separate from native Codex evidence. It never stops another project's backend.

## Operation names

The public operation ID is shared by API, CLI and MCP. CLI replaces dots with
spaces; MCP prefixes `forgeax_` and replaces dots or kebab-case separators with
underscores. Resource order and action names stay identical. The formatter lives
in [ToolRuntime](../../packages/tool-runtime/README.md#public-operation-names).

| Public operation ID | CLI | MCP tool |
|:--|:--|:--|
| `view.status` | `forgeax view status` | `forgeax_view_status` |
| `asset.inspect` | `forgeax asset inspect` | `forgeax_asset_inspect` |
| `view.workspace.pack.reveal` | `forgeax view workspace pack reveal` | `forgeax_view_workspace_pack_reveal` |
| `engine.asset.inspect` | `forgeax engine asset inspect` | `forgeax_engine_asset_inspect` |
| `engine.scene.tree.get` | `forgeax engine scene tree get` | `forgeax_engine_scene_tree_get` |
| `engine.entity.inspect` | `forgeax engine entity inspect` | `forgeax_engine_entity_inspect` |

Pass `--root "$PROJECT" --json` and the public operation's argument object
through `--input`. Source inspection uses the current `projectId` returned by View status in the installed plugin, plus `subject` on both clients: an absolute
trusted Pack path in MCP, or a project-relative subject in CLI. Both return the
public `assets` list with the same GUID, kind and source-key names. View reveal uses
`projectId`, `sourcePath`, `revision` and optional `connectionId` / `packageId`.
The running backend's public ToolApi projection supplies the direct Engine and
View workspace command entries; no MCP Host Pack is required for CLI discovery.
View's standalone workspace API uses the relative operation `pack.reveal`;
`view.workspace.*` identifies that public owner on ToolApi. Status additionally
projects the public `summary.get` and `pages.list` results into bounded fields.

Status retains the workspace owner's project, phase and targets at the top
level; each connected page retains its own owner facts in `pages`. MCP does not
derive a combined project phase or merge independent page targets into the
workspace owner's target roster. Its projections only select fields and bound
result sizes. Pack child-process isolation, cancellation, local authentication
and schema validation belong to the adapter; Pack evaluation and reveal policy
remain with their public owners.

`forgeax_asset_inspect` runs in a child process with a five second budget. It gives the Pack owner one explicit source root, so an invalid sibling source does not block inspection. A failing or hanging selected source returns a structured failure. The project-wide source index is a bounded Pack owner query used by View.

`forgeax_engine_asset_inspect` requires the project and target identities returned by
status. The Engine owner routes by `targetId` and checks `projectId`, so multiple
View pages cannot make the adapter silently choose one project target.

> [!IMPORTANT]
> Reveal requires project ID, project-relative source path and exact revision. With multiple pages, supply the live `connectionId` from status; omission returns `view-page-ambiguous`. A stale connection returns `view-page-gone`. Neither failure selects a page. A `shown` receipt requires the addressed page to display and select the Pack card.

## Stop or return to the ordinary View Host

```sh
codex mcp remove forgeax-tools
# If installed, remove the generated plugin and its local marketplace too.
codex plugin remove "forgeax-view-codex@${MARKETPLACE_NAME}"
codex plugin marketplace remove "$MARKETPLACE_NAME"
node packages/devkit/dist/cli.mjs backend stop --root "$PROJECT" --json
node packages/devkit/dist/cli.mjs backend start --root "$PROJECT" --host-pack "$ENGINE/tools/view/host.pack.json" --json
```

Changing Host Packs requires an explicit backend restart. Codex disconnect alone leaves View and independent game runs under their existing owners.

## Verification

| Gate | Command or evidence |
|:--|:--|
| Discovery and portable packaging | `node tools/forgeax-mcp/test/mcp-discovery.mjs` and `node tools/forgeax-mcp/test/local-plugin.mjs` |
| Direct API/CLI/MCP operation parity and backend-free discovery | `node tools/forgeax-mcp/__tests__/operation-cli.test.mjs` |
| Public owner API routing | `node tools/forgeax-mcp/test/public-contract.mjs` |
| Live six-tool transport | `node tools/forgeax-mcp/test/mcp-smoke.mjs "$PROJECT" /absolute/path/to/a/source.pack.json` |
| Pack API/CLI parity with a malformed sibling and disconnect | `node tools/forgeax-mcp/test/pack-partial.mjs` and `node tools/forgeax-mcp/test/bridge-disconnect.mjs` |
| Visible exact-page reveal | `node tools/forgeax-mcp/test/reveal-browser.mjs "$PROJECT" "$VIEW_URL" /absolute/path/to/a/source.pack.json` |
| Stopped backend | After stopping Host, `node tools/forgeax-mcp/test/mcp-stopped.mjs "$PROJECT"` |

The full headed-page matrix uses a trusted fixture with `assets/scene.pack.json`, a real Scene and Mesh in its Catalog, and two independent ready runs. Save each `engine run start --headless --json` result in a separate file, then run:

```sh
FORGEAX_ISOLATION_RUN_A=/absolute/path/to/run-a.json \
FORGEAX_ISOLATION_RUN_B=/absolute/path/to/run-b.json \
node tools/forgeax-mcp/test/page-isolation-browser.mjs "$PROJECT" "$VIEW_URL" /absolute/path/to/evidence
```

The matrix opens the same View entry twice, checks distinct targets, resource opens, scene selection, selected tabs, actual workspace/Display subscriptions, two run bindings, directed reveal, and refresh retirement. It uses the real page's authenticated WebSocket; captured receipts omit tokens and iframe URLs. Set `FORGEAX_BROWSER_EXECUTABLE` to a local Chrome executable if necessary. All Chromium probes set `chromiumSandbox: true` as the final launch option so the repository sandbox contract rejects any later override. Entry startup has a separate bounded setup wait; mounted UI and running-state assertions retain sixty-second bounds.

Desktop validation must call tools injected into the Desktop session and inspect the real in-app browser. Portable-package and CLI success do not prove current-chat tool injection. Regenerate the plugin and open a fresh session when tool schemas change.
