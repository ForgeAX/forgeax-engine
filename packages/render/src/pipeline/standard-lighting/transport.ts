import { err, ok, type Result } from '@forgeax/engine-types';
import { type RenderError, StandardClusterTransportUnavailableError } from '../../errors/render';
import { BYTES_PER_DIRECT_LIGHT_SLOT } from '../../light-buffer-layout';
import type { PreparedStandardLighting } from './prepare';
import { standardClusterTextureLayout } from './texture';

export interface StandardClusterCapabilities {
  readonly compute: boolean;
  readonly storageBuffer: boolean;
  /** Maximum extent of baseline sampled integer textures on this device. */
  readonly maxTextureDimension2D?: number;
  /**
   * The graph producer is ready to encode the selected compute lane. The
   * renderer supplies this from the actual pipeline + bind-group layout; it is
   * required so capability admission cannot forge a GPU producer from
   * `compute` alone.
   */
  readonly membershipPipelineReady: boolean;
}

export type StandardClusterTransportKind = 'compute-storage' | 'cpu-storage' | 'cpu-texture';
export type StandardClusterMembershipProducer = 'cpu' | 'gpu';

export interface StandardClusterTransport {
  readonly kind: StandardClusterTransportKind;
  readonly producer: StandardClusterMembershipProducer;
  readonly layout: PreparedStandardLighting['layout'];
  readonly requestedLightCount: number;
  readonly admittedLightCount: number;
  readonly membershipEntryCount: number;
  readonly occupiedClusterCount: number;
  readonly clusterGridBytes: number;
  readonly lightIndexListBytes: number;
  readonly lightDataBytes: number;
  readonly lightBoundsBytes: number;
}

function occupiedClusterCount(prepared: PreparedStandardLighting): number {
  let occupied = 0;
  for (let index = 1; index < prepared.clusterGrid.length; index += 2) {
    if ((prepared.clusterGrid[index] ?? 0) > 0) occupied += 1;
  }
  return occupied;
}

/**
 * Select a transport from one prepared frame. Capability facts choose only a
 * producer/storage pair; all counts and byte sizes come from that frame.
 */
export function selectStandardClusterTransport(
  capabilities: StandardClusterCapabilities,
  prepared: PreparedStandardLighting,
): Result<StandardClusterTransport, RenderError> {
  const requested = prepared.local.length;
  const texture = standardClusterTextureLayout(prepared.layout);
  if (
    !capabilities.storageBuffer &&
    (capabilities.maxTextureDimension2D ?? 0) < Math.max(texture.width, texture.height)
  ) {
    return err(
      new StandardClusterTransportUnavailableError(
        requested,
        'provide storage buffers or a sampled integer texture large enough for the complete Cluster payload',
      ),
    );
  }

  const producer: StandardClusterMembershipProducer =
    capabilities.storageBuffer && capabilities.compute && capabilities.membershipPipelineReady
      ? 'gpu'
      : 'cpu';
  const kind: StandardClusterTransportKind = !capabilities.storageBuffer
    ? 'cpu-texture'
    : producer === 'gpu'
      ? 'compute-storage'
      : 'cpu-storage';
  return ok({
    kind,
    producer,
    layout: prepared.layout,
    requestedLightCount: requested,
    admittedLightCount: requested,
    membershipEntryCount: prepared.membershipEntryCount,
    occupiedClusterCount: occupiedClusterCount(prepared),
    clusterGridBytes: prepared.layout.clusterGridU32Length * Uint32Array.BYTES_PER_ELEMENT,
    lightIndexListBytes: prepared.membershipEntryCount * Uint32Array.BYTES_PER_ELEMENT,
    lightDataBytes: requested * BYTES_PER_DIRECT_LIGHT_SLOT,
    lightBoundsBytes: prepared.lightBounds.byteLength,
  });
}
