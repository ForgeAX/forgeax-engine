import {
  admitRayMaterial,
  type RayMaterialError,
  type RaySurfaceProgram,
  rayMaterialContract,
  rayMaterialFailure,
} from '@forgeax/engine-shader';
import {
  derive,
  type MaterialAsset,
  type MaterialError,
  type MaterialTable,
  ok,
  type Result,
  resolveMaterialAsset,
  selectMaterialStaticContract,
  standardPhysicalTextureFields,
  stripWgslComments,
} from '@forgeax/engine-types';
import { compileShader, type PreparedShaderCompiler } from '../compile.js';
import type { ShaderError } from '../errors.js';
import { compareDerivedMaterialInterface } from '../reflection.js';
import { staticCardContextFailure } from './card-context.js';
import { composeSurfaceSource, digestMaterialSourceClosure } from './compose.js';
import { generateParameterModule, type MaterialCompilation } from './cook.js';
import { lowerStandardContract, lowerStandardPhysicalBindings } from './lower-standard-contract.js';
import type { MaterialSourceCatalog } from './source-catalog.js';

// Ray compute cannot use screen derivatives. Project Surface closures without
// an explicit ray-context path remain raster-only; the native compiler still
// validates every claimed context path before any ray program is published.
const SCREEN_DERIVATIVE_RE =
  /\b(?:dpdx|dpdy|fwidth)(?:Coarse|Fine)?\s*\(|\btextureSample(?:Bias)?\s*\(/;

function surfaceUsesScreenDerivatives(source: string): boolean {
  const code = stripWgslComments(source);
  return SCREEN_DERIVATIVE_RE.test(code) && !/\bRAY_SURFACE_CONTEXT\b/.test(code);
}

export interface RayMaterialCookRequest {
  readonly material: string;
  readonly table: MaterialTable;
  readonly sources: MaterialSourceCatalog;
  /** The diagnostic raster adapter evaluates the exact same Surface at matched points. */
  readonly context?: RaySurfaceProgram['context'];
}
export interface CookedRayMaterial {
  readonly asset: MaterialAsset;
  readonly program: RaySurfaceProgram;
  readonly sourceClosure: readonly string[];
}
type RayCookError = MaterialError | RayMaterialError | ShaderError;

/** Build-time derivative of the same resolved MaterialAsset. */
export async function cookRayMaterial(
  request: RayMaterialCookRequest,
  compile: typeof compileShader = compileShader,
): Promise<Result<CookedRayMaterial, RayCookError>> {
  const work = rayMaterialCompilation(request);
  let next = work.next();
  while (!next.done) next = work.next(await compile(...next.value));
  return next.value;
}

/** Compile the selected Ray or Card context using the same MaterialAsset contract. */
export function compileRayMaterialSelection(
  request: RayMaterialCookRequest,
  compiler: PreparedShaderCompiler,
): Result<CookedRayMaterial, RayCookError> {
  const work = rayMaterialCompilation(request);
  let next = work.next();
  while (!next.done) next = work.next(compiler.compile(...next.value));
  return next.value;
}

function* rayMaterialCompilation(
  request: RayMaterialCookRequest,
): MaterialCompilation<CookedRayMaterial, RayCookError> {
  const resolved = resolveMaterialAsset(request.material, request.table);
  if (!resolved.ok) return resolved;
  const asset = selectMaterialStaticContract(resolved.value.asset);
  const context = request.context ?? 'ray-hit';
  const admitted = admitRayMaterial(asset, request.material, context);
  if (!admitted.ok) return admitted;
  const lowered = lowerStandardContract(asset.parameters ?? [], asset.passes, request.material);
  if (!lowered.ok) return lowered;
  const forward = asset.passes?.find((p) => p.name.toLowerCase() === 'forward');
  const surfaceModule =
    forward?.program.moduleSlots?.surface ??
    asset.surface?.module ??
    'forgeax_material::default_standard_surface';
  const composed = composeSurfaceSource({
    material: request.material,
    pass: context,
    templateModule: 'forgeax_material::ray_surface',
    sources: request.sources,
    generatedParameters: generateParameterModule(lowered.value.paramSchema),
    surfaceModule,
  });
  if (!composed.ok) return composed;
  if (
    context === 'ray-hit' &&
    [composed.value.surfaceModule, ...composed.value.sourceClosure].some((moduleId) => {
      const record = request.sources.get(moduleId);
      return (
        record.ok &&
        (moduleId === composed.value.surfaceModule || record.value.provenance === 'project') &&
        surfaceUsesScreenDerivatives(record.value.source)
      );
    })
  )
    return rayMaterialFailure(
      request.material,
      composed.value.surfaceModule,
      'explicit filtering: the Surface uses screen-space derivatives, which ray hits lack',
    );
  const source = lowerStandardPhysicalBindings(composed.value.source, lowered.value.paramSchema);
  const defines = {
    ...lowered.value.defines,
    ALPHA_HASH_AVAILABLE: false,
    // Ray hits report rejected coverage; Card captures decide whether their
    // geometry proxy should keep it. Neither path discards inside the Surface.
    SURFACE_COVERAGE_DEFERRED: true,
    RAY_SURFACE_CONTEXT: context === 'ray-hit',
    CARD_SURFACE_CONTEXT: context === 'card-capture',
  };
  const options = {
    // The template/context owns compiler identity; material identity stays in publication.
    id: `forgeax_material::ray_surface::${context}`,
    imports: { ...composed.value.imports },
    defines,
    ...(context === 'card-capture'
      ? {
          valueMemberReads: 'shader-value-member-reads/1' as const,
          renderEntries: {
            vertex: 'vs_card',
            fragment: 'fs_card',
            colorFormats: ['rgba16float', 'rgba16float', 'rgba16float', 'rgba16float'] as const,
          },
        }
      : {}),
  };
  const compiled = yield [source, options];
  if (!compiled.ok) return compiled;
  if (context === 'card-capture') {
    const schema = lowered.value.paramSchema;
    const checked = compareDerivedMaterialInterface(
      derive(schema),
      compiled.value.reflection,
      new Set(standardPhysicalTextureFields(schema)),
      true,
    );
    if (!checked.ok) return checked;
    const material = yield [
      lowerStandardPhysicalBindings(generateParameterModule(schema), schema),
      { id: 'forgeax_material::card_parameter_contract' },
    ];
    if (!material.ok) return material;
    const failure = staticCardContextFailure(compiled.value.reflection, material.value.reflection);
    if (failure !== undefined)
      return rayMaterialFailure(
        request.material,
        composed.value.surfaceModule,
        `static Card inputs: ${failure}`,
      );
  }
  return ok({
    asset,
    sourceClosure: composed.value.sourceClosure,
    program: {
      context,
      wgsl: compiled.value.wgsl,
      paramSchema: lowered.value.paramSchema,
      contract: rayMaterialContract(asset, context),
      sourceClosureDigest: digestMaterialSourceClosure({
        ...composed.value.imports,
        source,
        context: JSON.stringify({
          defines,
          valueMemberReads: options.valueMemberReads,
          staticCardPolicy: 'reachable-surface-context/2',
        }),
      }),
    },
  });
}
