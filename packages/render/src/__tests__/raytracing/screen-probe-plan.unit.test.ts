import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { freezeRenderProfile, validateRenderProfile } from '../../assembly/renderer-facade';
import {
  DEFAULT_STANDARD_PROFILE,
  type StandardProfile,
  type StandardScreenProbeGi,
} from '../../pipeline/standard-profile';
import { validateDiffuseGi } from '../../raytracing/irradiance-field-plan';
import {
  SCREEN_PROBE_BINDINGS,
  SCREEN_PROBE_STAGES,
  screenProbeWorldRoster,
  screenProbeWorldWgsl,
} from '../../raytracing/screen-probe-kernels';
import {
  packScreenProbeFrame,
  planScreenProbeLayout,
  SCREEN_PROBE_DEFAULTS,
  SCREEN_PROBE_FRAME_BYTES,
  validateScreenProbes,
} from '../../raytracing/screen-probe-plan';

const wgsl = readFileSync(
  new URL('../../../../shader/src/ray-screen-probe.wgsl', import.meta.url),
  'utf8',
);

const gi: StandardScreenProbeGi = {
  gather: 'screen-probe',
  maxDistance: 100,
  environment: [0.5, 0.5, 0.5],
  probes: SCREEN_PROBE_DEFAULTS,
  field: {
    region: {
      grid: {
        origin: [-4, -4, -4],
        dimensions: [33, 33, 33],
        spacing: 0.25,
        maxDistance: 2,
        coverageDistance: 1,
      },
      maxInstances: 64,
      maxFieldBytes: 16 * 1024 * 1024,
    },
    probeSpacing: 1,
    raysPerProbe: 64,
    probeBudget: 32,
    hysteresis: 0.9,
    cards: { resolution: 32, maxCaptureBytes: 8 * 1024 * 1024, budget: 64 },
    resolution: 'half',
    radiosity: true,
  },
};

describe('screen probe plan', () => {
  it('validates the closed probe configuration', () => {
    expect(validateScreenProbes(SCREEN_PROBE_DEFAULTS).ok).toBe(true);
    for (const invalid of [
      { downsample: 12 },
      { adaptiveFraction: 1.5 },
      { importance: 'cosine' },
      { screenTrace: { maxSteps: 200, thickness: 0.02 } },
      { screenTrace: { maxSteps: 8, thickness: 0 } },
      { screenTrace: { maxSteps: 8, thickness: 0.02, extra: 1 } },
      { filterPasses: 5 },
      { shortRangeAo: -1 },
      { maxFrames: 0 },
      { history: { probe: 1 } },
      { history: { extra: true } },
      { history: null },
      { history: [] },
      { extra: true },
    ])
      expect(
        validateScreenProbes({ ...SCREEN_PROBE_DEFAULTS, ...invalid } as never).ok,
        JSON.stringify(invalid),
      ).toBe(false);
  });

  it('admits the screen-probe gather through the shared selector and freezes it', () => {
    expect(validateDiffuseGi(gi).ok).toBe(true);
    expect(
      validateScreenProbes({ ...gi.probes, history: { probe: false, pixel: true, screen: false } })
        .ok,
    ).toBe(true);
    expect(validateDiffuseGi({ ...gi, probes: { ...gi.probes, downsample: 3 } } as never).ok).toBe(
      false,
    );
    expect(validateDiffuseGi({ ...gi, field: undefined } as never).ok).toBe(false);
    const profile: StandardProfile = {
      ...DEFAULT_STANDARD_PROFILE,
      renderPath: 'deferred',
      ibl: false,
      diffuseGi: { ...gi, probes: { ...gi.probes, history: { probe: false } } },
    };
    expect(validateRenderProfile(profile)).toBeUndefined();
    const frozen = freezeRenderProfile(profile).diffuseGi;
    expect(frozen?.gather).toBe('screen-probe');
    if (frozen?.gather !== 'screen-probe') return;
    expect(Object.isFrozen(frozen.probes.screenTrace)).toBe(true);
    expect(Object.isFrozen(frozen.field.cards)).toBe(true);
    expect(Object.isFrozen(frozen.probes.history)).toBe(true);
  });

  it('plans uniform tiles plus a bounded adaptive tail', () => {
    expect(planScreenProbeLayout({ ...SCREEN_PROBE_DEFAULTS, downsample: 8 }, 33, 17)).toEqual({
      width: 33,
      height: 17,
      tilesX: 5,
      tilesY: 3,
      uniformCount: 15,
      adaptiveCapacity: 7,
      probeCount: 22,
    });
    const none = planScreenProbeLayout({ ...SCREEN_PROBE_DEFAULTS, adaptiveFraction: 0 }, 64, 64);
    expect(none.probeCount).toBe(none.uniformCount);
  });

  it('packs the frame uniform at the offsets ScreenProbeFrame declares', () => {
    const layout = planScreenProbeLayout({ ...SCREEN_PROBE_DEFAULTS, downsample: 8 }, 32, 32);
    const query = new Uint8Array(8);
    new DataView(query.buffer).setUint32(0, 96, true);
    new DataView(query.buffer).setFloat32(4, 0.25, true);
    const bytes = packScreenProbeFrame({
      layout,
      downsample: 8,
      frameIndex: 7,
      importance: 'brdf',
      screenSteps: 32,
      thickness: 0.02,
      environment: [0.1, 0.2, 0.3],
      maxDistance: 100,
      shortRangeAo: 0.5,
      maxFrames: 10,
      sceneHistory: true,
      pixelHistory: false,
      probeHistory: true,
      worldBias: 1,
      cardMargin: 0.5,
      query,
      reprojection: {
        viewProjection: Array.from({ length: 16 }, (_, i) => i + 1),
        cameraPosition: [7, 8, 9],
      },
    });
    expect(bytes.byteLength).toBe(SCREEN_PROBE_FRAME_BYTES);
    const u = new Uint32Array(bytes.buffer);
    const f = new Float32Array(bytes.buffer);
    expect([...u.subarray(0, 12)]).toEqual([32, 32, 4, 4, 16, 8, 8, 7, 1, 32, 5, 10]);
    expect(f[15]).toBe(100);
    expect([...f.subarray(16, 20)].map((v) => Math.round(v * 100) / 100)).toEqual([
      0.02, 0.5, 1, 0.5,
    ]);
    expect(u[20]).toBe(96);
    expect(f[21]).toBe(0.25);
    expect([...f.subarray(24, 44)]).toEqual([
      ...Array.from({ length: 16 }, (_, i) => i + 1),
      7,
      8,
      9,
      1,
    ]);
  });

  it('keeps every kernel roster in the bindings the WGSL declares', () => {
    const declared = (source: string) =>
      new Map(
        [
          ...source.matchAll(
            /@group\(0\) @binding\((\d+)\) var(?:<([^>]+)>)? (\w+)\s*:\s*([^;]+);/g,
          ),
        ].map((match) => [Number(match[1]), { space: match[2] ?? '', type: match[4] ?? '' }]),
      );
    const kindOf = ({ space, type }: { space: string; type: string }) =>
      type.trim() === 'acceleration_structure'
        ? 'tlas'
        : space === 'uniform'
          ? 'uniform'
          : space.includes('read_write')
            ? 'storage'
            : space.startsWith('storage')
              ? 'read'
              : type.includes('depth')
                ? 'depth'
                : type.includes('u32')
                  ? 'uint'
                  : 'float';
    const probe = declared(wgsl);
    for (const [slot, [binding, kind]] of Object.entries(SCREEN_PROBE_BINDINGS)) {
      const entry = probe.get(binding);
      expect(entry, slot).toBeDefined();
      if (entry) expect(kindOf(entry), slot).toBe(kind);
    }
    for (const [stage, spec] of Object.entries(SCREEN_PROBE_STAGES)) {
      expect(wgsl, stage).toContain(`fn ${stage}(`);
      // WebGPU default: eight storage buffers per stage, three in the field sample group.
      const storage = spec.slots.filter((slot) => {
        const kind = SCREEN_PROBE_BINDINGS[slot][1];
        return kind === 'storage' || kind === 'read';
      });
      expect(storage.length + 3, stage).toBeLessThanOrEqual(8);
    }
    for (const traversal of ['global-sdf', 'ray-query'] as const) {
      const roster = screenProbeWorldRoster(traversal);
      const world = declared(screenProbeWorldWgsl(traversal));
      expect(world.size, traversal).toBe(roster.length);
      for (const [binding, kind, name] of roster) {
        const entry = world.get(binding);
        expect(entry, name).toBeDefined();
        if (entry) expect(kindOf(entry), name).toBe(kind);
      }
      expect(
        roster.filter(([, kind]) => kind === 'storage' || kind === 'read').length,
        traversal,
      ).toBeLessThanOrEqual(8);
    }
  });
});
