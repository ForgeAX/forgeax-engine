import { describe, expect, it, vi } from 'vitest';
import type { UiAsset } from '../asset.js';
import { inspectUi } from '../inspection.js';
import { mountUi } from '../mount.js';

const asset: UiAsset = {
  guid: 'ui-main',
  html: '<button data-ui-action="save">Save</button>',
  css: '.x{}',
};

describe('mountUi lifecycle', () => {
  it('bounds direct text reads and source strings in the same live inspection', () => {
    const mounted = mountUi(asset, { root: document.body, layer: 1 });
    if (!mounted.ok) throw mounted.error;
    const host = mounted.value.host;
    host.dataset.uiAsset = 'a'.repeat(600);
    host.dataset.uiSource = 'b'.repeat(600);
    const texts = Array.from({ length: 5 }, () => document.createTextNode('x'));
    host.append(...texts);
    const last = texts.at(-1);
    if (!last) throw new Error('Expected the final text node');
    const read = vi.spyOn(last, 'textContent', 'get');
    const observed = inspectUi(host, { limit: 2, styles: [] });
    mounted.value.dispose();
    if (!observed.ok) throw observed.error;
    expect(read).not.toHaveBeenCalled();
    expect(observed.value.nodes[0]?.text).toBe('xx');
    expect(observed.value.nodes[0]?.source).toEqual({
      guid: 'a'.repeat(512),
      path: 'b'.repeat(512),
    });
    expect(observed.value.truncated).toBe(true);
  });
  it('maps live inspection to the owning source and rejects the retired root', () => {
    const result = mountUi(
      { ...asset, sourcePath: 'guide.ui.html' },
      { root: document.body, layer: 1 },
    );
    if (!result.ok) throw result.error;
    const button = result.value.host.shadowRoot?.querySelector<HTMLButtonElement>('button');
    if (!button) throw new Error('Expected mounted control');
    const inspected = inspectUi(button, { styles: [] });
    expect(inspected).toMatchObject({
      ok: true,
      value: {
        nodes: [{ source: { guid: asset.guid, path: 'guide.ui.html' }, tag: 'button' }],
        truncated: false,
      },
    });
    result.value.dispose();
    expect(inspectUi(button)).toMatchObject({ ok: false, error: { code: 'inspection-failed' } });
  });
  it('uses an open shadow root, delegates one action, and disposes idempotently', () => {
    const root = document.createElement('div');
    const action = vi.fn();
    const instance = mountUi(asset, { root, layer: 1, onAction: action });
    expect(instance.ok).toBe(true);
    if (!instance.ok) return;
    expect(instance.value.host.shadowRoot).toBeTruthy();
    expect(instance.value.host.style.pointerEvents).toBe('none');
    expect(
      (instance.value.host.shadowRoot?.lastElementChild as HTMLElement | undefined)?.style
        .pointerEvents,
    ).toBe('none');
    instance.value.host.shadowRoot
      ?.querySelector('button')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(action).toHaveBeenCalledWith('save', expect.any(Event));
    instance.value.dispose();
    instance.value.dispose();
    expect(root.childElementCount).toBe(0);
  });
  it('does not mutate DOM on invalid input', () => {
    const root = document.createElement('div');
    const result = mountUi(asset, { root, layer: -1 });
    expect(result.ok).toBe(false);
    expect(root.childElementCount).toBe(0);
  });
  it('applies the portable support table before mutating the browser DOM', () => {
    const root = document.createElement('div');
    const result = mountUi(
      { ...asset, sourcePath: 'hud.ui.html', css: '.x { backdrop-filter: blur(4px); }' },
      { root, layer: 0 },
    );
    expect(result.ok).toBe(false);
    if (result.ok || result.error.code !== 'invalid-asset')
      throw new Error('Expected invalid-asset');
    expect(result.error.detail.diagnostics?.[0]).toMatchObject({
      code: 'unsupported-css-property',
      sourcePath: 'hud.ui.css',
    });
    expect(root.childElementCount).toBe(0);
  });
});
