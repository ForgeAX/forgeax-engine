# bevy-fog

This carrier demonstrates the Engine-owned `Fog` component with the Standard
environment path. Bevy supplies public component facts and draw/inspection
data; the Engine owns extraction, the fog semantic, graph placement, and
recovery.

## Quick start

```bash
pnpm --filter @forgeax/bevy-fog smoke:browser
pnpm --filter @forgeax/bevy-fog smoke:dawn
```

Each smoke runs at least 60 frames and records `source`, `build`, `backend`,
`runner`, and `frameIdentity`. Browser and Dawn PNG/readback evidence is kept
alongside the structural receipt. Missing backend evidence is `unavailable`,
not `pass`.

## Recovery route

Use `inspect()` to identify the owner and branch on the structured error
`code`, `expected`, `hint`, and typed `detail`. Repair the source or capability,
then retry the same draw request. Fog has one Engine semantic and one graph
owner; the carrier does not implement a fullscreen formula, private history,
or a second resource topology.

The evidence manifest and schema index current-source provenance, structural
checks, and real Browser/Dawn readback separately from any historical oracle.
