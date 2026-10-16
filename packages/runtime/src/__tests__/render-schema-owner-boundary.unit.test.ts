import { World } from '@forgeax/engine-ecs';
import { Camera, perspective } from '@forgeax/engine-render';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { prepareExtractContext } from '../../../render/src/render-system-extract';
import { extractFrame } from '../../../render/src/render-system-extract-tail';

describe('render extract owner boundary', () => {
  it('joins render Camera with scene Transform in one world', () => {
    const world = new World();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 3] } },
        { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
      )
      .unwrap();

    expect(propagateTransforms(world).ok).toBe(true);
    const frame = extractFrame(world, prepareExtractContext(world));
    expect(frame.cameras).toHaveLength(1);
    expect(frame.cameras[0]?.position[2]).toBeCloseTo(3);
  });
});
