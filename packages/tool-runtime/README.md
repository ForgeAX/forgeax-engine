# `@forgeax/engine-tool-runtime`

AI tools follow one discoverable proposition: `list -> describe -> run -> terminal`.
This focused package owns the realm-neutral contract only. A contribution keeps its
descriptor and executor together, while DevKit and other hosts provide the authority
and physical realm. `ToolRealm` distinguishes resident Node `host`, browser
`frontend`, simulation `engine`, and build-time `build`; the Plugin loader uses
the same vocabulary.

`TOOL_REALMS` is the frozen, ordered tool-realm vocabulary. `ToolRealm` derives
from it; provider admission, serialized command admission, capability matrices
and DevKit's default providers consume that same value.

`ToolCommandDeclaration` derives its identity fields from `ToolDescriptor`.
Its schemas remain serialized strings and evidence is optional; runtime parser
objects do not cross the declaration boundary.

Preview descriptors may add a portable `preview` contract containing `realm`, a
`ToolSubjectRef`, and a `SnapshotRef`; `evidence` remains the required
`ArtifactRef` kind list. `defineTool` rejects a preview contract whose realm does
not match its descriptor, so a consumer cannot silently execute in another realm.

```ts
const tool = defineTool({
  id: 'author.write',
  title: 'Write author state',
  summary: 'Writes one project value.',
  realm: 'build',
  argsSchema,
  resultSchema,
  evidence: [],
}, async (args, context) => ({ ok: true, value: await write(args, context.signal) }));
```

Terminal payloads contain only typed results, serialized `snapshotAfter`, `ArtifactRef`
values, and an optional `ToolCleanupReport`. A live handle, canvas, renderer, page,
Fiber, or carrier is never part of the portable contract. Providers call
`context.setCleanupReport` before terminal; the runtime publishes one terminal only
after required evidence and lexical cleanup are complete.
Serialized commands, terminal results and migration payloads share JSON value
admission: finite primitives, dense arrays and ordinary/null-prototype records.
Repeated acyclic references are valid; cycles, accessors, symbols, hidden fields
and class instances are rejected before values are read or published. Migration
then checks its live-state key policy over the admitted JSON tree. A non-zero resource census
turns a would-be success into `tool-cleanup-failed`.

`ToolJsonSchema` owns the small schema vocabulary consumed by tool admission,
including array bounds and JSON-content uniqueness. DevKit RHI descriptors and
thumbnail tools use the same contract as their executable parsers. Object key
order does not affect `enum`, `const` or `uniqueItems` equality.
`toolJsonSchema` retains its serialized description as the parser input, so later
author mutations cannot change validation independently of discovery.

This package has no filesystem, Vite, WebGPU, Editor, or second registry dependency.

## Fiber-local typed capabilities

`defineToolCapability<T>(id)` creates only a static identity. A host adapter passes
one `capabilityResolver` when it runs a selected Entry; the executor obtains a
Fiber-local service with `context.require(capability)`. The result is a typed
`{ ok: true, value }` or a closed `ToolRuntimeError`. The token never enters tool
arguments, terminal results, artifacts, or a second service registry.

```ts
const previewHost = defineToolCapability<PreviewHost>('previewHost');
const contribution = defineTool(descriptor, async (_args, context) => {
  const host = context.require(previewHost);
  if (!host.ok) return host;
  return host.value.withSession(context.signal);
});
```

The resolver is valid only while the owning ToolRun lease is active. A missing
service returns `tool-capability-unavailable`; a resolver retained past terminal
returns `tool-run-terminal`. Hosts bridge their active Cordis Context through
`@forgeax/engine-plugin` and do not expose raw Context to executors.

## Optional service boundary

`createServiceCapability` accepts a workload-scoped `ServiceAdmissionRef` and
validates its tool, descriptor, recipe, code, browser, backend, 300-frame sample,
correctness, threshold, cleanup, and eviction facts. A missing or mismatched report
produces the closed `tool-service-capability-absent` state; callers cannot admit a
service with a boolean. `createAuthenticatedLoopbackTransport`
accepts only loopback HTTP and a bearer token; its request is structured-clone
safe and carries descriptor/recipe digests plus JSON arguments. The transport
does not add an operation registry or transfer live World, Renderer, Canvas,
Context, Fiber, or GPU handles. Hosts must retain a private executor and use it
when admission is absent or when the disposable service is deleted.

## Capability migration

Migration is a finite, versioned contract rather than a live runtime handoff.
`createCapabilityToken` records source and expected target probes;
`probeMigrationTarget` must succeed before a target is used. A migration recipe
carries only JSON arguments, `SnapshotRef`, and `ArtifactRef` values. Recursive
live `world`, `renderer`, `canvas`, `context`, `fiber`, `page`, `carrier`, `ui`,
`selection`, `draft`, `undo`, and `session` state is rejected with
`tool-migration-live-state`.

> [!IMPORTANT]
> A target probe failure is a structured capability failure. It never transfers
> a live World, Renderer, Canvas, Context, Fiber, page, carrier, or UI session.

## Authenticated ephemeral visible carrier

The visible carrier transport is an ephemeral two-process boundary. A host
publishes a POD offer containing `offerId`, loopback `endpoint`, bearer token,
`generation`, `descriptorDigest`, `recipeDigest`, and `expiresAt`. The consumer
must complete `lease -> start -> execute -> exit`; the transport never creates a
ToolRun, registry, World, or fallback executor. The current phase owns the lease
identity: expiry, fallback, and exit cannot restart a retired lease. Only an
active leased offer may replace its lease before start.

`createAuthenticatedCarrierTransport` authenticates every request and exposes
structured failures with stable `code`, `expected`, `hint`, and optional
`detail`. Digest/auth failures require a fresh offer. Provider exit after
`start` is terminal (`carrier-provider-exit` or `carrier-exited`): report one
failure and never execute through a second fallback path. Capture and cleanup
failures remain structured so retry is allowed only from a safe snapshot.

## Artifact record contracts

Preview records select `owner`, `uri`, `digest` and `byteLength` from
`ToolArtifactManifestEntry`. Preview keeps its own kind/role vocabulary and
requires `mediaType` and `derivedFrom`; ordinary Tool records allow those
fields to be absent. Manifest versions and run/subject identities stay distinct.

Command help leaves select title, realm, schemas and example from
`ToolDescriptor`. Their descriptions remain help-owned; normalized
`capabilities` and `errors` are required arrays even when the descriptor omits them.

`ToolApiRunOptions` is `ToolRunOptions` with internal `owner` omitted. Provider
routing and observed generation are declared once on the run contract. The
public option name is a type alias; it is not an interface augmentation point.

## Public operation names

The domain operation ID is the naming authority. Lower-case resource segments
use dots; the final segment names the action or status query. A subordinate
resource keeps its own segment (`asset.source.instance.create`,
`engine.scene.tree.get`); compound words inside one segment use kebab-case.
Owner scope distinguishes authoring `asset.inspect` from live-target
`engine.asset.inspect` and View presentation `view.workspace.pack.reveal`.

| Surface | Derived spelling |
|:--|:--|
| API operation | `engine.scene.tree.get` |
| CLI | `forgeax engine scene tree get` |
| MCP | `forgeax_engine_scene_tree_get` |

`operationCommandPath(id)` and `operationMcpName(id)` format the same ID.
Adapters do not reorder words, substitute verbs or invent aliases. The MCP
adapter checks its fixed tool set for collisions after punctuation conversion.
CLI help is generated from the owners' contracts. A running BackendHost exposes
its callable ToolApi descriptors through `engine.backend.tool.list`; CLI reads
that projection without activating plugins. Calls still enter the same owner
through `engine.backend.call`, preserving authentication and cancellation.

Carrier operations use `createAuthenticatedCarrierTransport`; stateless tool calls
use `createAuthenticatedLoopbackTransport`. Both send actual authenticated HTTP
requests. Local lease transitions use `createCarrierStateMachine` directly.

Preview sessions and ToolRuntime terminals share `ToolCleanupCensus`,
`ToolCleanupReport` and the post-disposal failure check. Explicit cleanup
failures precede live-resource counts. ToolRun keeps the executor's original
failed outcome unless lease cleanup itself fails; a successful result requires
a clean report before terminal publication.

Evidence kinds derive from `TOOL_EVIDENCE_KINDS`; command declarations and
manifest admission use that vocabulary. Artifact construction and ToolRun
terminal validation share one check for supported kinds, nonempty digests,
optional string metadata and non-negative safe byte lengths. Preview role and
kind types derive from their role mapping rather than independent lists.

`ServiceAdmissionExpectation` selects workload identity from `ServiceAdmissionRef`;
DevKit executor options derive the same fields. Admission still validates the
explicit identity whitelist, correctness evidence and performance thresholds
before allowing a service; absent or invalid evidence keeps the private executor.

Provider revocation and Tool API disposal share the provider's executor-exit
completion. Every overlapping caller waits for that completion, including an
executor that ignores cancellation. A failed provider remains the identity owner
until its executors exit; registering a replacement before then is rejected.

Provider revocation withdraws admission synchronously. Cancellation and the
executor-exit snapshot run after the current admission stack, so an executor that
revokes its own provider before its ToolRun handle is returned is still included
in the shared retirement completion.

Exclusive phase timing uses the recorded observation to admit each phase once;
`begin`, `end`, and externally measured `record` share that completion state.
