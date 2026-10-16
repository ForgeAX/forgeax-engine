import type { World } from '@forgeax/engine-ecs';
import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import type { CompiledRenderGraph } from '@forgeax/engine-render-graph';
import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import { expect } from 'vitest';
import { gpuDrivenMaterialResourceClass } from '../extract/gpu-driven';
import type { GpuDrivenProduction, PreparedGpuDrivenFrame } from '../gpu-driven/production-raster';
import { GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { ExtractedFrame, RenderableSnapshot } from '../render-system-extract';
import type { PersistentRenderScene } from '../scene/render-scene';

/** Reuse the real Standard/scene-index shader and compiled graph of the Dawn fixture. */
export async function verifyRetainedRasterClass(input: {
  readonly device: RhiDevice;
  readonly compiled: CompiledRenderGraph<RenderPipelineFrame>;
  readonly production: GpuDrivenProduction;
  readonly prepareInput: Parameters<GpuDrivenProduction['prepare']>[0];
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
  let catalogEpoch = 0;
  for (const [alphaCutoff, discardedTexture] of [
    [0, undefined],
    [0.5, undefined],
    [0, undefined],
    [0.5, undefined],
    [0.5, true],
    [0.5, false],
  ] as const) {
    const material = {
      ...input.source.material,
      paramSnapshot: { ...input.source.material.paramSnapshot, alphaCutoff },
    };
    const updatedMaterial =
      discardedTexture === undefined
        ? material
        : {
            ...material,
            textureHandles: new Map([['baseColorTexture', (discardedTexture ? 3 : 1) as never]]),
          };
    if (discardedTexture !== undefined) input.setDiscardedTexture(discardedTexture);
    const source = {
      ...input.source,
      material: updatedMaterial,
      materials: [updatedMaterial],
      ...(discardedTexture === undefined
        ? {}
        : {
            gpuDrivenDraws: (input.source.gpuDrivenDraws ?? []).map((draw) => ({
              ...draw,
              materialResourceClass: gpuDrivenMaterialResourceClass(updatedMaterial),
            })),
          }),
    };
    // A changed accepted catalog revisits the existing source, while retaining
    // its GPU Scene and physical mesh/indirect allocations.
    input.persistentScene.extractComposition(
      [input.persistentWorld],
      { cameraOwner: 0, resourceOwner: 0 },
      ++catalogEpoch,
      () => ({ ...input.persistentFrame, renderables: [source] }),
      [input.persistentLease],
    );
    const scene = input.persistentScene.compositionGpuDrivenState();
    if (scene === undefined) throw new Error('missing updated GPU scene');
    expect(scene.plan.batches[0]?.key.admission).toBe(alphaCutoff === 0 ? 'opaque' : 'alpha-mask');
    const prepared = input.production.prepare({ ...input.prepareInput, scene }).unwrap();
    if (prepared === undefined) throw new Error('missing updated GPU frame');
    prepared.updateShadowViews?.(input.shadowViews).unwrap();
    expect(prepared.topologySignature).toBe(input.topologySignature);
    expect(prepared.ownsAllDrawItems).toBe(true);
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
