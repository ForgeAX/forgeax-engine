import { AssetGuid } from '@forgeax/engine/pack/source';
import { err, type WaterBodyAsset } from '@forgeax/engine/types';
import {
  buildWaterWaveUploadBody,
  validateWaterRuntimeAsset,
  WaterQueryFlags,
  WaterSystem,
} from '@forgeax/engine/water';
import { beforeAll, describe, expect, it } from 'vitest';
import { LAKE_CENTER, RIVER_PATH } from '../../src/watershed';
import pack from '../water-mesh.pack';

const guid = (key: string) => AssetGuid.format(AssetGuid.derive(pack.packageId, key));
let system: WaterSystem;
const bodies = new Map<string, WaterBodyAsset>();

beforeAll(async () => {
  const outputs = (
    await pack.build({
      packageId: pack.packageId,
      readByGuid: async () => err(new Error('All Water dependencies belong to this Pack')),
    })
  ).unwrap();
  const zone = validateWaterRuntimeAsset(outputs['zone/main']).unwrap();
  if (zone.kind !== 'water-zone') throw new Error('Missing cooked Zone');
  const assets = new Map(Object.entries(outputs).map(([key, asset]) => [guid(key), asset]));
  system = new WaterSystem(
    (requested) => (requested === guid('zone/main') ? { generation: 1, asset: zone } : undefined),
    (body) => {
      if (!body.waveSetGuid) return [];
      const waveSet = validateWaterRuntimeAsset(assets.get(body.waveSetGuid)).unwrap();
      if (waveSet.kind !== 'water-wave-set') throw new Error('Missing cooked WaveSet');
      return [
        {
          guid: body.waveSetGuid,
          kind: waveSet.kind,
          field: 'waveSetGuid',
          status: 'valid',
          payload: waveSet,
        },
      ];
    },
  );
  for (const type of ['ocean', 'lake', 'river']) {
    const body = validateWaterRuntimeAsset(outputs[`body/${type}`]).unwrap();
    if (body.kind !== 'water-body') throw new Error(`Missing cooked ${type}`);
    bodies.set(type, body);
    system.mountBody(guid(`body/${type}`), 'flow-regression', body).unwrap();
  }
});

describe('cooked watershed source flow', () => {
  it.each([
    {
      type: 'ocean',
      positions: [
        [500, 0, 500],
        [-600, 0, 150],
        [800, 0, -300],
      ] as const,
    },
    { type: 'lake', positions: [LAKE_CENTER, [-210, 30, -80], [-175, 30, -65]] as const },
  ])('keeps $type still without disabling its authored waves', ({ type, positions }) => {
    for (const positionM of positions) {
      for (const timeSeconds of [0, 1.75]) {
        const result = system.queryBody(guid(`body/${type}`), {
          positionM,
          flags:
            WaterQueryFlags.ComputeLocation |
            WaterQueryFlags.ComputeDepth |
            WaterQueryFlags.ComputeVelocity |
            WaterQueryFlags.IncludeWaves,
          timeSeconds,
        });
        if (!result.ok) throw new Error(JSON.stringify(result.error));
        const query = result.value;
        expect(query.valid.has('velocity')).toBe(true);
        expect(query.excluded).toBe(false);
        if (!query.velocityMPerSec) throw new Error('Missing queried flow');
        expect(Math.hypot(...query.velocityMPerSec)).toBe(0);
        expect(query.waveInfo?.maxHeightM).toBeGreaterThan(0);
      }
    }
  });

  it('retains the descending River flow through real spline queries', () => {
    for (const [index, point] of RIVER_PATH.entries()) {
      const result = system.queryBody(guid('body/river'), {
        positionM: [point[0], point[1], point[2]],
        splineKey: index,
        flags: WaterQueryFlags.ComputeLocation | WaterQueryFlags.ComputeVelocity,
        timeSeconds: 0,
      });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      const query = result.value;
      expect(query.valid.has('velocity')).toBe(true);
      expect(query.source).toBe('spline');
      expect(query.excluded).toBe(false);
      if (!query.velocityMPerSec) throw new Error('Missing queried River flow');
      expect(Math.hypot(...query.velocityMPerSec)).toBeCloseTo(2.8);
      expect(query.velocityMPerSec[0]).toBeGreaterThan(0);
      expect(query.velocityMPerSec[1]).toBeLessThan(0);
    }
  });

  it('derives each material wave-mask flow input from its own cooked Body', () => {
    for (const [type, body] of bodies) {
      const snapshot = system.snapshot(guid(`body/${type}`));
      if (!snapshot) throw new Error(`Missing admitted ${type}`);
      for (const heightSource of [
        { kind: 'fixed' as const },
        { kind: 'water-info' as const, zoneIndex: 0, slice: 0 },
      ]) {
        const upload = buildWaterWaveUploadBody(snapshot, {
          worldId: 0,
          worldIdentity: 'watershed-flow-regression',
          timeSeconds: 1.75,
          previousTimeSeconds: 1.5,
          heightSource,
        }).unwrap();
        const speed = Math.hypot(...upload.heightSource.fixedVelocityXZ);
        if (type === 'river') {
          expect(speed).toBeGreaterThan(2.7);
          expect(upload.supportsWaves).toBe(false);
        } else {
          expect(speed).toBe(0);
          expect(upload.supportsWaves).toBe(true);
          expect(upload.waveSetGuid).toBe(body.waveSetGuid);
          expect(upload.waveSet.waves.length).toBeGreaterThan(0);
        }
      }
    }
  });
});
