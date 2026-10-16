import type { MaterialParameter, MaterialPass } from './asset.js';
import {
  createMaterialError,
  type MaterialErrorFor,
  type MaterialPhysicalContractInvalidDetail,
  type MaterialPhysicalLayer,
} from './errors.js';
import {
  type MaterialStaticSwitches,
  standardMaterialParameterEnabled,
} from './static-switches.js';

export type StandardLayerMode = 'base-only' | 'physical';
export type StandardPassFamily = 'forward' | 'deferred' | 'shadow';

export interface StandardLayerPlanEntry {
  readonly name: MaterialPhysicalLayer;
  readonly parameters: readonly string[];
}

/**
 * Root-parameter groups used by the Standard physical projection.  This is
 * intentionally data-only and shared by render/compiler callers through
 * `deriveStandardLayerPlan`; texture axes are optional supplements and do not
 * make an otherwise complete layer incomplete.
 */
export const STANDARD_LAYER_PARAMETER_GROUPS = Object.freeze({
  anisotropy: ['anisotropyStrength', 'anisotropyRotation'] as const,
  iridescence: [
    'iridescence',
    'iridescenceIor',
    'iridescenceThicknessMinimum',
    'iridescenceThicknessMaximum',
  ] as const,
  sheen: ['sheenColor', 'sheenRoughness'] as const,
  clearcoat: ['clearcoat', 'clearcoatRoughness'] as const,
  diffuseTransmission: ['diffuseTransmission', 'diffuseTransmissionColor'] as const,
});

/**
 * Physical texture slots are part of the Standard root vocabulary, not a
 * renderer or compiler inventory.  Consumers project this tuple against the
 * effective root schema so an authored declaration is the only thing that
 * admits a resource binding.
 */
export const STANDARD_PHYSICAL_TEXTURE_FIELDS = [
  'clearcoatTexture',
  'clearcoatRoughnessTexture',
  'clearcoatNormalTexture',
  'anisotropyTexture',
  'sheenColorTexture',
  'sheenRoughnessTexture',
  'iridescenceTexture',
  'iridescenceThicknessTexture',
  'specularTexture',
  'specularColorTexture',
  'diffuseTransmissionTexture',
  'diffuseTransmissionColorTexture',
] as const;

export type StandardPhysicalTextureField = (typeof STANDARD_PHYSICAL_TEXTURE_FIELDS)[number];

export function standardPhysicalTextureFields(
  schema: readonly { readonly name: string }[],
): readonly StandardPhysicalTextureField[] {
  const names = new Set(schema.map((entry) => entry.name));
  return STANDARD_PHYSICAL_TEXTURE_FIELDS.filter((field) => names.has(field));
}

/** Scalar + texture names whose declaration selects a physical Standard layer. */
export const STANDARD_PHYSICAL_PARAMETER_NAMES = new Set<string>([
  ...STANDARD_LAYER_PARAMETER_GROUPS.anisotropy,
  ...STANDARD_LAYER_PARAMETER_GROUPS.iridescence,
  ...STANDARD_LAYER_PARAMETER_GROUPS.sheen,
  ...STANDARD_LAYER_PARAMETER_GROUPS.clearcoat,
  ...STANDARD_LAYER_PARAMETER_GROUPS.diffuseTransmission,
  'clearcoatNormalScale',
  ...STANDARD_PHYSICAL_TEXTURE_FIELDS,
]);

/** Existing transmission owner fields; they are not a physical layer. */
export const STANDARD_TRANSMISSION_PARAMETER_NAMES = new Set<string>([
  'transmission',
  'ior',
  'thickness',
  'attenuationColor',
  'attenuationDistance',
  'transmissionTexture',
  'thicknessTexture',
]);

export interface StandardLayerPlan {
  readonly mode: StandardLayerMode;
  readonly layers: readonly StandardLayerPlanEntry[];
  readonly passFamily: readonly StandardPassFamily[];
  readonly identity: string;
}

export class MaterialPhysicalContractError extends Error {
  readonly code = 'material-physical-contract-invalid' as const;
  readonly expected =
    'the Standard physical contract contains complete declared layers and valid passes';
  readonly hint = 'repair the root parameters or pass policy and derive the material again';
  readonly detail: MaterialPhysicalContractInvalidDetail;

  constructor(detail: Omit<MaterialPhysicalContractInvalidDetail, 'code'>) {
    super(`${detail.layer}: Standard physical contract is invalid (${detail.reason})`);
    this.name = 'MaterialPhysicalContractError';
    this.detail = { code: 'material-physical-contract-invalid', ...detail };
  }
}

const LAYER_PARAMETERS: readonly StandardLayerPlanEntry[] = [
  { name: 'anisotropy', parameters: STANDARD_LAYER_PARAMETER_GROUPS.anisotropy },
  { name: 'iridescence', parameters: STANDARD_LAYER_PARAMETER_GROUPS.iridescence },
  { name: 'sheen', parameters: STANDARD_LAYER_PARAMETER_GROUPS.sheen },
  { name: 'clearcoat', parameters: STANDARD_LAYER_PARAMETER_GROUPS.clearcoat },
  {
    name: 'diffuseTransmission',
    parameters: STANDARD_LAYER_PARAMETER_GROUPS.diffuseTransmission,
  },
];

function planIdentity(
  mode: StandardLayerMode,
  layers: readonly StandardLayerPlanEntry[],
  passFamily: readonly StandardPassFamily[],
): string {
  return `standard-layer-plan-v1:${mode}:${layers
    .map((layer) => `${layer.name}(${layer.parameters.join(',')})`)
    .join('|')}:${passFamily.join(',')}`;
}

function invalid(
  detail: Omit<MaterialPhysicalContractInvalidDetail, 'code'>,
): MaterialPhysicalContractError {
  return new MaterialPhysicalContractError(detail);
}

/** Derive the transient layer and pass projection from one effective root contract. */
export function deriveStandardLayerPlan(
  parameters: readonly MaterialParameter[],
  passes?: readonly MaterialPass[],
  staticSwitches?: MaterialStaticSwitches,
): StandardLayerPlan {
  const names = new Set(
    parameters
      .filter((parameter) => standardMaterialParameterEnabled(parameter, staticSwitches))
      .map((parameter) => parameter.name),
  );
  const layers: StandardLayerPlanEntry[] = [];
  for (const layer of LAYER_PARAMETERS) {
    const present = layer.parameters.filter((name) => names.has(name));
    if (present.length === 0) continue;
    if (present.length !== layer.parameters.length) {
      throw invalid({
        material: 'Standard',
        layer: layer.name,
        missing: layer.parameters.filter((name) => !names.has(name)),
        reason: 'incomplete-layer',
      });
    }
    layers.push(layer);
  }

  // Texture-backed Standard extensions are still part of the physical root
  // contract even when they do not introduce a separate scalar layer (the
  // KHR specular maps are the current example). Their declaration must move
  // the material to Forward so a Deferred g-buffer cannot silently discard
  // the authored response.
  const hasPhysicalTexture = STANDARD_PHYSICAL_TEXTURE_FIELDS.some((field) => names.has(field));
  const mode: StandardLayerMode =
    layers.length === 0 && !hasPhysicalTexture ? 'base-only' : 'physical';
  const passFamily: readonly StandardPassFamily[] =
    mode === 'base-only' ? ['forward', 'deferred', 'shadow'] : ['forward', 'shadow'];
  if (mode === 'physical') {
    const deferredPass = passes?.find((pass) => {
      const tags = pass.renderState?.tags;
      return (
        pass.name === 'deferred' ||
        (typeof tags === 'object' &&
          tags !== null &&
          'LightMode' in tags &&
          tags.LightMode === 'Deferred')
      );
    });
    if (deferredPass !== undefined) {
      throw invalid({
        material: 'Standard',
        layer: layers[0]?.name ?? 'root',
        pass: deferredPass.name,
        reason: 'deferred-pass',
      });
    }
  }
  return Object.freeze({
    mode,
    layers,
    passFamily,
    identity: planIdentity(mode, layers, passFamily),
  });
}

export function isMaterialPhysicalContractError(
  value: unknown,
): value is MaterialPhysicalContractError | MaterialErrorFor<'material-physical-contract-invalid'> {
  return (
    value instanceof MaterialPhysicalContractError ||
    (typeof value === 'object' &&
      value !== null &&
      'code' in value &&
      value.code === 'material-physical-contract-invalid')
  );
}

export function materialPhysicalContractResult(
  detail: Omit<MaterialPhysicalContractInvalidDetail, 'code'>,
): MaterialErrorFor<'material-physical-contract-invalid'> {
  return createMaterialError('material-physical-contract-invalid', {
    code: 'material-physical-contract-invalid',
    ...detail,
  });
}
