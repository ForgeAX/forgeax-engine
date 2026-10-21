# Hello Tilemap

One `Tilemap` contains a complete grid layer and a managed Tileset handle. The Tileset owns its atlas references. Update asset values with `assets.update` and cells with `world.set`; Renderer adopts changes and emits visible chunks without creating derived ECS entities.

`pnpm -F @forgeax/hello-tilemap dev` opens the example. After 120 updates it removes one diagonal tile and changes another.

`pnpm -F @forgeax/hello-tilemap smoke` runs 60 completed Dawn frames using the same scene builder. It reads the expected colors before and after the cell edit, checks the unchanged neighboring tile and verifies that no `MeshFilter`/`MeshRenderer` entities were generated. RGB tolerance is 0.05; capability failures fail the gate.
