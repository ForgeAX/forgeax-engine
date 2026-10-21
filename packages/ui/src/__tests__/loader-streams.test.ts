import { type ArtifactDescriptor, ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createUiLoader } from '../loader.js';
import { mountUi } from '../mount.js';

const descriptor = {
  path: 'media/panel.png',
  delivery: 'stream',
  mediaType: 'image/png',
  byteLength: 3,
  contentEncoding: 'identity',
  integrity: { algorithm: 'sha256', digest: `sha256:${'a'.repeat(64)}` },
} satisfies ArtifactDescriptor;
const envelope = {
  guid: 'ui-guid',
  kind: 'ui',
  payload: {
    guid: 'ui-guid',
    sourcePath: 'hud.ui.html',
    html: '<p>panel.png</p><img src="panel.png#icon">',
    css: '.hud{background:url(panel.png)}.hud::before{content:"panel.png"}',
  },
  refs: [],
  artifacts: { 'panel.png': descriptor },
};

describe('UI companion streaming', () => {
  it('projects admitted stream URLs at mount without reading or rewriting source bytes', async () => {
    const read = vi.fn(async () => ok(Uint8Array.of(1, 2, 3)));
    const locate = vi.fn(() => 'https://published.test/media/panel.png');
    const loaded = await createUiLoader().decode({
      envelope,
      signal: new AbortController().signal,
      artifacts: { read, locate },
    });
    if (!loaded.ok) throw loaded.error;
    expect(read).not.toHaveBeenCalled();
    expect(locate).toHaveBeenCalledWith(descriptor);
    expect(loaded.value.html).toBe(envelope.payload.html);
    expect(loaded.value.css).toBe(envelope.payload.css);
    const mounted = mountUi(loaded.value, { root: document.body, layer: 0 });
    if (!mounted.ok) throw mounted.error;
    try {
      const shadow = mounted.value.host.shadowRoot;
      expect(shadow?.querySelector('img')?.getAttribute('src')).toBe(
        'https://published.test/media/panel.png#icon',
      );
      expect(shadow?.querySelector('p')?.textContent).toBe('panel.png');
      expect(shadow?.querySelector('style')?.textContent).toContain('content:"panel.png"');
      expect(mounted.value.resourceUrl('./panel.png')).toEqual({
        ok: true,
        value: 'https://published.test/media/panel.png',
      });
      expect(mounted.value.resourceUrl('../panel.png')).toMatchObject({ ok: false });
    } finally {
      mounted.value.dispose();
    }
    expect(mounted.value.resourceUrl('panel.png')).toMatchObject({
      ok: false,
      error: { detail: { reason: 'instance-disposed' } },
    });
  });

  it.each([
    'missing-locator',
    'unavailable-url',
    'eager-artifact',
  ])('retains verified reads for %s', async (mode) => {
    const read = vi.fn(async () => ok(Uint8Array.of(1, 2, 3)));
    const locate = vi.fn(() =>
      mode === 'unavailable-url' ? undefined : 'https://published.test/media/panel.png',
    );
    const { delivery: _, ...eager } = descriptor;
    const loaded = await createUiLoader().decode({
      envelope: {
        ...envelope,
        artifacts: { 'panel.png': mode === 'eager-artifact' ? eager : descriptor },
      },
      signal: new AbortController().signal,
      artifacts: { read, ...(mode === 'missing-locator' ? {} : { locate }) },
    });
    if (!loaded.ok) throw loaded.error;
    expect(read).toHaveBeenCalledTimes(1);
    expect(loaded.value.resources?.['panel.png']).toEqual({
      mediaType: 'image/png',
      bytes: Uint8Array.of(1, 2, 3),
    });
    if (mode === 'eager-artifact') expect(locate).not.toHaveBeenCalled();
  });

  it('rejects a retired stream publication before introducing any resource URL', async () => {
    const controller = new AbortController();
    const locate = vi.fn(() => {
      controller.abort();
      return 'https://published.test/media/panel.png';
    });
    const read = vi.fn(async () => ok(Uint8Array.of(1, 2, 3)));
    const loaded = await createUiLoader().decode({
      envelope,
      signal: controller.signal,
      artifacts: { read, locate },
    });
    expect(loaded).toMatchObject({ ok: false, error: { code: 'asset-load-cancelled' } });
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['read', 'locate'])('keeps admitted companion media types across %s', async (mode) => {
    const mutableDescriptor = { ...descriptor };
    const mutate = () => {
      mutableDescriptor.mediaType = 'text/plain';
    };
    const loaded = await createUiLoader().decode({
      envelope: { ...envelope, artifacts: { 'panel.png': mutableDescriptor } },
      signal: new AbortController().signal,
      artifacts: {
        read: async () => {
          mutate();
          return ok(Uint8Array.of(1, 2, 3));
        },
        ...(mode === 'locate'
          ? {
              locate: () => {
                mutate();
                return 'https://published.test/media/panel.png';
              },
            }
          : {}),
      },
    });
    expect(loaded).toMatchObject({
      ok: true,
      value: { resources: { 'panel.png': { mediaType: 'image/png' } } },
    });
  });

  it('accepts admitted Pack streams while ignoring serialized resource fields', () => {
    const loader = createUiLoader();
    const resources = { 'panel.png': { mediaType: 'image/png', url: 'https://untrusted.test/' } };
    const payload = { ...envelope.payload, resources };
    expect(loader.load(payload)).toEqual({ ok: true, value: envelope.payload });
    const loaded = loader.load({
      ...envelope,
      payload,
      artifacts: {},
      streams: { 'panel.png': { descriptor, url: 'https://published.test/media/panel.png' } },
    });
    expect(loaded).toMatchObject({
      ok: true,
      value: {
        resources: {
          'panel.png': { mediaType: 'image/png', url: 'https://published.test/media/panel.png' },
        },
      },
    });
  });

  it('admits publication resources only through its artifact reader', async () => {
    const read = vi.fn(async () => ok(Uint8Array.of(1, 2, 3)));
    const locate = vi.fn(() => 'https://published.test/media/panel.png');
    const publication = {
      ...envelope,
      artifacts: {},
      streams: {
        'panel.png': { descriptor, url: 'https://unadmitted.invalid/panel.png' },
      },
    };
    const loaded = await createUiLoader().decode({
      envelope: publication,
      signal: new AbortController().signal,
      artifacts: { read, locate },
    });
    expect(loaded).toEqual({ ok: true, value: envelope.payload });
    expect(read).not.toHaveBeenCalled();
    expect(locate).not.toHaveBeenCalled();
  });
});

it('keeps admitted UI source stable while its companion read is pending', async () => {
  const payload = {
    ...envelope.payload,
    browserExtensions: ['css' as const],
    localization: {
      fallbackLng: 'en',
      defaultNS: 'translation',
      resources: { en: { translation: { label: 'Play' } } },
    },
  };
  const read = vi.fn(async () => {
    payload.html = '<p>changed after admission</p>';
    Reflect.set(payload.browserExtensions, 1, 'invalid-extension');
    payload.localization.fallbackLng = 'missing';
    payload.localization.resources.en.translation.label = 'Changed';
    return ok(Uint8Array.of(1, 2, 3));
  });
  const loaded = await createUiLoader().decode({
    envelope: { ...envelope, payload },
    signal: new AbortController().signal,
    artifacts: { read },
  });
  expect(loaded).toMatchObject({
    ok: true,
    value: {
      html: envelope.payload.html,
      browserExtensions: ['css'],
      localization: {
        fallbackLng: 'en',
        resources: { en: { translation: { label: 'Play' } } },
      },
      resources: { 'panel.png': { bytes: Uint8Array.of(1, 2, 3) } },
    },
  });
});
