import { World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { warnIgnoredDirectionalShadowCasters } from '../helpers';

function lightFixture() {
  const world = new World();
  const entity = world.spawn().unwrap();
  const firstIgnored = world.spawn().unwrap();
  const secondIgnored = world.spawn().unwrap();
  return {
    directional: {
      kind: 'directional' as const,
      entity,
      direction: vec3.create(0, -1, 0),
      color: vec3.create(1, 1, 1),
      intensity: 1,
      contactShadowLength: 0,
    },
    ignoredDirectionalShadowCasters: [firstIgnored, secondIgnored],
  };
}

describe('warnIgnoredDirectionalShadowCasters', () => {
  afterEach(() => vi.restoreAllMocks());

  it('stays silent without ignored shadow casters', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const frameState = { warnedIgnoredDirectionalShadow: false };
    warnIgnoredDirectionalShadowCasters(frameState, {
      directional: lightFixture().directional,
      ignoredDirectionalShadowCasters: [],
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('warns once, naming the CSM owner and the ignored entities', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const frameState = { warnedIgnoredDirectionalShadow: false };
    const lights = lightFixture();
    warnIgnoredDirectionalShadowCasters(frameState, lights);
    warnIgnoredDirectionalShadowCasters(frameState, lights);
    expect(spy).toHaveBeenCalledTimes(1);
    const message = String(spy.mock.calls[0]?.[0]);
    expect(message).toContain(`entity ${lights.directional.entity} owns the single CSM shadow`);
    expect(message).toContain(
      `entities ${lights.ignoredDirectionalShadowCasters.join(', ')} render unshadowed`,
    );
  });
});
