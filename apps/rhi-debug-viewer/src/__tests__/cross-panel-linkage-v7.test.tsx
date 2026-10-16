import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ViewerPanels } from '../App';
import type { ViewerModel } from '../viewer-model';
import { makeEmptyResourceLifecycle } from './viewer-model-fixtures';

function model(): ViewerModel {
  const work: ViewerModel['works'][number] = {
    workIndex: 0,
    eventIndex: 4,
    passIndex: 1,
    kind: 'drawIndexed',
    commandIndex: 1,
    drawCall: null,
    pipeline: { status: 'unavailable', shaders: [], reason: 'pipeline-not-bound' },
    bindings: [],
    vertexBuffers: [],
    indexBuffer: null,
    attachments: null,
  };
  const resource: ViewerModel['resources'][number] = {
    resourceId: 'buffer:linked',
    kind: 'buffer',
    origin: 'bootstrap',
    createEventIndex: null,
    destroyEventIndex: null,
    descriptor: { size: 8, usage: 132 },
    consumers: [{ eventIndex: 4, workIndex: 0, access: 'read' }],
    lifecycle: {
      state: 'live',
      byteEstimate: { status: 'known', bytes: 8, basis: 'buffer-descriptor' },
    },
  };
  return {
    commands: [],
    resources: [resource],
    resourceLifecycle: makeEmptyResourceLifecycle(),
    unseededResources: [],
    works: [work],
    passes: [
      {
        passIndex: 0,
        kind: 'compute' as const,
        beginEventIndex: 0,
        endEventIndex: 2,
        workIndices: [],
        commandIndices: [],
        colorAttachmentViewHandleIds: [],
        colorAttachmentResolveViewHandleIds: [],
        colorAttachmentDepthSlices: [],
        depthStencilViewHandleId: null,
      },
      {
        passIndex: 1,
        kind: 'render' as const,
        beginEventIndex: 3,
        endEventIndex: 5,
        workIndices: [0],
        commandIndices: [],
        colorAttachmentViewHandleIds: [],
        colorAttachmentResolveViewHandleIds: [],
        colorAttachmentDepthSlices: [],
        depthStencilViewHandleId: null,
      },
    ],
    events: [],
  };
}

describe('v7 cross-panel linkage', () => {
  it('uses one workIndex selection for pipeline, draw call, and resource panels', () => {
    const { container } = render(<ViewerPanels model={model()} />);
    fireEvent.click(container.querySelector('[data-forgeax-work-index="0"]') as HTMLElement);

    expect(container.querySelector('[data-forgeax-pipeline-state="selected"]')).not.toBeNull();
    expect(container.querySelector('[data-forgeax-draw-call-viewer="selected"]')).not.toBeNull();
    expect(container.querySelector('[data-forgeax-resource-inspector="selected"]')).not.toBeNull();
    expect(
      container.querySelector('[data-forgeax-work-index="0"][data-forgeax-selected="true"]'),
    ).not.toBeNull();

    fireEvent.click(
      container.querySelector('[data-forgeax-resource-row="buffer:linked"]') as HTMLElement,
    );
    expect(container.textContent).toContain('Resource facts');
    expect(container.textContent).toContain('buffer:linked');
  });

  it('keeps workspace topology outside the selected model and replay facts', () => {
    const modelValue = model();
    const { container } = render(<ViewerPanels model={modelValue} />);
    expect(container.querySelector('[data-forgeax-workspace]')).toBeNull();
    expect(modelValue).not.toHaveProperty('layout');
    expect(modelValue).not.toHaveProperty('session');
  });
});
