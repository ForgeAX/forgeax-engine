import type { RenderError, Renderer, RendererOptions, RenderFeature } from '@forgeax/engine-render';
import type { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { ok, type Result } from '@forgeax/engine-types';
import { createRenderer } from '../index';

type FrameData = {
  readonly visibleCount: number;
};

const feature = {
  identity: 'test.runtime-public-surface',
  extract({ owner }) {
    return ok<FrameData>({ visibleCount: owner });
  },
  plan(data: FrameData) {
    const count: number = data.visibleCount;
    void count;
    return ok({ work: [] });
  },
} satisfies RenderFeature<FrameData>;

declare const canvas: HTMLCanvasElement;

const options: RendererOptions = { features: [feature] };
const rendererPromise: Promise<Result<Renderer, EngineEnvironmentError | RenderError>> =
  createRenderer(canvas, options);
void rendererPromise;
declare const renderer: Renderer;
// The public contract is feature input plus receipt/observe; diagnostics and
// per-frame pass lists remain implementation-owned.
// @ts-expect-error renderer diagnostics are not public
renderer.renderFeatureDiagnostics();
// @ts-expect-error per-frame pass names are not public
renderer.perFramePassNames;
// @ts-expect-error raw readback is owned by Dawn/browser harnesses
renderer.readPixels();

// Runtime owns assembly; its public factory does not expose the internal host.
// @ts-expect-error the feature host is private to engine-render
type _NoRuntimeFeatureHost = typeof import('@forgeax/engine-runtime')['RenderFeatureHost'];
// @ts-expect-error runtime does not expose manifest/RPC implementation symbols
type _NoRuntimeBundlerOptions = typeof import('@forgeax/engine-runtime')['BundlerOptions'];
