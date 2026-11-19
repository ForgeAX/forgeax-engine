/** Engine lighting follows the complete author-owned material binding region. */
export const MATERIAL_LIGHTING_INPUT_MODULE = 'forgeax_material::lighting_inputs';

export function materialLightingInputBindings(userRegionBindingEnd: number) {
  return {
    irradianceMap: userRegionBindingEnd,
    irradianceSampler: userRegionBindingEnd + 1,
    prefilterMap: userRegionBindingEnd + 2,
    prefilterSampler: userRegionBindingEnd + 3,
    brdfLut: userRegionBindingEnd + 4,
    skylight: userRegionBindingEnd + 5,
    skylightPrefilterMap: userRegionBindingEnd + 30,
  } as const;
}
