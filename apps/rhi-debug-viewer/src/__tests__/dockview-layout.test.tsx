import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../App';

if (typeof globalThis.ResizeObserver === 'undefined') {
  class TestResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { value: TestResizeObserver });
}

describe('Dockview workspace shell', () => {
  it('captures file drags at the window boundary and exposes a stable drop target', async () => {
    const { container, unmount } = render(<App />);
    fireEvent.dragEnter(window, { dataTransfer: { types: ['Files'] } });
    await waitFor(() =>
      expect(container.querySelector('[data-forgeax-drop-overlay="ready"]')).not.toBeNull(),
    );
    fireEvent.dragLeave(window, {
      dataTransfer: { types: ['Files'] },
      relatedTarget: null,
    });
    await waitFor(() => expect(container.querySelector('[data-forgeax-drop-overlay]')).toBeNull());
    unmount();
  });

  it('mounts the fixed four-panel workspace with compact layout actions', async () => {
    const { container } = render(<App />);
    await waitFor(() => {
      expect(
        (screen.getByRole('button', { name: 'Layout menu' }) as HTMLButtonElement).disabled,
      ).toBe(false);
      expect(container.querySelector('[data-forgeax-workspace="dockview"]')).not.toBeNull();
      for (const id of [
        'event-browser',
        'pipeline-state',
        'draw-call-viewer',
        'resource-inspector',
      ]) {
        expect(container.querySelector(`[data-forgeax-panel="${id}"]`)).not.toBeNull();
      }
    });
    expect(screen.queryByRole('menu', { name: 'Layout actions' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Layout menu' }));
    const menu = screen.getByRole('menu', { name: 'Layout actions' });
    expect(within(menu).getByRole('menuitem', { name: /float resource/i })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: /split resource/i })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: /stack pipeline/i })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: /reset layout/i })).toBeTruthy();
  });

  it('uses a three-region default with an independent Draw Call Viewer', async () => {
    const { container } = render(<App />);
    await waitFor(() => {
      const view = within(container);
      const eventTab = view.getByRole('tab', { name: 'Event browser' });
      const pipelineTab = view.getByRole('tab', { name: 'Pipeline state' });
      const drawTab = view.getByRole('tab', { name: 'Draw Call Viewer' });
      const resourceTab = view.getByRole('tab', { name: 'Resource Inspector' });
      const groupOf = (tab: HTMLElement) => tab.closest('.dv-tabs-and-actions-container');

      expect(groupOf(pipelineTab)).not.toBeNull();
      expect(groupOf(resourceTab)).toBe(groupOf(pipelineTab));
      expect(groupOf(drawTab)).not.toBe(groupOf(pipelineTab));
      expect(groupOf(eventTab)).not.toBe(groupOf(pipelineTab));
      expect(drawTab.getAttribute('aria-selected')).toBe('true');
      expect(pipelineTab.getAttribute('aria-selected')).toBe('true');
      expect(container.querySelectorAll('.dv-groupview')).toHaveLength(3);
    });
  });

  it('exposes recovery status rather than silently accepting an invalid layout', async () => {
    window.localStorage.setItem('forgeax-rhi-debug-viewer-layout', '{');
    const { container } = render(<App />);
    await waitFor(() => {
      expect(container.querySelector('[data-forgeax-layout-recovery]')).not.toBeNull();
    });
  });
});
