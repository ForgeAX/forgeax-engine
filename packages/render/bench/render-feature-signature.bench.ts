import { ok } from '@forgeax/engine-types';
import { bench, describe } from 'vitest';
import { createRenderFeatureHost } from '../src/features/host';
import {
  freezeRenderFeaturePlan,
  type RenderFeatureWorkPlan,
  renderFeaturePlanSignatureEvidenceMatches,
} from '../src/features/plan';
import type { RenderFeature } from '../src/features/types';

const EMITTER_COUNT = 18;
const WGSL_BYTES = 64 * 1024;
const ENTRY = '@compute @workgroup_size(64) fn simulate() {}\n';
const WGSL = ENTRY + `// ${'x'.repeat(WGSL_BYTES - ENTRY.length - 4)}\n`;
const CHANGED_WGSL = WGSL.replace('fn simulate()', 'fn simulate ()');
const options = { time: 1_000, warmupTime: 200, warmupIterations: 10 };

function plan(revision: number, change: 'uploads' | 'topology' | 'shader'): RenderFeatureWorkPlan {
  const resources: RenderFeatureWorkPlan['resources'][number][] = [];
  const passes: RenderFeatureWorkPlan['passes'][number][] = [];
  for (let emitter = 0; emitter < EMITTER_COUNT; emitter += 1) {
    const prefix = `emitter-${emitter}`;
    const changed = emitter === 0 && revision === 1;
    resources.push(
      {
        kind: 'compute-program',
        name: `${prefix}.program`,
        program: {
          wgsl: change === 'shader' && changed ? CHANGED_WGSL : WGSL,
          entryPoints: ['simulate'],
          bindings: [
            {
              entries: [
                { binding: 0, visibility: 4, buffer: { type: 'storage' } },
                { binding: 1, visibility: 4, buffer: { type: 'uniform' } },
              ],
            },
          ],
        },
      },
      {
        kind: 'buffer',
        name: `${prefix}.particles`,
        size: change === 'topology' && changed ? 8_192 : 4_096,
        usage: ['storage'],
      },
      {
        kind: 'buffer',
        name: `${prefix}.runtime`,
        size: 16,
        usage: ['uniform'],
        data: new Uint32Array([revision, emitter, 0, 0]),
      },
      {
        kind: 'compute-bindings',
        name: `${prefix}.bindings`,
        program: `${prefix}.program`,
        entries: [
          { binding: 0, resource: `${prefix}.particles` },
          { binding: 1, resource: `${prefix}.runtime` },
        ],
      },
    );
    passes.push({
      kind: 'compute',
      name: `${prefix}.simulate`,
      program: `${prefix}.program`,
      bindings: `${prefix}.bindings`,
      dispatches: [
        {
          kind: 'direct',
          entryPoint: 'simulate',
          workgroups: [change === 'topology' && changed ? 2 : 1],
        },
      ],
    });
  }
  const result = freezeRenderFeaturePlan('signature-bench', { resources, passes });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function admission(change: 'uploads' | 'topology' | 'shader'): () => void {
  const feature: RenderFeature<undefined> = {
    identity: `signature-bench.${change}`,
    extract: () => ok(undefined),
    plan: () => ok({ work: [] }),
  };
  const result = createRenderFeatureHost([feature]);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  const host = result.value;
  const plans = [plan(0, change), plan(1, change)] as const;
  let index = 0;
  let previous = host.recordPlanSignature?.(feature.identity, plans[0]);
  if (previous === undefined) throw new Error('Missing native signature owner');
  return () => {
    index = 1 - index;
    const current = plans[index];
    if (current === undefined) throw new Error('Missing signature fixture');
    const signature = host.recordPlanSignature?.(feature.identity, current);
    if (
      signature === undefined ||
      (signature === previous) !== (change === 'uploads') ||
      !renderFeaturePlanSignatureEvidenceMatches(current, signature)
    ) {
      throw new Error('Host and graph admission disagreed on the topology revision');
    }
    previous = signature;
  };
}

describe('RenderFeature host + graph signature admission: 18 emitters, 64 KiB WGSL each', () => {
  bench('buffer uploads only', admission('uploads'), options);
  bench('one buffer capacity and dispatch change', admission('topology'), options);
  bench('one shader source change', admission('shader'), options);
});
