import { err, ok, type Result } from '@forgeax/engine-types';
import type { WaterBodySnapshot, WaterError } from './contracts.js';
import { prepareWaterBodyWaves, waterBodyOwnerKey } from './waves.js';

/** A logical read request, not another wave snapshot or a render/device handle. */
export interface WaterGerstnerSurfaceSource {
  readonly model: 'gerstner-fixed/1';
  readonly bodyKey: string;
  readonly bodyGeneration: number;
  readonly zoneGeneration: number;
  readonly waveSetDigest: string;
}

/** Render must additionally qualify its actual branch, frame and device inputs. */
export function waterGerstnerSurfaceSource(
  worldIdentity: string,
  body: WaterBodySnapshot,
): Result<WaterGerstnerSurfaceSource, WaterError> {
  if (
    !worldIdentity ||
    (body.asset.type !== 'lake' && body.asset.type !== 'ocean') ||
    !body.asset.waveSetGuid
  )
    return err({
      code: 'query-data-unavailable',
      expected: 'a World-owned flat Body with an accepted Gerstner WaveSet',
      hint: 'select a fixed-plane Lake or Ocean; river and custom geometry require their own model',
      detail: { bodyGuid: body.guid, model: 'gerstner-fixed/1' },
    });
  const prepared = prepareWaterBodyWaves(body);
  if (prepared.cooked === undefined)
    return err({
      code: 'query-data-unavailable',
      expected: 'the accepted Body WaveSet dependency',
      hint: 'wait for source admission before requesting a surface read',
      detail: { bodyGuid: body.guid },
    });
  if (!prepared.cooked.ok) return prepared.cooked;
  const zoneGeneration = body.binding.kind === 'bound' ? body.binding.zoneGeneration : 0;
  return ok(
    Object.freeze({
      model: 'gerstner-fixed/1',
      bodyKey: waterBodyOwnerKey(worldIdentity, body.guid, body.sceneGeneration, zoneGeneration),
      bodyGeneration: body.sceneGeneration,
      zoneGeneration,
      waveSetDigest: prepared.cooked.value.inputDigest,
    }),
  );
}
