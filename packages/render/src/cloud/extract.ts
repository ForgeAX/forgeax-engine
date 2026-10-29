import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { Time } from '@forgeax/engine-ecs';
import { readRenderArrayView } from '@forgeax/engine-ecs/projection';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import { err, ok, type Result } from '@forgeax/engine-types';
import { CloudLayer, type CloudLayerData } from '../components/cloud-layer';
import { DirectionalLight } from '../components/directional-light';
import { type CloudLayerError, CloudLayerOwnerConflictError } from '../errors/cloud';
import { cloudLayerSourceKey, type ValidatedCloudLayer, validateCloudLayer } from './parameters';

export interface CloudLayerCandidate {
  readonly entityKey: EntityHandle;
  readonly data: CloudLayerData;
}

export interface ExtractedCloudLayer {
  readonly status: 'available';
  readonly entityKey: EntityHandle;
  readonly sourceKey: string;
  readonly params: ValidatedCloudLayer;
  readonly worldTimeSeconds: number;
  /** First World-owned sun selected by the same extraction boundary. */
  readonly sunDirection: readonly [number, number, number] | undefined;
  readonly sunRadiance: readonly [number, number, number] | undefined;
  readonly revision: number;
}

/** Select the one resource owner without creating a second World registry. */
export function selectCloudLayerFrame(
  candidates: readonly CloudLayerCandidate[],
  worldTimeSeconds = 0,
  sunDirection: readonly [number, number, number] | undefined = undefined,
  sunRadiance: readonly [number, number, number] | undefined = undefined,
): Result<ExtractedCloudLayer | undefined, CloudLayerError> {
  if (candidates.length === 0) return ok(undefined);
  if (candidates.length > 1) return err(new CloudLayerOwnerConflictError(candidates.length));
  const candidate = candidates[0];
  if (candidate === undefined) return ok(undefined);
  const validated = validateCloudLayer(candidate.data);
  if (!validated.ok) return validated;
  return ok(
    Object.freeze({
      status: 'available' as const,
      entityKey: candidate.entityKey,
      sourceKey: cloudLayerSourceKey(validated.value),
      params: validated.value,
      worldTimeSeconds: Number.isFinite(worldTimeSeconds) ? Math.max(0, worldTimeSeconds) : 0,
      sunDirection:
        sunDirection === undefined
          ? undefined
          : Object.freeze([...sunDirection] as [number, number, number]),
      sunRadiance:
        sunRadiance === undefined
          ? undefined
          : Object.freeze([...sunRadiance] as [number, number, number]),
      revision: 1,
    }),
  );
}

/** Read the World-owned component and Time resource at the extraction boundary. */
export function extractCloudLayer(
  world: World,
): Result<ExtractedCloudLayer | undefined, CloudLayerError> {
  let owner: EntityHandle | undefined;
  let ownerCount = 0;
  // Older worlds may be rendered without renderComponentsPlugin. The absence
  // of the optional cloud vocabulary is the empty state, not an extraction
  // failure; once the component is registered, query failures remain visible
  // through the surrounding World extraction boundary.
  try {
    const query = world.query({ read: [CloudLayer] });
    if (!query.ok) return ok(undefined);
    for (const row of query.value) {
      owner ??= row.entity;
      ownerCount++;
    }
  } catch {
    return ok(undefined);
  }
  if (owner === undefined) return ok(undefined);
  if (ownerCount > 1) return err(new CloudLayerOwnerConflictError(ownerCount));
  const read = world[worldRead];
  const wind = readRenderArrayView(world, owner, CloudLayer, 'wind') as Float32Array;
  const candidates: CloudLayerCandidate[] = [
    {
      entityKey: owner,
      data: {
        seed: read.getFieldValue(owner, CloudLayer, 'seed') as number,
        baseHeight: read.getFieldValue(owner, CloudLayer, 'baseHeight') as number,
        thickness: read.getFieldValue(owner, CloudLayer, 'thickness') as number,
        scale: read.getFieldValue(owner, CloudLayer, 'scale') as number,
        coverage: read.getFieldValue(owner, CloudLayer, 'coverage') as number,
        density: read.getFieldValue(owner, CloudLayer, 'density') as number,
        quality: read.getFieldValue(owner, CloudLayer, 'quality') as number,
        shadowRange: read.getFieldValue(owner, CloudLayer, 'shadowRange') as number,
        wind,
      },
    },
  ];
  let sunDirection: readonly [number, number, number] | undefined;
  let sunRadiance: readonly [number, number, number] | undefined;
  try {
    const query = world.query({ read: [DirectionalLight] });
    if (query.ok) {
      const read = world[worldRead];
      for (const span of query.value.spans().unwrap()) {
        if (span.length === 0) continue;
        const entity = span.entities[0] as EntityHandle;
        const strength = read.getFieldValue(entity, DirectionalLight, 'intensity') as number;
        const intensity = Number.isFinite(strength) ? Math.max(0, strength) : 0;
        // Stored direction points from light to surface; cloud integration follows the incoming sun.
        sunDirection = [
          -(read.getArrayElement(entity, DirectionalLight, 'direction', 0) as number),
          -(read.getArrayElement(entity, DirectionalLight, 'direction', 1) as number),
          -(read.getArrayElement(entity, DirectionalLight, 'direction', 2) as number),
        ];
        sunRadiance = [
          (read.getArrayElement(entity, DirectionalLight, 'color', 0) as number) * intensity,
          (read.getArrayElement(entity, DirectionalLight, 'color', 1) as number) * intensity,
          (read.getArrayElement(entity, DirectionalLight, 'color', 2) as number) * intensity,
        ];
        break;
      }
    }
  } catch {
    // Optional light vocabulary is absent in camera-only worlds.
  }
  return selectCloudLayerFrame(
    candidates,
    world.getResource(Time).elapsed,
    sunDirection,
    sunRadiance,
  );
}
