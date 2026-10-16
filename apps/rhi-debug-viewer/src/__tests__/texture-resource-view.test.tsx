import { ok } from '@forgeax/engine-types';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ViewerPanels } from '../App';
import { PanelNavigationProvider } from '../panel-navigation';
import type { ReadResource } from '../viewer-context';
import type { ViewerModel } from '../viewer-model';
import { makeEmptyResourceLifecycle } from './viewer-model-fixtures';

if (typeof globalThis.PointerEvent === 'undefined') {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  Object.defineProperty(globalThis, 'PointerEvent', { value: TestPointerEvent });
}

function model(): ViewerModel {
  return {
    commands: [],
    resources: [
      {
        resourceId: 'texture:array',
        kind: 'texture',
        origin: 'bootstrap',
        createEventIndex: null,
        destroyEventIndex: null,
        descriptor: {
          dimension: '2d-array',
          format: 'rgba8unorm',
          size: [4, 4, 3],
          mipLevelCount: 2,
        },
        consumers: [{ eventIndex: 1, workIndex: 0, access: 'write' }],
        lifecycle: {
          state: 'live',
          byteEstimate: { status: 'known', bytes: 80, basis: 'texture-tight-layout' },
        },
      },
      {
        resourceId: 'view:array',
        kind: 'texture-view',
        origin: 'bootstrap',
        createEventIndex: null,
        destroyEventIndex: null,
        descriptor: { sourceHandleId: 'texture:array' },
        consumers: [{ eventIndex: 1, workIndex: 0, access: 'write' }],
        lifecycle: { state: 'live', byteEstimate: null },
      },
      {
        resourceId: 'texture:bound',
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
        resourceId: 'view:bound',
        kind: 'texture-view',
        origin: 'bootstrap',
        createEventIndex: null,
        destroyEventIndex: null,
        descriptor: { sourceHandleId: 'texture:bound' },
        consumers: [{ eventIndex: 1, workIndex: 0, access: 'read' }],
        lifecycle: { state: 'live', byteEstimate: null },
      },
      {
        resourceId: 'texture:unrelated',
        kind: 'texture',
        origin: 'bootstrap',
        createEventIndex: null,
        destroyEventIndex: null,
        descriptor: { dimension: '2d', format: 'rgba8unorm', size: [8, 8, 1] },
        consumers: [],
        lifecycle: {
          state: 'live',
          byteEstimate: { status: 'known', bytes: 256, basis: 'texture-tight-layout' },
        },
      },
      {
        resourceId: 'texture:depth',
        kind: 'texture',
        origin: 'bootstrap',
        createEventIndex: null,
        destroyEventIndex: null,
        descriptor: {
          kind: 'createTexture',
          handleId: 'texture:depth',
          desc: {
            dimension: '2d',
            format: 'depth24plus-stencil8',
            size: { width: 4, height: 4, depthOrArrayLayers: 1 },
            mipLevelCount: 1,
          },
        },
        consumers: [{ eventIndex: 1, workIndex: 0, access: 'write' }],
        lifecycle: { state: 'live', byteEstimate: null },
      },
      {
        resourceId: 'view:depth',
        kind: 'texture-view',
        origin: 'bootstrap',
        createEventIndex: null,
        destroyEventIndex: null,
        descriptor: {
          kind: 'createTextureView',
          sourceHandleId: 'texture:depth',
          resultHandleId: 'view:depth',
          desc: {},
        },
        consumers: [{ eventIndex: 1, workIndex: 0, access: 'write' }],
        lifecycle: { state: 'live', byteEstimate: null },
      },
      {
        resourceId: 'buffer:uniforms',
        kind: 'buffer',
        origin: 'bootstrap',
        createEventIndex: null,
        destroyEventIndex: null,
        descriptor: { size: 256, usage: 64 },
        consumers: [{ eventIndex: 1, workIndex: 0, access: 'read' }],
        lifecycle: {
          state: 'live',
          byteEstimate: { status: 'known', bytes: 256, basis: 'buffer-descriptor' },
        },
      },
    ],
    resourceLifecycle: makeEmptyResourceLifecycle(),
    unseededResources: [],
    works: [
      {
        workIndex: 0,
        eventIndex: 1,
        passIndex: 0,
        kind: 'draw',
        commandIndex: 0,
        drawCall: { vertexCount: 3, instanceCount: 1 },
        pipeline: { status: 'unavailable', shaders: [], reason: 'pipeline-not-bound' },
        bindings: [
          {
            groupIndex: 0,
            binding: 1,
            bindGroupId: 'bind-group:main',
            resourceId: 'view:bound',
            resourceKind: 'textureView',
            bufferOffset: null,
            bufferSize: null,
            dynamicOffset: null,
            access: 'read',
          },
          {
            groupIndex: 0,
            binding: 2,
            bindGroupId: 'bind-group:main',
            resourceId: 'buffer:uniforms',
            resourceKind: 'buffer',
            bufferOffset: 0,
            bufferSize: 256,
            dynamicOffset: null,
            access: 'read',
          },
        ],
        vertexBuffers: [],
        indexBuffer: null,
        attachments: {
          colorViewHandleIds: ['view:array'],
          colorResolveViewHandleIds: [null],
          colorDepthSlices: [null],
          depthStencilViewHandleId: 'view:depth',
        },
      },
    ],
    passes: [
      {
        passIndex: 0,
        kind: 'render',
        beginEventIndex: 0,
        endEventIndex: 2,
        workIndices: [0],
        commandIndices: [0],
        colorAttachmentViewHandleIds: ['view:array'],
        colorAttachmentResolveViewHandleIds: [null],
        colorAttachmentDepthSlices: [null],
        depthStencilViewHandleId: 'view:depth',
      },
    ],
    events: [],
  };
}

describe('DrawCallViewer and ResourceInspector facts', () => {
  it('owns one draw call and lists only its attachments and texture bindings', () => {
    const { container } = render(<ViewerPanels model={model()} />);
    fireEvent.click(container.querySelector('[data-forgeax-work-index="0"]') as HTMLElement);

    const viewer = container.querySelector('[data-forgeax-draw-call-viewer]') as HTMLElement;
    expect(viewer).not.toBeNull();
    expect(within(viewer).getByText('Draw Call Viewer')).toBeTruthy();
    expect(within(viewer).getByRole('button', { name: 'texture:array' })).toBeTruthy();
    expect(within(viewer).getByRole('button', { name: 'texture:depth' })).toBeTruthy();
    expect(within(viewer).getByRole('button', { name: 'texture:bound' })).toBeTruthy();
    expect(within(viewer).queryByRole('button', { name: 'texture:unrelated' })).toBeNull();
    expect(viewer.querySelectorAll('[data-forgeax-texture-thumbnail]')).toHaveLength(3);
  });

  it('navigates pipeline texture and buffer references to their owning panels on double click', () => {
    const openPanel = vi.fn();
    const { container } = render(
      <PanelNavigationProvider openPanel={openPanel}>
        <ViewerPanels model={model()} />
      </PanelNavigationProvider>,
    );
    fireEvent.click(container.querySelector('[data-forgeax-work-index="0"]') as HTMLElement);
    const pipeline = within(
      container.querySelector('[data-forgeax-pipeline-state]') as HTMLElement,
    );

    fireEvent.doubleClick(pipeline.getByRole('button', { name: /view:bound.*draw call viewer/i }));
    expect(openPanel).toHaveBeenLastCalledWith('draw-call-viewer');

    fireEvent.doubleClick(
      pipeline.getByRole('button', { name: /buffer:uniforms.*resource inspector/i }),
    );
    expect(openPanel).toHaveBeenLastCalledWith('resource-inspector');
  });

  it('shows descriptor, subresource, slice, zoom, and texel controls', () => {
    const { container } = render(<ViewerPanels model={model()} />);
    fireEvent.click(container.querySelector('[data-forgeax-work-index="0"]') as HTMLElement);
    const viewer = within(
      container.querySelector('[data-forgeax-draw-call-viewer]') as HTMLElement,
    );
    expect(screen.getAllByText(/rgba8unorm/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/2d-array/).length).toBeGreaterThan(0);
    expect(viewer.getByRole('button', { name: /fit/i })).toBeTruthy();
    expect(viewer.getByRole('button', { name: /1:1/i })).toBeTruthy();
    expect(container.querySelector('[data-forgeax-texture-slice]')).not.toBeNull();
    expect(container.querySelector('[data-forgeax-texel-info]')).not.toBeNull();
  });

  it('shows lifecycle and consumer identity for a resource', () => {
    const { container } = render(<ViewerPanels model={model()} />);
    fireEvent.click(
      container.querySelector('[data-forgeax-resource-row="texture:array"]') as HTMLElement,
    );
    expect(screen.getAllByText(/lifecycle live/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/eventIndex/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('texture:array').length).toBeGreaterThan(0);
  });

  it('zooms around the cursor with the wheel and pans with a left-button drag', async () => {
    const inspectWork = vi.fn().mockResolvedValue(
      ok({
        workIndex: 0,
        eventIndex: 1,
        passIndex: 0,
        attachment: {
          resourceId: 'texture:attachment',
          kind: 'texture' as const,
          format: 'rgba8unorm',
          width: 100,
          height: 100,
          bytes: new Uint8Array(100 * 100 * 4),
          provenance: {
            generation: 1,
            resourceId: 'texture:attachment',
            subresource: null,
            selectedWorkIndex: 0,
          },
        },
      }),
    );
    const { container } = render(
      <ViewerPanels
        model={model()}
        inspectWork={inspectWork}
        capability={{ kind: 'webgpu', message: 'ready' }}
      />,
    );
    fireEvent.click(container.querySelector('[data-forgeax-work-index="0"]') as HTMLElement);

    const canvas = (await waitFor(() => {
      const element = container.querySelector(
        'canvas[aria-label="RHI debug texture pixels"]',
      ) as HTMLCanvasElement | null;
      expect(element).not.toBeNull();
      return element as HTMLCanvasElement;
    })) as HTMLCanvasElement;
    const stage = container.querySelector('[data-forgeax-texture-stage]') as HTMLElement;
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100));
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100));

    fireEvent.wheel(stage, { clientX: 25, clientY: 25, deltaY: -100 });
    expect((within(container).getByLabelText('Texture zoom') as HTMLInputElement).value).toBe(
      '122',
    );
    expect(canvas.style.transform).toBe('translate3d(5.5px, 5.5px, 0)');

    fireEvent.pointerDown(stage, { button: 0, clientX: 25, clientY: 25, pointerId: 7 });
    fireEvent.pointerMove(stage, { clientX: 45, clientY: 55, pointerId: 7 });
    fireEvent.pointerUp(stage, { clientX: 45, clientY: 55, pointerId: 7 });
    expect(canvas.style.transform).toBe('translate3d(25.5px, 35.5px, 0)');
  });

  it('automatically reads the selected work attachment until a texture resource is explicitly selected', async () => {
    const inspectWork = vi.fn().mockResolvedValue(
      ok({
        workIndex: 0,
        eventIndex: 1,
        passIndex: 0,
        attachment: {
          resourceId: 'texture:attachment',
          kind: 'texture' as const,
          format: 'rgba8unorm',
          width: 1,
          height: 1,
          bytes: new Uint8Array([32, 64, 128, 255]),
          provenance: {
            generation: 1,
            resourceId: 'texture:attachment',
            subresource: null,
            selectedWorkIndex: 0,
          },
        },
      }),
    );
    let finishReadResource: (value: Awaited<ReturnType<ReadResource>>) => void = () => {};
    const pendingReadResource = new Promise<Awaited<ReturnType<ReadResource>>>((resolve) => {
      finishReadResource = resolve;
    });
    const readResource = vi.fn<ReadResource>().mockReturnValue(pendingReadResource);
    const resourcePixels = ok({
      resourceId: 'texture:array',
      kind: 'texture' as const,
      format: 'rgba8unorm',
      width: 1,
      height: 1,
      bytes: new Uint8Array([0, 0, 0, 255]),
      provenance: { generation: 1, resourceId: 'texture:array', subresource: null },
    });
    const { container } = render(
      <ViewerPanels
        model={model()}
        inspectWork={inspectWork}
        readResource={readResource}
        capability={{ kind: 'webgpu', message: 'ready' }}
      />,
    );

    fireEvent.click(container.querySelector('[data-forgeax-work-index="0"]') as HTMLElement);

    await waitFor(() =>
      expect(inspectWork).toHaveBeenCalledWith(0, ['pixels'], expect.any(AbortSignal)),
    );
    await waitFor(() =>
      expect(
        container.querySelector('canvas[aria-label="RHI debug texture pixels"]'),
      ).not.toBeNull(),
    );
    const canvas = container.querySelector(
      'canvas[aria-label="RHI debug texture pixels"]',
    ) as HTMLCanvasElement;
    const stage = container.querySelector('[data-forgeax-texture-stage]') as HTMLElement;
    const viewer = within(
      container.querySelector('[data-forgeax-draw-call-viewer]') as HTMLElement,
    );
    expect(canvas.style.width).toBe('100%');
    expect(canvas.style.height).toBe('100%');
    expect(canvas.style.maxWidth).toBe('100%');
    expect(canvas.style.maxHeight).toBe('100%');
    expect(canvas.style.objectFit).toBe('contain');
    fireEvent.click(viewer.getByRole('button', { name: '1:1' }));
    expect(canvas.style.width).toBe('1px');
    expect(canvas.style.height).toBe('1px');
    fireEvent.click(viewer.getByRole('button', { name: 'Fit' }));
    expect(canvas.style.width).toBe('100%');
    expect(canvas.style.height).toBe('100%');
    expect(screen.queryByRole('button', { name: /inspect pixels|replay again/i })).toBeNull();
    expect(readResource).not.toHaveBeenCalled();

    fireEvent.click(container.querySelector('[data-forgeax-texture-thumbnail="0"]') as HTMLElement);

    await waitFor(() =>
      expect(readResource).toHaveBeenCalledWith(
        'texture:array',
        {
          mipLevel: 0,
          arrayLayer: 0,
          aspect: 'all',
        },
        expect.any(AbortSignal),
      ),
    );
    expect(container.querySelector('[data-forgeax-texture-stage]')).toBe(stage);
    expect(container.querySelector('canvas[aria-label="RHI debug texture pixels"]')).toBe(canvas);
    await waitFor(() =>
      expect(container.querySelector('[data-forgeax-texture-loading-overlay]')).not.toBeNull(),
    );

    finishReadResource(resourcePixels);
    await waitFor(() =>
      expect(container.querySelector('[data-forgeax-texture-loading-overlay]')).toBeNull(),
    );
    expect(container.querySelector('[data-forgeax-texture-stage]')).toBe(stage);
  });

  it('derives a depth-only readback for a combined depth-stencil texture', async () => {
    const readResource = vi.fn().mockResolvedValue(
      ok({
        resourceId: 'texture:depth',
        kind: 'texture' as const,
        format: 'depth24plus-stencil8',
        width: 1,
        height: 1,
        bytes: new Uint8Array([0, 0, 0, 0]),
        provenance: { generation: 1, resourceId: 'texture:depth', subresource: null },
      }),
    );
    const { container } = render(
      <ViewerPanels
        model={model()}
        readResource={readResource}
        capability={{ kind: 'webgpu', message: 'ready' }}
      />,
    );
    fireEvent.click(container.querySelector('[data-forgeax-work-index="0"]') as HTMLElement);
    const viewer = within(
      container.querySelector('[data-forgeax-draw-call-viewer]') as HTMLElement,
    );
    fireEvent.click(viewer.getByRole('button', { name: 'texture:depth' }));

    await waitFor(() =>
      expect(readResource).toHaveBeenCalledWith(
        'texture:depth',
        { mipLevel: 0, arrayLayer: 0, aspect: 'depth-only' },
        expect.any(AbortSignal),
      ),
    );
    expect(readResource).toHaveBeenCalledTimes(1);
    expect((viewer.getByRole('combobox', { name: 'Aspect' }) as HTMLSelectElement).value).toBe(
      'depth-only',
    );
    expect(viewer.queryByRole('option', { name: 'all' })).toBeNull();
    expect(viewer.getByRole('option', { name: 'stencil-only' })).toBeTruthy();
  });
});
