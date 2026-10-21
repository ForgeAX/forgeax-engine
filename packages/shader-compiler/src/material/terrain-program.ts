const TERRAIN_DEFINES = {
  TERRAIN_GEOMETRY_AVAILABLE: true,
  GPU_DRIVEN_SCENE_INDEX_AVAILABLE: false,
  GPU_DRIVEN_SCENE_INDEX_EXPLICIT: false,
  VERTEX_COLOR_AVAILABLE: false,
  SKINNING_DISABLED: true,
  TRANSMISSION_AVAILABLE: false,
  VISIBLE_SURFACE_AVAILABLE: false,
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
