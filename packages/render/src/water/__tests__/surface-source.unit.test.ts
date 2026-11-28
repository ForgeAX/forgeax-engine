import {
  buildWaterWaveUploadPlan,
  type WaterWaveUploadBody,
  waterBodyOwnerKey,
} from '@forgeax/engine-water';
import { describe, expect, it } from 'vitest';
import type { RenderFeatureWaterMaterialInput } from '../../features/prepared-graphics';
import type { RenderableSnapshot } from '../../render-system-extract';
import {
  fixedGerstnerSurfaceBodyKeys,
  waterGerstnerSurfaceBindings,
  waterGerstnerSurfacePublicationMatches,
} from '../surface-source';
import {
  type WaterInfoFramePublication,
  waterInfoMaterialBindingSnapshots,
} from '../water-info-publication-work';

const key = waterBodyOwnerKey('world', 'body', 4, 3);
const input: RenderFeatureWaterMaterialInput = {
  bodyKey: key,
  bodyGeneration: 4,
  zoneGeneration: 3,
  viewIdentity: 'view',
  surfaceSource: { model: 'gerstner-fixed/1', waveSetDigest: 'a'.repeat(64) },
  programInputs: { entryPoints: [], systemInputs: { water: 'water-frame/3' } },
};
function publication(): WaterInfoFramePublication {
  const body: WaterWaveUploadBody = {
    worldId: 0,
    worldIdentity: 'world',
    bodyGuid: 'body',
    bodyGeneration: 4,
    zoneGeneration: 3,
    waveSet: {
      inputDigest: 'a'.repeat(64),
      waves: [],
      depthMaskM: 0,
      maxWaveHeightM: 0,
      timeSource: 'scene-clock',
    },
    timeSeconds: 2,
    previousTimeSeconds: 1,
    baseHeightM: 0,
    tileOriginWorldXZ: [0, 0],
    tileLengthM: 20971.52,
    heightSource: { kind: 'fixed', fixedHeightM: 0, fixedDepthM: 5, fixedVelocityXZ: [0, 0] },
    supportsWaves: false,
    usesFlatSurfaceHeight: true,
    meshEdgeOverlayEnabled: false,
  };
  return {
    waveBodies: [body],
    waveUploadPlan: buildWaterWaveUploadPlan([body]).unwrap(),
  } as unknown as WaterInfoFramePublication;
}

describe('Gerstner receiving frame qualification', () => {
  it('keeps fixed geometry inputs bindable without a WaterInfo texture even when the Body has a target row', () => {
    const frame = publication();
    const published = {
      ...frame,
      targets: [{ targetName: 'info', targetFormat: 'rgba16float' }],
      rows: new Map([[key, { targetName: 'info' }]]),
    } as WaterInfoFramePublication;
    const cohorts = waterInfoMaterialBindingSnapshots(published).unwrap();
    const independent = cohorts.find((cohort) => cohort.targets.length === 0);
    expect(
      independent,
      'geometry-only reads must not depend on unrelated target availability',
    ).toBeDefined();
    expect(independent?.waveBodies).toEqual(frame.waveBodies);
    expect(independent?.waveUploadPlan.bodyIndices.has(key)).toBe(true);
    expect(independent?.rows.size).toBe(0);
  });
  it('qualifies exact owner, revision, model and shared time and rejects stale/mapped sources', () => {
    const frame = publication();
    expect(waterGerstnerSurfacePublicationMatches(frame, input)).toBe(true);
    expect(
      waterGerstnerSurfacePublicationMatches(frame, {
        ...input,
        surfaceSource: { model: 'gerstner-fixed/1', waveSetDigest: 'b'.repeat(64) },
      }),
    ).toBe(false);
    expect(waterGerstnerSurfacePublicationMatches(frame, { ...input, bodyGeneration: 5 })).toBe(
      false,
    );
    const source = frame.waveBodies[0];
    if (source === undefined) throw new Error('Missing fixture source');
    expect(
      waterGerstnerSurfacePublicationMatches(
        { ...frame, waveBodies: [{ ...source, timeSeconds: 3 }] },
        input,
      ),
    ).toBe(false);
    const row = frame.waveUploadPlan.bodyData[0];
    if (row === undefined) throw new Error('Missing fixture row');
    expect(
      waterGerstnerSurfacePublicationMatches(
        {
          ...frame,
          waveUploadPlan: {
            ...frame.waveUploadPlan,
            bodyData: [
              {
                ...row,
                heightSource: { ...row.heightSource, kind: 'water-info', zoneIndex: 0, slice: 0 },
              },
            ],
          },
        },
        input,
      ),
    ).toBe(false);
  });

  it('only admits the actual fixed native deformation branch', () => {
    const row = {
      waterOwner: { guid: 'body', generation: 4, worldIdentity: 'world', zoneGeneration: 3 },
      materials: [
        {
          snapshot: {
            waterDeformation: { module: 'forgeax_material::water_deformation_default' },
            staticSwitches: {
              waterWaves: true,
              waterInfo: false,
              waterFixedHeight: true,
              waterFixedDepth: true,
            },
          },
        },
      ],
    } as unknown as RenderableSnapshot;
    expect(fixedGerstnerSurfaceBodyKeys([row], 'view').has(key)).toBe(true);
    const material = row.materials[0];
    if (material?.snapshot === undefined) throw new Error('Missing fixture material');
    const native = {
      ...row,
      materials: [
        {
          ...material,
          snapshot: {
            ...material.snapshot,
            staticSwitches: {
              ...material.snapshot.staticSwitches,
              waterInfo: true,
              waterVertexMapping: false,
              waterFixedHeight: false,
              waterFixedDepth: false,
            },
          },
        },
      ],
    };
    expect(fixedGerstnerSurfaceBodyKeys([native], 'view').has(key)).toBe(true);
    const changed = {
      ...row,
      materials: [
        {
          ...material,
          snapshot: {
            ...material.snapshot,
            staticSwitches: { ...material.snapshot.staticSwitches, waterShallowSimulation: true },
          },
        },
      ],
    };
    expect(fixedGerstnerSurfaceBodyKeys([changed], 'view').has(key)).toBe(false);
  });

  it('creates a reflected declarative group without private slots or wave copies', () => {
    const result = waterGerstnerSurfaceBindings({
      name: 'source',
      program: 'field',
      viewIdentity: 'view',
      source: {
        model: 'gerstner-fixed/1',
        bodyKey: key,
        bodyGeneration: 4,
        zoneGeneration: 3,
        waveSetDigest: 'a'.repeat(64),
      },
      contract: {
        bindings: 'render-material',
        systemInputs: { water: 'water-frame/3' },
        entryPoints: [],
      },
    }).unwrap();
    expect(result.values).toMatchObject({ group: 2, waterMaterial: input });
  });
});
