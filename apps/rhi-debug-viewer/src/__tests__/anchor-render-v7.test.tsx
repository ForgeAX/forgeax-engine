import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ViewerPanels } from '../App';
import type { ViewerModel } from '../viewer-model';
import { makeEmptyResourceLifecycle } from './viewer-model-fixtures';

function makeModel(): ViewerModel {
  const work: ViewerModel['works'][number] = {
    workIndex: 0,
    eventIndex: 1,
    passIndex: 0,
    kind: 'draw',
    commandIndex: 1,
    drawCall: null,
    pipeline: { status: 'unavailable', shaders: [], reason: 'pipeline-not-bound' },
    bindings: [],
    vertexBuffers: [],
    indexBuffer: null,
    attachments: null,
  };
  return {
    commands: [],
    resources: [],
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
        commandIndices: [],
        colorAttachmentViewHandleIds: [],
        colorAttachmentResolveViewHandleIds: [],
        colorAttachmentDepthSlices: [],
        depthStencilViewHandleId: null,
      },
    ],
    events: [
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'encoder:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      {
        kind: 'draw',
        passHandleId: 'pass:1',
        vertexCount: 3,
        instanceCount: 1,
        firstVertex: 0,
        firstInstance: 0,
      },
      { kind: 'endRenderPass', passHandleId: 'pass:1' },
    ],
  };
}

describe('v7 viewer anchors', () => {
  it('renders the four read-only surfaces and the stable work anchor', () => {
    const { container } = render(<ViewerPanels model={makeModel()} />);

    expect(container.querySelector('[data-forgeax-event-browser]')).not.toBeNull();
    expect(container.querySelector('[data-forgeax-pipeline-state]')).not.toBeNull();
    expect(container.querySelector('[data-forgeax-draw-call-viewer]')).not.toBeNull();
    expect(container.querySelector('[data-forgeax-resource-inspector]')).not.toBeNull();
    expect(container.querySelector('[data-forgeax-work-index="0"]')).not.toBeNull();
  });

  it('publishes the AI global with the model and inspectWork operation', () => {
    const model = makeModel();
    render(<ViewerPanels model={model} />);

    const api = (
      window as unknown as { __forgeaxRhiDebug?: { model: ViewerModel; inspectWork: unknown } }
    ).__forgeaxRhiDebug;
    expect(api?.model).toBe(model);
    expect(api?.inspectWork).toBeTypeOf('function');
  });

  it('keeps the selected work anchor machine-readable after a click', () => {
    const { container } = render(<ViewerPanels model={makeModel()} />);
    const work = container.querySelector('[data-forgeax-work-index="0"]');
    expect(work).not.toBeNull();
    fireEvent.click(work as HTMLElement);
    expect(container.querySelector('[data-forgeax-selected="true"]')).not.toBeNull();
  });
});
