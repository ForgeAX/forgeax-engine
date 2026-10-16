import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeDarkGradientMetrics, createDarkGradientFixtureReport, createInsufficientEvidenceReport, failedRouteGates, pixelSourceForBackend, runDarkGradientFalsifiers, runDarkGradientRouteFalsifiers } from '../../scripts/dark-gradient-fixture.mjs';
import { createDarkGradientTexture, gradientValue } from '../../scripts/dark-gradient-scene.mjs';
import { applyRuntimeEvent, createRuntimeCache, snapshotRuntimeCache } from '../../scripts/smoke-browser-runtime-cache.mjs';

const WIDTH = 800;
const HEIGHT = 600;

function frame(transform) {
  const bytes = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = (y * WIDTH + x) * 4;
      const color = transform(x, y);
      bytes.set([...color, 255], offset);
    }
  }
  return bytes;
}

describe('dark-gradient paired pixel metric contract', () => {
  it('reports the completed sample count without changing the frozen fixture', () => {
    const bytes = frame((x, y) => [x % 256, y % 256, (x + y) % 256]);
    const report = createDarkGradientFixtureReport({
      backendId: 'dawn', lane: 'direct', bytes, referenceBytes: bytes,
      surface: {}, sampleFrameCount: 300,
    });
    expect(report.fixture.frameCount).toBe(60);
    expect(report.observation.sampleFrameCount).toBe(300);
    expect(report.referenceObservation.sampleFrameCount).toBe(300);
  });

  it('rejects a sample count exceeding the actual observation frame', () => {
    const bytes = frame((x, y) => [x % 256, y % 256, (x + y) % 256]);
    const identity = { observationId: 'fxaa', frameId: 60, rendererInspectionRef: 'fxaa:frame-60' };
    const report = createDarkGradientFixtureReport({
      backendId: 'dawn', lane: 'direct', bytes, referenceBytes: bytes,
      surface: {}, sampleFrameCount: 300, identity,
      referenceIdentity: { ...identity, observationId: 'none' },
    });
    expect(report.errors.some((error) => error.expected.endsWith('observationIdentity'))).toBe(true);
    expect(report.errors.some((error) => error.expected.endsWith('referenceObservationIdentity'))).toBe(true);
  });

  it('retains the first structured renderer error after a poisoned page timeout', () => {
    const cache = createRuntimeCache({ pixelSourceMethod: 'webkit-compositor-rgba8' });
    const firstError = {
      code: 'device-operation-failed',
      expected: 'the active device generation completes the renderer-owned operation',
      hint: 'inspect renderer state and the structured cause, then retry or recover',
      detail: {
        operation: 'draw',
        frameId: 60,
        deviceGeneration: 4,
        cause: {
          code: 'surface-unavailable',
          expected: 'the presentation surface accepts the requested lifecycle operation',
          hint: 'inspect renderer state, then restore the surface or create a new Renderer',
          detail: { operation: 'acquire-swap-chain-target' },
        },
      },
    };
    applyRuntimeEvent(cache, {
      configureUsageBefore: 0x10,
      configureUsageAfter: 0x10,
      rawCopyInjected: false,
      surfaceIdentity: 'canvas-surface-1',
      lastSuccessfulLifecyclePhase: 'surface-configured',
      rendererError: firstError,
    });
    for (let index = 0; index < 32; index += 1) {
      applyRuntimeEvent(cache, {
        rendererError: { code: 'device-operation-failed', detail: { operation: `draw-${index}` } },
      });
    }
    const poisonedReport = snapshotRuntimeCache(cache);
    expect(poisonedReport.configureUsageBefore).toBe(0x10);
    expect(poisonedReport.configureUsageAfter).toBe(0x10);
    expect(poisonedReport.rawCopyInjected).toBe(false);
    expect(poisonedReport.lastSuccessfulLifecyclePhase).toBe('surface-configured');
    expect(poisonedReport.surfaceIdentity).toBe('canvas-surface-1');
    expect(poisonedReport.firstRendererError).toEqual(firstError);
    expect(poisonedReport.rendererErrors).toHaveLength(8);
  });

  it('transports structured renderer events through the browser marker channel', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../../scripts/smoke-browser.mjs'), 'utf8');
    const appSource = readFileSync(resolve(import.meta.dirname, '../main.ts'), 'utf8');
    expect(source).toContain('__forgeaxDarkGradientRuntime:');
    expect(source).toContain('snapshotRuntimeCache(runtimeCache)');
    expect(source).toContain('pagePoisoned ? \'page-abandoned-after-timeout\'');
    expect(appSource).toContain('app.renderer.subscribe((event) =>');
    expect(appSource).toContain('projectRendererError(event.error)');
    expect(appSource).not.toContain('error.message.includes');
  });

  it('allows slow software WebGL2 fallback to reach the 60-frame observation', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../../scripts/smoke-browser.mjs'), 'utf8');
    expect(source).toContain('FORGEAX_BROWSER_HARD_DEADLINE_MS ?? 180_000');
    expect(source).toContain('FORGEAX_DARK_GRADIENT_OBSERVATION_TIMEOUT_MS ?? 90_000');
  });

  it('arms capture from the Engine observation phase instead of global rAF frame numbers', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../../scripts/smoke-browser.mjs'), 'utf8');
    expect(source).toContain('__forgeaxDarkGradientArmCapture');
    expect(source).toContain("captures?.has('none')");
    expect(readFileSync(resolve(import.meta.dirname, '../main.ts'), 'utf8')).toContain('__forgeaxDarkGradientArmCapture?.');
    expect(source).not.toContain('captureTargets');
    expect(source).not.toContain('frame >= target');
    expect(source).toContain('armedEngineFrame');
    expect(source).toContain('actualSubmitFrame');
    expect(source).toContain('webkitPaused');
    expect(source).toContain('pausedAnimationFrames');
    expect(source).not.toContain('__forgeaxDarkGradientWebkitReadback');
    expect(source).toContain('pagePoisoned');
    expect(source).toContain('diagnostics-evaluate');
    expect(source).toContain('hard-deadline-exceeded');
    expect(source).toContain('cleanup-failed');
    expect(source).toContain('if (!pagePoisoned)');
  });

  it('uses the pixel-source contract to separate WebGPU copy from WebKit screenshots', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../../scripts/smoke-browser.mjs'), 'utf8');
    expect(pixelSourceForBackend('browser-webgpu')).toEqual({ endpoint: 'surface.storage.raw', method: 'gpu-raw-readback' });
    expect(pixelSourceForBackend('webkit-webgl2')).toEqual({ endpoint: 'surface.display.final', method: 'webkit-compositor-rgba8' });
    expect(pixelSourceForBackend('chromium-webgl2')).toEqual({ endpoint: 'surface.display.final', method: 'chromium-compositor-rgba8' });
    expect(source).toContain('const usesRawReadback = pixelSource.method === \'gpu-raw-readback\';');
    expect(source).toContain('const usageAfter = rawReadback ? usageBefore | 1 : usageBefore;');
    expect(source).toContain('if (!rawReadback) return device;');
    expect(source).toContain('state.rawCopyInjected = true;');
    expect(source).toContain('pixelSourceMethod');
    expect(source).toContain('configureUsageBefore');
    expect(source).toContain('rendererErrors');
  });

  it('preserves complete browser state in insufficient-evidence reports', () => {
    const diagnostics = {
      state: 'capture-not-submitted',
      navigatorGpu: true,
      adapterCaptured: true,
      deviceCaptured: true,
      rafFrame: 607,
      lastRenderedFrame: 607,
      submittedFrames: [{ rafFrame: 607, engineFrameId: 60, observationId: 'none' }],
      captureKeys: [],
      noneObservation: { status: 'ready', frameId: 60, observationId: 'none' },
      pageConsole: [],
      pageErrors: [],
      requestFailed: [],
    };
    const report = createInsufficientEvidenceReport({ backendId: 'browser-webgpu', lane: 'direct', reason: 'capture-not-submitted', diagnostics });
    expect(report.status).toBe('insufficient-evidence');
    expect(report.diagnostics).toMatchObject(diagnostics);
    expect(report.errors[0].detail.state).toBe('capture-not-submitted');
  });

  it('uses paired U and scanline level retention denominators', () => {
    const none = frame((x, y) => [x % 256, y % 256, (x + y) % 256]);
    const fxaa = frame((x, y) => [x % 128, y % 256, (x + y) % 256]);
    const metrics = computeDarkGradientMetrics(fxaa, none);

    expect(metrics.uniqueColorCount).toBeGreaterThan(0);
    expect(metrics.referenceUniqueColorCount).toBeGreaterThan(0);
    expect(metrics.uniqueColorRatio).toBeCloseTo(
      metrics.uniqueColorCount / metrics.referenceUniqueColorCount,
      12,
    );
    expect(metrics.scanlineLevels).toBeGreaterThan(0);
    expect(metrics.referenceScanlineLevels).toBeGreaterThan(0);
    expect(metrics.levelRatio).toBeCloseTo(
      metrics.scanlineLevels / metrics.referenceScanlineLevels,
      12,
    );
  });

  it('reports affected-pixel ratio without making it an acceptance gate', () => {
    const reference = frame(() => [20, 20, 20]);
    const observed = frame((x) => (x === 0 ? [21, 20, 20] : [20, 20, 20]));
    const metrics = computeDarkGradientMetrics(observed, reference);

    expect(metrics.affectedPixelRatio).toBeCloseTo(1 / WIDTH, 12);
  });

  it('uses the fixture gradient stops to create spatial baseline diversity', () => {
    const texture = createDarkGradientTexture();
    const colors = new Set();
    for (let index = 0; index < texture.data.length; index += 4) {
      colors.add(`${texture.data[index]}:${texture.data[index + 1]}:${texture.data[index + 2]}`);
    }
    expect(colors.size).toBeGreaterThan(16);
    expect(texture.data[0]).not.toBe(texture.data[texture.data.length - 4]);
  });

  it('keeps the stop interpolation bounded and monotonic without byte wrapping', () => {
    const samples = Array.from({ length: 101 }, (_, index) => gradientValue(index / 100, 16));
    expect(samples.every((value) => value >= 0 && value <= 1)).toBe(true);
    expect(samples.every((value, index) => index === 0 || value >= samples[index - 1])).toBe(true);
    const texture = createDarkGradientTexture();
    let minimum = 255;
    let maximum = 0;
    for (const value of texture.data) {
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
    expect(maximum).toBeLessThanOrEqual(255);
    expect(minimum).toBeGreaterThanOrEqual(0);
  });

  it('fails closed when the paired no-FXAA observation identity is missing', () => {
    const bytes = frame((x, y) => [x % 256, y % 256, (x + y) % 256]);
    const report = createDarkGradientFixtureReport({
      backendId: 'dawn',
      lane: 'direct',
      bytes,
      referenceBytes: bytes,
      surface: {
        storageFormat: 'rgba8unorm',
        displayFormat: 'rgba8unorm-srgb',
        intermediateFormat: 'rgba16float',
        domain: 'display-encoded',
        endpoint: 'surface.storage.raw',
      },
      identity: { observationId: 'fxaa', frameId: 600, rendererInspectionRef: 'fxaa:frame-600' },
    });
    expect(report.status).toBe('insufficient-evidence');
    expect(report.errors.some((error) => error.expected.includes('referenceObservationIdentity'))).toBe(true);
  });

  it('keeps raw inspection facts separate from WebKit final-display pixels', () => {
    const bytes = frame((x, y) => [x % 256, y % 256, (x + y) % 256]);
    const report = createDarkGradientFixtureReport({
      backendId: 'webkit-webgl2',
      lane: 'direct',
      bytes,
      referenceBytes: bytes,
      surface: {
        storageFormat: 'rgba8unorm',
        displayFormat: 'rgba8unorm-srgb',
        intermediateFormat: 'rgba16float',
        domain: 'display-encoded',
        endpoint: 'surface.display.final',
      },
      identity: { observationId: 'fxaa', frameId: 600, rendererInspectionRef: 'fxaa:frame-600' },
      referenceIdentity: { observationId: 'none', frameId: 60, rendererInspectionRef: 'none:frame-60' },
    });
    expect(report.surface.endpoint).toBe('surface.storage.raw');
    expect(report.pixelSource).toEqual({ endpoint: 'surface.display.final', method: 'webkit-compositor-rgba8' });
  });

  it('does not default an unknown backend to a raw pixel source', () => {
    const bytes = frame((x, y) => [x % 256, y % 256, (x + y) % 256]);
    const report = createDarkGradientFixtureReport({
      backendId: 'unknown-backend',
      lane: 'direct',
      bytes,
      referenceBytes: bytes,
      surface: {
        storageFormat: 'rgba8unorm',
        displayFormat: 'rgba8unorm-srgb',
        intermediateFormat: 'rgba16float',
        domain: 'display-encoded',
        endpoint: 'surface.storage.raw',
      },
      identity: { observationId: 'fxaa', frameId: 600, rendererInspectionRef: 'fxaa:frame-600' },
      referenceIdentity: { observationId: 'none', frameId: 60, rendererInspectionRef: 'none:frame-60' },
    });
    expect(report.status).toBe('insufficient-evidence');
    expect(report.pixelSource).toEqual({ endpoint: '', method: '' });
  });

  it('records expected and actual falsifier gates', () => {
    const bytes = frame(() => [20, 20, 20]);
    const falsifiers = runDarkGradientFalsifiers(bytes, bytes);
    expect(falsifiers.map((entry) => entry.expectedGate)).toEqual([
      'uniqueColorRatio',
      'brightness',
      'meanAbsoluteChannelDelta',
      'surface-view-capability',
      'raw-only-overlay-ordering',
    ]);
    expect(falsifiers[1].actualFailedGates).toContain('brightness');
  });

  it('rejects missing surface view capability and raw-only post-transform overlay', () => {
    const falsifiers = runDarkGradientRouteFalsifiers();
    expect(falsifiers).toEqual([
      expect.objectContaining({
        mutation: 'missing-surface-view-capability',
        expectedGate: 'surface-view-capability',
        actualFailedGates: ['surface-view-capability'],
        passed: false,
      }),
      expect.objectContaining({
        mutation: 'raw-only-overlay-after-transform',
        expectedGate: 'raw-only-overlay-ordering',
        actualFailedGates: ['raw-only-overlay-ordering'],
        passed: false,
      }),
    ]);
    expect(failedRouteGates({
      surfaceProfile: 'dual-view',
      surfaceViewFormats: true,
      declaresDisplayView: true,
      overlayStage: 'after-output-transform',
    })).toEqual([]);
  });
});
