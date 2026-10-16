import type { RhiCaps } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { createFullscreenRenderFeature } from '../../../render/src/features/fullscreen';
import { createRenderFeatureHost, runRenderFeatureFrame } from '../../../render/src/features/host';
import { createRenderFeatureTarget } from '../../../render/src/features/targets';

const SOURCE = `
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let x = select(-1.0, 3.0, index == 1u);
  let y = select(-1.0, 3.0, index == 2u);
  return vec4<f32>(x, y, 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0, 0.0, 1.0, 1.0);
}`;

const feature = createFullscreenRenderFeature({
  identity: 'test::fullscreen-feature',
  source: SOURCE,
});

describe('fullscreen feature host contract', () => {
  it('keeps the effect declaration inside the producer plan', () => {
    const host = createRenderFeatureHost([feature]);

    expect(host.ok).toBe(true);
    if (!host.ok) return;
    expect(host.value.features).toHaveLength(1);
    const [registered] = host.value.features;
    expect(registered).toBeDefined();
    const planned = runRenderFeatureFrame(host.value, [
      {
        identity: 'main',
        render: true,
        worlds: [],
        owner: 0,
        frameNumber: 1,
        caps: {} as unknown as RhiCaps,
        targets: [],
      },
    ]).frame;
    expect(planned.plans[0]?.plan.resources[0]).toMatchObject({
      kind: 'fullscreen-program',
      name: 'fullscreen.test--fullscreen-feature',
      source: SOURCE,
    });
  });

  it('rejects duplicate producer identities at host construction', () => {
    const duplicate = createFullscreenRenderFeature({
      identity: feature.identity,
      source: SOURCE,
    });
    const host = createRenderFeatureHost([feature, duplicate]);

    expect(host.ok).toBe(false);
    if (host.ok) return;
    expect(host.error.code).toBe('render-feature-registration-conflict');
  });

  it('builds one closed plan without a late registry mutation', () => {
    const host = createRenderFeatureHost([feature]);
    expect(host.ok).toBe(true);
    if (!host.ok) return;
    const planned = runRenderFeatureFrame(host.value, [
      {
        identity: 'main',
        render: true,
        worlds: [],
        owner: 0,
        frameNumber: 1,
        caps: {} as unknown as RhiCaps,
        targets: [
          createRenderFeatureTarget({ kind: 'scene-color', format: 'rgba16float', sampleCount: 1 }),
        ],
      },
    ]).frame;

    expect(planned.errors).toEqual([]);
    expect(planned.plans).toHaveLength(1);
    expect(planned.plans[0]?.plan.resources[0]).toMatchObject({
      kind: 'fullscreen-program',
      name: 'fullscreen.test--fullscreen-feature',
      source: SOURCE,
    });
    expect(planned.plans[0]?.plan.passes).toEqual([]);
  });
});
