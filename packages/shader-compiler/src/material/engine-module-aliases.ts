/** Legacy Engine identifiers publish the same Engine source as their canonical module. */
export const ENGINE_MODULE_ALIASES: Readonly<Record<string, string>> = {
  'forgeax_material::standard': 'forgeax::default-standard-pbr',
  'forgeax_material::unlit': 'forgeax::default-unlit',
  'forgeax_material::pbr-skin': 'forgeax::pbr-skin',
  'forgeax_material::sprite': 'forgeax::sprite',
  'forgeax_material::sprite-lit': 'forgeax::sprite-lit',
};
