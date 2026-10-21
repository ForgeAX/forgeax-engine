import { mat4 } from '@forgeax/engine-math';
import { createStandardPbrArtifactReceipt } from '@forgeax/engine-shader';
import { BatchTopology, type GpuDrivenBatch } from '../gpu-driven/batch-topology';
import { GpuDrawSelection } from '../gpu-driven/draw-selection';
import { MaterialResource } from '../material-resource';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';

export function receiptRow(worldId = 0) {
  const material = new MaterialResource(defaultMaterialSnapshot(17));
  const source: RenderableSnapshot = {
    worldId,
    entityKey: 42,
    assetHandle: 9,
    transform: { world: mat4.identity(mat4.create()) },
    localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    gpuDrivenDraws: [2, 7].map((drawItemIndex) => {
      const draw = {
        kind: 'indexed' as const,
        first: drawItemIndex * 3,
        count: 3,
        baseVertex: 0,
        topology: 'triangle-list' as const,
      };
      return {
        ...draw,
        drawItemIndex,
        materialSlot: 0,
        pipelineClass: 'source',
        materialResourceClass: 'source',
        geometry: {
          receipt: {
            identity: 'triangle',
            vertexInputs: createStandardPbrArtifactReceipt().vertexInputs,
            topology: draw.topology,
            indexed: true,
          },
          draw,
          deformation: 'rigid' as const,
        },
      };
    }),
  };
  return { source };
}

export function receiptSelection(
  rows: readonly { readonly source: RenderableSnapshot }[],
  accepts: (batch: GpuDrivenBatch) => boolean,
) {
  const scene = new RenderScene();
  const topology = new BatchTopology();
  topology.apply(
    scene.apply(
      rows.map(({ source }) => ({
        kind: 'update' as const,
        worldId: source.worldId,
        entityKey: source.entityKey,
        snapshot: source,
      })),
    ),
  );
  return new GpuDrawSelection(
    topology.query(topology.sourcePlan(), undefined).batches.filter(accepts),
  );
}
