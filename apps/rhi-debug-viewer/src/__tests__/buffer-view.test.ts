import type { ReplayReadbackResult } from '@forgeax/engine-rhi-debug';
import { ok } from '@forgeax/engine-types';
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { ViewerPanels } from '../App';
import type { ViewerModel } from '../viewer-model';
import { makeEmptyResourceLifecycle } from './viewer-model-fixtures';

function model(): ViewerModel {
  return {
    commands: [],
    resources: [
      {
        resourceId: 'buffer:known',
        kind: 'buffer',
        origin: 'bootstrap',
        createEventIndex: null,
        destroyEventIndex: null,
        descriptor: { size: 16, usage: 132 },
        consumers: [{ eventIndex: 2, workIndex: 0, access: 'read' }],
        lifecycle: {
          state: 'live',
          byteEstimate: { status: 'known', bytes: 16, basis: 'buffer-descriptor' },
        },
      },
    ],
    resourceLifecycle: makeEmptyResourceLifecycle(),
    unseededResources: [],
    works: [],
    passes: [],
    events: [],
  };
}

describe('bounded buffer view', () => {
  it('shows bounded offset/size, hex bytes, typed values, and structured status', async () => {
    const { container } = render(
      createElement(ViewerPanels, {
        model: model(),
        readResource: async () =>
          ok<ReplayReadbackResult>({
            resourceId: 'buffer:known',
            kind: 'buffer',
            bytes: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
            provenance: {
              generation: 1,
              resourceId: 'buffer:known',
              subresource: null,
            },
          }),
      }),
    );
    fireEvent.click(
      container.querySelector('[data-forgeax-resource-row="buffer:known"]') as HTMLElement,
    );
    expect(await screen.findByText(/offset/)).toBeTruthy();
    expect((await screen.findAllByText(/size/)).length).toBeGreaterThan(0);
    expect(await screen.findByText(/00 01/)).toBeTruthy();
    expect(await screen.findByText(/uint32/)).toBeTruthy();
    expect(container.querySelector('[data-forgeax-buffer-status]')).not.toBeNull();
  });
});
