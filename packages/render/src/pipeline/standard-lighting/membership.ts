import { err, ok, type Result } from '@forgeax/engine-types';
import { bin, type ClusterBinScratch, createClusterBinScratch } from '../../cluster-binner';
import type { RenderError } from '../../errors/render';
import { fromClusterBinError } from './errors';
import type { StandardClusterLayout } from './layout';
import type { StandardLightFrame } from './light-frame';

export interface StandardClusterMembership {
  readonly clusterGrid: Uint32Array;
  readonly lightIndexList: Uint32Array;
  readonly lightBounds: Int32Array;
  readonly membershipEntryCount: number;
  readonly scratch: ClusterBinScratch;
}

export function deriveStandardMembership(
  frame: StandardLightFrame,
  layout: StandardClusterLayout,
  scratch = createClusterBinScratch(),
): Result<StandardClusterMembership, RenderError> {
  const clusterGrid = new Uint32Array(layout.clusterGridU32Length);
  // Each local light appears at most once per cluster; retain the shared GPU capacity.
  const lightIndexList = new Uint32Array(
    Math.min(layout.lightIndexListCapacity, layout.clusterCount * frame.local.length),
  );
  const result = bin(
    frame.local,
    frame.view,
    frame.projection,
    layout.grid,
    frame.near,
    frame.far,
    clusterGrid,
    lightIndexList,
    layout.lightIndexListCapacity,
    scratch,
  );
  if (!result.ok) return err(fromClusterBinError(result.error));
  return ok({
    clusterGrid,
    lightIndexList,
    lightBounds: scratch.lightBounds.slice(0, frame.local.length * 6),
    membershipEntryCount: result.value,
    scratch,
  });
}
