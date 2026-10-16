# Preview DoF route

The `game-default` Preview uses the ordinary mesh camera's Engine-owned
`DepthOfField` component. The example owner is
`apps/game-capability-lab/assets/plugins/depth-of-field.ts`.

## Public control surface

```ts
const dof = installDepthOfField(world, camera, false);
dof.setPreset('both');
dof.setControls({ focusDistance: 7, fStop: 1.4, quality: 'high' });
const state = dof.snapshot();
// state.preset, state.controls, and state.focalLength are derived evidence.
dof.setPreset('off');
```

The closed presets are `off`, `near`, `far`, and `both`. The Engine validates
perspective camera optics, derives focal length from sensor height and vertical
FOV, and places the effect after temporal/metering stages in the Standard
post chain. RenderExtent owns the output/internal dimensions, with ceil half
extents for the large-radius passes. Temporal-v1 validity and the bound depth
sample count select the depth contract; a failed graph submission leaves the
previous accepted graph and inspection LKG in place.

Run the focused Preview proof with:

```sh
pnpm --filter @forgeax/preview smoke:depth-of-field
```

The smoke toggles the public camera component through the game evidence seam,
checks the off and `both` presets plus derived focal length, captures the real
ordinary-mesh compositor, and verifies reset returns to `off`. It is a browser
pixel smoke, not physical-GPU, 300-frame Dawn, or measured performance proof.
