import type {
  RenderBundle,
  RenderPipelineDescriptor,
  RhiDevice,
  RhiRenderCommands,
  RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import {
  type PreparedRasterBindings,
  PreparedRasterBundleCache,
  PreparedRasterPassCache,
  recordPreparedRasters,
} from '../../gpu-driven/prepared-raster-bundle';

/** Observe the Null backend at execution and reduce it to effective work.
 * Every draw carries the pipeline, bind groups, vertex/index buffers and
 * dynamic state it executes with; bundles start from empty binding state and
 * clear it afterwards (WebGPU semantics). Two sequences that bind the same
 * state for every draw in the same order are equivalent, even when a bundle
 * prelude re-sets state a direct pass inherited.
 */
function observeCommands(d: RhiDevice) {
  type Command = { method: string; args: unknown[] };
  type Event = { method: string; args: unknown[]; state?: string };
  const recorded = new WeakMap<RenderBundle, Command[]>();
  const ids = new WeakMap<object, number>();
  let nextId = 0;
  const canonical = (arg: unknown): unknown => {
    if (Array.isArray(arg)) return arg.map(canonical);
    if (typeof arg !== 'object' || arg === null) return arg;
    if (!ids.has(arg)) ids.set(arg, nextId++);
    return `resource:${ids.get(arg)}`;
  };
  interface Binding {
    pipeline?: unknown;
    groups: Map<unknown, unknown>;
    vertex: Map<unknown, unknown>;
    index?: unknown;
  }
  const emptyBinding = (): Binding => ({ groups: new Map(), vertex: new Map() });
  const simulate = (
    command: Command,
    binding: Binding,
    dynamic: Map<string, unknown>,
    events: Event[],
  ) => {
    const { method, args } = command;
    switch (method) {
      case 'setPipeline':
        binding.pipeline = args[0];
        return;
      case 'setBindGroup':
        binding.groups.set(args[0], args.slice(1));
        return;
      case 'setVertexBuffer':
        binding.vertex.set(args[0], args.slice(1));
        return;
      case 'setIndexBuffer':
        binding.index = args;
        return;
      case 'setViewport':
      case 'setScissorRect':
      case 'setBlendConstant':
      case 'setStencilReference':
        dynamic.set(method, args);
        return;
      case 'draw':
      case 'drawIndexed':
      case 'drawIndirect':
      case 'drawIndexedIndirect':
        events.push({
          method,
          args,
          state: JSON.stringify([
            binding.pipeline,
            [...binding.groups].sort(),
            [...binding.vertex].sort(),
            binding.index,
            [...dynamic].sort(),
          ]),
        });
        return;
      default:
        events.push({ method, args });
    }
  };
  const capture = <T extends RhiRenderCommands>(
    target: T,
    onCommand: (command: Command) => void,
    onBundles?: (bundles: readonly RenderBundle[]) => void,
  ): T =>
    new Proxy(target, {
      get(object, key, receiver) {
        const method = Reflect.get(object, key, receiver);
        if (typeof method !== 'function') return method;
        return (...args: unknown[]) => {
          if (key === 'finish') return Reflect.apply(method, object, args);
          if (key === 'executeBundles') {
            const handles = Array.from(args[0] as Iterable<RenderBundle>);
            const result = Reflect.apply(method, object, [handles]);
            if (!result.ok) throw result.error;
            onBundles?.(handles);
            return result;
          }
          if (key === 'setBindGroup') {
            const offsets = args[2];
            args = [
              args[0],
              args[1],
              offsets instanceof Uint32Array
                ? Array.from(
                    offsets.subarray(args[3] as number, (args[3] as number) + (args[4] as number)),
                  )
                : (offsets ?? []),
            ];
          }
          onCommand({ method: String(key), args: args.map(canonical) });
          return Reflect.apply(method, object, args);
        };
      },
    });
  const create = d.createRenderBundleEncoder.bind(d);
  const builds = vi.spyOn(d, 'createRenderBundleEncoder').mockImplementation((desc) => {
    const result = create(desc);
    if (!result.ok) return result;
    const commands: Command[] = [];
    const encoder = capture(result.value, (command) => commands.push(command));
    const finish = encoder.finish.bind(encoder);
    encoder.finish = () => {
      const finished = finish();
      if (finished.ok) recorded.set(finished.value, commands);
      return finished;
    };
    return ok(encoder);
  });
  return {
    builds,
    frame(record: (pass: RhiRenderPassEncoder) => void) {
      const events: Event[] = [];
      let binding = emptyBinding();
      const dynamic = new Map<string, unknown>();
      const p = capture(
        d.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] }),
        (command) => simulate(command, binding, dynamic, events),
        (bundles) => {
          for (const bundle of bundles) {
            const commands = recorded.get(bundle);
            if (!commands) throw new Error('Unobserved bundle');
            const bundleBinding = emptyBinding();
            for (const command of commands) simulate(command, bundleBinding, dynamic, events);
          }
          binding = emptyBinding();
        },
      );
      record(p);
      p.end();
      return events;
    },
  };
}

it('matches the effective direct commands through 1,000 moving frames across eight raster passes', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const observer = observeCommands(device);
  const cache = new PreparedRasterBundleCache();
  const passes = new PreparedRasterPassCache();
  const buffers = Array.from({ length: 4 }, () =>
    device.createBuffer({ size: 2048, usage: 0x1f8 }).unwrap(),
  );
  const layout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const group = device.createBindGroup({ layout, entries: [] }).unwrap();
  const pipelines = Array.from({ length: 2 }, () =>
    device.createRenderPipeline({} as RenderPipelineDescriptor).unwrap(),
  );
  const counters = { hits: 0, builds: 0, commands: 0, evictions: 0 };
  let seed = 0x5eeda11;
  for (let frame = 0; frame < 1_000; frame++) {
    for (let lane = 0; lane < 8; lane++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const revision = lane === 0 ? 0 : Math.floor(frame / 3) + lane;
      const count = lane === 0 ? 4 : frame % 19 === 0 ? 0 : revision % 9;
      const rows: PreparedRasterBindings[] = [];
      const offsets = [0];
      for (let i = 0; i < count; i++) {
        const n = revision % 2 === 0 ? i : count - i - 1;
        const vertex = buffers[(n + revision) % 4];
        const pipeline = pipelines[(n + revision) % 2];
        if (!vertex || !pipeline) throw Error('Missing fixture input');
        rows.push({
          pipeline,
          view: group,
          viewOffset: (revision % 2) * 256,
          material: group,
          materialOffset: n * 256,
          mesh: group,
          meshOffsets: offsets,
          vertex,
          index: vertex,
          indexFormat: 'uint16',
          indirect: vertex,
          indirectOffset: n * 20,
          indexed: n % 2 === 0,
          windows: [group],
        });
      }
      const pass = passes.prepare(String(lane), { colorFormats: [] });
      const recording = cache.begin(pass, device, counters);
      for (const row of rows) recording.push(row);
      const raster = rows.length ? recording.finish() : undefined;
      const state = (p: RhiRenderPassEncoder) => {
        p.setViewport(0, 0, 16, 16, 0, 1);
        p.setScissorRect(seed >>> 30, 0, 8, 8);
        p.setStencilReference(revision % 256);
      };
      const direct = observer.frame((p) => {
        state(p);
        recordPreparedRasters(p, rows);
      });
      const bundled = observer.frame((p) => {
        state(p);
        if (raster) p.executeBundles([raster]).unwrap();
      });
      expect(bundled, `frame ${frame} pass ${lane}`).toEqual(direct);
      offsets[0] = 256;
      if (lane === 7 && frame % 10 === 0) cache.retire(pass, counters);
    }
  }
  expect(counters.hits).toBeGreaterThan(1_000);
  expect(counters.evictions).toBeGreaterThan(0);
  expect(counters.builds).toBe(observer.builds.mock.calls.length);
  for (const buffer of buffers) device.destroyBuffer(buffer).unwrap();
}, 30_000);
