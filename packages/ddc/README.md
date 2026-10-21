# @forgeax/engine-ddc

## Help and API schema

DDC is a Node-only, read-only, disposable projection of producer evidence. The author authority remains the source, Pack, and Meta inputs. A cache hit is never author truth, and a Catalog row is only a projection of validated producer facts.

The machine-readable category and producer index is [`schemas/asset-authority.schema.json`](../../schemas/asset-authority.schema.json). DDC does not provide Save, Undo, Move, Rename, Promote, or Editor write operations.

> [!IMPORTANT]
> DDC can be deleted and rebuilt from author inputs. It must not become Save, Undo, Move, Rename, collaboration state, or the only copy of a runtime asset.

The public entry point exports the following owners:

| Surface | Public exports | Purpose |
|---|---|---|
| Layout | `resolveBuildDdcLayout`, `resolveDdcLayout` | Resolve explicit build and project roots into the v2 child layout |
| Status | `serializeDdcStatus`, `projectDdcStatusForBrowser` | Produce a versioned status envelope and a path-free browser projection |
| Storage | `DdcEntryStore`, `ddcOutputDigest` | Stage, validate, publish, inspect, list, and remove immutable entries |
| Lifecycle | `DdcLifecycle`, `withDdcLock` | Allocate generation, fence leases, CAS heads, and recover failures |
| Scope and GC | `createRuntimeScope`, `collectDdcGarbage` | Preserve original scope identity and sweep only unreachable project objects |
| Errors | `DdcStoreError`, `DDC_ERROR_CODES` | Closed machine-readable errors with executable recovery actions |

Available Node subpaths are `.`, `./key`, `./entry-store`, `./layout`, `./status`, and `./errors`.

## Status summary

Status uses the stable schema identifier `forgeax-ddc-status/v2`. The first layer is the health summary; deeper fields identify the owner, scope, current/LKG facts, protection, and legal actions.

```json
{
  "schemaVersion": "forgeax-ddc-status/v2",
  "health": "blocked",
  "layers": [
    {
      "kind": "project",
      "owner": "engine-ddc",
      "rootKind": "project-ddc",
      "scopeId": "editor/main",
      "current": 7,
      "lastKnownGood": 6,
      "protection": ["current", "lease:editor-a"],
      "actions": [
        { "kind": "inspect", "executable": true },
        { "kind": "prune", "executable": true, "exactTarget": ".../generations/4" }
      ]
    }
  ]
}
```

`projectDdcStatusForBrowser(status)` preserves logical identity and recovery data while removing `gameDir`, `projectDdcRoot`, and every `exactTarget`. Browser and iframe consumers therefore never need host filesystem paths.

## Layer and scope layout

The host injects both roots. DDC never reads `cwd`, `roots[0]`, a basename, a game id, or a URL to infer persistence policy.

```mermaid
flowchart LR
    Host["Host root policy"] --> Build["buildCacheRoot<br/>optional shared build CAS"]
    Host --> Project["projectDdcRoot<br/>game-local v2 publication"]
    Build --> Objects["objects + staging"]
    Project --> Scope["scope metadata"]
    Project --> Heads["heads + generations + leases"]
    Project --> Runtime["runtime and publication evidence"]
    Source["Source + Pack + Meta"] --> Cook["producer cold cook"]
    Cook --> Build
    Cook --> Project
```

The canonical project root is `<gameDir>/.forgeax/ddc/v2`. The build root is an injected performance cache and may be shared only when the complete semantic key matches. Project publication, heads, current/LKG, leases, scopes, and runtime evidence never cross game boundaries.

| Call shape | Required root | Intended use | Missing-root behavior |
|---|---|---|---|
| `resolveBuildDdcLayout({ buildCacheRoot })` | `buildCacheRoot` | Build-only object reuse | Closed absolute-root failure |
| `resolveDdcLayout({ buildCacheRoot, projectDdcRoot })` | Both roots | Serve, publication, fixed bind, and rebind | `ddc-project-root-required` |
| `createRuntimeScope(projectDdcRoot, scopeId)` | Project root | Scope hash plus original metadata | `ddc-scope-mismatch` |

`a/b` and `a_b` receive different SHA-256 physical scope identities. The original scope id is stored in `scope.json` and is checked before enumeration or pruning; sanitized names and prefix matching are not ownership proofs.

## Lifecycle and recovery

```mermaid
stateDiagram-v2
    [*] --> Missing
    Missing --> Cooking : begin allocates generation + lease
    Cooking --> Current : validate entry + CAS commit
    Cooking --> Failed : producer failure or expiry
    Cooking --> Stale : superseded attempt or revision conflict
    Current --> Cooking : new semantic key
    Failed --> Cooking : inspect + cold rebuild
    Stale --> Cooking : allocate new generation
    Current --> [*] : close releases this instance lease
```

Each `begin` persists a strictly increasing generation and an expected head revision. `commit` rechecks the lease, expiry, expected revision, desired key, entry receipt, and integrity before switching `current`. A failed candidate never promotes LKG to current; LKG remains a read-only recovery view.

A successful commit returns its accepted `head` and rollback fence. That head is
the snapshot written by this CAS; later writers cannot change the returned
publication's key, revision, generation, or LKG. Consumers use this snapshot
without rereading the complete entry. Rejected commits return their attempted
key and observed revision; an `invalid` commit also carries its rollback fence.

`DdcGenerationSession` heartbeats active candidate leases while a multi-asset generation is still producing, so atomic publication may outlive one lease interval without weakening the final commit fence. A heartbeat renews only the persisted, unexpired attempt with its matching revision and desired key; an expired lease cannot be revived. Closing, discarding, or committing a candidate stops its heartbeat.

> [!NOTE]
> `DdcLifecycle.readCurrentEntry()` is a recovery read for a Pack producer to rehydrate its process-local transport cache after a restart. It accepts only a `current` head with a complete, integrity-checked entry; it never promotes LKG/stale content, mutates the head, or turns DDC into an authoring/runtime transport authority. Catalog and producer state remain the consumer-facing authority.

| Rollback surface | Contract | Result |
|---|---|---|
| `DdcLifecycle.beginWithSnapshot` | Captures the accepted head and allocates the lease while holding the same per-asset lock | No begin/snapshot TOCTOU window |
| `DdcLifecycle.restoreIfCurrent` | Accepts an active-attempt fence or an exact terminal mutation fence | `restored` or a diagnostic `not-owner` no-op |
| `DdcGenerationSession.restoreEntry` | Stops the heartbeat before the fenced restore and discards staging afterward | A superseded writer cannot overwrite a newer head |

> [!IMPORTANT]
> Rollback restores accepted content only. It never resurrects a superseded active lease, rewinds `revision` or `generation`, or replaces a newer active/terminal mutation. Stale, invalid, and failed terminal writes carry their own mutation fence so an old session cannot pass an ABA-shaped check.

<details>
<summary>Exact target and receipt contract</summary>

An immutable entry is accepted only when all of these facts agree:

1. `DdcEntry.key` matches `DdcReceipt.key` and the semantic key format.
2. `DdcReceipt.guid` matches the entry GUID.
3. `DdcReceipt.outputDigest` matches the canonical payload, refs, and artifact bytes.
4. The stored integrity record matches every payload, receipt, artifact, and entry digest.
5. The mutable head still owns the attempt, generation, and expected revision.

For a runtime Pack publication, the immutable payload excludes the live
`scopeId`/`generation` tuple; when a producer supplies that generation, it is
recorded as receipt metadata and rebound to the accepted Catalog tuple when
the payload is restored for transport.

`DdcEntryStore.publish` is idempotent for the same key and integrity. A different payload under the same key remains a conflict; it is never silently overwritten. Staging and destination stay under the injected root so publication does not claim cross-device atomicity.

Concurrent publication preserves that contract on Windows: an `EPERM` rename
is treated as an existing-entry race only when the destination is a directory,
then the same complete integrity and immutable-content checks apply. Permission
failures without an existing destination directory remain failures.

Commit validates immutable entry bytes before taking the mutable head lock, so
the same attempt can heartbeat during validation. The lock then fences the
persisted live expiry, attempt, revision and desired key; a superseding writer or
expired lease cannot advance current after a slow read. Existing-entry comparison reuses
the output digests already checked against both complete entries.

Semantic keys, output digests, and entry integrity hash one canonical JSON byte
sequence incrementally. Binary artifacts retain their existing base64 identity,
including wrapper field order and padding, without building a string for the
whole publication. This permits aggregate artifact content above V8's single
string limit while preserving existing cache keys and conflict checks.
`canonicalDdcJson` still returns a string for the ordinary stored JSON records.
Staging captures private payload JSON, references, receipt and logical artifact
bytes synchronously, then validates that exact disk representation through the
same three-digest reader. Its verified payload text is shared across the hashes;
caller edits and callbacks cannot change the candidate after capture. Publication
still independently reads and validates every staged file before promotion.
Readback validation cooperatively hashes its private parsed JSON and artifact
buffers, yielding between bounded chunks so lease heartbeats can run. Caller-owned
inputs and author callbacks retain synchronous canonical evaluation; readback still
validates every output and integrity digest before returning the entry.
The reader hashes the payload canonically once, then verifies that the loaded
file bytes encode that same canonical text. Only that verified private object
can reuse the text within the output and entry digests. Noncanonical files
fall back to ordinary canonical traversal; scalar omissions and key-dependent
callbacks retain their existing rules. The file stays in a byte buffer and is
decoded in bounded UTF-8 chunks, avoiding a retained second large heap string.
All three digests, stored keys, disk format and corruption checks remain intact.
The reader streams its private parsed arrays and artifact-buffer views without
creating a second complete graph. It orders one object at a time with the same
canonical property/prototype rules. Caller-owned values retain their original
snapshot semantics, including binary values observed by later author getters.

</details>

## Closed errors and executable actions

The closed configuration and lifecycle codes are:

| Code | Meaning | Safe recovery |
|---|---|---|
| `ddc-project-root-required` | Serve/publication did not receive a project root | Re-run host canonicalization and inject `projectDdcRoot` |
| `ddc-object-conflict` | Same object key has different integrity | Inspect and keep the verified object |
| `ddc-head-conflict` | Head revision changed before commit, or an existing head is unreadable/invalid | Inspect current/LKG and retry with a fresh attempt |
| `ddc-generation-conflict` | Requested generation is not allocatable | Allocate a persistent generation; do not edit the counter |
| `ddc-scope-mismatch` | Scope metadata and request disagree | Inspect the canonical project root and rebind |
| `ddc-lease-expired` | The attempt no longer owns a live lease | Discard stale work and acquire a new lease |

`DdcStoreError` exposes `code`, `hint`, `expected`, `actual`, `owner`, `rootKind`, `scope`, `generation`, `lease`, `revision`, and `recoveryActions`. Use these fields directly; do not parse `Error.message`, hand-edit heads/counters/leases, or recursively delete the cache. `toBrowserProjection()` removes host paths while retaining the fields needed to choose the next safe action.

## Safe action checklist

- [x] Inspect status before changing a head or pruning an object.
- [x] Keep current and LKG protected while a lease or revision can reach them.
- [x] Use a new generation after restart, stale work, or a lease conflict.
- [x] Cold-cook from source, Pack, and Meta when optional build CAS is absent, read-only, or corrupt.
- [ ] Treat DDC as an authoring or runtime transport authority.
- [ ] Guess a project root from `cwd`, a basename, `roots[0]`, game id, or URL.

The package owns derived evidence only. Source authority, Pack publication, Catalog projection, browser binding, and final release archives remain separate owners.

Publication tuples are constructed by Types `createAssetPublication`; DDC validates their shared output-set digest and owns staging, commit, cancellation and current/last-known-good state. It does not maintain another envelope builder.

Errors and status layers use the same `DdcRecoveryAction` contract, including
lease release. Their browser projections share path redaction. Construct
`DdcStoreError` with `{ code, detail, ... }`; entry-store failures use this same
structured input as lifecycle and session failures.

Both generation commit paths share candidate completion: restore validation, corruption accounting, heartbeat retirement and candidate removal. Concurrent session closes await the same completion. This does not introduce cross-session write ownership; lifecycle mutation fences remain authoritative.
