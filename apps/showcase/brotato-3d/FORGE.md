# Brotato 3D

game-brotato-3d is a small 3D top-down survival shooter template. Its authored
asset SSOT is `assets/brotato-3d.pack.ts`: it declares procedural meshes,
the continuous arena materials, actor/boss/projectile meshes, SceneAssets for
the arena and actors, and the external impact VFX dependency. The HUD is published as the canonical UI
sidecar `assets/ui/hud.pack.json`; no binary asset dependency is required.

## Play

- WASD moves the potato.
- The weapon auto-fires at the nearest enemy.
- Hold Space or click to overclock the fire cadence.
- Collect green pickups to score and recover one heart.
- Press R to restart a defeated run.

The camera is a fixed angled top-down view. The game loop lives in ECS:
variable-rate input writes player intent, FixedUpdate owns movement/combat and
deferred entity changes, and Update projects the HUD and inspection snapshot.

Runtime loads the published ordinary assets by GUID through `AssetRegistry` and
instantiates the arena/actor `SceneAsset` records. `assets/brotato-impact.vfx.wgsl`
is cooked through the Preview VFX producer and played through the GPU VFX host.

Useful checks from the engine checkout:

```sh
node packages/devkit/dist/cli.mjs asset.verify --json --root apps/showcase/brotato-3d
pnpm --filter @forgeax/preview build
```
