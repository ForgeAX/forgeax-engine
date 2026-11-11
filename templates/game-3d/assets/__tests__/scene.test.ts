import { CAMERA_EXPOSURE_MODE_MANUAL } from '@forgeax/engine/render';
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
  it('lights the scene with a shadow-casting sun, an unshadowed second DirectionalLight and an analytic Atmosphere sky, with no sky image', async () => {
    const scene = (await build(scenePack))['scene/showcase'] as {
      readonly entities: Record<string, { readonly components: Record<string, Record<string, unknown>> }>;
    };
    const components = Object.values(scene.entities).map((entry) => entry.components);
    const directionals = components.filter((entry) => entry.DirectionalLight);
    // The sun is the first castShadow DirectionalLight; the other one never requests shadows.
    expect(directionals).toHaveLength(2);
    expect(directionals[0]?.DirectionalLight?.castShadow).toBe(true);
    expect(directionals[1]?.DirectionalLight?.castShadow).toBeUndefined();
    expect(components.filter((entry) => entry.Atmosphere)).toHaveLength(1);
    // A starter must run on baseline device limits.
    expect(components.find((entry) => entry.Atmosphere)?.Atmosphere?.backgroundOnly).toBe(true);
    expect(components.filter((entry) => entry.SkyboxBackground)).toHaveLength(0);
    const skylights = components.filter((entry) => entry.Skylight);
    expect(skylights).toHaveLength(1);
    expect(skylights[0]?.Skylight?.equirect).toBeUndefined();
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
      'Lacquer Collision Cube',
      'Rusted Iron Ramp',
    ]) {
      const object = components.find((entry) => entry.Name?.value === name);
      expect(object?.RigidBody).toMatchObject({ type: 0 });
      expect(object?.Collider).toBeDefined();
    }
    expect(components.find((entry) => entry.Name?.value === 'Player Body')?.Skin).toBeDefined();
    expect(scene.skinGuids).toHaveLength(1);
    const sun = components.find((entry) => entry.DirectionalLight)?.DirectionalLight;
    expect(sun).toMatchObject({ castShadow: true });
    // The game opts into shadows while the engine owns the cascade defaults.
    expect(sun).not.toHaveProperty('cascadeCount');
    expect(components.some((entry) => entry.Skylight !== undefined)).toBe(true);
    expect(components.some((entry) => entry.PointLight !== undefined)).toBe(true);
    const camera = components.find((entry) => entry.Camera !== undefined)?.Camera;
    expect(components.some((entry) => entry.Atmosphere !== undefined)).toBe(true);
    // The template keeps a fixed exposure so lighting edits show directly in the frame.
    expect(camera).toMatchObject({ exposure: 0.95, exposureMode: CAMERA_EXPOSURE_MODE_MANUAL });
  });
});
