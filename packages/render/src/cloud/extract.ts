import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { Time } from '@forgeax/engine-ecs';
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
  const candidates: CloudLayerCandidate[] = [];
  // Older worlds may be rendered without renderComponentsPlugin. The absence
  // of the optional cloud vocabulary is the empty state, not an extraction
  // failure; once the component is registered, query failures remain visible
  // through the surrounding World extraction boundary.
  try {
    const query = world.query({ read: [CloudLayer] });
    if (!query.ok) return ok(undefined);
    for (const row of query.value)
      candidates.push({ entityKey: row.entity, data: row.get(CloudLayer) });
  } catch {
    return ok(undefined);
  }
  let sunDirection: readonly [number, number, number] | undefined;
  let sunRadiance: readonly [number, number, number] | undefined;
  try {
    const query = world.query({ read: [DirectionalLight] });
    if (query.ok) {
      for (const row of query.value) {
        const light = row.get(DirectionalLight);
        const intensity = Number.isFinite(light.intensity) ? Math.max(0, light.intensity) : 0;
        // DirectionalLight stores the outgoing vector (light -> surface),
        // while cloud optical paths integrate from the receiver toward the
        // sun. Keep the extracted cloud direction in that incoming convention
        // so low-sun gating and the GPU `-view.lightDir` path agree.
        sunDirection = [
          -(light.direction[0] ?? 0),
          -(light.direction[1] ?? -1),
          -(light.direction[2] ?? 0),
        ];
        sunRadiance = [
          (light.color[0] ?? 1) * intensity,
          (light.color[1] ?? 1) * intensity,
          (light.color[2] ?? 1) * intensity,
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
