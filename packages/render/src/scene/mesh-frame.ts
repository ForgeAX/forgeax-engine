import { deriveVertexCount, deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import type { AssetGuid, MeshAsset } from '@forgeax/engine-types';
import type { MaterialResource } from '../material-resource';
import { morphChannels, packMorphDeltas } from '../morph-attributes';
import {
  geometryAt,
  type MeshDirectory,
  publishGeometry,
  removeGeometry,
  visitGeometryChanges,
} from './mesh-directory';
import { skinGeometryEnvelopes } from './skin-geometry';

const EMPTY_MATERIALS: readonly MaterialResource[] = Object.freeze([]);

/** Shared geometry facts. Vertex bytes remain with the asset and GPU residency owners. */
export interface MeshGeometry {
  readonly handle: number;
  /** Exact producer revision used to capture metadata; absent on unqualified callers. */
  readonly source?: { readonly identity: string; readonly revision: number };
  readonly bounds: Float32Array | undefined;
  /** Shared base-position enclosure, derived only on admitted Mesh changes.
   * Absence forbids Skin culling; never substitute the rigid/bind-pose box.
   */
  readonly skinEnvelopes: Float32Array | undefined;
  /** Compact selected canonical target channels; derived once per admitted Mesh. */
  readonly morph: MeshMorphDeltas | undefined;
  readonly layout: ReturnType<typeof deriveVertexLayoutProjection>;
  readonly indexed: boolean;
  readonly materialSlots: MeshAsset['materialSlots'];
  readonly materials: readonly MaterialResource[];
  readonly submeshes: MeshAsset['submeshes'];
  readonly lods: MeshAsset['lods'];
  readonly lodHysteresis: MeshAsset['lodHysteresis'];
}

export interface MeshMorphDeltas {
  readonly vertexCount: number;
  readonly targetCount: number;
  readonly channels: number;
  readonly deltas: Float32Array;
}

function morphDeltas(mesh: MeshAsset): MeshMorphDeltas | undefined {
  const targets = mesh.morphTargets;
  if (targets === undefined) return undefined;
  const layout = deriveVertexLayoutProjection(mesh.attributes);
  const vertexCount = deriveVertexCount(mesh.vertices, layout);
  if (vertexCount === undefined || vertexCount <= 0) return undefined;
  const channels = morphChannels(mesh, layout, vertexCount);
  if (channels === undefined) return undefined;
  return {
    vertexCount,
    targetCount: targets.length,
    channels: channels.reduce((mask, channel) => mask | channel.bit, 0),
    deltas: packMorphDeltas(mesh, vertexCount, channels),
  };
}

/** Immutable geometry facts shared by culling, material dispatch and draw recording. */
export class MeshFrame {
  readonly identity = Symbol();

  constructor(private readonly root?: MeshDirectory) {}

  get(handle: number | undefined): MeshGeometry | undefined {
    return handle === undefined ? undefined : geometryAt(this.root, handle);
  }

  with(
    handle: number,
    mesh: MeshAsset,
    materials: readonly MaterialResource[] = EMPTY_MATERIALS,
    provenance?: { readonly identity: string; readonly revision: number },
  ): MeshFrame {
    // Only metadata is captured. A range edit may mutate the asset's backing bytes,
    // while old frames must retain their original bounds and section description.
    const source = mesh.aabb;
    const bounds =
      source !== undefined &&
      source.length >= 6 &&
      source.every(Number.isFinite) &&
      (source[0] as number) <= (source[3] as number) &&
      (source[1] as number) <= (source[4] as number) &&
      (source[2] as number) <= (source[5] as number)
        ? source.slice()
        : undefined;
    const geometry: MeshGeometry = {
      handle,
      ...(provenance === undefined ? {} : { source: Object.freeze({ ...provenance }) }),
      bounds,
      skinEnvelopes: skinGeometryEnvelopes(mesh),
      morph: morphDeltas(mesh),
      layout: deriveVertexLayoutProjection(mesh.attributes),
      indexed: mesh.indices !== undefined,
      materialSlots: captureMaterialSlots(mesh.materialSlots, this.get(handle)?.materialSlots),
      materials,
      submeshes: mesh.submeshes,
      lods: mesh.lods,
      lodHysteresis: mesh.lodHysteresis,
    };
    return this.withGeometry(geometry);
  }

  /** Consume already-captured metadata without rereading the asset or deriving it again. */
  withGeometry(geometry: MeshGeometry): MeshFrame {
    if (!Number.isSafeInteger(geometry.handle))
      throw new RangeError('Mesh handle must be a safe integer');
    return new MeshFrame(publishGeometry(this.root, geometry));
  }

  without(handle: number): MeshFrame {
    const next = removeGeometry(this.root, handle);
    return next === this.root ? this : new MeshFrame(next);
  }

  changesSince(
    previous: MeshFrame,
    visit: (before: MeshGeometry | undefined, after: MeshGeometry | undefined) => void,
  ): void {
    visitGeometryChanges(previous.root, this.root, visit);
  }
}

/** Detach admission facts once; unchanged slots keep the accepted Pass binding table. */
function captureMaterialSlots(
  source: MeshAsset['materialSlots'],
  previous: MeshAsset['materialSlots'] | undefined,
): MeshAsset['materialSlots'] {
  let slots: Array<MeshAsset['materialSlots'][number]> | undefined =
    previous?.length === source.length ? undefined : [];
  let index = 0;
  for (const { slotName, sourceKey, defaultMaterial } of source) {
    const old = previous?.[index];
    if (
      old !== undefined &&
      old.slotName === slotName &&
      old.sourceKey === sourceKey &&
      sameMaterialDefault(old.defaultMaterial, defaultMaterial)
    ) {
      slots?.push(old);
    } else {
      slots ??= previous?.slice(0, index) ?? [];
      slots.push(
        Object.freeze({
          slotName,
          ...(sourceKey === undefined ? {} : { sourceKey }),
          ...(defaultMaterial === undefined
            ? {}
            : {
                defaultMaterial:
                  typeof defaultMaterial === 'number'
                    ? defaultMaterial
                    : (defaultMaterial.slice() as AssetGuid),
              }),
        }),
      );
    }
    index++;
  }
  return slots === undefined && previous !== undefined ? previous : Object.freeze(slots ?? []);
}

function sameMaterialDefault(
  a: MeshAsset['materialSlots'][number]['defaultMaterial'],
  b: MeshAsset['materialSlots'][number]['defaultMaterial'],
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || typeof a === 'number' || typeof b === 'number')
    return false;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
