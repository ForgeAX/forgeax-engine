import {
  renderProfileForQuality,
  renderProfileForRequirements,
  textureMipSkipForQuality,
} from '@forgeax/engine-render/internal/host-data';
import { err, ok, type Result } from '@forgeax/engine-types';
import {
  freezeConfiguration,
  mergeConfiguration,
  ownConfigurationData,
  recordSources,
} from './configuration-data';
import { EngineConfigurationError } from './configuration-error';
import {
  type DeviceProfileDefinition,
  type EngineConfigurationDefinition,
  type EngineSettings,
  type EngineStartupPlan,
  type HostDeviceFacts,
  QUALITY_GROUPS,
  QUALITY_LEVELS,
  type QualityGroups,
  type QualityLevel,
  type QualitySelection,
} from './configuration-types';
import { ownEngineConfiguration, validateQualitySelection } from './configuration-validation';

export { EngineConfigurationError } from './configuration-error';
export * from './configuration-types';

const WECHAT_VIEW_SETTINGS: EngineSettings = { rendering: { view: { maxRenderShortSide: 720 } } };

const DEFAULT_PROFILES: readonly DeviceProfileDefinition[] = freezeConfiguration([
  { id: 'Default', defaults: { preset: 'high' } },
  { id: 'IOS', extends: 'Default', match: { platform: 'ios' } },
  { id: 'Android', extends: 'Default', match: { platform: 'android' } },
  { id: 'Desktop', extends: 'Default' },
  { id: 'Mac', extends: 'Desktop', match: { platform: 'macos' } },
  { id: 'Windows', extends: 'Desktop', match: { platform: 'windows' } },
  { id: 'Linux', extends: 'Desktop', match: { platform: 'linux' } },
]);

export function qualityPreset(level: QualityLevel): QualityGroups {
  return Object.fromEntries(
    QUALITY_GROUPS.map((group) => [group, level]),
  ) as unknown as QualityGroups;
}

function failure(
  code: ConstructorParameters<typeof EngineConfigurationError>[0],
  path: string,
  reason: string,
): never {
  throw new EngineConfigurationError(code, { path, reason });
}

function profileChain(
  id: string,
  profiles: ReadonlyMap<string, DeviceProfileDefinition>,
  trail: readonly string[] = [],
): readonly DeviceProfileDefinition[] {
  if (trail.includes(id))
    failure('configuration-inheritance-cycle', id, [...trail, id].join(' -> '));
  const profile = profiles.get(id);
  if (profile === undefined)
    failure('configuration-profile-missing', id, 'profile or parent does not exist');
  return [
    ...(profile.extends === undefined
      ? []
      : profileChain(profile.extends, profiles, [...trail, id])),
    profile,
  ];
}

function collectProfiles(
  definitions: readonly DeviceProfileDefinition[],
  facts: HostDeviceFacts,
): Map<string, DeviceProfileDefinition> {
  const profiles = new Map(
    DEFAULT_PROFILES.map((profile) => [
      profile.id,
      profile.id === 'Default' && facts.runtime === 'wechat'
        ? { ...profile, settings: WECHAT_VIEW_SETTINGS }
        : profile,
    ]),
  );
  const added = new Set<string>();
  for (const profile of definitions) {
    if (added.has(profile.id) || (profiles.has(profile.id) && !profile.override)) {
      failure(
        'configuration-invalid',
        profile.id,
        'duplicate profile; replacing an engine definition requires override: true',
      );
    }
    added.add(profile.id);
    profiles.set(profile.id, profile);
  }
  for (const id of profiles.keys()) profileChain(id, profiles);
  return profiles;
}

function selectProfile(
  profiles: ReadonlyMap<string, DeviceProfileDefinition>,
  facts: HostDeviceFacts,
  explicit: string | undefined,
): string {
  if (explicit !== undefined) return explicit;
  const matches = [...profiles.values()].filter(
    (profile) =>
      profile.match !== undefined &&
      Object.entries(profile.match).every(
        ([key, expected]) => facts[key as keyof HostDeviceFacts] === expected,
      ),
  );
  const best = Math.max(...matches.map((profile) => profile.priority ?? 0));
  const selected = matches.filter((profile) => (profile.priority ?? 0) === best);
  if (selected.length > 1)
    failure(
      'configuration-match-ambiguous',
      'deviceProfiles.match',
      selected.map((profile) => profile.id).join(', '),
    );
  return selected[0]?.id ?? 'Default';
}

/** Device recommendations, explicit intent and inherited ceilings share one group projection. */
function resolveQuality(
  chain: readonly DeviceProfileDefinition[],
  selection: QualitySelection,
  intentSource: 'project' | 'user',
  sources: Record<string, string>,
): Pick<EngineStartupPlan, 'requestedGroups' | 'effectiveGroups' | 'preset' | 'constraints'> {
  let presetSource = 'Default';
  const defaultGroupSources: Partial<Record<import('./configuration-types').QualityGroup, string>> =
    {};
  let defaults: NonNullable<DeviceProfileDefinition['defaults']> = {};
  for (const profile of chain) {
    defaults = mergeConfiguration(defaults, profile.defaults);
    if (profile.defaults?.preset !== undefined) presetSource = profile.id;
    for (const group of QUALITY_GROUPS)
      if (profile.defaults?.groups?.[group] !== undefined) defaultGroupSources[group] = profile.id;
  }
  const base =
    selection.base.kind === 'preset' ? selection.base.preset : (defaults.preset ?? 'high');
  const requestedGroups = {
    ...qualityPreset(base),
    ...(selection.base.kind === 'device-default' ? defaults.groups : {}),
    ...selection.groups,
  };
  const effectiveGroups = { ...requestedGroups };
  const constraints: EngineStartupPlan['constraints'][number][] = [];
  for (const group of QUALITY_GROUPS) {
    let limiting: string | undefined;
    for (const profile of chain) {
      const maximum = profile.constraints?.maximumQuality?.[group];
      if (
        maximum !== undefined &&
        QUALITY_LEVELS.indexOf(effectiveGroups[group]) > QUALITY_LEVELS.indexOf(maximum)
      ) {
        effectiveGroups[group] = maximum;
        limiting = profile.id;
      }
    }
    if (limiting !== undefined)
      constraints.push({
        group,
        requested: requestedGroups[group],
        effective: effectiveGroups[group],
        profile: limiting,
      });
    sources[`quality.${group}`] =
      selection.groups?.[group] !== undefined
        ? `${intentSource}-group`
        : selection.base.kind === 'preset'
          ? `${intentSource}-preset`
          : (defaultGroupSources[group] ?? presetSource);
  }
  const preset =
    QUALITY_LEVELS.find((level) =>
      QUALITY_GROUPS.every((group) => requestedGroups[group] === level),
    ) ?? 'custom';
  return { requestedGroups, effectiveGroups, preset, constraints };
}

/** Pure device/quality composition; no native object, environment read or global state. */
export function resolveEngineStartup(
  input: unknown,
  facts: HostDeviceFacts,
  saved?: QualitySelection,
  revision = 1,
): Result<EngineStartupPlan, EngineConfigurationError> {
  try {
    if (!Number.isSafeInteger(revision) || revision < 1)
      throw new EngineConfigurationError('configuration-invalid', {
        path: 'revision',
        reason: 'a positive safe integer is required',
      });
    if (
      !['ios', 'android', 'macos', 'windows', 'linux', 'unknown'].includes(facts.platform) ||
      (facts.runtime !== undefined && !['browser', 'wechat', 'native'].includes(facts.runtime)) ||
      (facts.model !== undefined && (typeof facts.model !== 'string' || facts.model.length === 0))
    )
      throw new EngineConfigurationError('configuration-invalid', {
        path: 'facts',
        reason: 'Host observations must use the declared platform and runtime vocabulary',
      });
    const definition = ownEngineConfiguration(input);
    const profiles = collectProfiles(definition.deviceProfiles ?? [], facts);
    const id = selectProfile(profiles, facts, definition.deviceProfile);
    const chain = profileChain(id, profiles);
    const sources: Record<string, string> = {};
    let settings: EngineSettings = {};
    for (const profile of chain) {
      settings = mergeConfiguration(settings, profile.settings);
      recordSources(profile.settings, profile.id, sources);
    }
    settings = mergeConfiguration(settings, definition.settings);
    recordSources(definition.settings, 'project', sources);
    const selection = ownConfigurationData(
      saved ?? definition.quality ?? { base: { kind: 'device-default' } },
    ) as QualitySelection;
    validateQualitySelection(selection);
    const quality = resolveQuality(
      chain,
      selection,
      saved === undefined ? 'project' : 'user',
      sources,
    );
    return ok(
      freezeConfiguration({
        schemaVersion: 1,
        revision,
        facts: ownConfigurationData(facts) as HostDeviceFacts,
        profileId: id,
        profileChain: chain.map((profile) => profile.id),
        settings,
        rendering: {
          profile: {
            ...renderProfileForQuality(
              settings.rendering?.profile ?? renderProfileForRequirements(settings.rendering ?? {}),
              quality.effectiveGroups,
              settings.rendering?.qualityLimits,
            ),
            configurationRevision: revision,
          },
          textureMipSkip: textureMipSkipForQuality(
            quality.effectiveGroups.textures,
            settings.rendering?.qualityLimits,
          ),
        },
        selection,
        ...quality,
        sources,
      }),
    );
  } catch (cause) {
    if (cause instanceof EngineConfigurationError) return err(cause);
    return err(
      new EngineConfigurationError('configuration-invalid', {
        path: 'configuration',
        reason: 'configuration validation failed',
        cause,
      }),
    );
  }
}

/** Compose explicit Host overrides into project defaults before device resolution. */
export function withEngineSettings(
  definition: EngineConfigurationDefinition,
  settings: EngineSettings,
): EngineConfigurationDefinition {
  return { ...definition, settings: mergeConfiguration(definition.settings ?? {}, settings) };
}
