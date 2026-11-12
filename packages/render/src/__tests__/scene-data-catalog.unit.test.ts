import { describe, expect, it } from 'vitest';
import {
  createSceneDataCatalog,
  SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA,
  SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
  SCENE_DATA_TEMPORAL_V1_SCHEMA,
} from '../temporal/scene-data-catalog';
import { createStandardSceneSurfaceAdmission } from '../temporal/standard-scene-data-admission';

describe('SceneDataCatalog authorization', () => {
  it('issues a frozen sampled-read token for the active plan generation', () => {
    const catalog = createSceneDataCatalog({
      featureIdentity: 'taa',
      generation: 7,
      planIdentity: 'plan-7',
      rgba16floatRenderable: true,
    });
    const result = catalog.require(SCENE_DATA_TEMPORAL_V1_SCHEMA);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result).toMatchObject({
      kind: 'scene-data',
      schema: SCENE_DATA_TEMPORAL_V1_SCHEMA,
      access: 'sampled-read',
      format: 'rgba16float',
      sampleCount: 1,
      extent: 'render-resolution',
    });
    expect(catalog.validate(result).ok).toBe(true);
  });

  it('rejects forged, stale, foreign, and write-shaped tokens', () => {
    const catalog = createSceneDataCatalog({
      featureIdentity: 'taa',
      generation: 7,
      planIdentity: 'plan-7',
      rgba16floatRenderable: true,
    });
    const foreign = createSceneDataCatalog({
      featureIdentity: 'motion-blur',
      generation: 7,
      planIdentity: 'plan-7',
      rgba16floatRenderable: true,
    });
    const issued = catalog.require(SCENE_DATA_TEMPORAL_V1_SCHEMA);

    expect(foreign.validate(issued).ok).toBe(false);
    expect(catalog.validate({ ...issued }).ok).toBe(false);
    expect(catalog.validate({ ...issued, access: 'write' } as never).ok).toBe(false);
    expect(catalog.validate(issued, 8).ok).toBe(false);
  });

  it('reports capability absence without issuing a physical target', () => {
    const catalog = createSceneDataCatalog({
      featureIdentity: 'taa',
      generation: 7,
      planIdentity: 'plan-7',
      rgba16floatRenderable: false,
    });
    expect(() => catalog.require(SCENE_DATA_TEMPORAL_V1_SCHEMA)).toThrow();
    expect(catalog.inspect().status).toBe('unavailable');
  });

  it('admits current-view normal and depth only with a faithful producer and coverage', () => {
    const unavailable = createSceneDataCatalog({
      featureIdentity: 'ambient-occlusion',
      generation: 9,
      planIdentity: 'ao-plan-9',
      rgba16floatRenderable: false,
    });
    expect(unavailable.availabilityFor(SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA)).toEqual({
      status: 'unavailable',
      reason: 'producer-missing',
    });
    expect(unavailable.inspect(SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA)).toMatchObject({
      schema: SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA,
      status: 'unavailable',
      reason: 'producer-missing',
    });
    expect(() => unavailable.require(SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA)).toThrow();

    const admitted = createSceneDataCatalog({
      featureIdentity: 'ambient-occlusion',
      viewIdentity: 'view-ao',
      generation: 9,
      planIdentity: 'ao-plan-9',
      rgba16floatRenderable: false,
      surfaceAdmission: createStandardSceneSurfaceAdmission({
        viewIdentity: 'view-ao',
        generation: 9,
        deviceGeneration: 0,
        standardPipeline: true,
        cameraAvailable: true,
        lane: 'direct',
        renderPath: 'forward',
        contributors: [],
      }),
    });
    const normal = admitted.require(SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA);
    const depth = admitted.require(SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA);
    expect(normal).toMatchObject({
      schema: SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
      format: 'r32uint',
      space: 'world',
      encoding: 'octahedral-normal-x12-y12-roughness-u8',
      coverage: 'opaque-alpha-mask',
    });
    expect(depth).toMatchObject({
      schema: SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA,
      format: 'depth32float-stencil8',
      space: 'camera-device-depth',
      encoding: 'rhi-zero-to-one',
      reconstruction: 'current-camera-inverse-projection',
      coverage: 'opaque-alpha-mask',
    });
    expect(admitted.validate(normal).ok).toBe(true);
    expect(admitted.validate(depth).ok).toBe(true);
  });

  it('rejects the surface contract when complete material coverage is not proven', () => {
    const surfaceAdmission = createStandardSceneSurfaceAdmission({
      viewIdentity: 'view-ao',
      generation: 9,
      deviceGeneration: 0,
      standardPipeline: true,
      cameraAvailable: true,
      lane: 'direct',
      renderPath: 'forward',
      contributors: [
        {
          id: 'custom-material-without-ao-input',
          publication: 'fixture-custom-publication',
          materialShaderId: 'custom::surface',
          geometry: 'mesh',
          deformation: 'rigid',
          entryPoint: 'fs_custom',
          selectedProgram: 'fixture-custom-artifact',
        },
      ],
    });
    const catalog = createSceneDataCatalog({
      featureIdentity: 'ambient-occlusion',
      viewIdentity: 'view-ao',
      generation: 9,
      planIdentity: 'ao-plan-9',
      rgba16floatRenderable: true,
      surfaceAdmission,
    });
    expect(catalog.availabilityFor(SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA)).toEqual({
      status: 'unavailable',
      reason: 'coverage-incomplete',
    });
    expect(catalog.inspect(SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA)).toMatchObject({
      missingContributorIds: ['custom-material-without-ao-input'],
    });
  });
});
