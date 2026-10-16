import type { V7Tape } from '@forgeax/engine-rhi-debug';
import { fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { ViewerPanels } from '../App';
import { buildViewerModel } from '../viewer-model';

function tape(): V7Tape {
  return {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: 3, blobCount: 0 },
    bootstrap: [],
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
    blobs: [],
  };
}

describe('no-WebGPU Viewer degradation', () => {
  it('retains structure and exposes a local readback recovery state', () => {
    Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
    const { container } = render(createElement(ViewerPanels, { model: buildViewerModel(tape()) }));

    fireEvent.click(container.querySelector('[data-forgeax-work-index="0"]') as HTMLElement);

    expect(container.querySelector('[data-forgeax-event-browser]')).not.toBeNull();
    expect(container.querySelector('[data-forgeax-pipeline-state="selected"]')).not.toBeNull();
    expect(container.querySelector('[data-forgeax-resource-inspector="selected"]')).not.toBeNull();
    expect(container.querySelector('[data-forgeax-rt-status="no-webgpu"]')).not.toBeNull();
    expect(container.querySelector('[data-forgeax-capability="no-webgpu"]')).not.toBeNull();
  });
});
