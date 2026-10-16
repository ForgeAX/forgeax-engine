import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it, vi } from 'vitest';
import { AmbientOcclusion, Atmosphere, Camera, DirectionalLight } from '../components';
import { prepareExtractContext, selectCameraRoles } from '../render-system-extract';
import { extractFrame, extractFrames } from '../render-system-extract-tail';
import { setActiveCamera } from '../systems/active-camera';

function spawnCamera(world: World, fov: number): number {
  return world
    .spawn(
      {
        component: Transform,
        data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
      },
      {
        component: Camera,
        data: {
          fov,
          aspect: 1,
          near: 0.1,
          far: 100,
          projection: 0,
          left: -1,
          right: 1,
          bottom: -1,
          top: 1,
        },
      },
    )
    .unwrap() as unknown as number;
}

describe('FrameCamera entity selection', () => {
  it('selects the explicit display camera through extraction', () => {
    const world = new World();
    const first = spawnCamera(world, 1);
    const second = spawnCamera(world, 2);
    setActiveCamera(world, first);

    const roles = selectCameraRoles(world, second);
    expect(roles.display).toHaveLength(1);
    expect(roles.display[0]?.entityKey).toBe(second);

    const frame = extractFrame(
      world,
      prepareExtractContext(world, { cameraEntityKey: second, renderables: 'none' }),
    );
    expect(frame.cameras[0]?.entityKey).toBe(second);
    expect(frame.cameras[0]?.fov).toBeCloseTo(2);

    const merged = extractFrames([world], {
      cameraOwner: 0,
      resourceOwner: 0,
      cameraEntityKey: second,
    });
    expect(merged.cameras[0]?.entityKey).toBe(second);
  });

  it('keeps ActiveCamera selection when FrameCamera has no entity key', () => {
    const world = new World();
    spawnCamera(world, 1);
    const second = spawnCamera(world, 2);
    setActiveCamera(world, second);

    const roles = selectCameraRoles(world);
    expect(roles.display[0]?.entityKey).toBe(second);
    const frame = extractFrame(world, prepareExtractContext(world, { renderables: 'none' }));
    expect(frame.cameras[0]?.entityKey).toBe(second);
  });

  it('does not fall back to the first camera for an invalid explicit key', () => {
    const world = new World();
    spawnCamera(world, 1);
    spawnCamera(world, 2);

    expect(selectCameraRoles(world, 999999).display).toHaveLength(0);
    expect(
      extractFrame(
        world,
        prepareExtractContext(world, { cameraEntityKey: 999999, renderables: 'none' }),
      ).cameras,
    ).toHaveLength(0);
  });
});

describe('Atmosphere sun extraction', () => {
  it('routes a missing sun through World, then retries after ownership is fixed', () => {
    const world = new World();
    world.spawn({ component: Atmosphere, data: {} }).unwrap();
    spawnCamera(world, 1);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() =>
        extractFrame(world, prepareExtractContext(world, { renderables: 'none' })),
      ).toThrow(
        expect.objectContaining({ code: 'sun-cardinality', detail: { field: 'sun', value: 0 } }),
      );
      const firstRouted = consoleError.mock.calls[0]?.[1] as
        | { code?: string; detail?: { value?: number } }
        | undefined;
      expect(consoleError.mock.calls[0]?.[0]).toBe(
        '[RenderSystem.extract (environment-selection)]',
      );
      expect(firstRouted?.code).toBe('sun-cardinality');
      expect(firstRouted?.detail?.value).toBe(0);

      // This is the direct extraction boundary. App.onError owns frame-loop
      // Result failures and renderer events; World routes this internal
      // producer error to its documented console boundary.

      const firstSun = world
        .spawn({
          component: DirectionalLight,
          data: { direction: [0, -0.25, 1], color: [1, 1, 1], intensity: 1 },
        })
        .unwrap();
      const recovered = extractFrame(world, prepareExtractContext(world, { renderables: 'none' }));
      expect(recovered.lights.directional?.entity).toBe(firstSun);
      expect(consoleError).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('keeps DirectionalLight intensity out of SunCandidate color', () => {
    const world = new World();
    world.spawn({ component: Atmosphere, data: {} }).unwrap();
    const sunEntity = world
      .spawn({
        component: DirectionalLight,
        data: { direction: [0, -0.25, 1], color: [0.2, 0.4, 0.6], intensity: 4 },
      })
      .unwrap() as unknown as number;
    spawnCamera(world, 1);

    const frame = extractFrame(world, prepareExtractContext(world, { renderables: 'none' }));
    expect(frame.environment).toMatchObject({
      source: { kind: 'atmosphere' },
      sun: {
        entityKey: sunEntity,
        color: [expect.closeTo(0.2, 5), expect.closeTo(0.4, 5), expect.closeTo(0.6, 5)],
        intensity: expect.closeTo(4, 5),
      },
    });
    expect(frame.lights.directional?.color[0]).toBeCloseTo(0.8, 5);
  });

  it('projects a zero-intensity sun with zero color', () => {
    const world = new World();
    world.spawn({ component: Atmosphere, data: {} }).unwrap();
    world
      .spawn({
        component: DirectionalLight,
        data: { direction: [0, -0.25, 1], color: [0.2, 0.4, 0.6], intensity: 0 },
      })
      .unwrap();
    spawnCamera(world, 1);

    const frame = extractFrame(world, prepareExtractContext(world, { renderables: 'none' }));
    expect(frame.environment).toMatchObject({
      sun: { color: [0, 0, 0], intensity: 0 },
    });
  });
});

it('extracts AO only from the explicitly selected camera, retaining direct-light strength', () => {
  const world = new World();
  const plain = spawnCamera(world, 1);
  const ao = world
    .spawn(
      { component: Transform, data: {} },
      { component: Camera, data: {} },
      { component: AmbientOcclusion, data: { directLightingStrength: 0.6, radius: 0.8 } },
    )
    .unwrap() as unknown as number;
  const selected = (cameraEntityKey: number) =>
    extractFrame(world, prepareExtractContext(world, { cameraEntityKey, renderables: 'none' }))
      .cameras[0];
  expect(selected(ao)?.ambientOcclusion).toMatchObject({
    directLightingStrength: expect.closeTo(0.6, 5),
    radius: expect.closeTo(0.8, 5),
  });
  expect(selected(plain)?.ambientOcclusion).toBeUndefined();
});
