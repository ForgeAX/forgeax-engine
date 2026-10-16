import { DEFAULT_STANDARD_SURFACE_MODULE } from '@forgeax/engine-shader';
import type {
  MaterialPass,
  MaterialRenderState,
  MaterialValue,
  StandardLayerPlan,
} from '@forgeax/engine-types';
import { shadowCasterRenderState } from '../../material-render-state';

export const STANDARD_MATERIAL_MODULE = 'forgeax_material::standard';
export { DEFAULT_STANDARD_SURFACE_MODULE };

export type StandardSurfacePassName = 'forward' | 'deferred' | 'shadow-caster';
export type StandardSurfaceGeometryVariant = 'rigid' | 'skinned' | 'instanced';
export type StandardSurfaceLightingLane = 'direct' | 'clustered';
export type StandardSurfaceKind = 'standard' | 'full-custom';

export interface StandardSurfaceProjectionOptions {
  readonly surfaceModule: string;
  readonly values: Readonly<Record<string, MaterialValue | null>>;
  readonly renderState?: MaterialRenderState;
  readonly queue?: number;
  readonly geometryVariant?: StandardSurfaceGeometryVariant;
  readonly lightingLane?: StandardSurfaceLightingLane;
  readonly alphaClip?: boolean;
  readonly surfaceKind?: StandardSurfaceKind;
  readonly declaredPasses?: readonly StandardSurfacePassName[];
  readonly layerPlan?: StandardLayerPlan;
}

function pass(
  name: StandardSurfacePassName,
  options: StandardSurfaceProjectionOptions,
  fragmentEntry: string,
): MaterialPass {
  const authoredState = options.renderState ?? {};
  const authoredRecord = authoredState as Readonly<Record<string, unknown>>;
  const tags = (authoredRecord.tags ?? {}) as Readonly<Record<string, string>>;
  const lightMode =
    name === 'shadow-caster' ? 'ShadowCaster' : name === 'forward' ? 'Forward' : 'Deferred';
  return {
    name,
    program: {
      module:
        name === 'shadow-caster' ? 'forgeax::default-shadow-caster' : STANDARD_MATERIAL_MODULE,
      fragmentEntry,
      moduleSlots: { surface: options.surfaceModule },
    },
    renderState: {
      ...(name === 'shadow-caster' ? shadowCasterRenderState(authoredState) : authoredState),
      tags:
        options.surfaceModule === DEFAULT_STANDARD_SURFACE_MODULE
          ? { LightMode: lightMode, ...tags }
          : {
              ...tags,
              LightMode: lightMode,
              SurfaceModule: options.surfaceModule,
              SurfaceKind: options.surfaceKind ?? 'standard',
              GeometryVariant: options.geometryVariant ?? 'rigid',
              LightingLane: options.lightingLane ?? 'direct',
              AlphaClip: options.alphaClip === true ? 'enabled' : 'disabled',
            },
      ...(options.queue === undefined ? {} : { queue: options.queue }),
    },
  };
}

/** Project one custom or default Surface into the existing Standard pass family. */
export function projectStandardSurfacePasses(
  options: StandardSurfaceProjectionOptions,
): [MaterialPass, ...MaterialPass[]] {
  const authoredPasses = options.declaredPasses;
  const passNames: StandardSurfacePassName[] =
    options.surfaceKind === 'full-custom' && authoredPasses !== undefined
      ? [...authoredPasses]
      : (['forward'] as StandardSurfacePassName[]);
  if (authoredPasses === undefined || options.surfaceKind !== 'full-custom') {
    const blended = options.renderState?.blend !== undefined;
    if (!blended && options.layerPlan?.mode !== 'physical') passNames.push('deferred');
    passNames.push('shadow-caster');
  }
  const entries = passNames.map((name) =>
    pass(
      name,
      options,
      name === 'forward' ? 'fs_main' : name === 'deferred' ? 'fs_gbuffer' : 'fs_shadow',
    ),
  );
  const passes = entries as [MaterialPass, ...MaterialPass[]];
  return passes;
}
