import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolvePostColorDomainContract } from '../render-pipeline';

const clusteredSource = readFileSync(
  new URL('../pipeline/standard-pipeline.ts', import.meta.url),
  'utf8',
);
const clusterGraphSource = readFileSync(
  new URL('../pipeline/standard-lighting/graph.ts', import.meta.url),
  'utf8',
);
const forwardSource = readFileSync(
  new URL('../pipeline/standard-forward-lane.ts', import.meta.url),
  'utf8',
);
const recordSource = readFileSync(new URL('../record/frame.ts', import.meta.url), 'utf8');

describe('Standard clustered post color-domain order', () => {
  it('retains the LUT stage and one output encoder for clustered plans', async () => {
    const { createStandardOutputPlan, validateStandardOutputPlan } = await import(
      '../pipeline/standard-output/graph'
    );
    const plan = createStandardOutputPlan({
      lane: 'clustered',
      temporal: true,
      meter: true,
      bloom: true,
      exposure: true,
      whiteBalance: true,
      lut: true,
      fxaa: true,
      outputEncoding: 'explicit-oetf',
    });
    expect(plan.logicalStages).toEqual([
      'temporal',
      'meter',
      'bloom',
      'exposure-white-balance',
      'tone',
      'lut',
      'fxaa',
      'output-encoding',
    ]);
    expect(plan.outputEncodingCount).toBe(1);
    expect(validateStandardOutputPlan(plan).ok).toBe(true);
  });

  it('keeps transparent and bloom work in linear HDR before tone output', () => {
    const stages = resolvePostColorDomainContract('linear-hdr');
    expect(stages).toContainEqual(['transparent-blend', 'linear-hdr', 'linear-hdr']);
    expect(stages).toContainEqual(['bloom', 'linear-hdr', 'linear-hdr']);
    expect(stages).toContainEqual(['output-transform', 'linear-hdr', 'display-encoded']);
    expect(stages).toContainEqual(['fxaa', 'display-encoded', 'display-encoded']);
    expect(stages).toContainEqual(['post-effect', 'display-encoded', 'display-encoded']);
    expect(stages).toContainEqual(['present', 'display-encoded', 'display-encoded']);
    expect(stages.findIndex(([name]) => name === 'output-transform')).toBeGreaterThan(
      stages.findIndex(([name]) => name === 'bloom'),
    );
  });

  it('keeps the real Standard producer and record owner as one provenance chain', () => {
    expect(clusterGraphSource).toContain("graph.addComputePass('cluster-membership-producer'");
    expect(clusterGraphSource).toContain("buffers.lightIndexList, usage: 'storage-write'");
    expect(clusterGraphSource).toContain('pass.dispatchWorkgroups(');
  });

  it('routes both Standard lanes through the one shared post-chain owner', () => {
    expect(clusteredSource.match(/addStandardPost\(/g)).toHaveLength(1);
    expect(forwardSource.match(/addStandardPost\(/g)).toHaveLength(1);
    expect(clusteredSource).not.toContain("target(graph, 'ldr-color'");
    expect(forwardSource).not.toContain("target(graph, 'ldr-color'");
  });

  it('retains clustered Spot shadow receiver and atlas dependencies', () => {
    const result = resolvePostColorDomainContract('linear-hdr');
    expect(result).toContainEqual(['bloom', 'linear-hdr', 'linear-hdr']);
    expect(clusteredSource).toContain('spotShadow: shadows.value.spot');
    expect(clusteredSource).toContain('shadows.value.spot,');
    expect(clusterGraphSource).toContain("'hdrp-light-index-list'");
  });

  it('routes clustered direct-light recording through the Spot modifier uploader', () => {
    expect(recordSource).toContain('writeLightModifierTextures(internals, pipelineState, lights);');
  });
});
