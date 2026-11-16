const TERRAIN_DEFINES = {
  TERRAIN_GEOMETRY_AVAILABLE: true,
  GPU_DRIVEN_SCENE_INDEX_AVAILABLE: false,
  GPU_DRIVEN_SCENE_INDEX_EXPLICIT: false,
  VERTEX_COLOR_AVAILABLE: false,
  SKINNING_DISABLED: true,
  TRANSMISSION_AVAILABLE: false,
  VISIBLE_SURFACE_AVAILABLE: false,
  WATER_WAVES_AVAILABLE: false,
  WATER_INFO_RGBA16: false,
  // Terrain is not a GPU-driven row batch, the only requester of lean inputs; fixing
  // the axis keeps it from doubling Terrain rows that nothing selects (UE compiles a
  // permutation only where ShouldCompilePermutation admits it, LandscapeRender.cpp:3724-3729).
  STANDARD_LEAN_INPUTS: false,
} as const;

/** Both built-in manifests and Pack cooking derive the fixed Terrain composition here. */
export function terrainProgramSource(identifier: string) {
  const selected = /^forgeax::standard-terrain(-ids)?(-shadow)?$/.exec(identifier);
  if (selected === null) return undefined;
  return {
    module:
      selected[2] === undefined
        ? 'forgeax::default-standard-pbr'
        : 'forgeax::default-shadow-caster',
    surface: `forgeax_material::terrain${selected[1] === undefined ? '' : '_id'}_surface`,
    defines: TERRAIN_DEFINES,
  };
}
