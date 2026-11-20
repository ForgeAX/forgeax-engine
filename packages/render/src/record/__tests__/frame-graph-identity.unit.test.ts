import { describe, expect, it } from 'vitest';
import { STANDARD_PIPELINE_ID } from '../../pipeline/standard-profile';
import type { RenderPipelineTopology } from '../../render-pipeline';
import { frameGraphChangedDependencies, frameGraphTopologyIdentity } from '../frame-graph-identity';

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
  it('rebuilds the graph when native material depth demand appears or disappears', () => {
    const noDepth = { ...topology, materialSceneDepth: false };
    const depth = { ...topology, materialSceneDepth: true };
    expect(key(noDepth)).not.toBe(key(depth));
    expect(key(noDepth, false)).not.toBe(key(depth, false));
    expect(
      frameGraphChangedDependencies(
        JSON.stringify({ topology: frameGraphTopologyIdentity(noDepth, true) }),
        JSON.stringify({ topology: frameGraphTopologyIdentity(depth, true) }),
      ),
    ).toContain('topology.materialSceneDepth');
  });
  it('keeps direct AO strength dynamic while retaining all other SSAO structure', () => {
    const aoTopology = {
      ...topology,
      pipelineId: STANDARD_PIPELINE_ID,
      config: {
        ambientOcclusion: {
          enabled: true,
          method: 'gtao',
          directLightingStrength: 0,
          resolutionScale: 0.5,
        },
      },
      standardProfile: {
        pipelineId: STANDARD_PIPELINE_ID,
        ambientOcclusion: {
          enabled: true,
          method: 'gtao',
          directLightingStrength: 0,
          resolutionScale: 0.5,
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
          directLightingStrength: 1,
        },
      },
      standardProfile: {
        ...aoTopology.standardProfile,
        ambientOcclusion: {
          enabled: true,
          method: 'gtao',
          directLightingStrength: 1,
          resolutionScale: 0.5,
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
            resolutionScale: 1,
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
            method: 'ssao',
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

  it('keeps shader-baked LUT strength and white balance in the identity', () => {
    const next = { ...topology, output: { ...required(topology.output), colorLutStrength: 0.8 } };
    expect(key(next)).not.toBe(key(topology));
    expect(key(next, false)).not.toBe(key(topology, false));
    expect(key({ ...next, output: { ...next.output, colorLut: false } })).not.toBe(key(next));
    expect(key({ ...next, output: { ...next.output, temperature: 7000 } })).not.toBe(key(next));
    expect(key({ ...next, output: { ...next.output, lutSize: 32 } })).not.toBe(key(next));
    expect(key({ ...next, output: { ...next.output, lutSourceKey: 'replacement' } })).not.toBe(
      key(next),
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
  it('reports all changed dependencies in stable order, without retaining source objects', () => {
    const previous = JSON.stringify({
      topology: { shadow: { mapSize: 1024 }, gpuDrivenTopologySignature: 'gpu:1' },
      observationCaptureDomains: [],
    });
    const next = JSON.stringify({
      topology: { shadow: { mapSize: 2048 }, gpuDrivenTopologySignature: 'gpu:2' },
      observationCaptureDomains: ['tone'],
    });
    expect(frameGraphChangedDependencies(previous, next)).toEqual([
      'topology.shadow',
      'topology.gpuDrivenTopologySignature',
      'observationCaptureDomains',
    ]);
    expect(frameGraphChangedDependencies(undefined, next)).toEqual(['cold']);
    expect(frameGraphChangedDependencies('invalidated', next)).toEqual(['invalid-key']);
  });
});
