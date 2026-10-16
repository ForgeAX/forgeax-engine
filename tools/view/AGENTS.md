# ForgeaX View

View is an optional project editor and read-only observer of Engine AI runs.
AI is the primary user. Engine owns execution in a separate browser, normally
headless, with fixed project inputs. View owns its browser resources, workspace
API clients, frontend plugins and presentation. AI Display never hosts the game.

Engine's explicit `backend start` owns the resident BackendHost and domain
plugins. The native View host plugin serves an optional UI; `view start` only
connects to that backend and returns a URL. `view project open` allocates an
editor project on that running View and returns the headed document URL; it
does not launch a browser or switch an already-open different project. Users
open their browser separately. `view start` does not open a project. Neither
command installs a browser, creates a renderer or runs
a game. The library path borrows its caller's Page. Engine contains no View
activation, package imports, credentials or presentation policy.

View `start` and `status` expose the owner-derived `presentationId`. A fixed URL
can survive replacement of its native admission lease; URL equality alone does
not establish presentation lifetime. Embedded consumers retain unchanged
resources and retire an old document before admitting its replacement.

## Architecture consensus

> Keep the host thin and behavior in plugins. Prefer removing a concept over
> introducing another registry, lifecycle, or source of truth.

Read the dated decisions below newest first. A newer decision supersedes older
statements on the same boundary; unchanged constraints still apply. Proposed
behavior and experiments are not implementation evidence. Check the installed
Engine package exports/README and the matching implementation evidence before
changing a runtime boundary. The north star
is an index to these decisions, not a competing contract.

| Decision, newest first | Current authority |
| 2026-10-16 Engine operation history | Engine CLI/SDK command receipts and verified PNG artifacts persist without View. The optional native History frontend reads the accepted project's bounded public history APIs; it never replays operations, mirrors command state or starts a game. Runtime observation remains separate. |
| 2026-10-16 View presentation API | `view.workspace.presentation.*` reads committed Shell/PageHost and native Dock/drawer facts and invokes the same page actions as the UI. Backend routes finite request/reply lifetimes to one authenticated document and joins its bounded workspace summary; it retains no UI mirror. Runtime `tabs.get/select` bindings remain separate. |
| 2026-10-12 unified frontend platform | Browser default and optional MCP/Codex producers share one View mount; native platform Fibers own reversible realm behavior and retain public Engine/Host authority |
| 2026-10-12 public operation names | Domain IDs derive CLI/MCP names; authenticated backend CLI submits ordinary flat arguments through the workspace provider. Naming design: View Harness PR #20 |
|:--|:--|
| [2026-10-15 resident asset references](docs/2026-10-15-view-resident-asset-references-design.md) | A View-owned coordinator installs one optional native read-only query plugin in the ordinary Editor through existing Runtime Pack operations. Same-document ToolApi calls read actual held resources and Registry identities; UI panels/core never read World. Direct references and effective material slots support Scene Tree, Inspector and existing resource fields. Scene Tree shortcuts require one declared, resolved primary; no Related Assets or candidate submenus are shown. Read-only asset names never navigate; separate folder and ExternalLink buttons browse or open the Asset Viewer. Unsupported controls remain disabled. Runtime Content excludes the exact owned package ID/native UID from user controls and saved content; raw Engine queries remain complete. New-page menus use registered type labels while open tabs use asset names. PageType presentation selects preview or generic details; details opens create no hidden preview. Target/browser/World ownership and native cleanup remain explicit; Engine/game code and independent runs are unchanged. Supersedes the mesh-only limitation in the [original navigation design](docs/2026-10-13-view-scene-mesh-asset-navigation-design.md). |
| [2026-10-15 complete component overview and grouped Details](docs/2026-10-13-view-inspector-component-tree-design.md) | Every scene entity shares the read-only object header and a bounded overview of all returned ECS components, including entity-level data and transient markers. Each raw component has its own row; MeshFilter/MeshRenderer remain separate. Clicking a row clears search, opens All, expands and scrolls to that component without filtering other data or changing scene selection. The card geometry and independent scroll regions remain. Supersedes the 2026-10-13 entity-root/function tree and component filtering. Platform clipboard/visibility ownership and shared controls remain; the primary-type classifier stays in workspace-core and sibling feature dependencies stay forbidden. Engine remains unchanged and resource pages retain independent ownership. |
| [2026-10-12 all scene entity Details](docs/2026-10-12-view-entity-inspector-design.md) | All scene entities use grouped read-only details. Common shows the current entity's local transform and primary capability, with exactly Transform/Static Mesh/Materials for ordinary meshes. Its Inspector-local relationship tree and Scene-owned classifier are superseded by the 2026-10-13 component projection and workspace-core classifier. Engine remains unchanged; resource pages and missing identity/default-material facts retain their existing boundaries. |
| 2026-10-09 `dev:ui` Fixture Host | UI development uses the ordinary Viewer against a private same-repository Fixture Host. The Host, WebSocket transport, workspace broker and frontend plugins remain production code; only the Engine workspace provider supplies deterministic fixture data. Product source contains no mock data, demo props or fallback mount path. |
| 2026-09-24 runtime content | Content Browser consumes Engine runtime Pack tools on the exact project App. UI drafts and snapshots carry no execution ownership; independent run bindings stay read-only. Local validation is complete; paired PR checks cover the integrated commits. |
| [2026-10-11 independent View sessions](docs/2026-10-11-independent-view-session-design.md) | Fresh documents open independent ordinary Engine runtimes; headed reload retains its session. Broker and Display route by admitted connection; Pack receipts recheck the live project/source at acknowledgment |
| 2026-09-23 package host composition | Explicit `backend start --host-pack` selects View's packaged PluginAsset without adding a View asset to the game. The View Fiber owns its backend children and ToolApi commands; the host projects one frontend root per connection. Supersedes project-owned View host selection in the Engine 0.2 decision |
| 2026-09-23 Engine 0.2 PluginAssets | Native PluginAsset and Cordis lifecycle; its project-owned View host selection is superseded by package host composition |
| 2026-09-23 Editor surface placement | View borrows the exact same-document Editor surface into its exclusive viewport and restores it on unload. Engine keeps runtime/canvas ownership. Supersedes the absolute no-relocation rule; asset tabs and iframe documents retain their separate ownership |
| 2026-09-22 simple project entry and refresh | Known project intent opens directly from the returned URL. Refresh uses the resident View entry for exact lost-target recovery and starts a fresh Editor without replaying editing history; the 2026-09-23 Engine 0.2 design supersedes its direct refresh route |
| 2026-09-22 workspace experience | Per-URL project intent, exact-target Editor recovery and submitted-frame picking; View owns navigation policy, Engine executes semantic motion and camera transactions; verification status lives in the design |
| 2026-09-21 asset editor pages | Plugin-declared PageType resource selectors route scenes to the existing Editor and other assets to singleton asset tabs with a dedicated preview host per tab. `asset.open` is observable; asset tabs never borrow the Editor canvas. Missing type-preview targets fail closed. Supersedes the 2026-09-13 single-preview replacement rule |
| 2026-09-20 startup boundaries | Explicit backend, optional UI, independent Shell readiness and exact observation binding |
| 2026-09-20 editor tools | Inline editing/assets, isolated Editor Play, shared Engine tool plugins; implemented scope and acceptance are recorded in the linked dogfood report |
| 2026-09-19 independent AI run | Fixed run inputs, separate browser, read-only View observation; supersedes default AI iframe/carrier execution |
| 2026-09-19 Engine authority | Engine domain tools survive UI removal; plugins provide only the endpoints they implement |
| 2026-09-17 plugin contributions | Declared package contributions; older launch/carrier proposals defer to the decisions above |
| 2026-09-15 single BackendHost | One backend assembly per workspace host, not a global process singleton |
| 2026-09-13 project/assets and plugin inspection | UI and CLI consume Engine operations and exact project/target identities. Asset Tab replacement is superseded by the 2026-09-21 plugin page design |
| 2026-09-12 Host/Plugin | Static Catalog, backend-authoritative HostAssembly, Cordis lifecycle |

| Boundary | Working consensus |
|:--|:--|
| Operation history | `forgeax.view.page.history.frontend` owns timeline, pagination, details and saved-image choice. Engine owns durable invocation receipts and artifact digests. `view.workspace.history.*` delegates to `engine.history.*` with the accepted project root. Hidden pages cancel reads; new records do not switch the active tab. Frontend uses Engine owner types through type-only imports. |
| Project and run | Engine observes authored files. An AI run owns frozen project and dependency inputs; Editor changes do not update that run. The Engine run service owns lifecycle, capture and errors; CLI submits requests |
| AI Display | Runtime capture selects this document's Editor Play or a read-only independent Engine run. The UI derives project root from the accepted workspace; `view.display.bind` can discover the current run once through `engine.run.observe`, then pins exact `{root, runId}`. Explicit API/CLI identities remain supported independently of Editor. Never follow a replacement run automatically. Preserve only the last accepted image on run retirement and mark it; a new binding clears it. Logs/identity are folded details. Hidden Play capture pages stop sampling; tabs, input, focus, resize, refresh, UI removal and View stop never control independent runs. Design: 2026-10-16 context-derived capture |
| Editor | A separate headed Engine workspace target owns App/World/Renderer, assets and camera. View owns key/button mapping, sensitivity, speed curves and pitch-limit preferences, and submits semantic camera motion through public APIs. Engine integrates motion and owns complete camera transactions and target-local orbit pivots; generic observation keeps its independent policy. Preview calls carry `targetId` and `targetGeneration` |
| Entity inspector | All scene entities share one read-only container with a bounded, independently scrolling overview of every returned ECS component. Raw rows are separate and include entity-level data and transient markers. Clicking a row opens All and scrolls the independent Details region to that component; categories restore their complete entity-level groups. These actions never change scene selection. View invents no component attachment or child-entity edges; Scene Tree owns parentId navigation and paginated structural reads. Workspace-core's pure component-name helper supplies the primary type to Scene Tree and Inspector; capabilities remain additive in Common/Object/Rendering/Physics/Animation/Media/Effects/Behavior/All. Schema defines enums, colors, vectors and collections; array length alone is not a vector type. View selection may retain multiple entity IDs, but Engine inspection/highlight/focus still addresses only the validated primary. Entity inspection remains exact-target and synchronously cancelled. Resource navigation requires an explicitly returned GUID; World handles, material defaults and binding versions are never inferred. Engine code/API remain unchanged; resource pages remain independent, and mesh tabs use the opened asset name. |
| Host and plugins | Engine domain plugins precede the selected View PluginAsset on the same BackendHost. `backend start --host-pack` selects View's package Pack independently of the game project; Engine resolves its module and native Cordis Fiber. View owns its backend child Fibers and a per-connection frontend root projection. Browser FrontendHost activates that root. The frontend root starts Shell and service pages before App bootstrap; the resident View entry can activate while a cold project opens. A healthy headed reload reactivates the same project/session/target after Engine retires old browser resources; known terminal failures use guarded exact-target recovery. Panels that borrow `engineWorkspacePresentation` start only when Engine publishes that exact service, so no pending presentation Fiber blocks native root activation. A changed root revision requires a fresh frontend environment; child removal and restoration use Cordis ownership, not in-place HostAssembly replacement. View disposal revokes its children, tools, connections and projection without updating the Host assembly. A UI-only plugin has no empty backend/API/CLI counterpart |
| State and presentation | Shell brand, document tabs and preferences share one navigation row. Theme preference defaults to system, resolved from host appearance when supplied and OS otherwise; explicit light/dark overrides it. Content Browser generates asset references from the accepted catalog and project snapshot; an optional platform conversation capability appends them to the host draft without submitting. View keeps bindings, selection and presentation snapshots. `view-workspace-core` stays React-free and owns no UI; `view-components` stays workspace-agnostic. Product plugins own their React panels and compose the two foundations. No duplicate project watcher, asset registry, scene graph, camera ledger or runtime. Engine owns catalog source locators and configured project assetRoots. Content Browser projects only sources inside those directories, including Pack and HTML inventory; external and generated sources remain in the Engine catalog for other consumers. View has no directory-name default or parallel asset-root configuration. Every asset-preview panel owns its DOM container and hosts its dedicated Engine type-preview surface through the public `createSurface` contract. Engine owns the canvas; View borrows the exact Editor surface into its exclusive viewport, never cloning or sharing it across asset tabs. Bound preview properties consume the Engine owner's `assetBinding` snapshot and retain its publication identity. Authored asset properties consume `asset.inspect`; kind facts come from that inspection's identity and meta, not extra inspect operations. Render actual Engine data; report missing capabilities explicitly; sample data belongs only to the explicit UI demo |
| Ownership and failure | Creators dispose resources; borrowers do not. UI unload preserves domain calls. Healthy browser refresh keeps the project/session/target and advances browserGeneration only after Engine retires old previews and Play. View restores borrowed canvas placement before removing its container, retains the existing Play iframe and its native frame scheduling until cleanup acknowledgment (unselected Play is transparent and ignores pointer input), and never creates a retiring Play in a replacement browser. The Editor preview stays hidden while an adopted Play is starting, including after Stop revokes Game observations; it resumes only when that Play becomes ready or retires. Known terminal failure uses the resident entry to request a new Editor only after Engine validates the exact lost target. Never replay writes, input or Play. Independent runs are unaffected |

The optional embedding helper `startView()` creates one BackendHost when none is supplied; its generated
browser document creates the paired frontend host. Supplied `backendHost` and
`frontendHost` are borrowed. Node FrontendHost requires explicit `frontend: true`.
The default CLI does not call that embedding helper. `view start` adds per-URL
browser intent from explicit `--project`, or from a backend root containing
`forge.json`, never a global backend project slot or immediate target.
The workspace frontend plugin owns the resident frontend-authenticated API connection
and confirmed project intent; embedding without that endpoint borrows its transport.
Refresh transfers the exact lost project through the resident View entry and starts with default pages,
selection and camera, not historical resource tabs, layout or Play. Saved files and
theme/language remain. The departing document must not bootstrap a new renderer.
An explicit `view project open`
allocates the editor project through the running View owner, never a global
backend project slot; the browser document adopts the returned headed URL.
An independent entry document consumes only the confirmed project intent and opens its own Engine session through the trusted caller resolver; it never navigates to another live document's target URL. Healthy reload retains its exact session. The per-connection Broker owns page selection/resource opens, Display owns per-connection bindings, and Pack receipts revalidate the live page/project/source revision. React consumers share its projection. Shell mounting needs no
canvas; only the viewport surface waits for Engine presentation. A confirmed
project gates pages declared with `context: 'project'`, including Runtime capture; the required
project dialog appears when neither a remote open nor tab recovery supplies one;
it is modeless so artifact pages and workspace navigation remain accessible;
opening a project never starts or rebinds an independent Engine run. Startup, project
opening, browser attachment and run observation are separate operations.
The workspace frontend composition owns the existing Play presentation Fiber;
viewport panels borrow its placement, so panel removal preserves the game document.
Bootstrap only constructs the host and platform; new behavior belongs in plugins.
Workspace document navigation belongs to its explicit `workspace/document-navigation`
module, not the Engine Host platform module.
Ordinary game platforms omit it, including their retained program namespaces;
Play continues to load its Engine-owned URL through the existing iframe handle.

Every capability has a native Cordis owner: declare dependencies with
`inject`/`provide`, register contributions and their inverses through `effect`,
and revoke them with the owning Fiber, including optional diagnostic observers
and animation callbacks. Prefer existing plugins; API/CLI and UI
are consumers of the same domain implementation. Pure helpers, ECS queries and
frame execution stay on their direct data paths. Hidden panel observations release active read leases and preserve UI state. Controlled asset previews yield
continuous rendering when hidden; their Engine plugin preserves queries and
explicit capture. Game execution never adopts this presentation policy.

The resident View workspace registers `view.workspace.*` ToolApi operations
under its native backend Fiber. Public operation IDs determine CLI paths and MCP names. The authenticated Engine backend CLI can submit a flat operation argument object; the workspace adapter creates the ordinary request and applies the same owner authorization. Frontend callers retain the explicit workspace envelope. Its frontend transport and Engine CLI workspace
call enter that provider, which invokes the same View workspace owner before
delegating domain work to Engine. The older `forgeax-view workspace` transport
client remains available; its wire service routes through this provider on a
running View. This does not change project-root plugin discovery or startup.

Standalone HTML file pages use a PageHost file request and project-scoped file
service. Their sandboxed DOM preview and viewport controls belong to the HTML
View plugin and never borrow an Engine canvas or synthesize an asset GUID.
Editing and asset previews adopt exact Engine surfaces; missing adapters never
trigger a URL-to-iframe fallback. Each asset editor tab hosts a dedicated
shell-placed Engine type-preview surface in its own container, or fails closed;
it never borrows the Editor viewport owner canvas. The Editor viewport may place
its exact same-document surface in normal DOM flow, restoring its original parent,
sibling position and presentation attributes before panel disposal. Target/generation
checks do not depend on placement mode. Only the Engine-created Editor Play target gets
a new document through `FrontendPlatform.createFrame`; its connection-owned
presentation Fiber disposes the handle after Engine cleanup. Viewport panels only
borrow placement. The browser producer navigates normally; the MCP producer
delivers isolated source bytes without navigating loopback. AI Display never loads the AI execution URL. Browser configuration uses ordinary browsers with no implicit View startup or duplicate game. An explicitly selected MCP Apps producer may host the same View in isolated documents; its native platform owns byte delivery and presentation, with no Codex branch in domain owners. The explicit borrowed-carrier library
seam retains its broker authority for independent embedding consumers; it needs
the real caller-owned Page in process and is not the AI run path. Cleanup must
preserve borrowed Page/browser resources and must not navigate a user's new page.

The `forgeax-view` binary is a thin workspace API client using an explicit
endpoint/token and the same operations as the frontend. Independent AI control
uses Engine CLI and its authorization. An endpoint or URL cannot supply a Page.
The View host resolves its static UI from the selected View package's
`@forgeax/view/plugin` entry; an Engine loader chunk URL is not a static
resource root. Game PluginAssets run in Engine's Worker and cannot use browser
DOM or the frontend App handle. Their UI PluginAssets own frontend behavior.

### Choosing the Engine / View boundary

Choose the authoritative owner, not the easiest place to patch. Minimize new
concepts and duplicated authority, not Engine changed-line counts. Keeping all
changes in View is not an improvement if it duplicates Engine state or weakens
execution guarantees; moving UI policy into Engine is not an improvement merely
because several panels need it.

| Concern | Placement and review rule |
|:--|:--|
| Interaction and presentation policy | View product plugins own bindings, sensitivity, speed/pitch preferences, layout, URL intent, retry policy and restoration choices. Submit semantic operations through Engine public APIs; do not redefine general Engine defaults |
| Execution correctness and resource lifetime | The owning Engine domain plugin/target enforces submitted-frame truth, camera transactions, exact identity, atomic replacement and resource cleanup. Keep these guarantees available without View; do not recreate a World, camera ledger or lifecycle authority in the frontend |
| Missing reusable mechanism | First reproduce the gap in the existing public contract. Prefer an existing domain plugin; change Engine core only for a minimal domain-neutral seam with a named consuming plugin and evidence that existing APIs cannot express the required behavior |

For each Engine change, explain why View cannot correctly implement it through
the existing contract, why that Engine owner is appropriate, and what remains
View policy. Verify the consuming plugin present, absent/removed, and restored;
preserve borrowed resources and unrelated game/observer behavior. Read the
installed package contract and reproduce the relevant runtime path before
changing its boundary; mocks alone do not establish browser/GPU correctness.
Do not spread Editor/Play branches through App, Host, generated startup code or
panels, or add parallel registries and health probes when the owner already
exposes the required fact. Document justified Engine changes instead of hiding
them behind View workarounds or a smaller diff.

Viewport clicks are View selection intents, not Engine-generated selection
events. View calls the existing Engine `target.pick` operation through its
`scene.pick` selection workflow; tree selection, picking and clearing share
one cancellation owner and exact target/generation guard. Engine returns query
facts or request failures and never changes the selected View target. Keep
business-specific event forwarding out of workspace transport providers.
Bind input to the borrowed Engine surface and the active View page explicitly;
do not require the owner canvas to be a descendant of the Dock.
Panel queries belong to their observed binding/selection, not React's delayed
cleanup. Revoke old requests synchronously when the workspace projection changes.
Reconcile actual Engine bindings before forwarding operation failures, including
while target disposal is pending. Do not suppress error codes globally: failures
on still-current targets remain visible, and commands are never replayed.

**Architecture changes must update this consensus and the owning dated design
in the same delivery, including supersession links and implementation evidence.**
Keep code, package contracts and this quick reference aligned; replace obsolete
statements instead of appending a second rule. Commit designs to View Harness
and link the corresponding product/documentation PRs.

## Source language contract

Product modules in `src/` and `packages/*/src/` use `.ts` or `.tsx` (JSX).
Node build scripts and tests stay `.mjs`; published executable modules are compiled
`.mjs`. Run `pnpm check:packages` for the complete strict source gate. Use only
erasable TypeScript syntax so source tests on Engine's pinned Node version keep
the actual execution path.
Shared View contracts belong to workspace-core. It may reuse public Engine App
owner types through `import type`; Engine domain runtime imports remain forbidden.
Type-only edges retain dependency direction checks and disappear from runtime
Host/catalog closure checks. Do not copy owner types or suppress strict errors.

## Working rules

- Never switch the primary checkout's branch. Use `.worktrees/` for branch work;
  preserve unrelated changes in both repositories.
- For View startup or local Engine binding, use [forgeax-view-start](skills/forgeax-view-start/SKILL.md); keep it aligned with the README startup contract.
- For View actions and demonstrations, use [forgeax-view-cli](skills/forgeax-view-cli/SKILL.md); it defines API/CLI priority, public prefixes and exact-target discovery. Browser tools verify presentation and interaction.
- Workflow selection is opt-in; ordinary work uses direct edits and relevant
  checks. Read installed skills when using their workflows.
- Before changing a runtime boundary, read its Engine package contract and
  reproduce the relevant path. Keep browser/GPU evidence distinct from mocks.
- Keep code and product-facing documentation in English. Design and knowledge
  prose may use Chinese. `CLAUDE.md` only includes this file.
- Architecture gate: `pnpm check:architecture` checks source and manifest
  boundaries independently of the required CI build. The final `bootstrap` gate
  requires architecture, build and all four browser shards to succeed before
  delivery. Keep its rejecting counterexamples current;
  never add broad suppressions to make a feature pass. Host/core/bootstrap
  changes need the public-seam and plugin-absent evidence above, using the
  [PR checklist](.github/pull_request_template.md). See the
  [gate's scope and limits](README.md#architecture-gate).
- Bootstrap checks: `pnpm test`, Harness `--verify`, KB lint, and `git diff --check`.
  Future runtime work must add real integration checks for its changed behavior.
- Do not claim a functional View, compatible GPU backend, or passing CI from
  bootstrap checks alone. Report the actual artifact and verification boundary.
- When changing public React components, overlay utilities, or token-driven
  styles under `packages/view-components/` (for example `components.tsx` or
  placement helpers), update Storybook in the same change: add or adjust
  `*.stories.tsx`, keep autodocs descriptions accurate, and align
  `.storybook/preview.tsx` story order when new top-level stories are added.
  Do not add partial component API writeups to `packages/view-components/README.md`;
  that file stays package-level and normative (styles entry, token workflow,
  Storybook commands). Update it only when those package contracts change. Verify
  with `pnpm --filter @forgeax/view-components check` and, when stories change,
  `pnpm build:storybook` from the repository root if Storybook is part of the
  delivery boundary.
