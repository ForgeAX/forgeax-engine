# @forgeax/engine-intelligence-fake

Deterministic provider for tests, demos, and offline development. Each
`advance()` emits at most one delta per active Activity, so a consumer can prove
frame polling, ordering, cancellation, failure, session reuse, and disposal
without credentials or timing-dependent mocks.
