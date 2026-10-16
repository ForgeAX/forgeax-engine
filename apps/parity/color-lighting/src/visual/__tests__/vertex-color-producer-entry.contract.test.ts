import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canvasViewFormats,
  installNodeAnimationContext,
  normalizeCanvasReadbackBytes,
  sampleValuesForDomain,
} from '../vertex-color-capture';
import { runVertexColorProducerEntry, vertexColorProducerIsScheduled } from '../vertex-color-producer-entry';

const environmentKeys = [
  'FORGEAX_VERTEX_COLOR_CASE_ID',
  'FORGEAX_VERTEX_COLOR_OUTPUT',
  'FORGEAX_VERTEX_COLOR_SOURCE_SHA',
  'FORGEAX_VERTEX_COLOR_SCHEDULED',
] as const;

const previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of environmentKeys) {
    const previous = previousEnvironment.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  globalThis.__forgeaxVertexColorPublish = undefined;
});

describe('vertex-color producer entry contract', () => {
  it('declares compatible Dawn canvas view formats', () => {
    expect(canvasViewFormats('rgba8unorm')).toEqual(['rgba8unorm-srgb']);
    expect(canvasViewFormats('bgra8unorm')).toEqual(['bgra8unorm-srgb']);
    expect(canvasViewFormats('rgba16float')).toEqual([]);
  });

  it('samples both producers from the fixture-declared color domain', () => {
    const fixture = {
      colorDomain: 'displayEncoded' as const,
      samplePoints: [{ id: 'center', coordinate: [0.5, 0.5] as const }],
    };
    const linearBytes = new Uint8Array([0, 60, 0, 60, 0, 60, 0, 60]);
    const finalBytes = new Uint8Array([255, 128, 64, 255]);
    expect(sampleValuesForDomain(linearBytes, finalBytes, fixture, 1, 1)[0]?.rgba).toEqual([
      1,
      128 / 255,
      64 / 255,
      1,
    ]);
    expect(
      sampleValuesForDomain(linearBytes, finalBytes, { ...fixture, colorDomain: 'linearHdr' }, 1, 1)[0]
        ?.rgba,
    ).toEqual([1, 1, 1, 1]);
  });

  it('normalizes BGRA swap-chain readback without changing RGBA attachments', () => {
    const bytes = new Uint8Array([3, 2, 1, 4]);
    expect(normalizeCanvasReadbackBytes(bytes, 'bgra8unorm-srgb')).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
    expect(normalizeCanvasReadbackBytes(bytes, 'rgba8unorm-srgb')).toBe(bytes);
  });

  it('bounds and restores the Node animation context used by Three Dawn', async () => {
    const scope = globalThis as unknown as {
      self?: {
        requestAnimationFrame?: (callback: (time: number) => void) => number;
      };
    };
    const previousSelf = scope.self;
    const lease = installNodeAnimationContext();
    let callbackCount = 0;
    const requestAnimationFrame = scope.self?.requestAnimationFrame;
    expect(requestAnimationFrame).toBeTypeOf('function');
    const loop = (): void => {
      callbackCount += 1;
      requestAnimationFrame?.(loop);
    };
    requestAnimationFrame?.(loop);
    await new Promise((resolve) => setTimeout(resolve, 10));
    lease.restore();
    expect(callbackCount).toBeGreaterThan(0);
    expect(callbackCount).toBeLessThanOrEqual(302);
    expect(scope.self).toBe(previousSelf);
  });

  it('keeps the Vite virtual adapter at the Browser entry boundary', async () => {
    const captureSource = readFileSync(new URL('../vertex-color-capture.ts', import.meta.url), 'utf8');
    expect(captureSource).not.toMatch(/from ['"]virtual:forgeax\/bundler/);

    process.env.FORGEAX_VERTEX_COLOR_CASE_ID = 'vertex-color-vec3';
    process.env.FORGEAX_VERTEX_COLOR_OUTPUT = '/tmp/vertex-color-entry-contract.json';
    process.env.FORGEAX_VERTEX_COLOR_SOURCE_SHA = 'a'.repeat(40);
    globalThis.__forgeaxVertexColorPublish = () => {};
    await expect(runVertexColorProducerEntry('forgeax', 'dawn')).rejects.toThrow(
      /ForgeaX bundler options were not injected into the capture entry/,
    );
  });

  it('opts the ForgeaX producer into the renderer-owned linear-HDR observation', () => {
    const captureSource = readFileSync(new URL('../vertex-color-capture.ts', import.meta.url), 'utf8');
    expect(captureSource).toMatch(/tonemap:\s*TONEMAP_LINEAR/);
    expect(captureSource).toMatch(/zero-config tonemap path writes directly to the display surface/);
  });

  it('accepts the repository Git SHA and reaches the live publisher blocker', async () => {
    process.env.FORGEAX_VERTEX_COLOR_CASE_ID = 'vertex-color-vec3';
    process.env.FORGEAX_VERTEX_COLOR_OUTPUT = '/tmp/vertex-color-entry-contract.json';
    process.env.FORGEAX_VERTEX_COLOR_SOURCE_SHA = 'a'.repeat(40);
    process.env.FORGEAX_VERTEX_COLOR_SCHEDULED = '1';

    expect(vertexColorProducerIsScheduled()).toBe(true);
    await expect(runVertexColorProducerEntry('forgeax', 'dawn')).rejects.toThrow(
      /producer output publisher is unavailable/,
    );
  });

  it.each(['not-a-sha', 'a'.repeat(39), 'A'.repeat(40)])('rejects malformed source SHA %s before capture', async (sourceSha) => {
    process.env.FORGEAX_VERTEX_COLOR_CASE_ID = 'vertex-color-vec3';
    process.env.FORGEAX_VERTEX_COLOR_OUTPUT = '/tmp/vertex-color-entry-contract.json';
    process.env.FORGEAX_VERTEX_COLOR_SOURCE_SHA = sourceSha;
    process.env.FORGEAX_VERTEX_COLOR_SCHEDULED = '1';

    await expect(runVertexColorProducerEntry('forgeax', 'dawn')).rejects.toThrow(
      /case\/output\/source SHA environment is incomplete/,
    );
  });
});
