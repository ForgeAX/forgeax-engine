import { describe, expect, it, vi } from 'vitest';
import { STANDARD_PIPELINE_ID } from '../../pipeline/standard-profile';
import type { RenderPipelineTopology } from '../../render-pipeline';
import { currentShadowViews } from '../../typed-shadow-passes';
import {
  frameGraphCompileAttribution,
  frameGraphKeyText,
  frameGraphTopologyIdentity,
} from '../frame-graph-identity';

const topology = {
  camera: { tonemap: 'aces-filmic', antialias: 'none', bloom: 'off', bloomIntensity: 0.5 },
  output: {
    autoExposure: false,
    whiteBalance: true,
    temperature: 6000,
    tint: 0,
    colorLut: true,
    colorLutStrength: 0.5,
  },
  transmissionDemand: { activeCount: 1, needsRoughMips: false },
  ssr: { status: 'not-requested', viewRange: 100 },
} as RenderPipelineTopology;
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('fixture value missing');
  return value;
}
const key = (value: RenderPipelineTopology, stock = true) =>
  JSON.stringify(frameGraphTopologyIdentity(value, stock));

describe('stock frame graph identity', () => {
  it('keeps the sorted transmission prefix structural and weighted class counts local to the view', () => {
    const withGlass = {
      ...topology,
      transparency: { weightedBlended: true as const, residual: false },
    };
    const mixed = {
      ...withGlass,
      transparency: { weightedBlended: true as const, residual: true },
    };
    const key = (value: RenderPipelineTopology) =>
      JSON.stringify(frameGraphTopologyIdentity(value, true, undefined, true, true));
    expect(key(mixed)).toBe(key(withGlass));
    expect(key(topology)).not.toBe(key(withGlass));
    expect(key({ ...topology, singleLayerMedium: true })).toBe(
      key({ ...mixed, singleLayerMedium: true }),
    );
    expect(key({ ...topology, transmissionDemand: undefined })).toBe(
      key({ ...mixed, transmissionDemand: undefined }),
    );
  });

  it('keeps submitted depth demand out of a current writer and preserves declared depth ports', () => {
    const noDepth = { ...topology, materialSceneDepth: false };
    const depth = { ...topology, materialSceneDepth: true };
    expect(frameGraphTopologyIdentity(noDepth, true, undefined, true)).toEqual(
      frameGraphTopologyIdentity(depth, true, undefined, true),
    );
    expect(key(noDepth)).not.toBe(key(depth));
    expect(key(noDepth, false)).not.toBe(key(depth, false));
    expect(
      frameGraphCompileAttribution(
        JSON.stringify({ topology: frameGraphTopologyIdentity(noDepth, true) }),
        JSON.stringify({ topology: frameGraphTopologyIdentity(depth, true) }),
      ).dependencies,
    ).toContain('topology.materialSceneDepth');
  });
  it('keys complex Grade layouts by their image and overlay consumers', () => {
    const owner = { ...topology, pipelineId: STANDARD_PIPELINE_ID };
    const key = (
      camera: Partial<typeof owner.camera>,
      observeLinear = false,
      native = true,
      whiteBalance = true,
    ) =>
      JSON.stringify(
        frameGraphTopologyIdentity(
          {
            ...owner,
            camera: { ...owner.camera, ...camera },
            output: { ...required(owner.output), whiteBalance },
          },
          true,
          undefined,
          true,
          true,
          true,
          native,
          observeLinear,
        ),
      );
    const active = { lensEffects: true, chromaticAberration: true, tonemap: 'linear' as const };
    expect(key(active)).toBe(key({}, false, true, false));
    expect(key(active, true)).not.toBe(key({}, true));
    expect(key({ ...active, lensFlare: true })).toBe(key({ lensFlare: true }));
    expect(key({ ...active, lensFlare: true }, false, false)).not.toBe(
      key({ lensFlare: true }, false, false),
    );
    expect(key({ ...active, barrelDistortion: true })).toBe(key({ barrelDistortion: true }));
    expect(key({ ...active, outline: true })).not.toBe(key({ outline: true }));
    expect(key(active, false, false)).not.toBe(key({}, false, false));
    expect(key({ tonemap: 'none' })).not.toBe(key({}));
  });

  it('keeps SSAO intensity dynamic while retaining authored quality structure', () => {
    const aoTopology = {
      ...topology,
      pipelineId: STANDARD_PIPELINE_ID,
      config: {
        ambientOcclusion: {
          enabled: true,
          method: 'ssao',
          intensity: 0.5,
          quality: 50,
        },
      },
      standardProfile: {
        pipelineId: STANDARD_PIPELINE_ID,
        ambientOcclusion: {
          enabled: true,
          method: 'ssao',
          intensity: 0.5,
          quality: 50,
        },
      },
    } as RenderPipelineTopology;
    const withStrength = {
      ...aoTopology,
      config: {
        ...aoTopology.config,
        ambientOcclusion: {
          enabled: true,
          ...aoTopology.config?.ambientOcclusion,
          intensity: 1,
        },
      },
      standardProfile: {
        ...aoTopology.standardProfile,
        ambientOcclusion: {
          enabled: true,
          method: 'ssao',
          intensity: 1,
          quality: 50,
        },
      },
    } as RenderPipelineTopology;

    expect(key(withStrength)).toBe(key(aoTopology));
    expect(key(withStrength, false)).not.toBe(key(aoTopology, false));
    expect(
      key({
        ...withStrength,
        config: {
          ...withStrength.config,
          ambientOcclusion: {
            ...withStrength.config?.ambientOcclusion,
            enabled: true,
            quality: 100,
          },
        },
      }),
    ).not.toBe(key(withStrength));
    expect(
      key({
        ...withStrength,
        config: {
          ...withStrength.config,
          ambientOcclusion: {
            ...withStrength.config?.ambientOcclusion,
            enabled: true,
            method: 'gtao',
          },
        },
      }),
    ).not.toBe(key(withStrength));
  });

  it('retains a backdrop when only the positive draw count changes', () => {
    const next = { ...topology, transmissionDemand: { activeCount: 17, needsRoughMips: false } };
    expect(key(next)).toBe(key(topology));
    expect(key(next, false)).not.toBe(key(topology, false));
    expect(
      key({ ...next, transmissionDemand: { activeCount: 0, needsRoughMips: false } }),
    ).not.toBe(key(next));
    expect(
      key({ ...next, transmissionDemand: { activeCount: 17, needsRoughMips: true } }),
    ).not.toBe(key(next));
  });

  it('describes output resource shapes while continuous grading and LUT bindings change', () => {
    const next = { ...topology, output: { ...required(topology.output), colorLutStrength: 0.8 } };
    expect(key(next)).toBe(key(topology));
    expect(key(next, false)).not.toBe(key(topology, false));
    expect(key({ ...next, output: { ...next.output, colorLut: false } })).not.toBe(key(next));
    expect(key({ ...next, output: { ...next.output, temperature: 7000 } })).toBe(key(next));
    expect(key({ ...next, output: { ...next.output, lutSize: 32 } })).not.toBe(key(next));
    expect(key({ ...next, output: { ...next.output, lutSourceKey: 'replacement' } })).toBe(
      key(next),
    );
  });

  it('keeps volume pass declarations independent of light and projector identities', () => {
    const volume = {
      enabled: true,
      lightKind: 'point' as const,
      lightEntity: 1,
      spotLightEntity: 2,
      projector: { guid: 'a', revision: 1, generation: 1 },
    };
    const initial = { ...topology, volumetricFog: volume };
    const next = {
      ...topology,
      volumetricFog: {
        ...volume,
        lightEntity: 8,
        spotLightEntity: 9,
        projector: { guid: 'b', revision: 3, generation: 1 },
      },
    };
    expect(key(initial)).toBe(key(next));
    expect(key(initial, false)).not.toBe(key(next, false));
    expect(key(initial)).not.toBe(
      key({ ...initial, volumetricFog: { ...volume, spotLightEntity: undefined } }),
    );
    expect(key(initial)).not.toBe(
      key({ ...initial, volumetricFog: { ...volume, projector: undefined } }),
    );
  });

  it('ignores an unrequested SSR range without weakening an admitted declaration', () => {
    const next = { ...topology, ssr: { ...required(topology.ssr), viewRange: 1000 } };
    expect(key(next)).toBe(key(topology));
    expect(key(next, false)).not.toBe(key(topology, false));
    const admitted = {
      ...next,
      ssr: { ...next.ssr, status: 'admitted' },
    } as RenderPipelineTopology;
    expect(key({ ...admitted, ssr: { ...required(admitted.ssr), viewRange: 1200 } })).not.toBe(
      key(admitted),
    );
  });
});

describe('canonical graph miss attribution', () => {
  it('attributes each changing ordinary attachment without serializing its layout during submission', () => {
    const raw = (width: number) => ({
      deferredDisplay: { width, standardPost: { hdr: true }, geometry: 'selection' },
      topology: { compactReceiver: width % 2 === 0 ? 'channels' : 'context' },
    });
    const encode = vi.spyOn(JSON, 'stringify'),
      decode = vi.spyOn(JSON, 'parse');
    let detail: ReturnType<typeof frameGraphCompileAttribution> | undefined;
    let encoded: number, decoded: number;
    try {
      for (let frame = 0; frame < 60; frame++)
        detail = frameGraphCompileAttribution(raw(frame), raw(frame + 1));
      encoded = encode.mock.calls.length;
      decoded = decode.mock.calls.length;
    } finally {
      encode.mockRestore();
      decode.mockRestore();
    }
    expect([encoded, decoded]).toEqual([0, 0]);
    const legacy = frameGraphCompileAttribution(
      frameGraphKeyText(raw(59)),
      frameGraphKeyText(raw(60)),
    );
    expect(detail).toEqual(legacy);
    expect(detail?.changes[1]?.after).toBe(JSON.stringify(raw(60).deferredDisplay));
  });

  it('counts every dependency but bounds the value history of a changing graph', () => {
    const attribution = frameGraphCompileAttribution(
      JSON.stringify({
        topology: { shadow: 'x'.repeat(800), previous: true, depth: false },
        oldLayout: 2,
      }),
      JSON.stringify({ topology: { shadow: 'new', depth: true, newPass: 1 }, nextLayout: 3 }),
    );
    expect(attribution.dependencies).toEqual([
      'topology.shadow',
      'topology.previous',
      'topology.depth',
      'topology.newPass',
      'oldLayout',
      'nextLayout',
    ]);
    expect(attribution.changes).toHaveLength(4);
    expect(attribution.changes[0]?.before).toHaveLength(400);
    expect(attribution.changes[1]?.after).toBe('undefined');
    expect(attribution.changes[3]?.before).toBe('undefined');
  });
  it('reports all changed dependencies in stable order, without retaining source objects', () => {
    const previous = JSON.stringify({
      topology: { shadow: { mapSize: 1024 }, gpuDrivenTopologySignature: 'gpu:1' },
      observationCaptureDomains: [],
    });
    const next = JSON.stringify({
      topology: { shadow: { mapSize: 2048 }, gpuDrivenTopologySignature: 'gpu:2' },
      observationCaptureDomains: ['tone'],
    });
    const attribution = frameGraphCompileAttribution(previous, next);
    expect(attribution.changes[0]).toEqual({
      dependency: 'topology.shadow',
      before: '{"mapSize":1024}',
      after: '{"mapSize":2048}',
    });
    expect(attribution.dependencies).toEqual([
      'topology.shadow',
      'topology.gpuDrivenTopologySignature',
      'observationCaptureDomains',
    ]);
    expect(frameGraphCompileAttribution(undefined, next).dependencies).toEqual(['cold']);
    expect(frameGraphCompileAttribution('invalidated', next).dependencies).toEqual(['invalid-key']);
  });
});

it('keeps direct local shadow lights as frame work while static and filtered layers own their dependencies', () => {
  const base = {
    directional: 'disabled' as const,
    pointFaceSize: 16,
    spotMapSize: 16,
    pointCount: 1,
    spotCount: 1,
  };
  function identity(shadow: RenderPipelineTopology['shadow']) {
    return frameGraphTopologyIdentity({ ...topology, shadow }, true, currentShadowViews(shadow))
      .shadow;
  }
  expect(identity(base)).toEqual(identity({ ...base, pointCount: 4, spotCount: 3 }));
  for (const held of [
    { pointCount: 0 },
    { spotCount: 0 },
    { pointStaticMask: 2 },
    { spotStaticMask: 1 },
    { variance: { directional: false, spots: [1] } },
    { spotMapSize: 32 },
  ])
    expect(identity({ ...base, ...held })).not.toEqual(identity(base));
  expect(
    frameGraphTopologyIdentity({ ...topology, shadow: base }, false, currentShadowViews(base))
      .shadow,
  ).toEqual(base);
});
