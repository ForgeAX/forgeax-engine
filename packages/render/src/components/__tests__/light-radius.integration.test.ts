import { createWorldContext, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { renderComponentsPlugin } from '../../plugin';
import { DirectionalLight, DirectionalShadowFilterValue } from '../directional-light';
import { validateDirectionalLightData } from '../light-helpers';

function adjacentFloat32(value: number, direction: -1 | 1): number {
  const floats = new Float32Array([value]);
  const bits = new Uint32Array(floats.buffer);
  bits[0] = (bits[0] ?? 0) + direction;
  return floats[0] ?? NaN;
}

describe('PCSS angular radius storage boundary', () => {
  for (const shadowFilter of [
    DirectionalShadowFilterValue.pcssMedium,
    DirectionalShadowFilterValue.pcssHigh,
  ]) {
    it(`accepts both authored endpoints after World spawn and set (${shadowFilter})`, async () => {
      const world = new World();
      const context = await createWorldContext(world, [renderComponentsPlugin()]);
      try {
        for (const radius of [0.0001, 0.05]) {
          const data = { direction: [0, -1, 0], shadowFilter, shadowAngularRadius: radius };
          expect(validateDirectionalLightData(data).ok).toBe(true);
          const entity = world.spawn({ component: DirectionalLight, data }).unwrap();
          const stored = world.get(entity, DirectionalLight).unwrap();
          expect(stored.shadowAngularRadius).toBe(Math.fround(radius));
          expect(validateDirectionalLightData(stored).ok).toBe(true);
          world.set(entity, DirectionalLight, { shadowAngularRadius: 0.025 }).unwrap();
          world.set(entity, DirectionalLight, { shadowAngularRadius: radius }).unwrap();
          expect(
            validateDirectionalLightData(world.get(entity, DirectionalLight).unwrap()).ok,
          ).toBe(true);
        }
      } finally {
        await context.fiber.dispose();
      }
    });
  }

  it.each([
    adjacentFloat32(0.0001, -1),
    adjacentFloat32(0.05, 1),
    0,
    -1,
    NaN,
    Infinity,
    -Infinity,
  ])('rejects a radius outside the float32 endpoints: %s', (shadowAngularRadius) => {
    const result = validateDirectionalLightData({
      direction: [0, -1, 0],
      shadowFilter: DirectionalShadowFilterValue.pcssHigh,
      shadowAngularRadius,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('shadow-invalid-config');
  });
});
