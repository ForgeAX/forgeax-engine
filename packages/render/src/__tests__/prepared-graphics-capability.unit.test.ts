import type { RhiCaps } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createRenderFeatureHost } from '../features/host';
import type { RenderFeature } from '../features/types';
import { admitStandardColorLut } from '../pipeline/standard-output/lut-admission';
import { runSingleViewFeatureFrame } from './single-view-feature-fixture';

const supportedCaps: Readonly<RhiCaps> = {
  backendKind: 'null',
  compute: true,
  timestampQuery: false,
  timestampPeriodNanoseconds: null,
  indirectDrawing: false,
  textureCompressionBc: false,
} as RhiCaps;

const missingCaps: Readonly<RhiCaps> = { ...supportedCaps, compute: false };

function preparedFeature(): RenderFeature<{ readonly draw: boolean }> {
  return {
    identity: 'synthetic.capability',
    requiredCapabilities: ['compute'],
    extract: () => ok({ draw: true }),
    plan: () => ok({ work: [{ scope: { view: 'main' }, resources: [], passes: [] }] }),
  };
}

function activePreparedFeature(
  active: () => boolean = () => true,
): RenderFeature<{ readonly draw: boolean }> {
  return {
    identity: 'synthetic.capability.active',
    requiredCapabilities: ['compute'],
    extract: () => ok({ draw: active() }),
    plan: ({ draw }) =>
      ok({
        work: [
          {
            scope: { view: 'main' },
            ...(draw
              ? {
                  resources: [
                    {
                      kind: 'fullscreen-program' as const,
                      name: 'synthetic.capability.program',
                      source: 'synthetic',
                    },
                  ],
                  passes: [],
                }
              : { resources: [], passes: [] }),
          },
        ],
      }),
  };
}

describe('prepared graphics capability projection', () => {
  it('keeps LUT filtering as an independent live capability', () => {
    const result = admitStandardColorLut({
      texture: {
        kind: 'texture',
        shape: { viewDimension: '3d', extent: { width: 16, height: 16, depth: 16 } },
        format: 'rgba16float',
        data: new Uint8Array(16 * 16 * 16 * 8),
        colorSpace: 'linear',
        mips: { kind: 'none' },
      },
      maxTextureDimension3D: 2048,
      rgba16floatFilterable: false,
      bind: () => true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('standard-lut-filter-unavailable');
  });

  it('projects supported capability into an accepted machine-readable operation', () => {
    const host = createRenderFeatureHost([preparedFeature()]).unwrap();
    const result = runSingleViewFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      caps: supportedCaps,
    });

    expect(result.errors).toEqual([]);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]?.plan).toEqual({ resources: [], passes: [] });
    expect(host.diagnostics()[0]?.status).toBe('active');
  });

  it('does not admit an inactive empty plan on an unsupported backend', () => {
    const host = createRenderFeatureHost([preparedFeature()]).unwrap();
    const result = runSingleViewFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      caps: missingCaps,
    });

    expect(result.errors).toEqual([]);
    expect(result.preparedResourceBatches).toHaveLength(0);
    expect(result.plans[0]?.plan).toEqual({ resources: [], passes: [] });
    expect(host.diagnostics()[0]?.status).toBe('active');
  });

  it('returns a structured capability failure without a silent operation', () => {
    const host = createRenderFeatureHost([activePreparedFeature()]).unwrap();
    const result = runSingleViewFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      caps: missingCaps,
    });

    expect(result.plans).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: 'render-feature-capability-missing',
      expected: expect.stringContaining('compute'),
      hint: expect.stringContaining('disable'),
      detail: {
        featureIdentity: 'synthetic.capability.active',
        capability: 'compute',
      },
    });
    expect(host.diagnostics()[0]?.status).toBe('disabled');
  });

  it('lets an active capability failure recover when the authored plan is disabled', () => {
    let enabled = true;
    const host = createRenderFeatureHost([activePreparedFeature(() => enabled)]).unwrap();
    const failed = runSingleViewFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      caps: missingCaps,
    });
    expect(failed.errors.map((error) => error.code)).toEqual(['render-feature-capability-missing']);
    expect(host.diagnostics()[0]?.status).toBe('disabled');

    enabled = false;
    const recovered = runSingleViewFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 2,
      caps: missingCaps,
    });
    expect(recovered.errors).toEqual([]);
    expect(recovered.plans[0]?.plan).toEqual({ resources: [], passes: [] });
    expect(host.diagnostics()[0]?.status).toBe('active');
  });
});
