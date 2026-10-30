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
The selected View package must provide both public page operations. An older
View checkout will return an owner or operation failure; the adapter does not
fall back to private Broker access.

## Dependency floors

The MCP SDK accepts `@hono/node-server` 2.x. Both workspace package-manager
policies require 2.1.3 or later in that major to prevent static middleware from
decoding a routed path a second time
([GHSA-rmxm-3fg6-px4f](https://github.com/advisories/GHSA-rmxm-3fg6-px4f)).
The real HTTP regression retains public encoded filenames and protected routes
while rejecting malformed paths that could bypass prefix middleware.

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

Simulation evidence must record the carrier's `srcdoc`, sandbox and CSP conditions.
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

Generate a self-contained [portable plugin](https://developers.openai.com/plugins/build/plugins) and marketplace for one exact project root. Choose a **new** output directory; the generator refuses to overwrite an existing package.

```sh
PLUGIN_MARKETPLACE_ROOT=/absolute/new/forgeax-view-marketplace
PLUGIN_META=$(node "$ENGINE/tools/forgeax-mcp/codex/create-local-plugin.mjs" "$PROJECT" "$PLUGIN_MARKETPLACE_ROOT")
MARKETPLACE_NAME=$(printf '%s' "$PLUGIN_META" | jq -r .marketplaceName)
codex plugin marketplace add "$PLUGIN_MARKETPLACE_ROOT"
codex plugin add "forgeax-view-codex@$MARKETPLACE_NAME"
```

The generated `plugin.json` and `mcp.json` live beside the bundled stdio servers. On macOS and Linux, the package includes a launcher pinned to the Node executable used during generation, so Desktop does not depend on the terminal's `PATH`; regenerate and reinstall after replacing that Node installation. The installed copy remains bound to the project root supplied at generation time. Restart Codex Desktop after adding the local marketplace, then use a new Desktop session to discover its tools. Remove the direct MCP probe before installing the plugin to avoid duplicate tools.

> [!IMPORTANT]
> Pack inspection can execute trusted author code and Pack reveal changes page selection. Their MCP annotations therefore do not claim read-only behavior. Codex permission policy decides admission before Host execution; a denied call is separate from a Host failure.

## Optional native View App

Build the App, then select `tools/forgeax-mcp/host.app.pack.json` when explicitly starting the backend. The ordinary `host.pack.json` keeps browser presentation. Generate the Codex package with the same generator above: it contains the six domain tools and an App server with `forgeax_view_start` plus app-only `forgeax_view_transport`.

Source checkouts should prepare the ordinary Engine shader profiles before measuring Preview startup:

```sh
node scripts/forgeax/prepare-shader-release-inputs.mjs --build --shared-input-manifest shared-build-inputs/manifest.json
```

This existing producer verifies source/compiler/profile identity and rebuilds missing inputs. Missing profiles otherwise invoke complete source compilation during Preview startup; that cost is separate from MCP resource transfer. Published Engine SDKs already carry the prepared profiles.

| MCP server | Purpose |
|:--|:--|
| `forgeax-tools` | Six public business tools, available to the model |
| `forgeax-view` | Open the `ForgeAX View` panel and deliver its UI resources and Host messages |

Both servers use stdio and connect to the same selected backend. Server names, package generation and MCP initialization share [one contract](src/contract.ts). The panel resource, opening tool and HTML document share the display name `ForgeAX View`; the opening operation remains `view.start`.

| Boundary | Contract |
|:--|:--|
| Business startup | `forgeax_view_start` invokes public `view.start`; CLI remains `forgeax view start` |
| Platform transport | App-only Host messages, admitted HTTP bytes, module compilation and chunks; no second business registry |
| Codex behavior | `forgeax.view.platform.codex` adds draft references; generic MCP has no OpenAI extension dependency |
| Resource ownership | Child SDK teardown precedes bridge removal; pending and admitted sockets retire with their owner. Reopening the same resource identity retains its document; a new public View presentation retires the old subtree, including when it reuses a fixed URL |
| Performance | One batched 60 Hz event pump, three foreground/one background slots, gzip level 1, bounded resource references, shared concurrent reads; 192 KiB chunks with four reads in flight. Remote module compilation shares four source reads across documents, keeping wide import graphs within the loopback connection budget. A reset source GET retries once within its original 30-second deadline and read slot; HTTP failures remain terminal |
| Document preparation | Presentation-owned compilation returns a pending phase immediately; the document owner polls for the completed byte reference under its existing Scene readiness deadline. Polling shares one compilation, at most 32 tasks remain admitted, document disposal releases its task, and presentation replacement cancels all remaining reads. RPC and individual source-read deadlines remain 30 seconds; source failures stay terminal. The App resource version separates this protocol from older cached carriers. |
| Resource reads | Same-turn GET/HEAD fetches use bounded HTTP batches. Each read retains its status, response bytes and cancellation; mutations are not batched. The 256 MiB resource budget bounds both each decoded HTTP response and the retained wire cache; oversized response streams cancel before full buffering. Batch replies reuse the common compressed byte decoder and origin admission. Gzip buffers feed the native transform directly; concurrent read/write handles backpressure and decode rejection without a Blob storage stream |
| Source URLs | The isolated document exposes its logical base through the platform; sandbox origin and browser security policy remain intact |
| Document frames | `FrontendPlatform.createFrame` carries both Preview and Play through MCP. Play owns its disposable handle; Preview placement borrows its retained document. No child navigates localhost. The game retains the sampled platform preparation without inheriting the Preview root |

The generator includes platform-specific installed Vite/TypeScript runtime dependencies and the built UI resources. It does not depend on the source checkout for its MCP server. Its launcher and project binding are local to the generating machine; regenerate after changing Node or moving to another platform. The backend still uses its explicitly built immutable frontend artifact. UI resource URIs carry the package version so an upgrade cannot reuse an older carrier document.

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
Opaque sandboxes use a classic physical Worker bootstrap that imports the logical
ESM entry. The CPU browser contract covers document and Worker data/blob imports.

The MCP game journey reuses the template's real vase-generation probe, including
parameter changes, invalid-input rejection and recovery.

Native coverage is qualified feature by feature. Content Browser, Scene viewport, camera/picking, guide HTML preview, theme and draft transport have focused evidence. Inline type-preview surface placement remains an additional native presentation boundary; API availability alone is not a surface-coverage claim.

```sh
node tools/forgeax-mcp/codex/build-app.mjs
node --test tools/forgeax-mcp/__tests__/app/*.test.mjs
node tools/forgeax-mcp/test/local-plugin.mjs
node tools/forgeax-mcp/test/app-browser.mjs "$ENGINE/templates/game-3d" /absolute/path/to/evidence
```

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
through `--input`. Source inspection uses `subject` on both clients: an absolute
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
