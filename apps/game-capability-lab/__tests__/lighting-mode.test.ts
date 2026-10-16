import { World } from '@forgeax/engine-ecs';
import { Camera, DirectionalLight, perspective, Skylight, SkyboxBackground } from '@forgeax/engine-render';
import { describe, expect, it, vi } from 'vitest';
import {
  GAME_DEFAULT_LIGHTING_TABLES,
  installLightingModeProjection,
} from '../assets/plugins/lighting-mode';
import { LightingMode } from '../assets/plugins/components/gameplay';
import { Transform } from '@forgeax/engine-scene';

describe('game-default Day/Night lighting owner', () => {
  it('projects one mode fact across authored lights, sky, camera, and reset', () => {
    const expectArrayClose = (actual: readonly number[], expected: readonly number[]): void => {
      expect(actual).toHaveLength(expected.length);
      actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index] ?? 0, 5));
    };
    const expectCameraClose = (actual: typeof GAME_DEFAULT_LIGHTING_TABLES.Day.camera, expected: typeof GAME_DEFAULT_LIGHTING_TABLES.Day.camera): void => {
      expect(actual.tonemap).toBe(expected.tonemap);
      expect(actual.bloom).toBe(expected.bloom);
      expect(actual.exposure).toBeCloseTo(expected.exposure, 5);
      expect(actual.bloomThreshold).toBeCloseTo(expected.bloomThreshold, 5);
      expect(actual.bloomIntensity).toBeCloseTo(expected.bloomIntensity, 5);
      expect(actual.bloomSoftKnee).toBeCloseTo(expected.bloomSoftKnee, 5);
      expect(actual.bloomScatter).toBeCloseTo(expected.bloomScatter, 5);
    };
    const world = new World();
    const sun = world.spawn({ component: DirectionalLight, data: { direction: [-1, -1, -1] } }).unwrap();
    const skylight = world.spawn({ component: Skylight, data: {} }).unwrap();
    const skybox = world.spawn({ component: SkyboxBackground, data: {} }).unwrap();
    const camera = world.spawn(
      { component: Transform, data: {} },
      { component: Camera, data: perspective({ fov: Math.PI / 3, aspect: 1 }) },
    ).unwrap();
    const setLightingMode = vi.fn();
    const lighting = installLightingModeProjection({
      world,
      camera,
      loaded: { mapping: new Map([[1, sun], [21, skylight], [22, skybox]]), nodes: [] },
      hud: { setLightingMode } as never,
    });

    world.update(0).unwrap();
    const day = lighting.snapshot();
    expect(day).toMatchObject({ mode: 'Day', available: true, sourceLocalIds: { sun: 1, skylight: 21, skybox: 22 } });
    expectArrayClose(day.sun.direction, GAME_DEFAULT_LIGHTING_TABLES.Day.sun.direction);
    expectCameraClose(day.camera, GAME_DEFAULT_LIGHTING_TABLES.Day.camera);
    expect(world.get(camera, LightingMode).unwrap().mode).toBe(0);

    expect(lighting.toggle()).toBe('Night');
    world.update(0).unwrap();
    const night = lighting.snapshot();
    expect(night.mode).toBe('Night');
    expectArrayClose(night.sun.direction, GAME_DEFAULT_LIGHTING_TABLES.Night.sun.direction);
    expectArrayClose(night.skylight.rotation, GAME_DEFAULT_LIGHTING_TABLES.Night.skylight.rotation);
    expectCameraClose(night.camera, GAME_DEFAULT_LIGHTING_TABLES.Night.camera);
    expect(night.sun.direction).not.toEqual(day.sun.direction);

    lighting.reset();
    world.update(0).unwrap();
    const restored = lighting.snapshot();
    expect(restored.mode).toBe('Day');
    expectArrayClose(restored.sun.direction, GAME_DEFAULT_LIGHTING_TABLES.Day.sun.direction);
    expectArrayClose(restored.skylight.rotation, GAME_DEFAULT_LIGHTING_TABLES.Day.skylight.rotation);
    expectCameraClose(restored.camera, GAME_DEFAULT_LIGHTING_TABLES.Day.camera);
    expect(setLightingMode.mock.calls.map(([mode]) => mode)).toEqual(['Day', 'Night', 'Day']);
  });
});
