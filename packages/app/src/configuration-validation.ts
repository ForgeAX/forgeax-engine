import { validateAssetBudgetBytes } from '@forgeax/engine-assets-runtime';
import { validateSolverIterations } from '@forgeax/engine-physics';
import {
  RENDERING_REQUIREMENT_KEYS,
  renderingRequirementsOf,
  renderProfileForRequirements,
  validateDynamicGeometryMeshBudget,
  validateRenderProfile,
  validateRenderQualityLimits,
} from '@forgeax/engine-render';
import { invalid, ownConfigurationData } from './configuration-data';
import {
  type EngineConfigurationDefinition,
  QUALITY_GROUPS,
  QUALITY_LEVELS,
} from './configuration-types';

type Rule =
  | 'positive'
  | 'integer'
  | 'nonnegative'
  | 'unsigned'
  | 'boolean'
  | 'string'
  | 'domain'
  | 'qualityLimits'
  | 'profile'
  | 'profiles'
  | readonly (string | number | boolean)[]
  | { readonly [key: string]: Rule };
const groups = Object.fromEntries(QUALITY_GROUPS.map((key) => [key, QUALITY_LEVELS]));
const settings: Rule = {
  presentation: { canvasPixelRatio: 'positive', outputColorSpace: ['srgb', 'display-p3'] },
  execution: {
    workers: {
      engine: ['auto', true, false],
      render: ['auto', true, false],
      kernels: ['auto', true, false],
    },
    taskWorkers: 'integer',
    renderPipelineCapacity: [2, 3, 4],
  },
  assets: { assetBudgetBytes: 'integer' },
  audio: {
    host: { maxCachedBytes: 'integer', maxCachedSources: 'integer', maxPendingPlays: 'integer' },
    publication: { maxPublishedBytes: 'integer', maxPublishedSources: 'integer' },
  },
  simulation: {
    time: {
      fixedDeltaSeconds: 'positive',
      maxStepsPerUpdate: 'integer',
      maxDeltaSeconds: 'positive',
      fixedCatchUp: ['substeps', 'merged'],
    },
    animation: { cadence: ['update', 'fixed'] },
    physics: { solverIterations: 'integer', asyncResultsInterpolation: 'boolean' },
  },
  rendering: {
    ...Object.fromEntries(RENDERING_REQUIREMENT_KEYS.map((key) => [key, 'domain' as const])),
    view: { maxRenderShortSide: 'unsigned' },
    qualityLimits: 'qualityLimits',
    profile: 'profile',
    renderBackend: ['auto', 'webgpu', 'webgl2'],
    resources: {
      dynamicGeometryMeshBudgetBytes: 'integer',
      featureTextureReadbackBudgetBytes: 'integer',
    },
  },
};
const match: Rule = {
  platform: ['ios', 'android', 'macos', 'windows', 'linux', 'unknown'],
  model: 'string',
  runtime: ['browser', 'wechat', 'native'],
};
const selection: Rule = {
  base: { kind: ['device-default', 'preset'], preset: QUALITY_LEVELS },
  groups,
};
const profile: Rule = {
  id: 'string',
  extends: 'string',
  override: 'boolean',
  match,
  priority: 'nonnegative',
  defaults: { preset: QUALITY_LEVELS, groups },
  settings,
  constraints: { maximumQuality: groups },
};

function validScalarRule(
  value: unknown,
  rule: Exclude<Rule, readonly unknown[] | object>,
): boolean {
  return rule === 'boolean'
    ? typeof value === 'boolean'
    : rule === 'string'
      ? typeof value === 'string' && value.length > 0
      : rule === 'profile' || rule === 'qualityLimits'
        ? value !== null && typeof value === 'object' && !Array.isArray(value)
        : rule === 'profiles'
          ? Array.isArray(value)
          : typeof value === 'number' &&
            Number.isFinite(value) &&
            (rule === 'nonnegative' || rule === 'unsigned' ? value >= 0 : value > 0) &&
            ((rule !== 'integer' && rule !== 'unsigned') || Number.isSafeInteger(value));
}

function validate(value: unknown, rule: Rule, path: string): void {
  if (Array.isArray(rule)) {
    if (!rule.includes(value as never)) invalid(path, 'not one of the declared values');
    return;
  }
  if (rule === 'domain') return;
  if (typeof rule === 'string') {
    const valid = validScalarRule(value, rule);
    if (!valid) invalid(path, `expected ${rule}`);
    return;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid(path, 'expected an object');
  for (const [key, child] of Object.entries(value)) {
    const childRule = (rule as { readonly [key: string]: Rule })[key];
    if (!Object.hasOwn(rule, key) || childRule === undefined)
      invalid(`${path}.${key}`, 'unknown configuration field');
    validate(child, childRule, `${path}.${key}`);
  }
}

export function validateQualitySelection(input: unknown): void {
  validate(input, selection, 'quality');
  const base = (input as { base?: { kind?: string; preset?: string } }).base;
  if (
    base === undefined ||
    base.kind === undefined ||
    (base.kind === 'preset' ? base.preset === undefined : base.preset !== undefined)
  ) {
    invalid(
      'quality.base',
      'preset selections require a preset; device-default selections do not accept one',
    );
  }
}

export function ownEngineConfiguration(input: unknown): EngineConfigurationDefinition {
  const owned = ownConfigurationData(input) as EngineConfigurationDefinition;
  validate(
    owned,
    {
      schemaVersion: [1],
      settings,
      quality: selection,
      deviceProfile: 'string',
      deviceProfiles: 'profiles',
    },
    'configuration',
  );
  validateDomainSettings(owned.settings);
  if (owned.quality !== undefined) validateQualitySelection(owned.quality);
  if (owned.deviceProfiles !== undefined) {
    if (!Array.isArray(owned.deviceProfiles)) invalid('deviceProfiles', 'expected an array');
    for (const item of owned.deviceProfiles) {
      validate(item, profile, 'deviceProfiles');
      validateDomainSettings(item.settings);
      if (item.id === undefined) invalid('deviceProfiles.id', 'a profile id is required');
      if (item.match !== undefined && Object.keys(item.match).length === 0)
        invalid(`deviceProfiles.${item.id}.match`, 'empty matches are ambiguous');
    }
  }
  return owned;
}

function validateDomainSettings(
  settings: import('./configuration-types').EngineSettings | undefined,
): void {
  if (settings === undefined) return;
  if (settings.assets?.assetBudgetBytes !== undefined)
    validateAssetBudgetBytes(settings.assets.assetBudgetBytes);
  if (settings.rendering?.resources?.dynamicGeometryMeshBudgetBytes !== undefined)
    validateDynamicGeometryMeshBudget(settings.rendering.resources.dynamicGeometryMeshBudgetBytes);
  if (settings.simulation?.physics?.solverIterations !== undefined)
    validateSolverIterations(settings.simulation.physics.solverIterations);
  const limits = settings.rendering?.qualityLimits;
  if (limits !== undefined) {
    const reason = validateRenderQualityLimits(limits);
    if (reason !== undefined) invalid('settings.rendering.qualityLimits', reason);
  }
  const legacy = settings.rendering?.profile;
  const requirements = renderingRequirementsOf(settings.rendering ?? {});
  if (legacy !== undefined && Object.keys(requirements).length > 0)
    invalid('settings.rendering', 'legacy profile and rendering requirements cannot compete');
  const profile = legacy ?? renderProfileForRequirements(requirements);
  if (profile !== undefined) {
    if (profile.quality !== undefined || profile.configurationRevision !== undefined)
      invalid(
        'settings.rendering.profile',
        'quality and revision are derived from the configuration request',
      );
    const reason = validateRenderProfile(profile);
    if (reason !== undefined) invalid('settings.rendering.profile', reason);
  }
}
