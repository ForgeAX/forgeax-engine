import { createShaderModule } from '@forgeax/engine-rhi-null';
import { assert, expect, it, vi } from 'vitest';
import {
  createProbeCardSupportRecorder,
  PROBE_CARD_SUPPORT_WGSL,
  type ProbeCardSupportInputs,
} from '../../raytracing/probe-card-support';
import { queryTestDevice } from './global-sdf-query-device.fixture';

it('borrows exact original ranges without allocating, mutating, ending or submitting them', async () => {
  const device = await queryTestDevice();
  const module = (await createShaderModule(device, { code: PROBE_CARD_SUPPORT_WGSL })).unwrap();
  const input = Object.fromEntries(
    Object.entries({ rays: 48, hits: 64, candidates: 32, samples: 448, output: 32 }).map(
      ([name, stride]) => {
        const size = stride * 65;
        return [
          name,
          {
            buffer: device.createBuffer({ size: size + 256, usage: 140 }).unwrap(),
            offset: 256,
            size,
          },
        ];
      },
    ),
  ) as unknown as ProbeCardSupportInputs;
  const encoder = device.createCommandEncoder({}).unwrap();
  const pass = encoder.beginComputePass({});
  const create = vi.spyOn(device, 'createBuffer');
  const write = vi.spyOn(device.queue, 'writeBuffer');
  const submit = vi.spyOn(device.queue, 'submit');
  const end = vi.spyOn(pass, 'end');
  const dispatch = vi.spyOn(pass, 'dispatchWorkgroups');
  const bind = vi.spyOn(device, 'createBindGroup');
  const recorder = createProbeCardSupportRecorder(device, module).unwrap();
  recorder.record(pass, input, 65).unwrap();
  expect(dispatch.mock.calls).toEqual([[2]]);
  expect(Array.from(bind.mock.calls[0]?.[0].entries ?? [], (e) => e.resource)).toEqual(
    Object.values(input).map((value) => ({ kind: 'buffer', value })),
  );
  for (const count of [0, -1, NaN, 1.5, Infinity, 65537])
    expect(recorder.record(pass, input, count).ok).toBe(false);
  for (const name of Object.keys(input) as (keyof ProbeCardSupportInputs)[]) {
    for (const offset of [-1, 1, NaN, Infinity, 256.5])
      expect(recorder.record(pass, { ...input, [name]: { ...input[name], offset } }, 65).ok).toBe(
        false,
      );
    const byteSize = input[name].size;
    assert(byteSize !== undefined);
    for (const size of [undefined, 0, byteSize - 4, byteSize + 4])
      expect(recorder.record(pass, { ...input, [name]: { ...input[name], size } }, 65).ok).toBe(
        false,
      );
    if (name !== 'output')
      expect(
        recorder.record(
          pass,
          { ...input, [name]: { ...input[name], buffer: input.output.buffer } },
          65,
        ).ok,
      ).toBe(false);
  }
  expect(dispatch).toHaveBeenCalledTimes(1);
  for (const spy of [create, write, submit, end]) expect(spy).not.toHaveBeenCalled();
  pass.end();
  encoder.finish().unwrap();
});
