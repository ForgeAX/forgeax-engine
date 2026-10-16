import { RhiError } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { worldEntityKey } from '../record/frame-snapshot';
import type { RenderPipelineTopology } from '../render-pipeline';
import type { RenderableSnapshot } from '../render-system-extract';

export interface TerrainShadowReceiver {
  readonly worldId: number;
  readonly entityKey: number;
}

/** The full pre-cull roster, including receivers whose own cast flag is off. */
export function terrainShadowReceivers(
  sources: readonly RenderableSnapshot[],
): readonly TerrainShadowReceiver[] {
  const roots = new Map<number, TerrainShadowReceiver>();
  for (const source of sources) {
    if (source.terrain === undefined || source.authorVisible === false) continue;
    roots.set(worldEntityKey(source.worldId, source.entityKey), {
      worldId: source.worldId,
      entityKey: source.entityKey,
    });
  }
  return [...roots.values()].sort(
    (a, b) => worldEntityKey(a.worldId, a.entityKey) - worldEntityKey(b.worldId, b.entityKey),
  );
}

type DirectionalTopology = RenderPipelineTopology['shadow']['directional'];

export function terrainShadowTopology(
  directional: DirectionalTopology,
  receivers: readonly TerrainShadowReceiver[],
  maxArrayLayers: number,
): Result<DirectionalTopology, RhiError> {
  if (directional === 'disabled' || receivers.length === 0) return ok(directional);
  const layers = directional.cascadeCount * (1 + receivers.length);
  const lastBase = layers - directional.cascadeCount;
  if (lastBase > 255 || !Number.isInteger(maxArrayLayers) || layers > maxArrayLayers) {
    return err(
      new RhiError({
        code: 'rhi-not-available',
        expected:
          'complete Terrain shadow families within the eight-bit base and device array limit',
        hint: `requestedLayers=${layers}, lastBase=${lastBase}, maxTextureArrayLayers=${maxArrayLayers}; reduce shadow receivers or cascades`,
      }),
    );
  }
  return ok({ ...directional, terrainReceivers: receivers });
}

/** Read the existing graph key; no second retained mapping is introduced. */
export function terrainShadowLayoutMatches(
  topologyKey: string,
  requested: DirectionalTopology,
): boolean {
  const roots = requested === 'disabled' ? [] : (requested.terrainReceivers ?? []);
  let previous: DirectionalTopology;
  try {
    previous = JSON.parse(topologyKey).topology.shadow.directional;
  } catch {
    return roots.length === 0;
  }
  if (previous === undefined) return roots.length === 0;
  const oldRoots = previous === 'disabled' ? [] : (previous.terrainReceivers ?? []);
  if (roots.length === 0 && oldRoots.length === 0) return true;
  if (requested === 'disabled' || previous === 'disabled') return false;
  return (
    requested.mapSize === previous.mapSize &&
    requested.cascadeCount === previous.cascadeCount &&
    roots.length === oldRoots.length &&
    roots.every((root, index) => {
      const old = oldRoots[index];
      return old?.worldId === root.worldId && old.entityKey === root.entityKey;
    })
  );
}
