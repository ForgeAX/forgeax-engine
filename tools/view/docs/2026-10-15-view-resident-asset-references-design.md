# Resident Asset References and Navigation

## Decision

View supplies one optional native read-only query PluginAsset to each ordinary
Scene App through the existing Runtime Pack and Cordis lifecycle. Its frontend
coordinator lives with the View root, independently of Scene Tree, Inspector,
selection, panel visibility and resource tabs. App readiness starts installation;
there is no frame callback, continuous query, extra socket, or scene/asset registry.

This supersedes the mesh-only explicit-GUID limitation in
[the original navigation design](2026-10-13-view-scene-mesh-asset-navigation-design.md).
Engine's builtin `entity.inspect` still returns raw World handles. Engine code,
game source and authored asset bindings are unchanged. The new code is packaged
by View but executes as a native plugin beside the actual World, not in React
panels or workspace-core. Project closing and Engine connection teardown retain
their existing authority. Play, resource-preview Apps and independent runs never
receive an automatic installation.

The existing public Engine contracts provide `runtime-pack.inspect`, `prepare`,
`admit`, `plugin-install`, `plugin-inspect`, `plugin-dispose` and `withdraw`.
A static source contains only the tooling plugin, so no game resource generator
is needed. Installation adds temporary runtime tooling definitions and a Fiber;
the query itself writes no ECS field, component, resource binding or game state.

## Ownership and query

`@forgeax/view-plugin-asset-references` owns the coordinator and native query.
Workspace-core exports serializable scope/result types and the frontend service
contract, without Engine domain runtime imports. Existing native ToolApi carries
`view.asset-references.get` in the same-document Scene root. Discovery and calls
select the exact provider ID and owner generation, not an arbitrary matching
operation. No workspace API or independent-run eval operation is added.

The scope includes project, target, known target generation, World identity and
browser generation. Engine target inspection validates the opaque entity
reference; the native query then reads schema-declared `shared<T>` references,
reference arrays and explicit AssetRef fields from that same live entity.
Unique state references, entity arrays and arbitrary strings are excluded.

For user-tier references the query borrows the base SharedRef payload and asks
the actual AssetRegistry `guidOf` for its registered identity. It does not use
a rendering projection or allocate/load resources. This preserves provenance
when a handle holds an old payload after a Catalog replacement. Engine's
registered identity does not promise the original authoring alias or binding
publication/version. Builtins, stale handles and uncatalogued runtime payloads
remain explicit unavailable states.

Material overrides are resolved independently. A zero/absent override consults
the material slots of the held mesh, with slot names and explicit default GUIDs.
An undeclared default is reported as Engine default without inventing an asset.
Reads are bounded to 128 entries per collection and 256 total references, with
an explicit incomplete-result marker. Raw entity inspection remains untouched.

Installing calls are shared within the current scope. Selection/panel changes
do not uninstall. Scope replacement synchronously cancels query consumers.
Cleanup addresses only this connection's installed UID and owned package;
it never uses `runtime-pack.release`. A dead/replaced World is left to its
Engine owner. A removed/failed provider can be restored by the next explicit
query, without a polling/retry loop. Cleanup checks actual native installations.

The TypeScript query is the sole program source. A shared Vite/esbuild transform
compiles it into the frontend's Runtime Pack source snapshot; admitted native
imports retain their Engine identities. No project-relative source import or
hand-maintained string copy is used. The source-only entry fails explicitly if
used without the build transform, but is evaluated only for an actual Scene
installation and cannot block an otherwise independent Shell.

## UI policy

Scene Tree handles any entity with direct asset references. A unique semantic
primary (mesh, scene source, audio clip, effect or terrain) gets two direct
commands. Without exactly one declared, resolved primary reference, both
commands are disabled and direct users to the Inspector reference fields.
An unresolved primary is not ignored when checking ambiguity, and a lone
secondary reference never substitutes for the primary. Related Assets and
candidate submenus are removed; other references remain in their exact fields.
Multiple selection
continues to address the validated primary entity and names that subject.
Neither browsing nor opening an unrelated resource changes scene selection.

Inspector enriches only its current observation with the returned references.
Fields, collections and material slots retain original raw copy values. Shared
AssetReferenceField controls get read-only Open/Browse callbacks. Names retain
their field borders and decorative dropdown arrow but never navigate on click,
double-click or keyboard confirmation. The folder button locates the exact
asset; a separate ExternalLink button opens its asset viewer. Missing identity,
missing assets and unavailable viewers disable the open button with a reason.
Unsupported controls remain visible but disabled; consumers never receive
replace, clear or use-selection writes. Resource pages pass the same
actions only to explicit GUID fields matched in the current Catalog. Resource
dependencies and child entities are not recursively added to the entity menu.

PageType declares preview/details presentation. The existing page registry
reports the current mode, so a removed dedicated page routes through the
registered fallback. View's existing `asset.open` operation accepts an optional
`detailsOnly` presentation request. Such requests use `asset.inspect`, publish
an ordinary resource open, and create no hidden Engine preview. Unsupported
View preview kinds also follow this path. Open-request/resource-open snapshots
retain details mode and sequence so a generic page keeps its own subject/title.
Every resource tab title is derived from the opened asset's name/source key.
The resource page is called the Asset Viewer, retaining type-specific Mesh
Preview/Properties and equivalent panel names. It is not a dependency graph
Reference Viewer. This revision supersedes the initial Related Assets submenu
and name-click opening policy without changing the resident query lifetime.

The query service reports its exact native plugin UID alongside its package ID.
Runtime Content excludes only those owned identities, on their matching
project/target/World, from user package/plugin controls and downloaded source
snapshots. Raw Engine inspect/snapshot operations remain unchanged and still
report the tooling definition. User definitions, programs and instances retain
their original bytes. New-page menu labels use the registered page type; only
opened tabs use live asset titles, and the generic title follows details-only
opens rather than adopting a Scene or dedicated preview's name.

## Evidence and limits

- PR #183 CI repair: browser shards 0/1 assumed an empty runtime Pack store;
  shard 2 looked up the Asset page after its label adopted an opened asset.
  Acceptance now validates the one precise resident definition separately
  from user content, and uses stable page IDs for asset-named tabs. Strict
  counts, source roundtrips and public-seam checks remain in force.
- Local real Engine probes pass runtime generation/replacement, user-only
  save/restore, Scene references and preview GPU resource cycles, plus the
  plugin-boundary Scene/asset/Inspector path and one Play lifecycle including
  failure cleanup. Evidence: `/private/tmp/pr183-runtime-content` and
  `/private/tmp/pr183-plugin-boundary`. The full Node suite, strict types,
  architecture and production build pass; remote CI is tracked separately.
- Asset Viewer action revision: real Game 3D `Astral Bloom` proves name click,
  double-click and keyboard confirmation do not navigate; the ExternalLink
  button opens the mesh page and repeated opens retain one named tab without
  increasing the active preview count. Its `Azure Flux` material slot browses
  to the exact GUID and opens the material viewer without changing scene
  selection. No Related Assets menu is present. Evidence:
  `/private/tmp/view-asset-viewer-game3d/result.json` and PNGs.
- Updated UI fixtures pass explicit-icon opening and exact material browsing,
  disabled missing/unregistered/unavailable viewer states, multi-primary and
  secondary-only shortcuts, keyboard behavior, target cancellation and
  320/480/640 widths in both themes. Strict source/component types, the full
  Node suite at concurrency 4, architecture, production build and Storybook
  build pass for this revision. Full CI shards remain a separate gate.
- Real Scene: resident before the first scene; numeric mesh handle resolved to
  a GUID; held-mesh default material slots; context Browse/Edit and Details
  Browse; named independent preview with captured pixels; provider removed and
  restored; resource-tab switching retains the same tooling package.
- Game 3D: `Lacquer Collision Cube` handle `1028` resolves to
  `bcb1b300-e235-59eb-b12b-fe619fd4165f`; Browse selects `mesh/cube`; Edit opens
  the `cube` preview; skeleton opens generic read-only details without another
  preview. Evidence: `/tmp/view-asset-reference-game3d/result.json` and PNGs.
- UI fixtures explicitly cover audio navigation, combined capabilities,
  material fields, missing identity, Content Browser removal/restoration,
  replacement cancellation and widths 320/480/640 in both themes with long names.
- Data/session tests cover actual World/Registry reads, old payloads, overrides,
  Engine defaults, custom arrays, bounds, provider revocation, unavailable
  capability recovery and synchronous cancellation. These are not media or
  physics simulation acceptance.
- Brotato's installed 0.4.2 project and a disposable source copy bound to the
  current local Engine both fail before Scene readiness with producer
  `produce-failed` for the project's assets. No Brotato UI success is claimed;
  its source and original dependency binding remain unchanged.

These focused browser results do not by themselves qualify the four CI browser
shards or the final bootstrap aggregate. Gate status must be reported separately.
The Node suite, strict TypeScript checks, architecture gate, component check,
Storybook build, UI fixture and KB lint pass. Harness `--verify` cannot qualify
this worktree because its local `install-manifest.json` is absent. The paired
Engine shard runner includes Engine dependency installation/build steps and was
not executed under the read-only Engine checkout constraint.
