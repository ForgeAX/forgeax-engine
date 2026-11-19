import { RenderGraphBuilder, type RenderGraphFrame } from '@forgeax/engine-render-graph';
import { rhi } from '@forgeax/engine-rhi-null';
import { assert, describe, expect, it } from 'vitest';
import {
  createRenderFeatureGraphTextureTargets,
  graphTextureTargetResolver,
} from '../graph-texture-targets';
import {
  canonicalSharedGraphTextures,
  importSharedGraphTextures,
  type SharedGraphTextureExport,
  type SharedGraphTexturePublication,
  sharedGraphTextureTopology,
} from '../shared-graph-textures';
import { createRenderFeatureGraphTextureTarget } from '../targets';

describe('recording-owned shared texture imports', () => {
  it('resolves repeated aliases of one view while rejecting a second physical producer', () => {
    const state = createRenderFeatureGraphTextureTargets();
    const builder = new RenderGraphBuilder();
    const texture = builder
      .createTexture('info', { format: 'rgba16float', size: { width: 8, height: 8 } })
      .unwrap();
    const view = builder.view(texture).unwrap();
    const descriptor = {
      format: 'rgba16float' as const,
      size: { width: 8, height: 8, depthOrArrayLayers: 1 },
    };
    const alias = () =>
      createRenderFeatureGraphTextureTarget({
        kind: 'graph-texture',
        name: 'info',
        producerIdentity: 'water-info-producer',
        format: 'rgba16float',
        sampleCount: 1,
        allocationKey: 'info',
        descriptor,
      });
    const resolved = { texture, view, label: 'info', scope: 'view:camera:265' };
    state.targets.set(alias(), resolved);
    state.targets.set(alias(), resolved);
    const reference = {
      kind: 'feature-texture' as const,
      featureIdentity: 'water-info-producer',
      name: 'info',
      viewIdentity: 'camera:265',
      format: 'rgba16float' as const,
      sampleCount: 1 as const,
    };
    const resolve = graphTextureTargetResolver(state, () => undefined);
    expect(resolve(reference)).toBe(resolved);
    expect(resolve({ ...reference, viewIdentity: 'camera:other' })).toBeUndefined();
    const other = builder.createTexture('other', descriptor).unwrap();
    state.targets.set(alias(), { ...resolved, texture: other, view: builder.view(other).unwrap() });
    expect(resolve(reference)).toBeUndefined();
  });
  it('resolves each recording physical allocation and rejects missing or incompatible exports', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const produce = (width = 16) => {
      const builder = new RenderGraphBuilder();
      const descriptor = {
        format: 'rgba16float' as const,
        size: { width, height: 16, depthOrArrayLayers: 1 },
        usage: 0x14,
      };
      const texture = builder.createTexture('shared-output', descriptor).unwrap();
      const view = builder.view(texture).unwrap();
      builder
        .addRasterPass('shared-write', {
          accesses: [{ resource: view, usage: 'color-attachment' }],
          colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
          encode() {},
        })
        .unwrap();
      const graph = builder.compile({ device, surfaceSize: { width, height: 16 } }).unwrap();
      const textures = [
        {
          name: 'output',
          label: 'shared-output',
          scope: 'frame',
          descriptor,
          view: { dimension: '2d' },
          target: createRenderFeatureGraphTextureTarget({
            kind: 'graph-texture',
            name: 'output',
            format: 'rgba16float',
            sampleCount: 1,
            allocationKey: 'output',
            allocationScope: 'producer:frame',
            producerIdentity: 'producer',
            materialSource: true,
            descriptor,
            view: { dimension: '2d' },
          }),
        },
      ] satisfies [SharedGraphTextureExport];
      return {
        graph,
        textures,
        passes: new Set(),
        topologyKey: sharedGraphTextureTopology(textures),
      } satisfies SharedGraphTexturePublication;
    };
    const first = produce();
    const second = produce();
    const changed = produce(32);
    interface Frame extends RenderGraphFrame {
      readonly shared?: SharedGraphTexturePublication | undefined;
    }
    const builder = new RenderGraphBuilder<Frame>();
    const targets = createRenderFeatureGraphTextureTargets();
    const imported = importSharedGraphTextures(
      builder,
      first,
      targets,
      (frame) => frame.shared,
    ).get('frame:output');
    assert(imported);
    const output = builder
      .createTexture('consumer-output', { format: 'rgba16float', size: 'surface' })
      .unwrap();
    const outputView = builder.view(output).unwrap();
    builder
      .addRasterPass('consume-shared', {
        accesses: [
          { resource: imported.view, usage: 'sampled-read' },
          { resource: outputView, usage: 'color-attachment' },
        ],
        colorAttachments: [
          { view: outputView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
        ],
        encode() {},
      })
      .unwrap();
    const consumer = builder.compile({ device, surfaceSize: { width: 16, height: 16 } }).unwrap();
    const execute = (shared: SharedGraphTexturePublication | undefined) =>
      consumer.execute({
        encoder: device.createCommandEncoder().unwrap(),
        shared,
      });
    const physical = (graph: typeof consumer, label: string) =>
      graph.inspect().resources.find((resource) => resource.label === label)?.physicalAllocationKey;
    try {
      execute(first).unwrap();
      const held = consumer.inspect();
      expect(physical(consumer, 'shared:shared-output')).toBe(
        physical(first.graph, 'shared-output'),
      );
      execute(second).unwrap();
      expect(
        graphTextureTargetResolver(targets, () => undefined)(second.textures[0].target),
      ).toMatchObject({ view: imported.view });
      expect(physical(consumer, 'shared:shared-output')).toBe(
        physical(second.graph, 'shared-output'),
      );
      expect(physical(consumer, 'shared:shared-output')).not.toBe(
        physical(first.graph, 'shared-output'),
      );
      expect(
        held.resources.find((resource) => resource.label === 'shared:shared-output')
          ?.physicalAllocationKey,
      ).toBe(physical(first.graph, 'shared-output'));
      expect(execute(undefined).ok).toBe(false);
      expect(execute(changed).ok).toBe(false);
      for (const textures of [
        [],
        first.textures.map((entry) => ({ ...entry, scope: 'view:other' })),
        first.textures.map((entry) => ({ ...entry, view: { dimension: '2d-array' as const } })),
        first.textures.map((entry) => ({
          ...entry,
          descriptor: { ...entry.descriptor, format: 'rgba32float' as const },
        })),
        first.textures.map((entry) => ({
          ...entry,
          descriptor: { ...entry.descriptor, sampleCount: 4 as const },
        })),
      ])
        expect(
          execute({ ...first, textures, topologyKey: sharedGraphTextureTopology(textures) }).ok,
        ).toBe(false);
      execute(first).unwrap();
      expect(canonicalSharedGraphTextures([...first.textures, ...first.textures])).toHaveLength(1);
      expect(() => canonicalSharedGraphTextures([...first.textures, ...changed.textures])).toThrow(
        'ambiguous',
      );
      const original = first.textures[0];
      const alias = {
        ...original,
        name: 'alias',
        target: createRenderFeatureGraphTextureTarget({
          ...original.target,
          kind: 'graph-texture',
          name: 'alias',
          allocationKey: 'output',
          descriptor: original.descriptor,
          view: { dimension: '2d-array', arrayLayerCount: 1 },
        }),
        view: { dimension: '2d-array' as const, arrayLayerCount: 1 },
      };
      const importAliases = (entry: typeof alias) =>
        importSharedGraphTextures(
          new RenderGraphBuilder(),
          { ...first, textures: [original, entry] },
          createRenderFeatureGraphTextureTargets(),
        );
      expect(() => importAliases(alias)).not.toThrow();
      const incompatible = {
        ...alias,
        descriptor: changed.textures[0].descriptor,
        target: createRenderFeatureGraphTextureTarget({
          ...alias.target,
          kind: 'graph-texture',
          name: 'alias',
          allocationKey: 'output',
          descriptor: changed.textures[0].descriptor,
        }),
      };
      expect(() => importAliases(incompatible)).toThrow('immutable graph texture descriptor');
    } finally {
      for (const graph of [consumer, first.graph, second.graph, changed.graph])
        (await graph.retire()).unwrap();
    }
  });
});
