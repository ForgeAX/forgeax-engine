# View workspace core

Realm-neutral workspace state, operation effects and API clients. React and platform presentation belong to consuming plugins; Engine owns project execution and asset facts.

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
