import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { FORWARD_PASS_SELECTOR } from '../../systems/pass-selector';
import { prepareMainPassPipelines } from '../main-pass';
import { CPU_SETUP_SHADER, cpuSetupFixture } from './main-pass-cpu-setup-fixture';

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module),
    entry = f.add({ entity: 1, submeshes: 1 });
  Object.assign(entry.source.material, { transparent: true, materialShaderId: 'test::prepared' });
  Object.assign(entry.source, {
    authorVisible: false,
    pipelinePreparation: [
      {
        materialHandle: entry.source.material.materialHandle ?? 0,
        passIndex: 0,
        queue: 3000,
        layer: 0,
        tags: { LightMode: 'Forward' },
        renderState: { cullMode: 'none' },
        defines: undefined,
        materialShaderId: 'test::prepared',
        vertexEntry: 'vertex',
        fragmentEntry: 'fragment',
        paramSnapshot: undefined,
      },
    ],
  });
  Object.assign(f.c, { validatedOrdered: [], pipelinePreparationEntries: [entry] });
  const prepare = () =>
    prepareMainPassPipelines(
      f.c,
      FORWARD_PASS_SELECTOR,
      { recordMode: 'transparent', transparentDepthWrite: true },
      1,
      ['rgba16float'],
    );
  return { ...f, device, entry, prepare };
}
it('prepares an empty transparent lane, waits for its exact PSO, and opens no raster pass', async () => {
  const f = await fixture(),
    lookup = vi.spyOn(f.c.runtime, 'getMaterialShaderPipelineEntry'),
    encoder = vi.spyOn(f.device, 'createCommandEncoder');
  try {
    lookup.mockReturnValueOnce(null);
    f.prepare();
    expect(f.c.frameState.pipelinePreparationPending).toBe(true);
    expect(f.c.frameState.pipelinePreparationPendingReason).toMatchObject({
      code: 'material-pipeline-preparation',
      entity: 1,
    });
    f.c.frameState.pipelinePreparationPending = false;
    f.prepare();
    expect(f.c.frameState.pipelinePreparationPending).toBe(false);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup.mock.calls[1]).toEqual(lookup.mock.calls[0]);
    expect(encoder).not.toHaveBeenCalled();
    expect(f.receipts).toEqual([]);
    expect(f.entry.source.authorVisible).toBe(false);
  } finally {
    f.dispose();
  }
});
it('does no work for an unrelated or excluded material lane', async () => {
  const f = await fixture(),
    lookup = vi.spyOn(f.c.runtime, 'getMaterialShaderPipelineEntry'),
    encoder = vi.spyOn(f.device, 'createCommandEncoder');
  try {
    prepareMainPassPipelines(f.c, FORWARD_PASS_SELECTOR, { recordMode: 'opaque' }, 1, [
      'rgba16float',
    ]);
    prepareMainPassPipelines(
      f.c,
      FORWARD_PASS_SELECTOR,
      { recordMode: 'transparent', excludeSelector: FORWARD_PASS_SELECTOR },
      1,
      ['rgba16float'],
    );
    Object.assign(f.c, { pipelinePreparationEntries: [] });
    f.prepare();
    expect(lookup).not.toHaveBeenCalled();
    expect(encoder).not.toHaveBeenCalled();
    expect(f.receipts).toEqual([]);
  } finally {
    f.dispose();
  }
});
