import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import * as assetsRuntime from '@forgeax/engine-assets-runtime';
import { type Component, defineComponent, type EntityHandle, World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { ChildOf, registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import type { ShaderRegistry } from '@forgeax/engine-shader';
import type { MaterialAsset } from '@forgeax/engine-types';
import { Camera, MeshFilter, MeshRenderer } from '../src/components';
import { extractFrames } from '../src/render-system-extract-tail';
import {
  type PersistentRenderCandidateRequest,
  PersistentRenderScene,
} from '../src/scene/render-scene';

// Fixed before sampling. Sequential extraction is a CPU lower-bound reference;
// it does not include persistent topology or GPU preparation and is not a player.
const contract = {
  warmup: 60,
  samples: 180,
  entities: 2048,
  smallEntities: 64,
  comparison: 'candidate p95 <= baseline p95 * 1.20 + 0.2 ms for each matching workload',
  backend: 'headless CPU; no GPU, submission, input latency or browser timing',
  workloads: [
    'small',
    'static',
    'sparse',
    'scattered',
    'dense',
    'fragmented',
    'history',
    'parent',
    'material',
  ],
} as const;

function measureStateProjection() {
  const reports = [];
  const selected = contract.workloads.filter(
    (name) =>
      !process.env.FORGEAX_PROJECTION_WORKLOAD || name === process.env.FORGEAX_PROJECTION_WORKLOAD,
  );
  for (const workload of selected)
    for (const mode of (['persistent', 'sequential'] as const).filter(
      (mode) =>
        !process.env.FORGEAX_PROJECTION_MODE || mode === process.env.FORGEAX_PROJECTION_MODE,
    )) {
      const world = new World();
      registerPropagateTransforms(world);
      const entities: EntityHandle[] = [];
      const count = workload === 'small' ? contract.smallEntities : contract.entities;
      const parent = world.spawn({ component: Transform, data: {} }).unwrap();
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 20] } },
          {
            component: Camera,
            data: { near: 0.1, far: 100, aspect: 1 },
          },
        )
        .unwrap();
      if (workload === 'history') {
        for (let index = 0; index < 512; index++) {
          const tag = defineComponent(`History${mode}${index}`, {});
          const temporary = world.spawn({ component: tag, data: {} }).unwrap();
          world.despawn(temporary).unwrap();
        }
      }
      const tags =
        workload === 'fragmented'
          ? Array.from({ length: 128 }, (_, index) =>
              defineComponent(`Fragment${mode}${index}`, {}),
            )
          : [];
      const values = { baseColor: [1, 0, 0, 1], roughness: 0.5 };
      const material: MaterialAsset = {
        kind: 'material',
        values,
        passes: [
          {
            name: 'Forward',
            program: { module: 'forgeax::default-standard-pbr' },
            renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
          },
        ],
      };
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
      for (let index = 0; index < count; index++) {
        const entity = world
          .spawn(
            { component: Transform, data: { pos: [(index % 16) / 16, 0, 0] } },
            { component: MeshFilter, data: { assetHandle: assetsRuntime.HANDLE_CUBE } },
            { component: MeshRenderer, data: { materials: [handle] } },
          )
          .unwrap();
        const tag = tags[index % tags.length];
        if (tag !== undefined) world.addComponent(entity, { component: tag, data: {} }).unwrap();
        if (workload === 'parent')
          world.addComponent(entity, { component: ChildOf, data: { parent } }).unwrap();
        entities.push(entity);
      }
      const scene = new PersistentRenderScene();
      const lease = createRenderReadLease(world);
      const assets = new assetsRuntime.AssetRegistry({
        findMaterialArtifact: () => ({ ok: false, error: new Error('not registered') }),
      } as unknown as ShaderRegistry);
      const owner = { cameraOwner: 0, resourceOwner: 0 };
      const build = (request: PersistentRenderCandidateRequest) =>
        extractFrames(
          [world],
          owner,
          assets,
          undefined,
          mode === 'persistent' ? scene.materialSnapshotCacheStore() : undefined,
          { cull: 'none', retainHidden: true, renderables: request },
        );
      const simulationMs: number[] = [];
      const projectionMs: number[] = [];
      let scannedRows = 0;
      let heapPeak = 0;
      let finalCount = 0;
      try {
        for (let frame = 0; frame < contract.warmup + contract.samples; frame++) {
          const start = performance.now();
          const changing = ['dense', 'fragmented'].includes(workload)
            ? count
            : ['sparse', 'scattered', 'small', 'history'].includes(workload)
              ? Math.max(1, count / 64)
              : 0;
          for (let index = 0; index < changing; index++) {
            const entity =
              entities[workload === 'scattered' ? (index * 67 + frame) % count : index];
            if (entity !== undefined)
              world
                .set(entity, Transform, { pos: [Math.sin(frame / 10), index / count, 0] })
                .unwrap();
          }
          if (workload === 'parent')
            world.set(parent, Transform, { pos: [Math.sin(frame / 10), 0, 0] }).unwrap();
          if (workload === 'material') {
            const value = (frame % 10) / 10;
            if (content !== undefined && contentType !== undefined)
              world.set(content, contentType, { value: [value] }).unwrap();
            else {
              values.roughness = value;
              (world.sharedRefs as unknown as { markChanged(handle: number): void }).markChanged(
                handle,
              );
            }
          }
          world.update(1 / 60).unwrap();
          const simulated = performance.now();
          const result =
            mode === 'persistent'
              ? scene.extractComposition([world], owner, 0, build, [lease])
              : build('full');
          const projected = performance.now();
          finalCount = result.renderables.length;
          if (
            workload === 'material' &&
            result.renderables.some(
              (renderable) =>
                Math.abs((renderable.materials[0]?.roughness ?? -1) - (frame % 10) / 10) > 0.000001,
            )
          ) {
            throw new Error('material workload failed semantic equivalence');
          }
          if (frame >= contract.warmup) {
            simulationMs.push(simulated - start);
            projectionMs.push(projected - simulated);
            scannedRows += mode === 'persistent' ? scene.inspect().worldEntitiesScanned : count;
            heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
          }
        }
        if (finalCount !== count) throw new Error(`incomplete workload: ${finalCount}/${count}`);
        const summary = (samples: number[]) => {
          const ordered = [...samples].sort((a, b) => a - b);
          return {
            median: ordered[Math.floor(ordered.length / 2)],
            p95: ordered[Math.floor(ordered.length * 0.95)],
          };
        };
        reports.push({
          workload,
          mode,
          count,
          simulationMs: summary(simulationMs),
          projectionMs: summary(projectionMs),
          totalMs: summary(projectionMs.map((value, index) => value + (simulationMs[index] ?? 0))),
          scannedRowsPerFrame: scannedRows / contract.samples,
          processHeapPeakBytes: heapPeak,
          samples: { simulationMs, projectionMs },
        });
      } finally {
        lease.dispose();
        scene.dispose();
      }
    }
  const result = {
    contract,
    environment: { node: process.version, cpu: cpus()[0]?.model },
    reports,
  };
  const output = process.env.FORGEAX_PROJECTION_BENCH_OUTPUT;
  if (output !== undefined) writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  else console.log(JSON.stringify(result));
}
measureStateProjection();
