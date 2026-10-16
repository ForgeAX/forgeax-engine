import type { RhiQueue } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { writeViewUbo } from '../record/view-ubo';
import type { CameraSnapshot } from '../render-contract';
import type { DirectionalLightSnapshot, ExtractedLights } from '../render-system-extract';
import {
  createTemporalView,
  HALTON_23_8,
  resolveTemporalReset,
  type TemporalResetReason,
} from '../temporal/view';

describe('TemporalView v1', () => {
  it('uses the fixed eight-sample Halton(2,3) sequence', () => {
    expect(HALTON_23_8).toEqual([
      [0, -1 / 6],
      [-0.25, 1 / 6],
      [0.25, -5 / 18],
      [-0.375, -1 / 18],
      [0.125, 5 / 18],
      [-0.125, -7 / 54],
      [0.375, 11 / 54],
      [-0.4375, 7 / 18],
    ]);
  });

  it('keeps jittered current projection separate from unjittered previous projection', () => {
    const view = createTemporalView({
      antialias: 'taa',
      width: 1280,
      height: 720,
      frameIndex: 3,
      viewIdentity: 'camera:main',
    });
    const jitter = (HALTON_23_8[3] ?? [0, 0]) as readonly [number, number];
    expect(view.jitter).toEqual(jitter);
    expect(view.currentProjection).toBe('jittered');
    expect(view.previousProjection).toBe('unjittered');
    expect(view.jitterCancellationUv).toEqual([jitter[0] / 1280, jitter[1] / 720]);
  });

  it('uses the fixed internal extent for TAAU jitter while preserving output dimensions', () => {
    const view = createTemporalView({
      antialias: 'taa',
      width: 200,
      height: 150,
      internalWidth: 128,
      internalHeight: 96,
      frameIndex: 1,
    });
    const jitter = (HALTON_23_8[1] ?? [0, 0]) as readonly [number, number];
    expect(view.input.width).toBe(200);
    expect(view.input.height).toBe(150);
    expect(view.input.internalWidth).toBe(128);
    expect(view.input.internalHeight).toBe(96);
    expect(view.jitterCancellationUv).toEqual([jitter[0] / 128, jitter[1] / 96]);
  });

  it.each([
    ['first-frame', undefined, 'first-frame'],
    ['resize', { width: 640, height: 360 }, 'resize'],
    ['camera-cut', { cameraCut: true }, 'camera-cut'],
    ['history-version', { historyVersion: 2 }, 'history-version'],
    ['view-switch', { viewIdentity: 'camera:secondary' }, 'view-switch'],
    ['environment-change', { environmentSignature: 'env:2' }, 'environment-change'],
    ['fog-change', { fogSignature: 'fog:2' }, 'fog-change'],
    ['device-recover', { deviceGeneration: 2 }, 'device-recover'],
  ] as const)('reports %s as a deterministic reset reason', (reason, changes, expected) => {
    const previous = createTemporalView({
      antialias: 'taa',
      width: 1280,
      height: 720,
      historyVersion: 1,
      viewIdentity: 'camera:main',
      environmentSignature: 'env:1',
      fogSignature: 'fog:1',
      deviceGeneration: 1,
    });
    const next = createTemporalView({
      antialias: 'taa',
      width: 1280,
      height: 720,
      historyVersion: 1,
      viewIdentity: 'camera:main',
      environmentSignature: 'env:1',
      fogSignature: 'fog:1',
      deviceGeneration: 1,
      ...changes,
    });
    const resolved =
      reason === 'first-frame'
        ? resolveTemporalReset(undefined, next)
        : resolveTemporalReset(previous, next);
    expect(resolved).toBe(expected satisfies TemporalResetReason);
  });

  it('has no jitter or history requirement when antialias is off', () => {
    const view = createTemporalView({ antialias: 'none', width: 320, height: 200 });
    expect(view.mode).toBe('off');
    expect(view.jitter).toBeUndefined();
    expect(view.historyRequired).toBe(false);
  });

  it('writes a zero first-frame previous matrix and only the last successful matrix thereafter', () => {
    const uploads: Float32Array[] = [];
    const queue = {
      writeBuffer: (_buffer: unknown, _offset: number, data: ArrayBufferView) => {
        uploads.push(
          new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
        );
        return { ok: true, value: undefined };
      },
    } as unknown as RhiQueue;
    const camera = {
      position: new Float32Array([0, 0, 3]),
      world: new Float32Array(16),
      fov: Math.PI / 3,
      aspect: 1,
      near: 0.1,
      far: 100,
      projection: 'perspective',
      orthoLeft: -1,
      orthoRight: 1,
      orthoBottom: -1,
      orthoTop: 1,
      tonemap: 'none',
      exposure: 1,
      whitePoint: 1,
      antialias: 'taa',
      bloom: 'disabled',
      bloomThreshold: 1,
      bloomIntensity: 0,
      bloomSoftKnee: 0.5,
      bloomScatter: 0.7,
      clearColor: [0, 0, 0, 1] as const,
    } as unknown as CameraSnapshot;
    const light = {
      kind: 'directional',
      direction: new Float32Array([0, -1, 0]),
      color: new Float32Array([1, 1, 1]),
      intensity: 1,
      contactShadowLength: 0,
    } as unknown as DirectionalLightSnapshot;
    const lights = {
      directional: light,
      directionalCount: 1,
      point: [],
      spot: [],
      lightViewProj: undefined,
      splitPlanes: undefined,
    } as unknown as ExtractedLights;
    const buffer = {} as Parameters<typeof writeViewUbo>[1];
    const first = createTemporalView({ antialias: 'taa', width: 4, height: 4, frameIndex: 0 });
    writeViewUbo(queue, buffer, camera, light, lights, [], first);
    // Each display write uploads the main slot and three translucent-fog copies.
    expect(uploads).toHaveLength(4);
    expect(Array.from(uploads[0]?.slice(212, 228) ?? [])).toEqual(new Array(16).fill(0));

    const previous = Float32Array.from({ length: 16 }, (_value, index) => index + 1);
    const second = createTemporalView({
      antialias: 'taa',
      width: 4,
      height: 4,
      frameIndex: 1,
      previousUnjitteredViewProjection: previous,
    });
    writeViewUbo(queue, buffer, camera, light, lights, [], second);
    expect(Array.from(uploads[4]?.slice(212, 228) ?? [])).toEqual(Array.from(previous));

    writeViewUbo(queue, buffer, camera, light, lights, [], second);
    expect(Array.from(uploads[8]?.slice(212, 228) ?? [])).toEqual(Array.from(previous));
  });
});
