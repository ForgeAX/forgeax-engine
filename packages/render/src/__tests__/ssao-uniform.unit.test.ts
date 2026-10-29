import { mat4, vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import { jitterCameraProjection } from '../camera-projection';
import { computeProjectionMatrix, computeViewMatrix } from '../record/helpers';
import type { CameraSnapshot } from '../render-contract';
import { buildSsaoUniformPayload } from '../ssao-uniform';

function camera(): CameraSnapshot {
  return {
    entityKey: 1,
    worldId: 0,
    historyVersion: 0,
    position: vec3.create(0, 0, 5),
    world: mat4.identity(mat4.create()),
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
    whitePoint: 4,
    antialias: 'none',
    bloom: 'off',
    bloomThreshold: 1,
    bloomIntensity: 1,
    bloomSmoothWidth: 0.01,
    bloomRadius: 0,
    clearColor: [0, 0, 0, 1],
  };
}

function matrixPayload(source: CameraSnapshot): Float32Array {
  const projection = computeProjectionMatrix(source, mat4.create());
  jitterCameraProjection(projection, projection, source.temporal?.currentJitterUv);
  const output = new Float32Array(48);
  output.set(computeViewMatrix(source, mat4.create()));
  output.set(projection, 16);
  output.set(mat4.invert(mat4.create(), projection), 32);
  return output;
}

describe('SSAO matrix scratch ownership', () => {
  it.each([
    'perspective',
    'orthographic',
    'stereo',
    'capture',
  ] as const)('keeps owned %s payloads and zero padding after later writes', (kind) => {
    const source: CameraSnapshot = {
      ...camera(),
      projection: kind === 'orthographic' ? 'orthographic' : 'perspective',
      ...(kind === 'stereo' ? { projectionOffset: [-0.04, 0.02] as const } : {}),
      ...(kind === 'capture' ? { captureProjection: new Float32Array([2, 3, 4]) } : {}),
    };
    const expected = matrixPayload(source);
    const first = buildSsaoUniformPayload(source, undefined);
    expect(first.slice(0, 48)).toEqual(expected);
    expect(first.slice(56)).toEqual(new Float32Array(8));
    const retained = first.slice();
    const next = buildSsaoUniformPayload(camera(), { enabled: true, intensity: 2 });
    expect(first).toEqual(retained);
    expect(next.buffer).not.toBe(first.buffer);
  });

  it('isolates nested camera reads and recovers after camera getter failure', () => {
    const source = camera();
    const expected = matrixPayload(source);
    const nestedSource = { ...camera(), aspect: 2 };
    const nestedExpected = matrixPayload(nestedSource);
    let nested: Float32Array | undefined;
    const reentrant = {
      ...source,
      get world() {
        nested = buildSsaoUniformPayload(nestedSource, undefined);
        return source.world;
      },
    };
    expect(buildSsaoUniformPayload(reentrant, undefined).slice(0, 48)).toEqual(expected);
    expect(nested?.slice(0, 48)).toEqual(nestedExpected);
    const failure = new Error('SSAO camera getter failed');
    const throwing = {
      ...source,
      get world(): Float32Array {
        throw failure;
      },
    };
    expect(() => buildSsaoUniformPayload(throwing, undefined)).toThrow(failure);
    expect(buildSsaoUniformPayload(source, undefined).slice(0, 48)).toEqual(expected);
  });
});
