import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ViewerPanels } from '../App';
import type { ViewerModel } from '../viewer-model';
import { makeEmptyResourceLifecycle } from './viewer-model-fixtures';

function model(): ViewerModel {
  const work: ViewerModel['works'][number] = {
    workIndex: 0,
    eventIndex: 1,
    passIndex: 0,
    kind: 'draw',
    commandIndex: 1,
    drawCall: { vertexCount: 3, instanceCount: 1 },
    pipeline: {
      status: 'available',
      pipelineHandleId: 'pipeline:main',
      kind: 'render',
      descriptor: { topology: 'triangle-list' },
      shaders: [
        {
          stage: 'vertex',
          moduleHandleId: 'shader:vertex',
          entryPoint: 'vsMain',
          source: '@vertex fn vsMain() -> vec4f { return vec4f(); }',
        },
      ],
    },
    bindings: [
      {
        groupIndex: 0,
        binding: 0,
        bindGroupId: 'bind-group:main',
        resourceId: 'texture:color',
        resourceKind: 'texture',
        bufferOffset: null,
        bufferSize: null,
        dynamicOffset: null,
        access: 'read',
      },
    ],
    vertexBuffers: [{ slot: 0, bufferHandleId: 'buffer:vertices', offset: 4, size: 24 }],
    indexBuffer: null,
    attachments: {
      colorViewHandleIds: ['view:color'],
      colorResolveViewHandleIds: [null],
      colorDepthSlices: [null],
      depthStencilViewHandleId: null,
    },
  };
  return {
    commands: [
      {
        eventIndex: 0,
        passIndex: 0,
        kind: 'setPipeline',
        category: 'state',
        isWork: false,
        params: { pipelineHandleId: 'pipeline:main' },
        group: [],
      },
      {
        eventIndex: 1,
        passIndex: 0,
        kind: 'draw',
        category: 'work',
        isWork: true,
        params: { vertexCount: 3, instanceCount: 1 },
        group: ['opaque'],
        marker: 'main draw',
      },
    ],
    resources: [
      {
        resourceId: 'texture:color',
        kind: 'texture',
        origin: 'bootstrap',
        createEventIndex: null,
        destroyEventIndex: null,
        descriptor: { dimension: '2d', format: 'rgba8unorm', size: [2, 2, 1] },
        consumers: [{ eventIndex: 1, workIndex: 0, access: 'read' }],
        lifecycle: {
          state: 'live',
          byteEstimate: { status: 'known', bytes: 16, basis: 'texture-tight-layout' },
        },
      },
      {
        resourceId: 'buffer:vertices',
        kind: 'buffer',
        origin: 'bootstrap',
        createEventIndex: null,
        destroyEventIndex: null,
        descriptor: { size: 24, usage: 32 },
        consumers: [{ eventIndex: 1, workIndex: 0, access: 'read' }],
        lifecycle: {
          state: 'live',
          byteEstimate: { status: 'known', bytes: 24, basis: 'buffer-descriptor' },
        },
      },
    ],
    resourceLifecycle: makeEmptyResourceLifecycle(),
    unseededResources: [],
    works: [work],
    passes: [
      {
        passIndex: 0,
        kind: 'render',
        beginEventIndex: 0,
        endEventIndex: 2,
        workIndices: [0],
        commandIndices: [0, 1],
        colorAttachmentViewHandleIds: ['view:color'],
        colorAttachmentResolveViewHandleIds: [null],
        colorAttachmentDepthSlices: [null],
        depthStencilViewHandleId: null,
      },
    ],
    events: [],
  };
}

describe('viewer panel contract', () => {
  it('mounts the four panel surfaces from the producer-owned model', () => {
    const { container } = render(<ViewerPanels model={model()} />);
    expect(container.querySelector('[data-forgeax-event-browser]')).not.toBeNull();
    expect(container.querySelector('[data-forgeax-pipeline-state]')).not.toBeNull();
    expect(container.querySelector('[data-forgeax-draw-call-viewer]')).not.toBeNull();
    expect(container.querySelector('[data-forgeax-resource-inspector]')).not.toBeNull();
  });
});
