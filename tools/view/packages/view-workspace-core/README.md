# View workspace core

Realm-neutral workspace state, operation effects and API clients. React and platform presentation belong to consuming plugins; Engine owns project execution and asset facts.

Project catalogue client calls return the successful list, directory listing or
registered project directly. Engine ToolApi consumes the owner's `Result` envelope;
failures reject through the existing workspace diagnostic path. Consumers must not
unwrap a second `Result` or replace catalogue authority with a local list.

### Request sharing and cancellation

`VIEW_WORKSPACE_OPERATION_EFFECTS` is the operation inventory and request-sharing
policy. Snapshot queries with identical operation, arguments, transport generation,
and explicit request identity share one in-flight request. Each caller retains its
own cancellation lease; the underlying request cancels when its final reader leaves.
Commands execute independently and fence subsequent queries. Completed snapshots are
never cached by the client. Producer operations such as `asset.inspect` retain their
independent execution path.

Selection superseded by a newer selection on the same target rejects with
`view-workspace-selection-superseded`; the command notice owner ignores that expected
replacement. Caller cancellation, target replacement, and genuine domain failures
retain their own rejection and recovery behavior.

### Project document ownership

The backend elects one top-level View document to present its shared Engine
project. `project.present` serializes handoff: the current presenter acknowledges
`presentation.document.release` before the requesting document is elected.
Failed retirement preserves the original owner. Disconnection retires the old
page lease; the new document connects independently and uses the Host-published
project document. Embedded project callers borrow only the current presenter's
broker for the identical Engine runtime. Page closure never selects another H
or replaces the project backend.

Page listing and Pack reveal use the same presentation owners. The retained
Shell and its embedded Engine document count as one addressable View page.
Replacing a resource cancels only its retired placement lease; a new preview's
state read and placement remain live while the old preview releases its surface.

Frontend `pack.reveal` uses its admitted document connection automatically.
An explicit frontend connection must identify that same document. CLI callers
retain explicit page selection when several View documents are connected.

Each workspace publication projects state once and advances its revision on the
same detached snapshot. A Shell and an embedded document sharing one broker
receive the same revision through their individual subscriptions. Catalog and
thumbnail refreshes visit each broker once, including when it has both
connections.
