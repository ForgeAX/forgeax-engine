import { AssetGuid } from '@forgeax/engine-pack/guid';
import { parsePackSourceJson, projectDirectPackJson } from '@forgeax/engine-pack/source';
import {
  type MaterialAsset,
  type MaterialPass,
  type MaterialRootAsset,
  selectMaterialStaticContract,
} from '@forgeax/engine-types';
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
      const source = parsePackSourceJson(pack).unwrap();
      if (source.format !== 'direct') throw new Error('Physical shader package must be direct');
      const entry = projectDirectPackJson(source).assets[0];
      if (entry === undefined) throw new Error('Physical shader package has no assets');
      const material = entry.payload as unknown as MaterialRootAsset;
      const pass = material.passes?.[0];
      if (pass === undefined) throw new Error('Physical shader package has no passes');
      const parent = AssetGuid.parse(entry.guid);
      if (!parent.ok) throw new Error('Physical shader package has invalid GUID');
      const activeParameters = selectMaterialStaticContract(material, true).parameters;
      return { guid: entry.guid, parent: parent.value, module: pass.program.module, material, activeParameters };
    },
  );
const contracts = new Map(physicalMaterialRoots.map((root) => [root.module, root]));

/** Runtime values inherit the accepted Catalog root and its cooked program identity. */
export function physicalMaterialChild(material: MaterialAsset, module: string): MaterialAsset {
  const root = contracts.get(module);
  if (root === undefined) throw new Error(`Unknown physical material contract: ${module}`);
  return {
    kind: 'material',
    parent: root.guid,
    values: Object.fromEntries(
      Object.entries(material.values ?? {}).filter(([name]) =>
        root.activeParameters?.some((parameter) => parameter.name === name),
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
      Object.entries({ ...contract.values, ...material.values }).filter(([name]) =>
        contract.parameters?.some((parameter) => parameter.name === name),
      ),
    ),
    passes: [replace(first), ...rest.map(replace)],
  };
}
