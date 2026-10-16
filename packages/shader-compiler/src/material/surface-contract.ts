import type {
  MaterialError,
  MaterialErrorFor,
  MaterialSurfaceModel,
  Result,
} from '@forgeax/engine-types';
import { createMaterialError, err, ok } from '@forgeax/engine-types';

export const SURFACE_SLOT = 'surface' as const;
export const SURFACE_EXPORT = 'evaluate_surface' as const;
export const SURFACE_ABI = 'fn evaluate_surface(input: SurfaceInput) -> SurfaceData' as const;
export const SINGLE_LAYER_MEDIUM_SURFACE_ABI =
  'fn evaluate_surface(input: SingleLayerMediumSurfaceInput) -> SingleLayerMediumSurfaceData' as const;
export const SINGLE_LAYER_MEDIUM_SURFACE_MODULE =
  'forgeax_material::single_layer_medium_surface_v1' as const;

export interface SurfaceContractRequest {
  readonly material: string;
  readonly pass: string;
  readonly source: string;
  readonly sourcePath: string;
  readonly model?: MaterialSurfaceModel;
}

export interface SurfaceContract {
  readonly module: string;
  readonly sourcePath: string;
  readonly exportName: typeof SURFACE_EXPORT;
}

type SurfaceContractError =
  | MaterialErrorFor<'material-surface-abi-mismatch'>
  | MaterialErrorFor<'material-surface-forbidden-interface'>;

function abiMismatch(
  request: SurfaceContractRequest,
  actual: string,
): MaterialErrorFor<'material-surface-abi-mismatch'> {
  return createMaterialError('material-surface-abi-mismatch', {
    code: 'material-surface-abi-mismatch',
    material: request.material,
    pass: request.pass,
    source: request.sourcePath,
    slot: SURFACE_SLOT,
    expected:
      request.model === 'single-layer-medium' ? SINGLE_LAYER_MEDIUM_SURFACE_ABI : SURFACE_ABI,
    actual,
    action: 'repair-surface-export',
  });
}

function forbiddenInterface(
  request: SurfaceContractRequest,
  interfaceName: Extract<
    MaterialError['detail'],
    { code: 'material-surface-forbidden-interface' }
  >['interface'],
): MaterialErrorFor<'material-surface-forbidden-interface'> {
  return createMaterialError('material-surface-forbidden-interface', {
    code: 'material-surface-forbidden-interface',
    material: request.material,
    pass: request.pass,
    source: request.sourcePath,
    slot: SURFACE_SLOT,
    interface: interfaceName,
    action: 'remove-forbidden-interface',
  });
}

function moduleName(source: string): string {
  return /^\s*#define_import_path\s+([A-Za-z0-9_.:-]+)/m.exec(source)?.[1] ?? '<anonymous-surface>';
}

const FORBIDDEN_INTERFACES: readonly [RegExp, Parameters<typeof forbiddenInterface>[1]][] = [
  [/@fragment\b/, 'fragment-entry'],
  [/@vertex\b/, 'vertex-entry'],
  [/@compute\b/, 'compute-entry'],
  [/@group\s*\(/, 'resource-binding'],
  [/@binding\s*\(/, 'resource-binding'],
  [/\bfn\s+(?:vs_main|fs_main|vertex_main|fragment_main)\s*\(/, 'engine-entry'],
  [/\bposition(?:OS|WS)\s*=\s*/, 'vertex-position-mutation'],
];

function validateForbiddenInterfaces(
  request: SurfaceContractRequest,
  source: string,
): Result<true, SurfaceContractError> {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');
  for (const [pattern, interfaceName] of FORBIDDEN_INTERFACES) {
    if (pattern.test(withoutComments)) return err(forbiddenInterface(request, interfaceName));
  }
  return ok(true);
}

/**
 * Validate a module imported by a Surface implementation.
 *
 * A helper cannot be required to export `evaluate_surface`, but it is still
 * part of the authored Surface's executable closure. Stage entry points and
 * resource declarations in that closure would give the helper a second
 * rendering owner, so they fail before naga composition as well.
 */
export function validateSurfaceDependency(
  request: SurfaceContractRequest,
): Result<true, SurfaceContractError> {
  return validateForbiddenInterfaces(request, request.source);
}

/** Validate the narrow author-facing Surface ABI before invoking the compiler. */
export function validateSurfaceSource(
  request: SurfaceContractRequest,
): Result<SurfaceContract, SurfaceContractError> {
  const source = request.source;
  const exportMatches = [...source.matchAll(/\bfn\s+evaluate_surface\s*\(/g)];
  if (exportMatches.length !== 1) {
    return err(abiMismatch(request, `evaluate_surface declarations: ${exportMatches.length}`));
  }
  const exportPattern =
    request.model === 'single-layer-medium'
      ? /fn\s+evaluate_surface\s*\(\s*input\s*:\s*SingleLayerMediumSurfaceInput\s*\)\s*->\s*SingleLayerMediumSurfaceData\s*\{/u
      : /fn\s+evaluate_surface\s*\(\s*input\s*:\s*SurfaceInput\s*\)\s*->\s*SurfaceData\s*\{/u;
  if (!exportPattern.test(source)) return err(abiMismatch(request, 'evaluate_surface signature'));

  const interfaces = validateForbiddenInterfaces(request, source);
  if (!interfaces.ok) return interfaces;
  return ok({
    module: moduleName(source),
    sourcePath: request.sourcePath,
    exportName: SURFACE_EXPORT,
  });
}

/** Validate a single-layer medium Surface without exposing a water category. */
export function validateSingleLayerMediumSurfaceSource(
  request: Omit<SurfaceContractRequest, 'model'>,
): Result<SurfaceContract, SurfaceContractError> {
  return validateSurfaceSource({ ...request, model: 'single-layer-medium' });
}
