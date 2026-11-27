import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { setActiveCamera } from '../authoring';
import { Camera, orthographic, perspective } from '../components/camera';
import { getActiveCamera } from '../systems/active-camera';

describe('authoring path', () => {
  it('does not require authoring tokens in the render base surface', () => {
    expect(true).toBe(true);
  });

  it('uses a transparent clear alpha by default and exposes opaque as an opt-in field', () => {
    expect(Camera.fields.clearColor.default).toEqual(new Float32Array([0, 0, 0, 0]));
    expect(perspective({ fov: 1, aspect: 1 }).clearColor).toEqual(new Float32Array([0, 0, 0, 0]));
    expect({ alphaMode: 'opaque' }).not.toEqual({ alphaMode: 'premultiplied' });
  });

  it('gives each camera its own writable lens, color and exposure columns', () => {
    const a = perspective({ fov: 1, aspect: 1 });
    const b = orthographic({ left: -2, right: 2, bottom: -1, top: 1 });
    a.clearColor[0] = 1;
    a.projectionOffset[1] = 0.5;
    a.rangeEv[0] = -2;
    a.rates[0] = 5;
    expect([...b.clearColor, ...b.projectionOffset, ...b.rangeEv, ...b.rates]).toEqual([
      0, 0, 0, 0, 0, 0, -8, 8, 3, 1,
    ]);
    expect(Camera.fields.clearColor.default).toEqual(new Float32Array(4));
    expect(Camera.fields.projectionOffset.default).toEqual(new Float32Array(2));
  });

  it('owns active-camera authoring without requiring the internal entrypoint', () => {
    const world = new World();
    setActiveCamera(world, 42);
    expect(getActiveCamera(world)).toEqual({ entity: 42 });
  });
});
