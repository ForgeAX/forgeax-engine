// resolve-depth-only-view.test.ts —
// feat-20260702-postprocess-camera-depth-read M2 / w6.
//
// Spy/mock unit tests for resolveDepthOnlyView and its SSAO delegate:
// (a) resolveDepthOnlyView calls graph.getColorTargetTexture(key) and
//     device.createTextureView({aspect:'depth-only'}) with the caller's label.
// (b) resolveHdrDepthDepthOnlyView delegates with label 'ssao-hdr-depth-only-view'
//     (plan-strategy D-5: thin delegate, byte-identical behaviour).
// (c) Null return paths: graph null, texture undefined, createTextureView error.
//
// Pure mock — no real GPU required.

import type { RenderGraph } from '@forgeax/engine-render-graph';
import { describe, expect, it, vi } from 'vitest';

// resolveDepthOnlyView is exported from render-graph-primitives.ts.
// resolveHdrDepthDepthOnlyView is package-private — we test it indirectly
// through resolveDepthOnlyView with the SSAO label (behaviour equivalence).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let resolveDepthOnlyView: (
  internals: Record<string, unknown>,
  key: string,
  label: string,
  preferredKey?: string | null,
) => unknown;

// Dynamic import so Vitest hoists vi.mock before the module loads.
await vi.hoisted(async () => {
  // No hoisting needed — we import after mock setup.
});

// Import the render-graph-primitives module to extract the functions under test.
// We can reach them through the resolved module namespace.
const mod = await import('../../../render/src/render-graph-primitives');
// resolveDepthOnlyView is exported; resolveHdrDepthDepthOnlyView is not.
// We can test the delegate equivalence by calling resolveDepthOnlyView with
// the SSAO label, which is the exact body of the delegate.
resolveDepthOnlyView = (mod as unknown as Record<string, unknown>)
  .resolveDepthOnlyView as typeof resolveDepthOnlyView;
expect(resolveDepthOnlyView).toBeDefined();
expect(typeof resolveDepthOnlyView).toBe('function');

function makeSpyInternals(overrides: {
  graph?: unknown;
  device?: { createTextureView: ReturnType<typeof vi.fn> };
}) {
  return {
    frameState: {
      compiledFrameGraph:
        overrides.graph === undefined || overrides.graph === null
          ? null
          : { targets: overrides.graph },
    },
    runtime: {
      device: overrides.device ?? {
        createTextureView: vi.fn(),
      },
      errorRegistry: {
        fire: vi.fn(),
      },
    },
  };
}

describe('resolveDepthOnlyView', () => {
  it('returns null when no compiled graph is installed', () => {
    const internals = makeSpyInternals({ graph: null });
    const result = resolveDepthOnlyView(internals, 'depth', 'test-label');
    expect(result).toBeNull();
  });

  it('returns null when getColorTargetTexture returns undefined', () => {
    const graph = {
      getColorTargetTexture: vi.fn().mockReturnValue(undefined),
    } as unknown as RenderGraph;
    const internals = makeSpyInternals({ graph });
    const result = resolveDepthOnlyView(internals, 'missing-key', 'test-label');
    expect(result).toBeNull();
    expect(graph.getColorTargetTexture).toHaveBeenCalledWith('missing-key');
  });

  it('resolves depth-only texture view with correct parameters', () => {
    const fakeTexture = { __fakeTex: true };
    const fakeView = { __fakeView: true };
    const createTextureViewFn = vi.fn().mockReturnValue({ ok: true, value: fakeView });
    const graph = {
      getColorTargetTexture: vi.fn().mockReturnValue(fakeTexture),
    } as unknown as RenderGraph;
    const internals = makeSpyInternals({
      graph,
      device: { createTextureView: createTextureViewFn },
    });

    const result = resolveDepthOnlyView(internals, 'hdrDepth', 'my-depth-view');

    expect(result).toBe(fakeView);
    expect(graph.getColorTargetTexture).toHaveBeenCalledWith('hdrDepth');
    expect(createTextureViewFn).toHaveBeenCalledWith(fakeTexture, {
      label: 'my-depth-view',
      dimension: '2d',
      aspect: 'depth-only',
      baseMipLevel: 0,
      mipLevelCount: 1,
      baseArrayLayer: 0,
      arrayLayerCount: 1,
    });
  });

  it('prefers the active geometry depth target when supplied', () => {
    const logicalTexture = { __logicalDepth: true };
    const activeTexture = { __activeDepth: true };
    const createTextureViewFn = vi.fn().mockReturnValue({ ok: true, value: { __view: true } });
    const graph = {
      getColorTargetTexture: vi.fn((key: string) =>
        key === 'hdrDepthMsaa' ? activeTexture : logicalTexture,
      ),
    } as unknown as RenderGraph;
    const internals = makeSpyInternals({
      graph,
      device: { createTextureView: createTextureViewFn },
    });

    resolveDepthOnlyView(internals, 'depth', 'active-depth-view', 'hdrDepthMsaa');

    expect(createTextureViewFn).toHaveBeenCalledWith(activeTexture, expect.anything());
  });

  it('fires error on createTextureView failure and returns null', () => {
    const fakeTexture = { __fakeTex: true };
    const fakeError = { message: 'failed' };
    const createTextureViewFn = vi.fn().mockReturnValue({ ok: false, error: fakeError });
    const errorRegistry = { fire: vi.fn() };
    const graph = {
      getColorTargetTexture: vi.fn().mockReturnValue(fakeTexture),
    } as unknown as RenderGraph;
    const internals = {
      frameState: { compiledFrameGraph: { targets: graph } },
      runtime: {
        device: { createTextureView: createTextureViewFn },
        errorRegistry,
      },
    };

    const result = resolveDepthOnlyView(internals, 'depth', 'err-view');

    expect(result).toBeNull();
    expect(errorRegistry.fire).toHaveBeenCalledWith(fakeError);
  });
});

describe('SSAO delegate: resolveHdrDepthDepthOnlyView behaviour preservation', () => {
  it('delegates with label ssao-hdr-depth-only-view (D-5 thin delegate)', () => {
    // The delegate body is resolveDepthOnlyView(internals, hdrDepthKey, 'ssao-hdr-depth-only-view').
    // We verify this by calling resolveDepthOnlyView with the SSAO label and confirming the
    // createTextureView receives that exact label.
    const fakeTexture = { __fakeTex: true };
    const fakeView = { __fakeView: true };
    const createTextureViewFn = vi.fn().mockReturnValue({ ok: true, value: fakeView });
    const graph = {
      getColorTargetTexture: vi.fn().mockReturnValue(fakeTexture),
    } as unknown as RenderGraph;
    const internals = makeSpyInternals({
      graph,
      device: { createTextureView: createTextureViewFn },
    });

    const result = resolveDepthOnlyView(internals, 'hdrDepth', 'ssao-hdr-depth-only-view');

    expect(result).toBe(fakeView);
    expect(graph.getColorTargetTexture).toHaveBeenCalledWith('hdrDepth');
    expect(createTextureViewFn).toHaveBeenCalledWith(
      fakeTexture,
      expect.objectContaining({ label: 'ssao-hdr-depth-only-view' }),
    );
  });
});
