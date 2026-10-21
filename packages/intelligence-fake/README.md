# @forgeax/engine-intelligence-fake

Deterministic provider for tests, demos, and offline development. Each
`advance()` emits at most one delta per active Activity, so a consumer can prove
frame polling, ordering, cancellation, failure, session reuse, and disposal
without credentials or timing-dependent mocks.

An advance visits the Activity roster present at its start. Reentrant starts wait for the next advance; removed or replaced entries are skipped. Closing clears the roster before delivering cancellation callbacks.
