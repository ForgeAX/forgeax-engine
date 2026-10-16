import { createMaterialError, selectMaterialStaticContract, type MaterialAsset, type MaterialPass, type MaterialRootAsset } from '@forgeax/engine-types';
import leaf from './leaf-diffuse-transmission.pack.json' with { type: 'json' };

/**
 * Physical Standard layers are selected by the cooked root contract, not by
 * runtime values: the shader plugin cooks this package into an alias of the
 * Engine Standard template with `DIFFUSE_TRANSMISSION_AVAILABLE` enabled. The
 * root declares the optional factor texture; an unbound slot falls back to
 * white (alpha 1), so uniform and masked leaves share one program.
 */
export const FOLIAGE_MATERIAL_PACKAGES = ['leaf-diffuse-transmission.pack.json'] as const;

const contract = leaf.assets[0]?.payload as unknown as MaterialRootAsset;
const selectedContract = selectMaterialStaticContract(contract, true);
const declaredModule = contract.passes?.[0]?.program.module;
if (declaredModule === undefined) throw new Error('Foliage material package has no pass module');
const module: string = declaredModule;

/** Bind a runtime Standard material to the cooked diffuse-transmission alias. */
export function withFoliageMaterialModule(material: MaterialAsset): MaterialAsset {
  if (material.passes === undefined) throw new Error('Foliage material must have resolved passes');
  const replace = (pass: MaterialPass): MaterialPass =>
    pass.name === 'shadow-caster'
      ? pass
      : { ...pass, program: { ...pass.program, module } };
  for (const [name, enabled] of Object.entries(material.staticSwitches ?? {})) {
    const fixed = selectedContract.staticSwitches?.[name as keyof NonNullable<MaterialAsset['staticSwitches']>] ?? true;
    if (enabled !== fixed) {
      const error = createMaterialError('material-specialization-not-cooked', { code: 'material-specialization-not-cooked', material: module, staticSelection: [`static-switch:${name}=${enabled}`] });
      throw Object.assign(new Error(error.message), error);
    }
  }
  const { staticSwitches: _choices, ...invocation } = material;
  const names = new Set(selectedContract.parameters?.map((parameter) => parameter.name));
  const [first, ...rest] = material.passes;
  return {
    ...invocation,
    parameters: selectedContract.parameters ?? [],
    values: Object.fromEntries(Object.entries(material.values ?? {}).filter(([name]) => names.has(name))),
    passes: [replace(first), ...rest.map(replace)],
  };
}
