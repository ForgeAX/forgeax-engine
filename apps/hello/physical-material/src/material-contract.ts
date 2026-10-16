import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { MaterialAsset, MaterialPass, MaterialRootAsset } from '@forgeax/engine-types';
import scalar from './standard-clearcoat.pack.json' with { type: 'json' };
import factor from './standard-clearcoat-factor-r.pack.json' with { type: 'json' };
import roughness from './standard-clearcoat-roughness-g.pack.json' with { type: 'json' };
import normal from './standard-clearcoat-normal-rg.pack.json' with { type: 'json' };
import full from './standard-full-physical.pack.json' with { type: 'json' };
import skinFactor from './skin-clearcoat-factor-r.pack.json' with { type: 'json' };
import skinRoughness from './skin-clearcoat-roughness-g.pack.json' with { type: 'json' };
import skinNormal from './skin-clearcoat-normal-rg.pack.json' with { type: 'json' };
import skinFull from './skin-full-physical.pack.json' with { type: 'json' };

export const physicalMaterialRoots =
  [scalar, factor, roughness, normal, full, skinFactor, skinRoughness, skinNormal, skinFull].map(
    (pack) => {
      const material = pack.assets[0]!.payload as unknown as MaterialRootAsset;
      if (material.passes === undefined) throw new Error('Physical shader package has no passes');
      const parent = AssetGuid.parse(pack.assets[0]!.guid);
      if (!parent.ok) throw parent.error;
      return { guid: pack.assets[0]!.guid, parent: parent.value, module: material.passes[0]!.program.module, material };
    },
  );
const contracts = new Map(physicalMaterialRoots.map((root) => [root.module, root]));

/** Runtime values inherit the accepted Catalog root and its cooked program identity. */
export function physicalMaterialChild(material: MaterialAsset, module: string): MaterialAsset {
  const root = contracts.get(module);
  if (root === undefined) throw new Error(`Unknown physical material contract: ${module}`);
  return {
    kind: 'material',
    parent: root.parent,
    values: Object.fromEntries(
      Object.entries(material.values ?? {}).filter(([name]) =>
        root.material.parameters?.some((parameter) => parameter.name === name),
      ),
    ),
  };
}

/** Use the same parameter ABI as the shader package, not the default root ABI. */
export function withPhysicalMaterialModule(material: MaterialAsset, module: string): MaterialAsset {
  const contract = contracts.get(
    module === 'physical-material::standard-clearcoat-mutant'
      ? 'physical-material::standard-clearcoat'
      : module,
  )?.material;
  if (contract === undefined) throw new Error(`Unknown physical material contract: ${module}`);
  if (material.passes === undefined) throw new Error('Physical material must have resolved passes');
  const replace = (pass: MaterialPass): MaterialPass =>
    pass.name === 'shadow-caster'
      ? pass
      : { ...pass, program: { ...pass.program, module } };
  const [first, ...rest] = material.passes;
  return {
    ...material,
    parameters: contract.parameters ?? [],
    values: Object.fromEntries(
      Object.entries(material.values ?? {}).filter(([name]) =>
        contract.parameters?.some((parameter) => parameter.name === name),
      ),
    ),
    passes: [replace(first), ...rest.map(replace)],
  };
}
