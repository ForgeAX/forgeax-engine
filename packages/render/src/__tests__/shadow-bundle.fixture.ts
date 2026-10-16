import type {
  Buffer,
  RenderBundle,
  RhiDevice,
  RhiRenderCommands,
  RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { vi } from 'vitest';
import { GpuResourceAllocationLedger } from '../gpu-driven/resource-allocation';
import { GpuDrivenView } from '../gpu-driven/view-gpu';

const commands = new WeakMap<
  RenderBundle,
  Array<{ method: keyof RhiRenderCommands; args: unknown[] }>
>();
const methods = [
  'setPipeline',
  'setVertexBuffer',
  'setIndexBuffer',
  'setBindGroup',
  'draw',
  'drawIndexed',
  'drawIndirect',
  'drawIndexedIndirect',
] as const;

/** The fixture omits compute buffers but executes the real view-owned raster cache. */
export function preparedShadowView(device: RhiDevice, indirect: Buffer): GpuDrivenView {
  const view = Object.create(GpuDrivenView.prototype);
  Object.defineProperty(view, 'device', { value: device });
  Object.defineProperty(view, 'indirectBuffer', { value: indirect });
  Object.defineProperty(view, 'allocationLedger', { value: new GpuResourceAllocationLedger() });
  return view;
}

/** Observe real backend bundle recording; replay its exact commands into the unit witness. */
export function captureShadowBundles(device: RhiDevice) {
  const create = device.createRenderBundleEncoder.bind(device);
  return vi.spyOn(device, 'createRenderBundleEncoder').mockImplementation((desc) => {
    const result = create(desc);
    if (!result.ok) return result;
    const encoder = result.value,
      trace: Array<{ method: keyof RhiRenderCommands; args: unknown[] }> = [];
    for (const method of methods) {
      const original = encoder[method].bind(encoder);
      Object.defineProperty(encoder, method, {
        value: (...args: unknown[]) => {
          trace.push({ method, args });
          return Reflect.apply(original, encoder, args);
        },
      });
    }
    const finish = encoder.finish.bind(encoder);
    encoder.finish = () => {
      const value = finish();
      if (value.ok) commands.set(value.value, trace);
      return value;
    };
    return result;
  });
}

export function shadowBundleCommands(bundles: Iterable<RenderBundle>) {
  const rows: Array<{ method: keyof RhiRenderCommands; args: unknown[] }> = [];
  for (const bundle of bundles) {
    const trace = commands.get(bundle);
    if (trace === undefined) throw Error('Unobserved native shadow bundle');
    rows.push(...trace);
  }
  return rows;
}

export function replayShadowBundles(pass: RhiRenderPassEncoder, bundles: Iterable<RenderBundle>) {
  for (const { method, args } of shadowBundleCommands(bundles))
    Reflect.apply(pass[method], pass, args);
  return ok(undefined);
}
