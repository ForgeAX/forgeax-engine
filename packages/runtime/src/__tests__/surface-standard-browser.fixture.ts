import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createRuntimeAssetImportTransport, runtimeBinding } from 'virtual:forgeax/pack-runtime';
import type { Renderer } from '@forgeax/engine-render';
import { expect, onTestFinished } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import {
  createSurfaceHostLossInstrumentation,
  createSurfaceSplashRuntimeHost,
  SURFACE_HEIGHT,
  SURFACE_WIDTH,
} from './surface-standard-pipeline.runtime-fixture';
import { createVfxEvidenceBackend } from './vfx-failure-evidence.fixture';

const evidenceEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
const evidenceSource = {
  sourceHead: evidenceEnv?.VITE_FORGEAX_EVIDENCE_SOURCE_SHA ?? 'unavailable',
  buildId: evidenceEnv?.VITE_FORGEAX_EVIDENCE_BUILD_ID ?? 'unavailable',
};

export async function createSurfaceBrowserFixture() {
  if (runtimeBinding === undefined) {
    throw new Error('surface-standard: Pack runtime binding unavailable in Browser Vitest');
  }
  const canvas = document.createElement('canvas');
  canvas.id = 'surface-standard-pipeline-test-canvas';
  canvas.width = SURFACE_WIDTH;
  canvas.height = SURFACE_HEIGHT;
  // Keep the full four-cell evidence surface inside the Browser Vitest
  // viewport. Playwright clips an oversized element screenshot to the
  // available viewport, which would otherwise turn the right two cells into
  // compositor-white pixels instead of a real Surface observation.
  const displayWidth = Math.min(SURFACE_WIDTH, Math.max(320, window.innerWidth - 32));
  const displayHeight = Math.round((displayWidth * SURFACE_HEIGHT) / SURFACE_WIDTH);
  canvas.style.width = `${displayWidth}px`;
  canvas.style.height = `${displayHeight}px`;
  document.body.append(canvas);
  const webgpuContext = canvas.getContext('webgpu');
  if (webgpuContext === null) {
    throw new Error('surface-standard: WebGPU canvas context unavailable');
  }
  const bundler = forgeaxBundlerAdapter();
  const vfxHost = createSurfaceSplashRuntimeHost();
  const hostLoss = createSurfaceHostLossInstrumentation();
  const evidenceBackend = createVfxEvidenceBackend({
    source: 'browser-native-webgpu',
    userAgent: navigator.userAgent,
    ...evidenceSource,
  });
  const recorder = evidenceBackend.recorder;

  let renderer: Renderer | undefined;
  onTestFinished(async () => {
    try {
      await renderer?.dispose();
    } finally {
      (await recorder.dispose()).unwrap();
      canvas.remove();
    }
  });
  const constructed = await constructRuntimeRendererHost(
    canvas,
    {
      rhi: recorder.backend.rhi,
      features: [vfxHost.feature],
      rhiInstrumentation: {
        ...hostLoss.instrumentation,
        onDeviceLost: () => evidenceBackend.recorder.deviceLost(),
      },
    },
    {
      ...bundler,
      importTransport: createRuntimeAssetImportTransport(runtimeBinding),
    },
  );
  expect(constructed.ok).toBe(true);
  if (!constructed.ok) throw constructed.error;
  const runtimeHost = constructed.value;
  renderer = runtimeHost.renderer;
  let diagnosticErrorCount = 0;
  renderer.subscribe((event) => {
    if (event.kind === 'error' && diagnosticErrorCount++ < 8)
      console.error('surface renderer failure:', JSON.stringify(event.error));
  });
  const assets = runtimeHost.assets;
  assets.configureRuntimeBinding(runtimeBinding);
  return { assets, canvas, evidenceBackend, evidenceSource, hostLoss, renderer, vfxHost };
}
