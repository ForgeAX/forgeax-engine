import type { EntityHandle } from '@forgeax/engine-ecs';
import { assert, expect, it, onTestFinished, vi } from 'vitest';
import { getOrCreateHdrpBuffers } from '../hdrp-buffers';
import {
  buildPerFrameBindGroups,
  captureGlobalMeshBindingsCurrent,
} from '../record/frame-lighting';
import { ViewStandardLighting, viewStandardLightingOf } from '../world/standard-lighting-systems';
import { recordContext } from '../world/view-record-context';
import { rendererInputHandoffFixture } from './renderer-input-handoff-fixture';

it.each([
  'grow',
  'cache-reset',
] as const)('invalidates the actual global mesh binding receipt after %s without issuing native work', async (mode) => {
  const f = await rendererInputHandoffFixture();
  onTestFinished(async () => {
    const closed = await f.close();
    if (!closed.ok) throw closed.error;
  });
  {
    const owner = f.manager.currentOwner;
    const context = recordContext(owner.internals);
    const pipeline = context.getPipelineState();
    assert(pipeline);
    const world = f.internals.renderWorld;
    assert(world);
    let entity: EntityHandle | undefined;
    for (const span of world
      .query({ with: [ViewStandardLighting] })
      .unwrap()
      .spans()
      .unwrap())
      for (const value of span.entities) entity = value as EntityHandle;
    const lighting = viewStandardLightingOf(world, entity);
    assert(lighting?.kind === 'prepared' && lighting.lighting.ok);
    const standard = lighting.lighting.value.standard;
    const counts = { createBindGroup: 0, keys: [] as string[] };
    const groups = buildPerFrameBindGroups(
      owner.internals,
      owner.frameState,
      pipeline,
      true,
      counts,
      undefined,
      false,
      standard,
    );
    const hdrp =
      standard.kind === 'clustered'
        ? getOrCreateHdrpBuffers(
            owner.internals,
            owner.frameState.installedPipelineConfig?.clusterGrid,
            owner.frameState.standardClusterTextureExtent,
          )
        : null;
    const current = captureGlobalMeshBindingsCurrent(
      owner.internals,
      owner.frameState,
      pipeline,
      groups,
      hdrp,
    );
    expect(current()).toBe(true);
    if (mode === 'cache-reset')
      owner.frameState.meshBindGroupCache.delete(pipeline.meshBindGroupLayout);
    else {
      assert(context.growMeshSsbo && context.meshSsboState);
      expect(
        context.growMeshSsbo(
          context.meshSsboState.meshSlotCount + 1,
          context.meshSsboState.materialSlotCount,
        ).ok,
      ).toBe(true);
    }
    const creates = vi.spyOn(f.internals.device, 'createBindGroup');
    try {
      expect(current()).toBe(false);
      expect(current()).toBe(false);
      expect(creates).not.toHaveBeenCalled();
    } finally {
      creates.mockRestore();
    }
  }
});
