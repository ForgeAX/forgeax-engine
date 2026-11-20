import { DEFAULT_STANDARD_PROFILE } from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';
import { resolveEngineStartup } from '../configuration';

const ios = { platform: 'ios', model: 'ExamplePhone' } as const;
const definition = {
  settings: { simulation: { time: { fixedDeltaSeconds: 1 / 60 } } },
  deviceProfiles: [
    {
      id: 'game-ios',
      extends: 'IOS',
      defaults: { preset: 'high', groups: { reflections: 'medium' } },
      settings: { audio: { host: { maxCachedBytes: 16 * 1024 * 1024 } } },
    },
    {
      id: 'example-phone',
      extends: 'game-ios',
      match: { platform: 'ios', model: 'ExamplePhone' },
      priority: 10,
      defaults: { groups: { shadows: 'low' } },
      settings: { assets: { assetBudgetBytes: 64 * 1024 * 1024 } },
    },
  ],
} as const;

describe('engine startup configuration', () => {
  it('resolves the named project AO settings independently from quality', () => {
    const defaultPlan = resolveEngineStartup({}, ios).unwrap();
    expect(defaultPlan.rendering.profile.ambientOcclusion).toEqual({
      enabled: false,
      method: 'ssao',
    });
    const enabled = resolveEngineStartup(
      { settings: { rendering: { ambientOcclusion: { enabled: true, method: 'gtao' } } } },
      ios,
    ).unwrap();
    expect(enabled.rendering.profile.ambientOcclusion).toMatchObject({
      enabled: true,
      method: 'gtao',
    });
  });

  it('migrates a saved legacy profile without changing its selected AO method', () => {
    const { ambientOcclusion: _ambientOcclusion, ...profile } = DEFAULT_STANDARD_PROFILE;
    const legacy = { ...profile, ssao: true };
    const startup = resolveEngineStartup(
      { schemaVersion: 1, settings: { rendering: { profile: legacy } } },
      ios,
    ).unwrap();
    expect(startup.rendering.profile.ambientOcclusion).toMatchObject({
      enabled: true,
      method: 'gtao',
    });
    expect(startup.rendering.profile).not.toHaveProperty('ssao');
    expect(legacy.ssao).toBe(true);
  });

  it('inherits the WeChat baseline through a custom device family while leaving Browser output native', () => {
    const native = resolveEngineStartup(definition, { ...ios, runtime: 'wechat' });
    const browser = resolveEngineStartup(definition, { ...ios, runtime: 'browser' });
    expect(native.ok && native.value.settings.rendering?.view?.maxRenderShortSide).toBe(720);
    expect(native.ok && native.value.profileChain).toEqual([
      'Default',
      'IOS',
      'game-ios',
      'example-phone',
    ]);
    expect(browser.ok && browser.value.settings.rendering?.view).toBeUndefined();
  });

  it('retains exact budget limits and their domain source in the immutable constructor plan', () => {
    const result = resolveEngineStartup(
      {
        settings: {
          rendering: {
            qualityLimits: { ambientOcclusion: { resolutionScale: 0.25 }, textureMipSkip: 3 },
          },
        },
      },
      ios,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rendering.profile.quality?.ambientOcclusion.resolutionScale).toBe(0.25);
    expect(result.value.rendering.textureMipSkip).toBe(3);
    expect(
      result.value.sources['settings.rendering.qualityLimits.ambientOcclusion.resolutionScale'],
    ).toBe('project');
  });

  it.each([
    'constructor',
    'toString',
    'hasOwnProperty',
  ])('rejects an inherited schema name as an unknown field: %s', (key) => {
    const result = resolveEngineStartup({ settings: { [key]: {} } }, ios);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail.path).toBe(`configuration.settings.${key}`);
  });

  it('composes one device chain across audio, assets, simulation and quality', () => {
    const result = resolveEngineStartup(definition, ios);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const plan = result.value;
    expect(plan.profileChain).toEqual(['Default', 'IOS', 'game-ios', 'example-phone']);
    expect(plan.settings.audio?.host?.maxCachedBytes).toBe(16 * 1024 * 1024);
    expect(plan.settings.assets?.assetBudgetBytes).toBe(64 * 1024 * 1024);
    expect(plan.settings.simulation?.time?.fixedDeltaSeconds).toBe(1 / 60);
    expect(plan.requestedGroups).toMatchObject({ reflections: 'medium', shadows: 'low' });
    expect(plan.preset).toBe('custom');
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.settings.audio?.host)).toBe(true);
  });

  it('replaces device quality defaults with a user preset while retaining device settings', () => {
    const result = resolveEngineStartup(definition, ios, {
      base: { kind: 'preset', preset: 'medium' },
      groups: { ambientOcclusion: 'high' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.requestedGroups).toMatchObject({
      reflections: 'medium',
      shadows: 'medium',
      ambientOcclusion: 'high',
    });
    expect(result.value.settings.audio?.host?.maxCachedBytes).toBe(16 * 1024 * 1024);
  });

  it('keeps explicit project values above device baselines', () => {
    const result = resolveEngineStartup(
      {
        ...definition,
        settings: { audio: { host: { maxCachedBytes: 8 * 1024 * 1024 } } },
      },
      ios,
    );
    expect(result.ok && result.value.settings.audio?.host?.maxCachedBytes).toBe(8 * 1024 * 1024);
  });

  it('does not guess an unavailable model', () => {
    const result = resolveEngineStartup(definition, { platform: 'ios' });
    expect(result.ok && result.value.profileId).toBe('IOS');
  });

  it.each([
    [
      {
        deviceProfiles: [
          { id: 'a', extends: 'b' },
          { id: 'b', extends: 'a' },
        ],
      },
      'configuration-inheritance-cycle',
    ],
    [{ deviceProfiles: [{ id: 'a', extends: 'missing' }] }, 'configuration-profile-missing'],
    [{ settings: { audio: { host: { maxCachedBytes: -1 } } } }, 'configuration-invalid'],
    [{ settings: { simulation: { time: { fixedDeltaSeconds: 0 } } } }, 'configuration-invalid'],
    [{ settings: { nonexistent: true } }, 'configuration-invalid'],
  ] as const)('rejects invalid definitions before any construction', (input, code) => {
    const result = resolveEngineStartup(input, ios);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });

  it('rejects ambiguous matches instead of depending on insertion order', () => {
    const result = resolveEngineStartup(
      {
        deviceProfiles: [
          { id: 'one', match: { platform: 'ios' }, priority: 1 },
          { id: 'two', match: { platform: 'ios' }, priority: 1 },
        ],
      },
      ios,
    );
    expect(!result.ok && result.error.code).toBe('configuration-match-ambiguous');
  });

  it('retains requested quality when inherited constraints bound the effective level', () => {
    const result = resolveEngineStartup(
      {
        deviceProfiles: [
          {
            id: 'limited',
            match: { platform: 'ios' },
            priority: 1,
            constraints: { maximumQuality: { reflections: 'low' } },
          },
        ],
        quality: { base: { kind: 'preset', preset: 'high' } },
      },
      ios,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.preset).toBe('high');
    expect(result.value.requestedGroups.reflections).toBe('high');
    expect(result.value.effectiveGroups.reflections).toBe('low');
    expect(result.value.constraints).toContainEqual({
      group: 'reflections',
      requested: 'high',
      effective: 'low',
      profile: 'limited',
    });
  });

  it('snapshots definitions and restores A after B without accumulating overrides', () => {
    const first = resolveEngineStartup(definition, ios);
    const middle = resolveEngineStartup(definition, ios, {
      base: { kind: 'preset', preset: 'low' },
    });
    const last = resolveEngineStartup(definition, ios);
    expect(first).toEqual(last);
    expect(first).not.toEqual(middle);
    expect(definition.deviceProfiles[0].defaults.groups.reflections).toBe('medium');
  });
});
