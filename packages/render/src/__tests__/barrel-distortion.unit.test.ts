import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { BarrelDistortion, Camera } from '../components';
import {
  BARREL_DISTORTION_POST_PROCESS_ID,
  BARREL_DISTORTION_WGSL,
  createBarrelDistortionRenderFeature,
} from '../features/barrel-distortion';
import { createRenderFeatureHost, runRenderFeatureFrame } from '../features/host';
import { resolveStandardRenderFeatureTargets } from '../features/targets';
import {
  attachBarrelDistortionCameraFrame,
  createBarrelDistortionMapping,
  mapDisplayToScene,
  mapDisplayUvToSceneUv,
  mapSceneToDisplay,
  mapSceneUvToDisplayUv,
  validateBarrelDistortionParameters,
} from '../index';
import { projectBarrelDistortionInspection } from '../inspection-types';
import { inspectBarrelDistortionState } from '../record/barrel-distortion-frame';
import type { RenderFrameState } from '../record/frame-snapshot';
import { extractCameraSnapshots } from '../render-system-extract';
import { setActiveCamera } from '../systems/active-camera';

function spawnBarrelTestCamera(world: World, strength?: number): number {
  const transform = {
    component: Transform,
    data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
  } as const;
  const camera = {
    component: Camera,
    data: {
      fov: Math.PI / 3,
      aspect: 16 / 9,
      near: 0.1,
      far: 100,
      projection: 0,
      left: -1,
      right: 1,
      bottom: -1,
      top: 1,
    },
  } as const;
  if (strength === undefined) {
    return world.spawn(transform, camera).unwrap() as unknown as number;
  }
  return world
    .spawn(transform, camera, {
      component: BarrelDistortion,
      data: { strength },
    })
    .unwrap() as unknown as number;
}

describe('bounded barrel distortion mapping', () => {
  it('extracts work from the selected camera only', () => {
    const world = new World();
    const disabled = spawnBarrelTestCamera(world);
    const enabled = spawnBarrelTestCamera(world, 0.2);
    const zero = spawnBarrelTestCamera(world, 0);
    const host = createRenderFeatureHost([createBarrelDistortionRenderFeature()]).unwrap();
    const targets = resolveStandardRenderFeatureTargets({
      tonemap: 'none',
      antialias: 'none',
      storageBuffer: false,
      multisample: false,
      colorAttachmentFormat: 'rgba8unorm',
    });

    const run = (frameNumber: number, entity: number) => {
      setActiveCamera(world, entity);
      const selected = extractCameraSnapshots(world)[0];
      expect(selected?.entityKey).toBe(entity);
      const result = runRenderFeatureFrame(host, [
        {
          identity: 'main',
          render: true,
          worlds: [world],
          owner: 0,
          frameNumber,
          generation: frameNumber,
          ...(selected === undefined ? {} : { selectedCamera: selected }),
          targets,
          caps: { rgba16floatRenderable: true } as never,
        },
      ]).views.get('main');
      if (result === undefined) throw new Error('main view missing');
      return result;
    };

    try {
      // A non-active enabled camera must not activate the display feature.
      expect(run(1, disabled).plans).toEqual([]);
      // An explicitly selected zero-strength companion is also zero work.
      expect(run(2, zero).plans).toEqual([]);

      const active = run(3, enabled);
      expect(active.errors).toEqual([]);
      expect(active.plans[0]?.plan.resources).toHaveLength(3);
      expect(active.plans[0]?.plan.passes).toHaveLength(1);
      expect(active.fullscreenEffects.has(BARREL_DISTORTION_POST_PROCESS_ID)).toBe(true);

      const backToDisabled = run(4, disabled);
      expect(backToDisabled.plans).toEqual([]);
      expect(backToDisabled.fullscreenEffects.size).toBe(0);
    } finally {
      host.dispose();
    }
  });

  it('keeps an unconfigured camera at feature zero work', () => {
    const host = createRenderFeatureHost([createBarrelDistortionRenderFeature()]).unwrap();
    const frame = runRenderFeatureFrame(host, [
      {
        identity: 'main',
        render: true,
        worlds: [new World()],
        owner: 0,
        frameNumber: 1,
        caps: { rgba16floatRenderable: true } as never,
      },
    ]).views.get('main');
    if (frame === undefined) throw new Error('main view missing');

    expect(frame.errors).toEqual([]);
    expect(frame.fullscreenEffects.size).toBe(0);
    expect(frame.preparedResourceBatches).toHaveLength(0);
    expect(frame.requiresPreparedResourceKey).toBe(false);
    expect(frame.plans).toEqual([]);
    host.dispose();
  });

  it('validates the production fullscreen entry point and keeps disabled plans exact-zero', () => {
    expect(BARREL_DISTORTION_WGSL).toContain('@builtin(vertex_index) vertex_index : u32');
    const feature = createBarrelDistortionRenderFeature();
    expect(feature.identity).toBe(BARREL_DISTORTION_POST_PROCESS_ID);
    expect(feature.requiredFullscreenPostProcesses).toEqual([
      { identity: BARREL_DISTORTION_POST_PROCESS_ID, source: BARREL_DISTORTION_WGSL },
    ]);
    const disabled = feature.plan({ views: [] }, {} as never);
    expect(disabled.ok).toBe(true);
    if (!disabled.ok) return;
    expect(disabled.value.work).toEqual([]);

    const enabled = feature.plan({ views: ['main'] }, {} as never);
    expect(enabled.ok).toBe(true);
    if (!enabled.ok) return;
    expect(enabled.value.work[0]?.resources).toHaveLength(3);
    expect(enabled.value.work[0]?.resources[0]).toMatchObject({
      kind: 'fullscreen-program',
      name: BARREL_DISTORTION_POST_PROCESS_ID,
      params: { byteSize: 16 },
    });
    expect(enabled.value.work[0]?.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'graphics-program',
          name: 'barrel-distortion-pipeline',
        }),
        expect.objectContaining({
          kind: 'graphics-bindings',
          name: 'barrel-distortion-bindings',
          logicalTargets: { input: 'barrel-input' },
        }),
      ]),
    );
    expect(enabled.value.work[0]?.passes).toMatchObject([
      {
        kind: 'raster',
        name: 'barrel-distortion',
        colorAttachments: [{ target: 'barrel-output' }],
        sampledTargets: ['barrel-input'],
      },
    ]);
  });

  it('keeps the disabled path exact and validates the authoring domain', () => {
    const identity = createBarrelDistortionMapping(1920, 1080, undefined);
    expect(identity.ok).toBe(true);
    if (!identity.ok) return;
    const mapped = { x: 0, y: 0 };
    expect(mapDisplayToScene(mapped, identity.value, 321.5, 777.25)).toBe(true);
    expect(mapped).toEqual({ x: 321.5, y: 777.25 });

    expect(validateBarrelDistortionParameters({ strength: 0.351 }).ok).toBe(false);
    expect(validateBarrelDistortionParameters({ centerX: Number.NaN }).ok).toBe(false);
    expect(validateBarrelDistortionParameters({ centerY: 1.1 }).ok).toBe(false);
    expect(createBarrelDistortionMapping(0, 1080, { strength: 0.2 }).ok).toBe(false);
  });

  it.each([
    [1920, 1080, 0.5, 0.5, 0.2],
    [1080, 1920, 0.2, 0.75, 0.35],
    [2560, 1080, 0.8, 0.3, 0.1],
  ])('round trips UVs for %s x %s with center %s,%s', (width, height, centerX, centerY, strength) => {
    const mapping = createBarrelDistortionMapping(width, height, {
      centerX,
      centerY,
      strength,
    });
    expect(mapping.ok).toBe(true);
    if (!mapping.ok) return;
    for (const uv of [
      [0.01, 0.01],
      [0.2, 0.7],
      [0.5, 0.5],
      [0.93, 0.12],
      [0.99, 0.99],
    ] as const) {
      const display = { x: 0, y: 0 };
      const scene = { x: 0, y: 0 };
      expect(mapDisplayUvToSceneUv(scene, mapping.value, uv[0], uv[1])).toBe(true);
      expect(mapSceneUvToDisplayUv(display, mapping.value, scene.x, scene.y)).toBe(true);
      expect(display.x).toBeCloseTo(uv[0], 6);
      expect(display.y).toBeCloseTo(uv[1], 6);
      expect(scene.x).toBeGreaterThanOrEqual(0);
      expect(scene.x).toBeLessThanOrEqual(1);
      expect(scene.y).toBeGreaterThanOrEqual(0);
      expect(scene.y).toBeLessThanOrEqual(1);
    }
  });

  it('normalizes machine-precision boundaries without accepting real crop misses', () => {
    const boundary = createBarrelDistortionMapping(1920, 1080, {
      strength: 0.35,
      centerX: 0,
      centerY: 1,
    }).unwrap();
    const scene = { x: 0, y: 0 };
    const display = { x: 0, y: 0 };
    expect(mapDisplayUvToSceneUv(scene, boundary, 0, 1)).toBe(true);
    expect(mapSceneUvToDisplayUv(display, boundary, scene.x, scene.y)).toBe(true);
    expect(display).toEqual({ x: 0, y: 1 });

    const centered = createBarrelDistortionMapping(1920, 1080, { strength: 0.35 }).unwrap();
    // This source corner is genuinely outside the auto-cropped display; it
    // must remain a miss instead of being clamped by the numerical repair.
    expect(mapSceneUvToDisplayUv(display, centered, 0, 0.01)).toBe(false);
  });

  it('keeps the 1920x1080 offset-corner counterexample inside the inverse domain', () => {
    const mapping = createBarrelDistortionMapping(1920, 1080, {
      strength: 0.35,
      centerX: 0,
      centerY: 0,
    }).unwrap();
    const scene = { x: 0, y: 0 };
    const display = { x: 0, y: 0 };
    // The forward equation produces exactly 1.0000000000000002 for the
    // inverse y at this valid displayed corner in binary64. It is a numerical
    // boundary roundoff, not a crop miss, and must normalize to the edge.
    expect(mapDisplayUvToSceneUv(scene, mapping, 0, 1)).toBe(true);
    expect(mapSceneUvToDisplayUv(display, mapping, scene.x, scene.y)).toBe(true);
    expect(display).toEqual({ x: 0, y: 1 });
  });

  it('keeps a seeded boundary sweep below the pixel error budget', () => {
    const extents = [
      [640, 360],
      [1280, 720],
      [1920, 1080],
    ] as const;
    const centers = Array.from({ length: 25 }, (_, index) => index / 24);
    const strengths = [0.05, 0.2, 0.35];
    let seed = 0x9e3779b9;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const positions: [number, number][] = [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
      ...Array.from({ length: 21 }, () => [next(), next()] as [number, number]),
    ];
    let rejected = 0;
    let maxPixelError = 0;
    for (const [width, height] of extents) {
      for (const centerX of centers) {
        for (const centerY of centers) {
          for (const strength of strengths) {
            const mapping = createBarrelDistortionMapping(width, height, {
              strength,
              centerX,
              centerY,
            }).unwrap();
            for (const [ux, uy] of positions) {
              const scene = { x: 0, y: 0 };
              const display = { x: 0, y: 0 };
              if (!mapDisplayUvToSceneUv(scene, mapping, ux, uy)) {
                rejected += 1;
                continue;
              }
              if (!mapSceneUvToDisplayUv(display, mapping, scene.x, scene.y)) {
                rejected += 1;
                continue;
              }
              maxPixelError = Math.max(
                maxPixelError,
                Math.abs(display.x - ux) * width,
                Math.abs(display.y - uy) * height,
              );
            }
          }
        }
      }
    }
    expect(rejected).toBe(0);
    expect(maxPixelError).toBeLessThanOrEqual(0.00001);
  });

  it('samples inward from the displayed edge under the documented direction', () => {
    const mapping = createBarrelDistortionMapping(1920, 1080, { strength: 0.2 }).unwrap();
    const scene = { x: 0, y: 0 };
    expect(mapDisplayUvToSceneUv(scene, mapping, 0.75, 0.5)).toBe(true);
    expect(scene.x).toBeCloseTo(0.707896, 5);
    expect(scene.y).toBeCloseTo(0.5, 8);
  });

  it('rejects display and inverse points outside the physical output viewport', () => {
    const mapping = createBarrelDistortionMapping(800, 600, { strength: 0.2 }).unwrap();
    const out = { x: 0, y: 0 };
    expect(mapDisplayToScene(out, mapping, -0.01, 10)).toBe(false);
    expect(mapDisplayToScene(out, mapping, 801, 10)).toBe(false);
    expect(mapSceneToDisplay(out, mapping, 10, 601)).toBe(false);
  });

  it('pairs the submitted mapping with immutable unjittered camera facts', () => {
    const mapping = createBarrelDistortionMapping(640, 360, { strength: 0.2 }).unwrap();
    const frame = attachBarrelDistortionCameraFrame(mapping, {
      projection: 'perspective',
      far: 100,
      viewMatrix: new Float32Array(16).fill(1),
      projectionMatrix: new Float32Array(16).fill(2),
    });
    expect(frame.camera).toMatchObject({ projection: 'perspective' });
    expect(frame.camera?.viewMatrix).toEqual(Array(16).fill(1));
    expect(frame.camera?.projectionMatrix).toEqual(Array(16).fill(2));
    expect(Object.isFrozen(frame)).toBe(true);
    expect(Object.isFrozen(frame.camera)).toBe(true);
  });

  it('keeps the submitted renderer graph identity after detached recovery compilation', () => {
    const mapping = createBarrelDistortionMapping(640, 360, { strength: 0.2 }).unwrap();
    const state = {
      lastSuccessfulBarrelDistortion: mapping,
      frameNumber: 12,
      graphGeneration: 4,
      compiledFrameGraph: { graph: { inspect: () => ({ generation: 5 }) } },
      barrelDistortionGraphResolution: 'retained',
    } as unknown as RenderFrameState;
    expect(inspectBarrelDistortionState(state, 1)).toMatchObject({
      effectiveMapping: mapping,
      frameId: 12,
      deviceGeneration: 1,
      graphGeneration: 4,
      lastKnownGood: true,
    });
  });

  it('projects the accepted mapping and LKG identity as one detached inspection', () => {
    const mapping = attachBarrelDistortionCameraFrame(
      createBarrelDistortionMapping(640, 360, { strength: 0.2 }).unwrap(),
      {
        projection: 'perspective',
        far: 100,
        viewMatrix: new Float32Array(16),
        projectionMatrix: new Float32Array(16),
      },
    );
    const inspection = projectBarrelDistortionInspection({
      effectiveMapping: mapping,
      frameId: 12,
      deviceGeneration: 3,
      graphGeneration: 7,
      lastKnownGood: true,
    });
    expect(inspection).toMatchObject({
      frameId: 12,
      deviceGeneration: 3,
      graphGeneration: 7,
      lastKnownGood: true,
      extent: { width: 640, height: 360 },
    });
    expect(inspection.effectiveMapping?.strength).toBe(0.2);
    expect(Object.isFrozen(inspection)).toBe(true);
    expect(Object.isFrozen(inspection.extent)).toBe(true);
    expect(Object.isFrozen(inspection.effectiveMapping)).toBe(true);
    expect(Object.isFrozen(inspection.effectiveMapping?.camera)).toBe(true);
  });
});
