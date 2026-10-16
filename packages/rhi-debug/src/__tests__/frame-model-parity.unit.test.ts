import { describe, expect, it } from 'vitest';
import { buildFrameModel } from '../frame-model';
import { summarizeFrame } from '../frame-summary';
import type { Tape } from '../protocol/types';

function makeTape(): Tape {
  return {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: 15, blobCount: 0 },
    bootstrap: [
      {
        handleId: 'buffer-1',
        kind: 'buffer',
        create: { kind: 'createBuffer', handleId: 'buffer-1', desc: { size: 64, usage: 4 } },
        initialData: [],
      },
      {
        handleId: 'shader:1',
        kind: 'shader-module',
        create: {
          kind: 'createShaderModule',
          handleId: 'shader:1',
          wgslCode: '@vertex fn vs_main() -> @builtin(position) vec4f { return vec4f(0.0); }',
        },
        initialData: [],
      },
    ],
    events: [
      {
        kind: 'beginRenderPass',
        passHandleId: 'pass:render',
        cmdHandleId: 'encoder:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      { kind: 'pushDebugGroup', cmdHandleId: 'encoder:1', groupLabel: 'render group' },
      { kind: 'passPushDebugGroup', passHandleId: 'pass:render', groupLabel: 'nested group' },
      { kind: 'insertDebugMarker', cmdHandleId: 'encoder:1', markerLabel: 'before draws' },
      {
        kind: 'draw',
        passHandleId: 'pass:render',
        vertexCount: 3,
        instanceCount: 1,
        firstVertex: 0,
        firstInstance: 0,
      },
      {
        kind: 'drawIndexed',
        passHandleId: 'pass:render',
        indexCount: 3,
        instanceCount: 1,
        firstIndex: 0,
        baseVertex: 0,
        firstInstance: 0,
      },
      {
        kind: 'drawIndirect',
        passHandleId: 'pass:render',
        indirectBufferHandleId: 'buffer-1',
        indirectOffset: 0,
      },
      {
        kind: 'drawIndexedIndirect',
        passHandleId: 'pass:render',
        indirectBufferHandleId: 'buffer-1',
        indirectOffset: 16,
      },
      { kind: 'passPopDebugGroup', passHandleId: 'pass:render' },
      { kind: 'popDebugGroup', cmdHandleId: 'encoder:1' },
      { kind: 'endRenderPass', passHandleId: 'pass:render' },
      {
        kind: 'beginComputePass',
        passHandleId: 'pass:compute',
        cmdHandleId: 'encoder:1',
        desc: {},
      },
      { kind: 'dispatchWorkgroups', passHandleId: 'pass:compute', x: 2, y: 3, z: 1 },
      {
        kind: 'dispatchWorkgroupsIndirect',
        passHandleId: 'pass:compute',
        indirectBufferHandleId: 'buffer-1',
        indirectOffset: 32,
      },
      { kind: 'endComputePass', passHandleId: 'pass:compute' },
    ],
    blobs: [],
  };
}

describe('FrameModel canonical projection', () => {
  it('exposes one JSON-safe projection with six globally indexed work kinds', () => {
    const model = buildFrameModel(makeTape());
    const roundTrip = JSON.parse(JSON.stringify(model)) as typeof model;

    expect(roundTrip).toEqual(model);
    expect(Object.keys(model)).toEqual([
      'unseededResources',
      'commands',
      'passes',
      'resources',
      'resourceLifecycle',
      'works',
    ]);
    expect(
      model.works.map((work) => [work.workIndex, work.eventIndex, work.passIndex, work.kind]),
    ).toEqual([
      [0, 4, 0, 'draw'],
      [1, 5, 0, 'drawIndexed'],
      [2, 6, 0, 'drawIndirect'],
      [3, 7, 0, 'drawIndexedIndirect'],
      [4, 12, 1, 'dispatchWorkgroups'],
      [5, 13, 1, 'dispatchWorkgroupsIndirect'],
    ]);
    expect(model.commands[1]).toMatchObject({
      eventIndex: 1,
      passIndex: 0,
      group: ['render group'],
    });
    expect(model.commands[3]).toMatchObject({ eventIndex: 3, marker: 'before draws' });
    expect(model.passes.map((pass) => pass.workIndices)).toEqual([
      [0, 1, 2, 3],
      [4, 5],
    ]);
    expect(model.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceId: 'buffer-1', kind: 'buffer' }),
        expect.objectContaining({ resourceId: 'shader:1', kind: 'shader-module' }),
      ]),
    );
    expect(model.works.every((work) => work.eventIndex >= 0 && work.passIndex >= 0)).toBe(true);
  });

  it('reports absent bootstrap bytes without claiming frame writes are initial snapshots', () => {
    const tape = makeTape();
    const model = buildFrameModel(tape);
    expect(model.unseededResources).toEqual([
      { resourceId: 'buffer-1', kind: 'buffer', format: null, sampleCount: 1, omitted: false },
    ]);
    const seeded = buildFrameModel({
      ...tape,
      bootstrap: tape.bootstrap.map((resource) =>
        resource.handleId === 'buffer-1'
          ? { ...resource, initialData: [{ hash: 'seed', byteOffset: 0, byteLength: 64 }] }
          : resource,
      ),
    });
    expect(seeded.unseededResources).toEqual([]);
    const summary = summarizeFrame(model);
    expect(summary.works.map((work) => work.workIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(summary.unseededResources).toEqual(model.unseededResources);
    expect(JSON.stringify(summary)).not.toContain('@vertex');
    expect(summary.works[0]?.group).toEqual(['render group', 'nested group']);
  });

  it('fails closed instead of exposing empty legacy projections or Map values', () => {
    const model = buildFrameModel(makeTape()) as unknown as Record<string, unknown>;
    for (const field of ['tree', 'draws', 'meta']) {
      expect(model, `legacy field ${field} must be absent`).not.toHaveProperty(field);
    }
    expect(model).not.toHaveProperty('totalDraws');
    expect(model.resources).toBeInstanceOf(Array);
    expect(JSON.stringify(model)).not.toContain('ReadonlyMap');
  });

  it('resolves pipeline, shader, and bind-group facts from the bootstrap closure', () => {
    const tape: Tape = {
      header: { formatVersion: 7, rhiCaps: {}, eventCount: 5, blobCount: 0 },
      bootstrap: [
        {
          handleId: 'texture:sample',
          kind: 'texture',
          create: {
            kind: 'createTexture',
            handleId: 'texture:sample',
            desc: { size: [2, 2, 1], format: 'rgba8unorm', usage: 4 },
          },
          initialData: [],
        },
        {
          handleId: 'view:sample',
          kind: 'texture-view',
          create: {
            kind: 'createTextureView',
            sourceHandleId: 'texture:sample',
            resultHandleId: 'view:sample',
            desc: {},
          },
          initialData: [],
        },
        {
          handleId: 'shader:vertex',
          kind: 'shader-module',
          create: {
            kind: 'createShaderModule',
            handleId: 'shader:vertex',
            wgslCode: '@vertex fn main() -> @builtin(position) vec4f { return vec4f(); }',
          },
          initialData: [],
        },
        {
          handleId: 'shader:fragment',
          kind: 'shader-module',
          create: {
            kind: 'createShaderModule',
            handleId: 'shader:fragment',
            wgslCode: '@fragment fn main() -> @location(0) vec4f { return vec4f(1.0); }',
          },
          initialData: [],
        },
        {
          handleId: 'bgl:main',
          kind: 'binding',
          create: {
            kind: 'createBindGroupLayout',
            handleId: 'bgl:main',
            desc: { entries: [] },
          },
          initialData: [],
        },
        {
          handleId: 'bindGroup:main',
          kind: 'binding',
          create: {
            kind: 'createBindGroup',
            handleId: 'bindGroup:main',
            layoutHandleId: 'bgl:main',
            entries: [{ binding: 3, resourceKind: 'textureView' }],
            resourceHandleIds: ['view:sample'],
          },
          initialData: [],
        },
        {
          handleId: 'pipelineLayout:main',
          kind: 'binding',
          create: {
            kind: 'createPipelineLayout',
            handleId: 'pipelineLayout:main',
            bglHandleIds: ['bgl:main'],
          },
          initialData: [],
        },
        {
          handleId: 'pipeline:main',
          kind: 'pipeline',
          create: {
            kind: 'createRenderPipeline',
            handleId: 'pipeline:main',
            desc: {
              vertex: { entryPoint: 'main', buffers: [] },
              fragment: { entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] },
            },
            layoutHandleId: 'pipelineLayout:main',
            vertexShaderModuleHandleId: 'shader:vertex',
            fragmentShaderModuleHandleId: 'shader:fragment',
          },
          initialData: [],
        },
      ],
      events: [
        {
          kind: 'beginRenderPass',
          passHandleId: 'pass:render',
          cmdHandleId: 'encoder:1',
          desc: { colorAttachments: [] },
          colorAttachmentViewHandleIds: ['view:sample'],
        },
        {
          kind: 'setPipeline',
          passHandleId: 'pass:render',
          pipelineHandleId: 'pipeline:main',
        },
        {
          kind: 'setBindGroup',
          passHandleId: 'pass:render',
          index: 0,
          bindGroupHandleId: 'bindGroup:main',
        },
        {
          kind: 'draw',
          passHandleId: 'pass:render',
          vertexCount: 3,
          instanceCount: 1,
          firstVertex: 0,
          firstInstance: 0,
        },
        { kind: 'endRenderPass', passHandleId: 'pass:render' },
      ],
      blobs: [],
    };

    const work = buildFrameModel(tape).works[0];
    expect(work?.pipeline).toMatchObject({
      status: 'available',
      pipelineHandleId: 'pipeline:main',
    });
    expect(work?.pipeline.shaders.map((shader) => shader.moduleHandleId)).toEqual([
      'shader:vertex',
      'shader:fragment',
    ]);
    expect(work?.bindings).toEqual([
      expect.objectContaining({
        groupIndex: 0,
        binding: 3,
        bindGroupId: 'bindGroup:main',
        resourceId: 'view:sample',
        resourceKind: 'textureView',
      }),
    ]);
  });

  it('attributes recorded dynamic offsets to each draw in layout binding order', () => {
    const buffer = (handleId: string) => ({
      handleId,
      kind: 'buffer' as const,
      create: { kind: 'createBuffer' as const, handleId, desc: { size: 4096, usage: 64 } },
      initialData: [],
    });
    const draw = {
      kind: 'draw' as const,
      passHandleId: 'pass:render',
      vertexCount: 3,
      instanceCount: 1,
      firstVertex: 0,
      firstInstance: 0,
    };
    const tape: Tape = {
      header: { formatVersion: 7, rhiCaps: {}, eventCount: 6, blobCount: 0 },
      bootstrap: [
        buffer('buffer:static'),
        buffer('buffer:view'),
        buffer('buffer:light'),
        {
          handleId: 'bgl:dynamic',
          kind: 'binding',
          create: {
            kind: 'createBindGroupLayout',
            handleId: 'bgl:dynamic',
            desc: {
              entries: [
                { binding: 4, visibility: 2, buffer: { type: 'uniform', hasDynamicOffset: true } },
                { binding: 0, visibility: 2, buffer: { type: 'uniform', hasDynamicOffset: true } },
                { binding: 1, visibility: 2, buffer: { type: 'uniform' } },
              ],
            },
          },
          initialData: [],
        },
        {
          handleId: 'bindGroup:dynamic',
          kind: 'binding',
          create: {
            kind: 'createBindGroup',
            handleId: 'bindGroup:dynamic',
            layoutHandleId: 'bgl:dynamic',
            entries: [
              { binding: 4, resourceKind: 'buffer', bufferSize: 256 },
              { binding: 0, resourceKind: 'buffer', bufferSize: 256 },
              { binding: 1, resourceKind: 'buffer' },
            ],
            resourceHandleIds: ['buffer:light', 'buffer:view', 'buffer:static'],
          },
          initialData: [],
        },
      ],
      events: [
        {
          kind: 'beginRenderPass',
          passHandleId: 'pass:render',
          cmdHandleId: 'encoder:1',
          desc: { colorAttachments: [] },
          colorAttachmentViewHandleIds: [],
        },
        {
          kind: 'setBindGroup',
          passHandleId: 'pass:render',
          index: 0,
          bindGroupHandleId: 'bindGroup:dynamic',
          dynamicOffsets: [0, 512],
        },
        draw,
        {
          kind: 'setBindGroup',
          passHandleId: 'pass:render',
          index: 0,
          bindGroupHandleId: 'bindGroup:dynamic',
          dynamicOffsets: [1280, 768],
        },
        draw,
        { kind: 'endRenderPass', passHandleId: 'pass:render' },
      ],
      blobs: [],
    };

    const offsets = buildFrameModel(tape).works.map((work) =>
      work.bindings.map((binding) => [binding.binding, binding.dynamicOffset]),
    );
    expect(offsets).toEqual([
      [
        [4, 512],
        [0, 0],
        [1, null],
      ],
      [
        [4, 768],
        [0, 1280],
        [1, null],
      ],
    ]);
  });

  it('projects MSAA resolve targets index-aligned with color attachments', () => {
    const tape: Tape = {
      header: { formatVersion: 7, rhiCaps: {}, eventCount: 3, blobCount: 0 },
      bootstrap: [],
      events: [
        {
          kind: 'beginRenderPass',
          passHandleId: 'pass:msaa',
          cmdHandleId: 'encoder:1',
          desc: { colorAttachments: [] },
          colorAttachmentViewHandleIds: ['view:accum-msaa', undefined, 'view:plain'],
          colorAttachmentResolveTargetHandleIds: ['view:accum', undefined, undefined],
        },
        {
          kind: 'draw',
          passHandleId: 'pass:msaa',
          vertexCount: 3,
          instanceCount: 1,
          firstVertex: 0,
          firstInstance: 0,
        },
        { kind: 'endRenderPass', passHandleId: 'pass:msaa' },
      ],
      blobs: [],
    };
    const model = buildFrameModel(tape);
    expect(model.passes[0]?.colorAttachmentViewHandleIds).toEqual([
      'view:accum-msaa',
      'view:plain',
    ]);
    expect(model.passes[0]?.colorAttachmentResolveViewHandleIds).toEqual(['view:accum', null]);
    expect(model.works[0]?.attachments).toEqual({
      colorViewHandleIds: ['view:accum-msaa', 'view:plain'],
      colorResolveViewHandleIds: ['view:accum', null],
      colorDepthSlices: [null, null],
      depthStencilViewHandleId: null,
    });
  });

  it('projects the written 3d depth slice index-aligned with color attachments', () => {
    const tape: Tape = {
      header: { formatVersion: 7, rhiCaps: {}, eventCount: 3, blobCount: 0 },
      bootstrap: [],
      events: [
        {
          kind: 'beginRenderPass',
          passHandleId: 'pass:volume',
          cmdHandleId: 'encoder:1',
          desc: {
            colorAttachments: [
              { view: {}, depthSlice: 3, loadOp: 'clear', storeOp: 'store' },
              { view: {}, loadOp: 'clear', storeOp: 'store' },
            ],
          },
          colorAttachmentViewHandleIds: ['view:volume', 'view:plain'],
        },
        {
          kind: 'draw',
          passHandleId: 'pass:volume',
          vertexCount: 3,
          instanceCount: 1,
          firstVertex: 0,
          firstInstance: 0,
        },
        { kind: 'endRenderPass', passHandleId: 'pass:volume' },
      ],
      blobs: [],
    };
    const model = buildFrameModel(tape);
    expect(model.passes[0]?.colorAttachmentDepthSlices).toEqual([3, null]);
    expect(model.works[0]?.attachments?.colorDepthSlices).toEqual([3, null]);
  });
});
