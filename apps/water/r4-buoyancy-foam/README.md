# Boat Sailing — R4 / R5

R4 is the primary entry for the combined native boat demonstration. Port 5384
and the R5 URL on port 5385 load the same R5-authored scene, controls and physics
implementation. R4 retains its harbor assets and native regression fixtures;
they are not a second running product.

```sh
pnpm --filter @forgeax/water-r4-buoyancy-foam dev
```

Observe calm floating, head-on waves, an airborne return and offset cargo.
Startup selects Head-on waves, enabling the authored Ocean wave field and
scene-depth shoreline foam. Calm remains the explicit no-wave comparison.
Motor/rudder forces and cargo torque run at the existing native fixed boundary.
Worker async and synchronous buoyancy are settings in this same experience;
GPU/CPU selects the actual WaterMesh path. Both `window.__waterR4` and
`window.__waterR5` reference the same evidence object.

The running scene has no white-sphere splash or foam particles. Lake/Ocean
materials use the Showcase porous foam texture author and ordinary Water
contact, crest and scene-depth foam inputs. Material foam is rendered on the
water; hidden pontoon debug geometry remains an explicit advanced control.

See the [shared experience](../r5-gpu-mesh-async-pontoons/README.md) and
[Water contract](../../../packages/water/README.md). Browser visibility and
rendered foam require the main thread's actual browser acceptance.
