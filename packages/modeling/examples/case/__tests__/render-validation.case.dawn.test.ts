import { model } from '@forgeax/engine-modeling';
import { expect, it } from 'vitest';
import { createCaseRenderer, frameModel } from '../render';

/** Native validation inside a render must reject its pixels and leave the next render usable. */
it('fails a render whose draw fails GPU validation instead of returning the previous frame', {
  timeout: 300_000,
}, async () => {
  const m = model();
  m.box({ size: [1, 1, 1] });
  m.uv.project({ mode: 'box', scale: 1 });
  let rejectNext = false;
  let rejected = 0;
  const gpu = navigator.gpu;
  const requestAdapter = gpu.requestAdapter.bind(gpu);
  gpu.requestAdapter = async (options) => {
    const adapter = await requestAdapter(options);
    if (adapter === null) return adapter;
    const requestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (descriptor) => {
      const created = await requestDevice(descriptor);
      const submit = created.queue.submit.bind(created.queue);
      created.queue.submit = (commands) => {
        if (!rejectNext) return submit(commands);
        rejectNext = false;
        rejected++;
        // COPY_SRC without COPY_DST makes clearBuffer fail real native validation.
        const buffer = created.createBuffer({ size: 4, usage: 0x0004 });
        const encoder = created.createCommandEncoder();
        encoder.clearBuffer(buffer);
        const invalid = encoder.finish();
        submit([...commands, invalid]);
        buffer.destroy();
      };
      return created;
    };
    return adapter;
  };
  const r = await createCaseRenderer({
    width: 64,
    height: 48,
    slots: { Default: [0.6, 0.6, 0.62] },
    view: frameModel(m),
  }).finally(() => { gpu.requestAdapter = requestAdapter; });
  try {
    const finished = m.finish({ key: 'box' });
    if (!finished.ok) throw finished.error;
    const box = finished.value['mesh/box'];
    if (box === undefined) throw new Error('box mesh missing');
    const solid = await r.render(box);
    expect(r.covered(solid)).toBeGreaterThan(0);
    rejectNext = true;
    await expect(r.render(box)).rejects.toMatchObject({
      code: 'case-render-gpu-validation',
    });
    expect(rejected).toBe(1);
    // The renderer stays usable for the next evidence image.
    expect(r.covered(await r.render(box))).toBeGreaterThan(0);
  } finally {
    await r.dispose();
  }
});
