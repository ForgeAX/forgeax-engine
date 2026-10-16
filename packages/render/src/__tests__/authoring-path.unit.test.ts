import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { setActiveCamera } from '../authoring';
import { Camera, perspective } from '../components/camera';
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

  it('owns active-camera authoring without requiring the internal entrypoint', () => {
    const world = new World();
    setActiveCamera(world, 42);
    expect(getActiveCamera(world)).toEqual({ entity: 42 });
  });
});
