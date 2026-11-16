import { CAMERA_EXPOSURE_MODE_AUTO } from '@forgeax/engine/render';
import { describe, expect, it } from 'vitest';
import { PLAYER_COLLIDER } from '../shared/player-rig.ts';
import scenePack from '../scene.pack.ts';

async function build(pack: {
  readonly build: (reader: never) => unknown;
}): Promise<Record<string, unknown>> {
  const result = await pack.build(undefined as never);
  if (typeof result !== 'object' || result === null || !('ok' in result) || result.ok !== true) {
    throw new Error(`ScriptablePack build failed: ${JSON.stringify(result)}`);
  }
  return (result as unknown as { readonly value: Record<string, unknown> }).value;
}

describe('world scene', () => {
  it('lights the clear-day scene with one shadow-casting sun and a physical sky', async () => {
    const scene = (await build(scenePack))['scene/showcase'] as {
      readonly entities: Record<string, { readonly components: Record<string, Record<string, unknown>> }>;
    };
    const components = Object.values(scene.entities).map((entry) => entry.components);
    const directionals = components.filter((entry) => entry.DirectionalLight);
    // The daylight recipe has one key light; the sky supplies environment lighting.
    expect(directionals).toHaveLength(1);
    expect(directionals[0]?.DirectionalLight?.castShadow).toBe(true);
    expect(components.filter((entry) => entry.Atmosphere)).toHaveLength(1);
    // Keep the full physical transport, with less aerosol haze for a clear day.
    expect(components.find((entry) => entry.Atmosphere)?.Atmosphere).toEqual({ mieScattering: 1.998e-6, mieAbsorption: 0.222e-6 });
    expect(components.filter((entry) => entry.SkyboxBackground)).toHaveLength(0);
    const skylights = components.filter((entry) => entry.Skylight);
    expect(skylights).toHaveLength(1);
    expect(skylights[0]?.Skylight).toEqual({});
    expect(components.filter((entry) => entry.Fog)).toHaveLength(1);
    expect(components.find((entry) => entry.Fog)?.Fog).toEqual({ density: 0.00008 });
  });

  it('authors physics on the player and every visible walkable obstacle', { timeout: 30000 }, async () => {
    const scene = (await build(scenePack))['scene/showcase'] as {
      readonly skinGuids: readonly string[];
      readonly entities: Record<
        string,
        { readonly components: Record<string, Record<string, unknown>> }
      >;
    };
    const components = Object.values(scene.entities).map((entity) => entity.components);
    const player = components.find((entry) => entry.Name?.value === 'Player');
    expect(player).toMatchObject({
      RigidBody: { type: 2 },
      Collider: { radius: PLAYER_COLLIDER.radius, halfHeight: PLAYER_COLLIDER.halfHeight },
      CharacterController: { autoStepMaxHeight: 0.32, snapToGroundDist: 0.24 },
    });
    for (const name of [
      'Ground',
      'Rusted Iron Sphere',
    ]) {
      const object = components.find((entry) => entry.Name?.value === name);
      expect(object?.RigidBody).toMatchObject({ type: 0 });
      expect(object?.Collider).toBeDefined();
    }
    const sphere = components.find((entry) => entry.Name?.value === 'Rusted Iron Sphere');
    expect(sphere).toMatchObject({
      Transform: { pos: [0, 1, 2.4], scale: [1, 1, 1] },
      Collider: { shape: 1, radius: 1 },
    });
    expect(components.find((entry) => entry.Name?.value === 'Player Body')?.Skin).toBeDefined();
    expect(scene.skinGuids).toHaveLength(1);
    const sun = components.find((entry) => entry.DirectionalLight)?.DirectionalLight;
    expect(sun).toMatchObject({ castShadow: true });
    // The game opts into shadows while the engine owns the cascade defaults.
    expect(sun).not.toHaveProperty('cascadeCount');
    expect(components.some((entry) => entry.Skylight !== undefined)).toBe(true);
    expect(components.some((entry) => entry.PointLight !== undefined)).toBe(false);
    const camera = components.find((entry) => entry.Camera !== undefined)?.Camera;
    expect(components.some((entry) => entry.Atmosphere !== undefined)).toBe(true);
    // The template meters exposure automatically with no compensation bias.
    expect(camera).toMatchObject({
      exposure: 0.95,
      exposureMode: CAMERA_EXPOSURE_MODE_AUTO,
      compensationEv: 0,
    });
  });
});
