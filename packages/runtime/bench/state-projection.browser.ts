import * as assetsRuntime from '@forgeax/engine-assets-runtime';
import {
  type Component,
  createWorldContext,
  defineComponent,
  type EntityHandle,
  World,
} from '@forgeax/engine-ecs';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import { createRenderer } from '@forgeax/engine-runtime';
import { ChildOf, scenePlugin, Transform } from '@forgeax/engine-scene';
import { expect, it, vi } from 'vitest';
import { commands } from 'vitest/browser';

declare module 'vitest/browser' {
  interface BrowserCommands {
    writeStateProjectionCost(result: unknown): Promise<void>;
  }
}

// Identical source is run against each revision's source aliases. Timings include
// real Chromium WebGPU submission and completion, never an inferred GPU duration.
it('measures the real browser projection path', async () => {
  const contract = {
    warmup: 30,
    samples: 90,
    entities: 512,
    smallEntities: 32,
    comparison: 'candidate p95 <= baseline p95 * 1.20 + 2 ms per workload',
    backend:
      'Chromium WebGPU; serialized submission completion; no GPU timestamps or DOM input latency',
  };
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  document.body.append(canvas);
  const renderer = (
    await createRenderer(canvas, {}, { shaderManifestUrl: '/shaders/manifest.json' })
  ).unwrap();
  let writes = 0;
  let bytes = 0;
  let submitMs = 0;
  const nativeWrite = GPUQueue.prototype.writeBuffer;
  const nativeSubmit = GPUQueue.prototype.submit;
  const write = vi.spyOn(GPUQueue.prototype, 'writeBuffer').mockImplementation(function (...args) {
    const data = args[2];
    const width =
      ArrayBuffer.isView(data) && 'BYTES_PER_ELEMENT' in data ? Number(data.BYTES_PER_ELEMENT) : 1;
    writes++;
    bytes += args[4] === undefined ? data.byteLength - (args[3] ?? 0) * width : args[4] * width;
    return nativeWrite.apply(this, args);
  });
  const submit = vi.spyOn(GPUQueue.prototype, 'submit').mockImplementation(function (...args) {
    const start = performance.now();
    try {
      return nativeSubmit.apply(this, args);
    } finally {
      submitMs += performance.now() - start;
    }
  });
  const reports = [];
  try {
    for (const workload of [
      'small',
      'static',
      'sparse',
      'scattered',
      'dense',
      'fragmented',
      'history',
      'parent',
      'material',
    ]) {
      const world = new World();
      const scene = await createWorldContext(world, [scenePlugin()]);
      const parent = world.spawn({ component: Transform, data: {} }).unwrap();
      const count = workload === 'small' ? contract.smallEntities : contract.entities;
      const tags =
        workload === 'fragmented'
          ? Array.from({ length: 64 }, (_, i) => defineComponent(`BrowserFragment${i}`, {}))
          : [];
      if (workload === 'history')
        for (let i = 0; i < 512; i++) {
          const tag = defineComponent(`BrowserHistory${i}`, {});
          world.despawn(world.spawn({ component: tag, data: {} }).unwrap()).unwrap();
        }
      const values = {
        baseColor: [1, 0, 0, 1] as [number, number, number, number],
        roughness: 0.5,
      };
      const material = Materials.standard(values);
      const handle = world.allocSharedRef('MaterialAsset', material);
      const contentType = Reflect.get(assetsRuntime, 'RuntimeMaterialValue') as
        | Component
        | undefined;
      const content =
        workload === 'material' && contentType !== undefined
          ? world
              .spawn({
                component: contentType,
                data: { asset: handle, parameter: 'roughness', value: [0.5] },
              })
              .unwrap()
          : undefined;
      const entities: EntityHandle[] = [];
      for (let i = 0; i < count; i++) {
        const entity = world
          .spawn(
            {
              component: Transform,
              data: {
                pos: [((i % 32) - 16) * 0.06, (Math.floor(i / 32) - 8) * 0.06, 0],
                scale: [0.035, 0.035, 0.035],
              },
            },
            { component: MeshFilter, data: { assetHandle: assetsRuntime.HANDLE_CUBE } },
            { component: MeshRenderer, data: { materials: [handle] } },
          )
          .unwrap();
        const tag = tags[i % tags.length];
        if (tag !== undefined) world.addComponent(entity, { component: tag, data: {} }).unwrap();
        if (workload === 'parent')
          world.addComponent(entity, { component: ChildOf, data: { parent } }).unwrap();
        entities.push(entity);
      }
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 4] } },
          { component: Camera, data: { aspect: 1, near: 0.1, far: 20 } },
        )
        .unwrap();
      world
        .spawn({ component: DirectionalLight, data: { direction: [0, 0, -1], intensity: 2 } })
        .unwrap();
      const lease = renderer.attach(world).unwrap();
      const samples = [];
      try {
        for (let frame = 0; frame < contract.warmup + contract.samples; frame++) {
          writes = bytes = submitMs = 0;
          const start = performance.now();
          const changing = ['dense', 'fragmented'].includes(workload)
            ? count
            : ['sparse', 'scattered', 'history', 'small'].includes(workload)
              ? Math.max(1, count / 64)
              : 0;
          for (let i = 0; i < changing; i++) {
            const entity = entities[workload === 'scattered' ? (i * 67 + frame) % count : i];
            if (entity !== undefined)
              world
                .set(entity, Transform, {
                  pos: [
                    ((i % 32) - 16) * 0.06 + Math.sin(frame / 10) * 0.01,
                    (Math.floor(i / 32) - 8) * 0.06,
                    0,
                  ],
                })
                .unwrap();
          }
          if (workload === 'parent')
            world.set(parent, Transform, { pos: [Math.sin(frame / 10) * 0.01, 0, 0] }).unwrap();
          if (workload === 'material') {
            if (content !== undefined && contentType !== undefined)
              world.set(content, contentType, { value: [(frame % 10) / 10] }).unwrap();
            else {
              const mutable = material.values as { roughness: number };
              mutable.roughness = (frame % 10) / 10;
              (world.sharedRefs as unknown as { markChanged(handle: number): void }).markChanged(
                handle,
              );
            }
          }
          world.update(1 / 60).unwrap();
          const simulated = performance.now();
          const receipt = renderer
            .draw({ leases: [lease], camera: { lease }, environment: { lease } })
            .unwrap();
          const submitted = performance.now();
          (await receipt.completed).unwrap();
          const completed = performance.now();
          if (frame >= contract.warmup)
            samples.push({
              simulationMs: simulated - start,
              drawCpuMs: submitted - simulated,
              completionMs: completed - start,
              submitMs,
              writes,
              bytes,
            });
        }
        expect(samples).toHaveLength(contract.samples);
        const summary = Object.fromEntries(
          Object.keys(samples[0] ?? {}).map((key) => {
            const ordered = samples
              .map((sample) => sample[key as keyof typeof sample])
              .sort((a, b) => a - b);
            return [
              key,
              {
                median: ordered[Math.floor(ordered.length / 2)],
                p95: ordered[Math.floor(ordered.length * 0.95)],
              },
            ];
          }),
        );
        reports.push({ workload, count, summary, samples });
      } finally {
        lease.dispose();
        await scene.fiber.dispose();
      }
    }
    await commands.writeStateProjectionCost({ contract, userAgent: navigator.userAgent, reports });
  } finally {
    write.mockRestore();
    submit.mockRestore();
    renderer.dispose();
    canvas.remove();
  }
}, 600_000);
