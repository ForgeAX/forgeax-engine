# Hello Tilemap Object Layer

A native `Tilemap` with `TilemapSort.perCell` shares the transparent drawing queue with an ordinary Sprite. Managed Tileset entries define each cell's region, atlas, dimensions and pivot; Tiled flip bits are carried by the cells. Multiple layers use ordinary scene hierarchy.

`pnpm -F @forgeax/hello-tilemap-object-layer dev` shows five cases: chunk boundaries, flips with off-center pivots, two atlases, unit cells and Sprite overlap.

`pnpm -F @forgeax/hello-tilemap-object-layer smoke` renders the same scene for 60 completed Dawn frames. It checks five RGB samples at tolerance 0.05, moves the overlapping Sprite to reveal the underlying tile, then removes map cells to prove the sampled output came from the Tilemap. Only the authored Sprite owns Mesh components.
