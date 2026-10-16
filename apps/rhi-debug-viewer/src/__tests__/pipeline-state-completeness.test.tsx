import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ViewerPanels } from '../App';
import type { ViewerModel } from '../viewer-model';
import { makeEmptyResourceLifecycle } from './viewer-model-fixtures';

function model(): ViewerModel {
  return {
    commands: [],
    resources: [],
    resourceLifecycle: makeEmptyResourceLifecycle(),
    unseededResources: [],
    works: [
      {
        workIndex: 2,
        eventIndex: 9,
        passIndex: 1,
        kind: 'draw',
        commandIndex: 3,
        drawCall: { vertexCount: 3, instanceCount: 4 },
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
              source: 'vertex source',
            },
            {
              stage: 'fragment',
              moduleHandleId: 'shader:fragment',
              entryPoint: 'fsMain',
              source: 'fragment source',
            },
          ],
        },
        bindings: [
          {
            groupIndex: 2,
            binding: 1,
            bindGroupId: 'bind-group:main',
            resourceId: 'texture:color',
            resourceKind: 'texture',
            bufferOffset: null,
            bufferSize: null,
            dynamicOffset: null,
            access: 'read',
          },
        ],
        vertexBuffers: [{ slot: 0, bufferHandleId: 'buffer:vertex', offset: 8, size: 36 }],
        indexBuffer: { bufferHandleId: 'buffer:index', format: 'uint16', offset: 0, size: 12 },
        attachments: {
          colorViewHandleIds: ['view:color'],
          colorResolveViewHandleIds: [null],
          colorDepthSlices: [null],
          depthStencilViewHandleId: 'view:depth',
        },
      },
    ],
    passes: [
      {
        passIndex: 1,
        kind: 'render',
        beginEventIndex: 8,
        endEventIndex: 11,
        workIndices: [2],
        commandIndices: [3],
        colorAttachmentViewHandleIds: ['view:color'],
        colorAttachmentResolveViewHandleIds: [null],
        colorAttachmentDepthSlices: [null],
        depthStencilViewHandleId: 'view:depth',
      },
    ],
    events: [],
  };
}

describe('PipelineState completeness', () => {
  afterEach(cleanup);
  it('keeps both editor stages when one module supplies vertex and fragment entries', () => {
    const original = model();
    const shared: ViewerModel = {
      ...original,
      works: original.works.map((work) => ({
        ...work,
        pipeline: {
          ...work.pipeline,
          shaders: work.pipeline.shaders.map((shader) => ({
            ...shader,
            moduleHandleId: 'shader:shared',
            source: 'one module with both entries',
          })),
        },
      })),
    };
    const { container } = render(<ViewerPanels model={shared} />);
    fireEvent.click(container.querySelector('[data-forgeax-work-index="2"]') as HTMLElement);
    const keys = [...container.querySelectorAll('[data-forgeax-editor-key]')].map((editor) =>
      editor.getAttribute('data-forgeax-editor-key'),
    );
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(screen.getByText('vertex / vsMain')).toBeTruthy();
    expect(screen.getByText('fragment / fsMain')).toBeTruthy();
  });

  it('renders pipeline identity, shaders, bindings, and vertex/index ranges', () => {
    const { container } = render(<ViewerPanels model={model()} />);
    fireEvent.click(container.querySelector('[data-forgeax-work-index="2"]') as HTMLElement);
    expect(screen.getByText('pipeline:main')).toBeTruthy();
    expect(screen.getAllByText(/vsMain/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/fsMain/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/bind-group:main/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/buffer:vertex/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/uint16/).length).toBeGreaterThan(0);
  });

  it('keeps all eight pipeline sections anchored to one selected work', () => {
    const { container } = render(<ViewerPanels model={model()} />);
    fireEvent.click(container.querySelector('[data-forgeax-work-index="2"]') as HTMLElement);
    for (const label of [
      'Input Assembly',
      'Vertex Input',
      'Shaders',
      'Rasterizer',
      'Depth-Stencil',
      'Blend',
      'Multisample',
      'Resource Bindings',
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(container.querySelector('[data-forgeax-work-index="2"]')).not.toBeNull();
  });
});
