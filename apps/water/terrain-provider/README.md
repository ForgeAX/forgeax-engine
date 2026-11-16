# Water Terrain Provider

Standalone scene with two pre-cooked Terrain plans, one WaterZone, and a River
body placed over the planned channel. The Terrain component renders the selected
landform while `WaterTerrainProvider` binds that same immutable asset version
to the Zone. Switching A/B changes only the Scene bindings. Disabling the
provider leaves the visible Terrain in place and reports that the Zone has no
ground provider.

The panel reports Zone ground generation, dirty state, provider availability,
Terrain GUID and registry version, and provider XZ bounds. This visualizes the
R1 TerrainProvider input contract only. It does not apply Water data to Terrain,
and it does not claim that the R2 WaterInfo render target has consumed the
input.

Run with `pnpm --filter @forgeax/water-terrain-provider dev`.

The project declares `@forgeax/engine/content` as its asset library. The Vite
adapter scans those source roots and registers the standard image importer so
the River material's inherited Content parent and textures belong to the same
production worklist as the planned Terrain outputs.
