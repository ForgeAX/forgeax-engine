import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ViewerPanels } from '../App';
import type { ViewerModel } from '../viewer-model';
import { makeEmptyResourceLifecycle } from './viewer-model-fixtures';

function model(): ViewerModel {
  return {
    commands: [
      {
        eventIndex: 0,
        passIndex: 0,
        kind: 'pushDebugGroup',
        category: 'marker',
        isWork: false,
        params: { groupLabel: 'opaque' },
        group: ['opaque'],
      },
      {
        eventIndex: 1,
        passIndex: 0,
        kind: 'drawIndexed',
        category: 'work',
        isWork: true,
        params: { indexCount: 6, instanceCount: 2, firstIndex: 1 },
        group: ['opaque'],
        marker: 'main indexed draw',
      },
    ],
    resources: [],
    resourceLifecycle: makeEmptyResourceLifecycle(),
    unseededResources: [],
    works: [
      {
        workIndex: 0,
        eventIndex: 1,
        passIndex: 0,
        kind: 'drawIndexed',
        commandIndex: 1,
        drawCall: { indexCount: 6, instanceCount: 2, firstIndex: 1 },
        pipeline: { status: 'unavailable', shaders: [], reason: 'pipeline-not-bound' },
        bindings: [],
        vertexBuffers: [],
        indexBuffer: null,
        attachments: null,
      },
    ],
    passes: [
      {
        passIndex: 0,
        kind: 'render',
        beginEventIndex: 0,
        endEventIndex: 2,
        workIndices: [0],
        commandIndices: [0, 1],
        colorAttachmentViewHandleIds: [],
        colorAttachmentResolveViewHandleIds: [],
        colorAttachmentDepthSlices: [],
        depthStencilViewHandleId: null,
      },
    ],
    events: [],
  };
}

describe('EventBrowser completeness', () => {
  it('switches between works-only and all commands while preserving event identity', () => {
    const { container } = render(<ViewerPanels model={model()} />);
    expect(screen.getByRole('button', { name: /works only/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /all commands/i }));
    expect(container.querySelector('[data-forgeax-command-row="0"]')).not.toBeNull();
    expect(screen.getByText('pushDebugGroup')).toBeTruthy();
    expect(screen.getByText(/indexCount/)).toBeTruthy();
  });

  it('shows nested group and marker facts without deriving private indices', () => {
    render(<ViewerPanels model={model()} />);
    expect(screen.getAllByText('opaque').length).toBeGreaterThan(0);
    expect(screen.getAllByText('main indexed draw').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/firstIndex/).length).toBeGreaterThan(0);
  });
});
