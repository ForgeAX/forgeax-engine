import type { World } from '@forgeax/engine-ecs';
import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import type { CompiledRenderGraph } from '@forgeax/engine-render-graph';
import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import { expect } from 'vitest';
import type { GpuDrivenProduction, PreparedGpuDrivenFrame } from '../gpu-driven/production-raster';
import { GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { ExtractedFrame, RenderableSnapshot } from '../render-system-extract';
import type { PersistentRenderScene } from '../scene/render-scene';
import { RenderScene } from '../scene/render-scene';
import { admitGpuFixture } from './gpu-driven-production-fixture';

/** Match the normal accepted material-frame publication before GPU preparation. */
export function admitPbrDawnFixture(input: Parameters<typeof admitGpuFixture>[0]) {
  const admitted = admitGpuFixture(input);
  if (input.scene !== undefined && admitted.materialFrame !== undefined)
    input.scene.scene
      .sync({ ...new RenderScene().apply([]), materials: admitted.materialFrame })
      .unwrap();
  return admitted;
}

/** Reuse the real Standard/scene-index shader and compiled graph of the Dawn fixture. */
export async function verifyRetainedRasterClass(input: {
  readonly device: RhiDevice;
  readonly compiled: CompiledRenderGraph<RenderPipelineFrame>;
  readonly production: GpuDrivenProduction;
  readonly prepareInput: Parameters<typeof admitGpuFixture>[0];
  readonly source: RenderableSnapshot;
  readonly persistentScene: PersistentRenderScene;
  readonly persistentWorld: World;
  readonly persistentLease: RenderReadLease;
  readonly persistentFrame: ExtractedFrame;
  readonly discardedReadbackBuffer: Buffer;
  readonly opaqueReadbackBuffer: Buffer;
  readonly setDiscardedTexture: (discarded: boolean) => void;
  readonly shadowViews: Parameters<NonNullable<PreparedGpuDrivenFrame['updateShadowViews']>>[0];
  readonly topologySignature: string;
}): Promise<void> {
  for (const [alphaCutoff, discardedTexture] of [
    [0, undefined],
    [0.5, undefined],
    [0, undefined],
    [0.5, undefined],
    [0.5, true],
    [0.5, false],
  ] as const) {
    const material = {
      ...input.source.material.snapshot,
      paramSnapshot: { ...input.source.material.snapshot.paramSnapshot, alphaCutoff },
    };
    const updatedMaterial =
      discardedTexture === undefined
        ? material
        : {
            ...material,
            textureHandles: new Map([['baseColorTexture', (discardedTexture ? 3 : 1) as never]]),
          };
    if (discardedTexture !== undefined) input.setDiscardedTexture(discardedTexture);
    input.source.material.adopt(updatedMaterial);
    const scene = input.prepareInput.scene;
    if (scene === undefined) throw Error('missing retained GPU scene');
    const prepared = input.production
      .prepare(admitPbrDawnFixture({ ...input.prepareInput, scene }))
      .unwrap();
    if (prepared === undefined) throw new Error('missing updated GPU frame');
    prepared.updateShadowViews?.(input.shadowViews).unwrap();
    expect(prepared.topologySignature).toBe(input.topologySignature);
    const sourceDraw = input.source.gpuDrivenDraws?.[0];
    if (sourceDraw === undefined) throw Error('missing source draw');
    expect(prepared.selection.owns(input.source, sourceDraw, 0)).toBe(true);
    const encoder = input.device.createCommandEncoder().unwrap();
    const encoded = input.compiled.execute({ encoder } as RenderPipelineFrame);
    if (!encoded.ok) throw encoded.error;
    input.device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await input.device.queue.onSubmittedWorkDone();
    prepared._commitResourceReplacement();
    const readback =
      discardedTexture === undefined ? input.discardedReadbackBuffer : input.opaqueReadbackBuffer;
    const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
    const pixel = [...new Uint8Array(mapped.getMappedRange().unwrap().slice(0, 4))];
    mapped.unmap();
    if (alphaCutoff === 0 || discardedTexture === false) {
      expect(pixel[0], 'current cutoff and texture must render the accepted texel').toBeGreaterThan(
        0,
      );
      expect(pixel[3]).toBeGreaterThan(0);
    } else {
      expect(pixel, 'current cutoff and texture must discard the translucent texel').toEqual([
        0, 0, 0, 0,
      ]);
    }
  }
}
