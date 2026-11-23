import { isStandardRootModule } from '@forgeax/engine-pack';
import {
  type MaterialAsset,
  type MaterialPass,
  STANDARD_LAYER_PARAMETER_GROUPS,
  standardMaterialParameters,
  standardSurfaceParameters,
  unlitMaterialParameters,
} from '@forgeax/engine-types';
import type { MaterialCookedPass } from './cook.js';
import { terrainProgramSource } from './terrain-program.js';

export const UNLIT_ROOT_MODULES = new Set(['forgeax_material::unlit', 'forgeax::default-unlit']);

export function supportsMaterialViewClipping(module: string): boolean {
  return (
    isStandardRootModule(terrainProgramSource(module)?.module ?? module) ||
    UNLIT_ROOT_MODULES.has(module) ||
    module === 'forgeax::default-shadow-caster'
  );
}

export function supportsMaterialLodCoverage(
  pass: MaterialCookedPass,
  sceneIndexAvailable = pass.sceneCompile !== undefined,
): boolean {
  return (
    sceneIndexAvailable &&
    pass.context.capability !== 'uniform-fallback' &&
    (pass.context.geometry === 'mesh' || pass.context.geometry === 'skinned') &&
    (pass.module === 'forgeax::default-shadow-caster' ||
      UNLIT_ROOT_MODULES.has(pass.module) ||
      (isStandardRootModule(pass.module) && pass.context.geometry !== 'skinned'))
  );
}

/**
 * Pack JSON keeps the authored pass intentionally small, but the renderer's
 * selector consumes the same LightMode tag that built-in Standard materials
 * publish.  Derive that policy at the Pack boundary so a cooked asset and an
 * in-memory Standard material enter the render graph with one pass identity.
 */
function normalizeMaterialPass(pass: MaterialPass): MaterialPass {
  const tags = pass.renderState?.tags;
  if (tags !== undefined && typeof tags === 'object' && tags !== null && 'LightMode' in tags) {
    return pass;
  }
  const lightMode =
    pass.name.toLowerCase() === 'shadow-caster'
      ? 'ShadowCaster'
      : pass.name.toLowerCase() === 'deferred'
        ? 'Deferred'
        : pass.name.toLowerCase() === 'forward'
          ? 'Forward'
          : undefined;
  if (lightMode === undefined) return pass;
  return {
    ...pass,
    renderState: {
      ...(pass.renderState ?? {}),
      tags: {
        LightMode: lightMode,
        ...(tags as Record<string, unknown> | undefined),
      },
    },
  };
}

export function normalizeMaterialAsset(source: MaterialAsset): MaterialAsset {
  const sourcePasses = source.passes;
  if (sourcePasses === undefined) return source;
  const passes = sourcePasses.map(normalizeMaterialPass);
  // Complete shorthand Engine authoring before composition. Publish the same
  // schema that the compiler consumes; explicit project contracts stay authoritative.
  let parameters = source.parameters;
  if (parameters === undefined && source.parent === undefined && source.surface === undefined) {
    if (sourcePasses.some((pass) => isStandardRootModule(pass.program.module))) {
      const names = new Set(Object.keys(source.values ?? {}));
      for (const group of Object.values(STANDARD_LAYER_PARAMETER_GROUPS)) {
        if (group.some((name) => names.has(name))) {
          for (const name of group) names.add(name);
        }
      }
      parameters = standardSurfaceParameters(standardMaterialParameters(names));
    } else if (sourcePasses.some((pass) => UNLIT_ROOT_MODULES.has(pass.program.module))) {
      parameters = unlitMaterialParameters(source.colorSpace ?? 'srgb');
    }
  }
  if (
    parameters === source.parameters &&
    passes.every((pass, index) => pass === sourcePasses[index])
  )
    return source;
  return {
    ...source,
    passes: passes as unknown as NonNullable<MaterialAsset['passes']>,
    ...(parameters === undefined ? {} : { parameters }),
  };
}
