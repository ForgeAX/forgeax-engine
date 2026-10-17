function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Missing fixture value');
  return value;
}

import type { BindGroup, Buffer, ComputePipeline, RenderPipeline } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import type { RenderFeaturePlanExecution, RenderFeaturePlanExecutionPass } from '../features/host';
import { sameRenderFeatureNativeExecutionTopology as same } from '../features/native-execution-topology';
import type {
  RenderFeatureComputeTarget,
  RenderFeatureGpuBindingsRef,
  RenderFeatureGpuBufferRef,
  RenderFeatureGpuProgramRef,
  RenderFeatureResolvedGpuComputePass,
} from '../features/prepared-gpu-work';
import type {
  RenderFeatureDrawRecord,
  RenderFeaturePreparedRef,
} from '../features/prepared-graphics';
import { createRenderFeatureTarget } from '../features/targets';
import type { PreparedGraphicsResolvedResource } from '../prepare/prepared-graphics-resolver';
import { SCENE_DATA_TEMPORAL_V1_SCHEMA } from '../temporal/scene-data';
import { createSceneDataCatalog } from '../temporal/scene-data-catalog';

const physical = () => Object.freeze({}) as Buffer;
const reference = <K extends RenderFeaturePreparedRef['kind']>(
  kind: K,
): RenderFeaturePreparedRef<K> => Object.freeze({ kind, generation: 1 });
function pool() {
  return {
    program: Object.freeze({ generation: 1 }) as RenderFeatureGpuProgramRef,
    computeBindings: Object.freeze({ generation: 1 }) as RenderFeatureGpuBindingsRef,
    overrideBindings: Object.freeze({ generation: 1 }) as RenderFeatureGpuBindingsRef,
    indirect: Object.freeze({ name: 'args', generation: 1 }) as RenderFeatureGpuBufferRef,
    pipeline: reference('pipeline'),
    bindings: reference('bindings'),
    vertex: reference('vertex-data'),
    index: reference('index-data'),
    stateBuffer: physical(),
    outputBuffer: physical(),
    argsBuffer: physical(),
    vertexBuffer: physical(),
    indexBuffer: physical(),
    materialBuffer: physical(),
    renderPipeline: Object.freeze({}) as RenderPipeline,
    computePipeline: Object.freeze({}) as ComputePipeline,
    bindGroup: Object.freeze({}) as BindGroup,
  };
}
function execution(
  p: ReturnType<typeof pool>,
  count = 1,
  enabled = true,
): RenderFeaturePlanExecution {
  const color = createRenderFeatureTarget({
    name: 'color',
    kind: 'scene-color',
    format: 'rgba16float',
    sampleCount: 1,
  });
  const depth = createRenderFeatureTarget({
    name: 'depth',
    kind: 'scene-depth',
    format: 'depth32float-stencil8',
    sampleCount: 1,
  });
  const buffer = (buffer: Buffer) => ({ buffer, size: 512, physicalUsage: 255 });
  const resources = new Map<RenderFeaturePreparedRef, PreparedGraphicsResolvedResource>([
    [
      p.pipeline,
      {
        kind: 'pipeline',
        reference: p.pipeline,
        handle: p.renderPipeline,
        standardLighting: true,
        writesDepth: true,
      },
    ],
    [
      p.bindings,
      {
        kind: 'bindings',
        reference: p.bindings,
        handle: p.bindGroup,
        descriptor: { pipeline: p.pipeline, values: { storageBuffers: ['material'] } },
      },
    ],
    [
      p.vertex,
      {
        kind: 'vertex-data',
        reference: p.vertex,
        handle: p.vertexBuffer,
        size: 512,
        physicalUsage: 255,
        byteOffset: 256,
        byteLength: 128,
      },
    ],
    [
      p.index,
      {
        kind: 'index-data',
        reference: p.index,
        handle: p.indexBuffer,
        size: 512,
        physicalUsage: 255,
        byteOffset: 64,
        byteLength: 64,
      },
    ],
  ]);
  const draw = {
    pipeline: p.pipeline,
    bindings: [p.bindings],
    vertexData: [{ slot: 3, resource: p.vertex }],
    enabled,
  };
  return {
    featureIdentity: 'particles',
    scope: 'view:main',
    order: 0,
    placement: 'post',
    passes: [
      {
        featureIdentity: 'particles',
        order: 0,
        name: 'simulate',
        enabled,
        gpuCompute: {
          program: p.program,
          bindings: p.computeBindings,
          dispatches: [
            { entryPoint: 'simulate', bindings: p.overrideBindings, workgroups: [count] },
            { entryPoint: 'sort', indirect: { buffer: p.indirect, offset: 12 } },
          ],
        },
        resolvedGpuCompute: {
          buffers: [
            { name: 'state', ...buffer(p.stateBuffer), access: 'storage-read-write' },
            { name: 'args', ...buffer(p.argsBuffer), access: 'indirect-read' },
          ],
          sampledTargets: [depth],
          storageTargets: [color],
          dispatches: [
            ...(count === 0
              ? []
              : [
                  {
                    pipeline: p.computePipeline,
                    bindGroup: p.bindGroup,
                    workgroups: [count, 1, 1] as const,
                    resolveBindGroup: () => p.bindGroup,
                  },
                ]),
            {
              pipeline: p.computePipeline,
              bindGroup: p.bindGroup,
              indirectBuffer: p.argsBuffer,
              indirectOffset: 12,
            },
          ],
        },
      },
      {
        featureIdentity: 'particles',
        order: 0,
        name: 'copy',
        enabled,
        resolvedGpuCopies: [
          {
            source: buffer(p.stateBuffer),
            destination: buffer(p.outputBuffer),
            sourceOffset: 0,
            destinationOffset: 0,
            size: 16,
            enabled,
          },
          {
            source: buffer(p.stateBuffer),
            destination: buffer(p.outputBuffer),
            sourceOffset: 16,
            destinationOffset: 256,
            size: 16,
            enabled,
          },
        ],
      },
      {
        featureIdentity: 'particles',
        order: 0,
        name: 'draw',
        enabled,
        graphics: {
          attachments: {
            colors: [{ resource: color, format: 'rgba16float', loadOp: 'load', storeOp: 'store' }],
            depthStencil: {
              resource: depth,
              format: 'depth32float-stencil8',
              depthLoadOp: 'load',
              depthStoreOp: 'store',
            },
          },
          sampledTargets: [depth],
          sceneDepth: 'before-pass',
          draws: [
            {
              ...draw,
              kind: 'draw-indexed-indirect',
              indexData: { resource: p.index, format: 'uint16' },
              command: { buffer: p.indirect, offset: 20 },
            },
            {
              ...draw,
              kind: 'draw',
              command: { vertexCount: 3, instanceCount: 2, firstVertex: 0, firstInstance: 1 },
            },
            {
              ...draw,
              kind: 'draw-indexed',
              indexData: { resource: p.index, format: 'uint16' },
              command: {
                indexCount: 6,
                instanceCount: 2,
                firstIndex: 1,
                baseVertex: 0,
                firstInstance: 1,
              },
            },
            { ...draw, kind: 'draw-indirect', command: { buffer: p.indirect, offset: 40 } },
          ],
        },
        graphicsState: {
          capabilityAvailable: true,
          generation: 1,
          attachments: [{ resource: color, format: 'rgba16float' }],
          pipeline: p.pipeline,
          pipelines: [p.pipeline],
          bindings: [p.bindings],
          vertexData: [p.vertex],
          indexData: [p.index],
        },
        resolvedGraphics: {
          generation: 1,
          resolve: (ref) => resources.get(ref),
          resolveGpuBuffer: () => buffer(p.argsBuffer),
          resolveGpuResource: (name) =>
            name === 'material' ? buffer(p.materialBuffer) : undefined,
        },
      },
    ],
  };
}
function pass(
  work: RenderFeaturePlanExecution,
  index: number,
  change: (value: RenderFeaturePlanExecutionPass) => RenderFeaturePlanExecutionPass,
): RenderFeaturePlanExecution {
  return { ...work, passes: work.passes.map((value, i) => (i === index ? change(value) : value)) };
}
function draw(
  work: RenderFeaturePlanExecution,
  index: number,
  change: (value: RenderFeatureDrawRecord) => RenderFeatureDrawRecord,
) {
  return pass(work, 2, (value) => {
    if (!value.graphics) throw Error('Missing graphics');
    return {
      ...value,
      graphics: {
        ...value.graphics,
        draws: value.graphics.draws.map((value, i) => (i === index ? change(value) : value)),
      },
    };
  });
}
function compute(
  work: RenderFeaturePlanExecution,
  change: (value: RenderFeatureResolvedGpuComputePass) => RenderFeatureResolvedGpuComputePass,
) {
  return pass(work, 0, (value) => {
    if (!value.resolvedGpuCompute) throw Error('Missing compute');
    return { ...value, resolvedGpuCompute: change(value.resolvedGpuCompute) };
  });
}
describe('native execution topology', () => {
  it('shares fresh views/snapshot closures while excluding frame enablement and zero/nonzero direct counts', () => {
    const p = pool();
    const before = execution(p);
    const next = execution(p, 0, false);
    expect(required(required(before.passes[0]).resolvedGpuCompute).dispatches).toHaveLength(2);
    expect(required(required(next.passes[0]).resolvedGpuCompute).dispatches).toHaveLength(1);
    expect(same(before, execution(p))).toBe(true);
    expect(same(before, next)).toBe(true);
    expect(same(next, before)).toBe(true);
    expect(same(before, execution({ ...p, bindGroup: Object.freeze({}) as BindGroup }))).toBe(true);
  });
  it('retains feature, scope, placement, logical pass identity, kind and order', () => {
    const before = execution(pool());
    for (const next of [
      { ...before, featureIdentity: 'foreign' },
      { ...before, scope: 'view:other' },
      { ...before, order: 1 },
      { ...before, placement: 'scene' as const },
      { ...before, passes: [...before.passes].reverse() },
      { ...before, passes: before.passes.slice(1) },
      pass(before, 0, (p) => ({ ...p, name: 'replacement' })),
      pass(before, 0, (p) => ({ ...p, featureIdentity: 'foreign' })),
      pass(before, 0, (p) => ({ ...p, order: 1 })),
      pass(before, 2, (p) => ({ ...p, shadowCaster: true })),
      pass(before, 1, (p) => {
        const { resolvedGpuCopies: _copies, ...withoutCopies } = p;
        return withoutCopies;
      }),
    ])
      expect(same(before, next)).toBe(false);
  });
  it('rejects same-count compute program, binding, entry, override and indirect replacement', () => {
    const p = pool();
    const before = execution(p);
    const original = required(required(before.passes[0]).gpuCompute);
    const changed = [
      { ...original, program: pool().program },
      { ...original, bindings: pool().computeBindings },
      { ...original, dispatches: [...original.dispatches].reverse() },
      ...original.dispatches.map((_, index) => ({
        ...original,
        dispatches: original.dispatches.map((d, i) =>
          i === index ? { ...d, entryPoint: 'replacement' } : d,
        ),
      })),
      {
        ...original,
        dispatches: original.dispatches.map((d, i) =>
          i === 0 ? { ...d, bindings: pool().overrideBindings } : d,
        ),
      },
      {
        ...original,
        dispatches: original.dispatches.map((d, i) =>
          i === 1 && d.indirect !== undefined
            ? { ...d, indirect: { buffer: p.indirect, offset: 16 } }
            : d,
        ),
      },
      {
        ...original,
        dispatches: original.dispatches.map((d, i) =>
          i === 1 && d.indirect !== undefined
            ? { ...d, indirect: { buffer: pool().indirect, offset: 12 } }
            : d,
        ),
      },
    ];
    for (const gpuCompute of changed)
      expect(
        same(
          before,
          pass(before, 0, (p) => ({ ...p, gpuCompute })),
        ),
      ).toBe(false);
  });
  it('compares complete physical compute dependencies and target roles', () => {
    const p = pool();
    const before = execution(p);
    for (const change of [
      (r: RenderFeatureResolvedGpuComputePass) => ({
        ...r,
        buffers: r.buffers.map((b, i) => (i === 0 ? { ...b, buffer: p.argsBuffer } : b)),
      }),
      (r: RenderFeatureResolvedGpuComputePass) => ({
        ...r,
        buffers: r.buffers.map((b) => ({ ...b, access: 'storage-read' as const })),
      }),
      (r: RenderFeatureResolvedGpuComputePass) => ({
        ...r,
        buffers: r.buffers.map((b) => ({ ...b, size: 256 })),
      }),
      (r: RenderFeatureResolvedGpuComputePass) => ({
        ...r,
        buffers: r.buffers.map((b) => ({ ...b, physicalUsage: 1 })),
      }),
      (r: RenderFeatureResolvedGpuComputePass) => ({
        ...r,
        sampledTargets: r.storageTargets ?? [],
        storageTargets: r.sampledTargets ?? [],
      }),
      (r: RenderFeatureResolvedGpuComputePass) => ({
        ...r,
        sampledTargets: [
          createRenderFeatureTarget({
            name: 'other',
            kind: 'scene-depth',
            format: 'depth32float-stencil8',
            sampleCount: 1,
          }),
        ],
      }),
    ])
      expect(same(before, compute(before, change))).toBe(false);
  });
  it('retains every ordered copy command and its actual physical alias/range facts', () => {
    const before = execution(pool());
    const copies = required(required(before.passes[1]).resolvedGpuCopies);
    const variants = [
      [...copies].reverse(),
      copies.slice(0, 1),
      ...(['sourceOffset', 'destinationOffset', 'size'] as const).map((key) =>
        copies.map((c, i) => (i === 0 ? { ...c, [key]: c[key] + 4 } : c)),
      ),
      copies.map((c, i) => (i === 0 ? { ...c, destination: c.source } : c)),
      copies.map((c, i) => (i === 0 ? { ...c, source: { ...c.source, buffer: physical() } } : c)),
    ];
    for (const resolvedGpuCopies of variants)
      expect(
        same(
          before,
          pass(before, 1, (p) => ({ ...p, resolvedGpuCopies })),
        ),
      ).toBe(false);
  });
  it('keeps ordered draw refs, slots, index format and indirect offsets in topology', () => {
    const p = pool();
    const before = execution(p);
    const replacements: ((d: RenderFeatureDrawRecord) => RenderFeatureDrawRecord)[] = [
      (d) => ({ ...d, pipeline: pool().pipeline }),
      (d) => ({ ...d, bindings: [pool().bindings] }),
      (d) => ({ ...d, vertexData: [{ slot: 4, resource: p.vertex }] }),
      (d) => ({ ...d, vertexData: [{ slot: 3, resource: pool().vertex }] }),
      (d) => ({ ...d, indexData: { resource: pool().index, format: 'uint16' } }),
      (d) => ({ ...d, indexData: { resource: p.index, format: 'uint32' } }),
      (d) => {
        if (d.kind !== 'draw-indexed-indirect') throw Error('Missing indirect');
        return { ...d, command: { ...d.command, offset: 24 } };
      },
    ];
    for (const replacement of replacements)
      expect(same(before, draw(before, 0, replacement))).toBe(false);
    const graphics = required(required(before.passes[2]).graphics);
    expect(
      same(
        before,
        pass(before, 2, (p) => ({
          ...p,
          graphics: { ...graphics, draws: [...graphics.draws].reverse() },
        })),
      ),
    ).toBe(false);
    for (const key of ['vertexCount', 'instanceCount', 'firstVertex', 'firstInstance'] as const)
      expect(
        same(
          before,
          draw(before, 1, (d) => {
            if (d.kind !== 'draw') throw Error('Missing draw');
            return { ...d, command: { ...d.command, [key]: (d.command[key] ?? 0) + 1 } };
          }),
        ),
      ).toBe(false);
    for (const key of [
      'indexCount',
      'instanceCount',
      'firstIndex',
      'baseVertex',
      'firstInstance',
    ] as const)
      expect(
        same(
          before,
          draw(before, 2, (d) => {
            if (d.kind !== 'draw-indexed') throw Error('Missing indexed');
            return { ...d, command: { ...d.command, [key]: (d.command[key] ?? 0) + 1 } };
          }),
        ),
      ).toBe(false);
  });
  it('retains attachment aliases, formats, multisampling, load/store and sampled roles', () => {
    const before = execution(pool());
    const graphics = required(required(before.passes[2]).graphics);
    const color = required(graphics.attachments.colors[0]);
    for (const resource of [
      createRenderFeatureTarget({
        name: 'other',
        kind: 'scene-color',
        format: 'rgba16float',
        sampleCount: 1,
      }),
      createRenderFeatureTarget({
        name: 'color',
        kind: 'scene-color',
        format: 'rgba8unorm',
        sampleCount: 1,
      }),
      createRenderFeatureTarget({
        name: 'color',
        kind: 'scene-color',
        format: 'rgba16float',
        sampleCount: 4,
      }),
    ])
      expect(
        same(
          before,
          pass(before, 2, (p) => ({
            ...p,
            graphics: {
              ...graphics,
              attachments: { ...graphics.attachments, colors: [{ ...color, resource }] },
            },
          })),
        ),
      ).toBe(false);
    for (const changed of [
      { ...color, format: 'rgba8unorm' as const },
      { ...color, loadOp: 'clear' as const },
      { ...color, storeOp: 'discard' as const },
    ])
      expect(
        same(
          before,
          pass(before, 2, (p) => ({
            ...p,
            graphics: { ...graphics, attachments: { ...graphics.attachments, colors: [changed] } },
          })),
        ),
      ).toBe(false);
    expect(
      same(
        before,
        pass(before, 2, (p) => {
          const { sceneDepth: _sceneDepth, ...withoutSceneDepth } = graphics;
          return { ...p, graphics: withoutSceneDepth };
        }),
      ),
    ).toBe(false);
  });
  it('detects resolved physical graphics replacement, byte ranges and material storage aliases', () => {
    const p = pool();
    const before = execution(p);
    for (const next of [
      execution({ ...p, vertexBuffer: physical() }),
      execution({ ...p, indexBuffer: p.vertexBuffer }),
      execution({ ...p, argsBuffer: physical() }),
      execution({ ...p, materialBuffer: p.stateBuffer }),
      execution({ ...p, renderPipeline: Object.freeze({}) as RenderPipeline }),
    ])
      expect(same(before, next)).toBe(false);
    const resolved = required(required(before.passes[2]).resolvedGraphics);
    for (const [reference, property] of [
      [p.vertex, 'byteOffset'],
      [p.index, 'byteLength'],
    ] as const) {
      const replacement = {
        ...resolved,
        resolve: (ref: RenderFeaturePreparedRef) => {
          const item = resolved.resolve(ref);
          return ref === reference &&
            item &&
            (item.kind === 'vertex-data' || item.kind === 'index-data')
            ? { ...item, [property]: 32 }
            : item;
        },
      };
      expect(
        same(
          before,
          pass(before, 2, (p) => ({ ...p, resolvedGraphics: replacement })),
        ),
      ).toBe(false);
    }
    expect(
      same(
        before,
        pass(before, 2, (p) => ({ ...p, resolvedGraphics: { ...resolved, generation: 2 } })),
      ),
    ).toBe(false);
  });
  it('compares scene-data catalog authority rather than fresh token closures or visual shape', () => {
    const p = pool();
    const target = (
      planIdentity = 'particles:main:1',
      generation = 1,
      featureIdentity = 'particles',
    ) =>
      createSceneDataCatalog({
        featureIdentity,
        planIdentity,
        generation,
        rgba16floatRenderable: true,
        producerPresent: true,
        coverageComplete: true,
      }).require(SCENE_DATA_TEMPORAL_V1_SCHEMA);
    const withTarget = (sampled: RenderFeatureComputeTarget) =>
      compute(execution(p), (r) => ({ ...r, sampledTargets: [sampled] }));
    const first = target();
    expect(first).not.toBe(target());
    expect(same(withTarget(first), withTarget(target()))).toBe(true);
    for (const next of [
      target('other'),
      target(undefined, 2),
      target(undefined, undefined, 'foreign'),
      { ...first },
    ])
      expect(same(withTarget(first), withTarget(next))).toBe(false);
  });
});
