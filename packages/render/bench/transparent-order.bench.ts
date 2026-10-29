/**
 * Retained transparent DISTANCE order under camera motion, driven through
 * `DirectDrawPhase.sync` on the CPU (no GPU). One bench op is one frame sync.
 * The body is identical on base and PR; both sides expose the same
 * `DirectDrawPhase` constructor, `sync` and `work` counters.
 *
 * Cases: steady, camera moving along one axis (never crossing a row),
 * camera orbiting on a multi-axis path through the rows, and a static camera
 * with 10% of the rows moving each frame.
 */
import { mat4 } from '@forgeax/engine-math';
import { assert, bench, describe } from 'vitest';
import { receiptRow } from '../src/__tests__/gpu-draw-selection-fixture';
import type { MeshGpuHandles } from '../src/device/gpu-residency';
import { BatchTopology, type GpuDrivenBatchBinding } from '../src/gpu-driven/batch-topology';
import { MaterialResource } from '../src/material-resource';
import type { RenderResourceScope } from '../src/publication/resource-scope';
import { type DirectDrawInput, DirectDrawPhase } from '../src/record/direct-draw-phase';
import type { CameraSnapshot } from '../src/render-contract';
import type { MaterialSnapshot, RenderableSnapshot } from '../src/render-system-extract';
import type { DrawEvidence } from '../src/scene/draw-evidence';
import { FrameSet } from '../src/scene/frame-set';
import { MaterialDispatch } from '../src/scene/material-dispatch';
import type { ProbeBlendBufferProjection } from '../src/scene/probe-blend';
import { RenderScene } from '../src/scene/render-scene';
import { TRANSPARENT_SORT_MODE_DISTANCE } from '../src/systems/transparent-sort-config';

const blend = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
} as const;

function material(handle: number, transparent: boolean): MaterialResource {
  return new MaterialResource({
    ...receiptRow().source.material.snapshot,
    materialHandle: handle,
    transparent,
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-standard-pbr' },
        renderState: transparent
          ? { tags: { LightMode: 'Forward' }, queue: 3000, blend }
          : { tags: { LightMode: 'Forward' } },
      },
    ],
  });
}

const opaque = material(1, false);
const glass = material(3, true);
const probe = {
  sourceIdentity: {},
  revision: 0,
  baseRevision: 0,
  capacity: 1,
  records: [],
  dirtyRecords: [],
  removedCacheKeys: [],
} as unknown as ProbeBlendBufferProjection;
const mesh = {
  submeshes: Array.from({ length: 3 }, () => ({ materialSlot: 0 })),
} as unknown as MeshGpuHandles;
const worlds = [{ identity: 'binned-world' }] as unknown as RenderResourceScope[];

function source(entityKey: number, resource: MaterialResource, z = entityKey): RenderableSnapshot {
  const base = receiptRow().source;
  const world = mat4.identity(mat4.create());
  world[14] = z;
  return {
    ...base,
    entityKey,
    material: resource,
    materials: [resource],
    transform: { world },
    gpuDrivenDraws: base.gpuDrivenDraws?.slice(0, 1) ?? [],
  };
}

function eye(z: number): CameraSnapshot {
  return { position: new Float32Array([0, 0, z]) } as unknown as CameraSnapshot;
}

/** A Scene with `opaqueCount` opaque and `glassCount` blended rows, all CPU-drawn. */
function fixture(opaqueCount: number, glassCount: number) {
  const scene = new RenderScene();
  const topology = new BatchTopology();
  const dispatch = new MaterialDispatch();
  const write = (sources: readonly RenderableSnapshot[]) => {
    topology.apply(
      scene.apply(
        sources.map((snapshot) => ({
          kind: 'update' as const,
          worldId: 0,
          entityKey: snapshot.entityKey,
          snapshot,
        })),
      ),
    );
    for (const snapshot of sources) {
      const record = scene.slot(0, snapshot.entityKey);
      assert(record);
      dispatch.bind(record.slot, record.snapshot);
    }
  };
  write([
    ...Array.from({ length: opaqueCount }, (_, index) => source(index, opaque)),
    ...Array.from({ length: glassCount }, (_, index) => source(opaqueCount + index, glass)),
  ]);
  const meshes = new Map<GpuDrivenBatchBinding, MeshGpuHandles>();
  const input = (camera = eye(0)): DirectDrawInput => {
    const plan = topology.sourcePlan();
    for (const batch of plan.batches) if (batch.binding) meshes.set(batch.binding, mesh);
    const materials = dispatch.materials();
    const draws: DrawEvidence = {
      slots: scene.slotsSnapshot(),
      meshes: scene.meshFrame(),
      unavailable: new FrameSet(),
      probe,
      temporal: undefined,
    };
    return {
      scene: {
        plan,
        slotAt: scene.slotAt,
        drawSnapshotAt: scene.drawSnapshotAt,
        unbatchedSlots: topology.unbatchedSlots,
        draws,
      },
      selection: [],
      select: (binding): MaterialSnapshot | undefined => materials.get(binding.material)?.snapshot,
      meshes,
      worlds,
      shadow: false,
      materials,
      prepareUnbatched: () => [],
      viewDraws: [],
      lod: (rows) => rows,
      entries: { selector: undefined },
      sort: { mode: TRANSPARENT_SORT_MODE_DISTANCE, yzAlpha: 1, camera, all: false },
    };
  };
  return { scene, dispatch, write, input };
}

const OPAQUE = 200;
const SIZES = [2_000, 10_000] as const;
const AXIS_START = -100_000;
const AXIS_WRAP = 50_000;

type Frame = (k: number) => DirectDrawInput;

interface Case {
  readonly name: string;
  readonly make: (glassCount: number) => { phase: DirectDrawPhase; frame: Frame };
}

function orbit(k: number, glassCount: number): CameraSnapshot {
  const angle = k * 0.002;
  return {
    position: new Float32Array([
      Math.cos(angle) * 5_000,
      Math.sin(angle) * 3_000,
      glassCount / 2 + Math.sin(angle * 0.7) * 800,
    ]),
  } as unknown as CameraSnapshot;
}

const CASES: readonly Case[] = [
  {
    name: 'steady',
    make: (n) => {
      const f = fixture(OPAQUE, n);
      const camera = eye(-100);
      return { phase: new DirectDrawPhase(), frame: () => f.input(camera) };
    },
  },
  {
    name: 'camera one-axis',
    make: (n) => {
      const f = fixture(OPAQUE, n);
      return {
        phase: new DirectDrawPhase(),
        frame: (k) => f.input(eye(AXIS_START + (k % AXIS_WRAP))),
      };
    },
  },
  {
    name: 'camera multi-axis orbit',
    make: (n) => {
      const f = fixture(OPAQUE, n);
      return { phase: new DirectDrawPhase(), frame: (k) => f.input(orbit(k, n)) };
    },
  },
  {
    name: 'change-heavy 10% rows, static camera',
    make: (n) => {
      const f = fixture(OPAQUE, n);
      const camera = eye(-100);
      // Ten row groups, each alternating between two z layouts so every move reorders.
      const groups = Array.from({ length: 10 }, (_, g) => {
        const rows = Array.from({ length: n / 10 }, (_, i) => OPAQUE + g * (n / 10) + i);
        return [0, 1].map((variant) =>
          rows.map((entity) => source(entity, glass, variant ? (entity * 7919) % n : entity)),
        );
      });
      const phase = new DirectDrawPhase();
      phase.sync(f.input(camera));
      return {
        phase,
        frame: (k) => {
          f.write(groups[k % 10]?.[Math.floor(k / 10) % 2] ?? []);
          return f.input(camera);
        },
      };
    },
  },
];

const OPTIONS = { time: 1_500, warmupTime: 400, warmupIterations: 5 } as const;

for (const count of SIZES) {
  describe(`transparent order N=${count}`, () => {
    for (const { name, make } of CASES) {
      const { phase, frame } = make(count);
      let k = 0;
      phase.sync(frame(k++));
      phase.sync(frame(k++));
      bench(
        name,
        () => {
          phase.sync(frame(k++));
        },
        OPTIONS,
      );
    }
  });
}

// Per-frame phase work (mean over 30 frames after two warm syncs), printed once.
if (process.env.BENCH_WORK) {
  for (const count of SIZES) {
    for (const { name, make } of CASES) {
      const { phase, frame } = make(count);
      let k = 0;
      phase.sync(frame(k++));
      phase.sync(frame(k++));
      const before: Record<string, number> = { ...phase.work };
      const frames = 30;
      for (let i = 0; i < frames; i++) phase.sync(frame(k++));
      const perFrame: Record<string, number> = {};
      for (const [key, value] of Object.entries(phase.work)) {
        perFrame[key] = (value - (before[key] ?? 0)) / frames;
      }
      process.stdout.write(`WORK N=${count} ${name} ${JSON.stringify(perFrame)}\n`);
    }
  }
}
