# Water R4 Buoyancy Harbor

Saved Scene carrier for the synchronous [Water buoyancy contract](../../../packages/water/README.md),
specified-body CPU particle queries and actual renderer foam-input inspection.

```powershell
pnpm build:engine
pnpm --filter @forgeax/water-r4-buoyancy-foam dev
```

Open `http://127.0.0.1:5384/`. The Chinese controls edit the real
`WaterPontoonSet`, Water assets, colliders and exclusion volume. Launch presets
perform one explicit native pose/velocity reset; subsequent movement comes
from Physics. The event particle consumer samples the event's exact Water body
and generation after its source physics step completes.

The saved Lake and Ocean sensors extend 2 m above the source plane; the River
uses its cooked spline-mesh height. The panel and exported accepted descriptors
show the exact extents. Ordinary static Terrain receives shore contacts.
The wave switch retains the Cooked body's conservative height envelope.

`window.__waterR4.readState()` exposes accepted bodies, native dynamics, the
latest complete step, actual system/particle query requests and renderer inspection.
The numeric particle offset moves the query marker from the committed native
system position. River metadata varies from 2 to 8 m, making the instance and
particle depth branches observable. The panel records source tick and query flags.
Per-point checkboxes edit the saved enabled mask and expose first-solve/cache hits.
`exportTrace()` retains 240 complete steps and explicitly counts retired steps;
particle sample retention has its own count. The visible export command emits
the same facts. GPU particle DI returns its structured unsupported result.

> [!NOTE]
> Set `FORGEAX_RHI_CAPTURE_ROOT` to a directory outside this checkout before
> starting Vite when persisting a capture through its recorder transport.
> Numerical traces and Browser/RHI artifacts are independent evidence. Engine
> source/asset adaptation does not establish UE pixel or numerical parity.
