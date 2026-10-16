import type { UiAsset } from '@forgeax/engine/ui';
import {
  captureUiPreview,
  createDomPartScenario,
  createUiPreviewSession,
  type UiPreviewCaptureAdapter,
  type UiPreviewCaptureReadiness,
} from '@forgeax/engine/ui/preview';
import { CheckList, defineFeature } from '../../lab/feature';

const GUID = 'feature-lab/2d/preview-card';
const CARD: UiAsset = {
  guid: GUID,
  html: '<main data-ui-part="root"><h1 data-ui-part="title">Preview</h1><button data-ui-part="cta">Start</button></main>',
  css: 'main { width: 100%; height: 100%; background: #0f766e; color: #fff; font: 700 28px sans-serif; } button { background: #f59e0b; }',
};
const RECT = { x: 16, y: 16, width: 320, height: 180 } as const;

/** Rasterizes the shadow content through an SVG foreignObject so the adapter returns real PNG bytes in-page. */
async function rasterize(host: HTMLElement): Promise<Uint8Array> {
  const shadow = host.shadowRoot;
  if (shadow === null) throw new Error('no shadow root');
  const markup = new XMLSerializer().serializeToString(
    Object.assign(document.createElement('div'), { innerHTML: shadow.innerHTML }),
  );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${RECT.width}" height="${RECT.height}"><foreignObject width="100%" height="100%">${markup}</foreignObject></svg>`;
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = RECT.width;
  canvas.height = RECT.height;
  canvas.getContext('2d')?.drawImage(image, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (blob === null) throw new Error('toBlob returned null');
  return new Uint8Array(await blob.arrayBuffer());
}

function adapter(
  host: () => HTMLElement | undefined,
  overrides: Partial<UiPreviewCaptureReadiness> = {},
): UiPreviewCaptureAdapter {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  return {
    viewport,
    deviceScaleFactor: window.devicePixelRatio,
    readiness: () => ({
      viewport: window.innerWidth === viewport.width && window.innerHeight === viewport.height,
      deviceScale: true,
      fonts: document.fonts.status === 'loaded',
      resources: true,
      scenario: (host()?.shadowRoot?.querySelectorAll('[data-ui-scenario-ready]').length ?? 0) >= 2,
      clock: true,
      failures: { console: [], page: [], request: [] },
      ...overrides,
    }),
    freezeClock: () => ({ ok: true, value: { timeMs: 1000 } }),
    screenshot: async () => {
      const element = host();
      if (element === undefined) throw new Error('no mounted host');
      return rasterize(element);
    },
  };
}

export default defineFeature({
  title: 'UI preview evidence',
  catalog: 'UI preview evidence',
  kind: 'probe',
  summary:
    'createUiPreviewSession mounts a UiAsset at an explicit rect with a data-ui-part scenario; captureUiPreview pairs one PNG with JSON evidence (viewport, DPR, fonts, resources, scenario, frozen clock) only when every readiness gate holds.',
  expect:
    'All checks pass: the session mounts, an unmet gate yields capture-not-ready without a PNG, a ready capture returns PNG bytes plus evidence with parts and clock, a missing part fails structurally, and dispose ends the lifecycle.',
  async setup({ canvas }) {
    const root = canvas.parentElement;
    if (root === null) throw new Error('canvas has no parent');
    let current: UiAsset = CARD;
    const assets = {
      invalidate: () => undefined,
      loadByGuid: async (guid: string) =>
        guid === GUID
          ? ({ ok: true, value: current } as const)
          : ({ ok: false, error: { code: 'preview-load-failed' } } as never),
    };
    const session = createUiPreviewSession({
      guid: GUID,
      assets,
      root,
      rect: RECT,
      layer: 5,
      scenario: createDomPartScenario({ requiredParts: ['root', 'cta'] }),
    });
    const c = new CheckList();
    const opened = await session.open();
    c.ok('session opens', opened.ok, opened.ok ? undefined : opened.error.code);
    c.equal('state is mounted', session.state, 'mounted');
    const host = (): HTMLElement | undefined => session.instance?.host;
    c.equal('host is placed at the explicit rect', host()?.style.width, `${RECT.width}px`);

    const notReady = await captureUiPreview(
      session,
      adapter(host, { fonts: false, failures: { console: ['boom'], page: [], request: [] } }),
    );
    c.equal(
      'unmet gates return capture-not-ready',
      notReady.ok ? 'ok' : notReady.error.code,
      'capture-not-ready',
    );
    const unmet =
      !notReady.ok && 'unmet' in notReady.error.detail
        ? (notReady.error.detail.unmet as readonly string[])
        : [];
    c.equal('unmet lists fonts and console', unmet, ['fonts', 'console']);
    c.ok('failed capture carries no png', !('value' in notReady));

    const captured = await captureUiPreview(session, adapter(host));
    c.ok(
      'ready capture succeeds',
      captured.ok,
      captured.ok ? undefined : JSON.stringify(captured.error.detail),
    );
    if (captured.ok) {
      const png = captured.value.png;
      c.ok(
        'png has a PNG signature',
        png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47,
        `bytes=${png.length}`,
      );
      const evidence = captured.value.evidence;
      c.equal('evidence parts', evidence.parts, ['root', 'title', 'cta']);
      c.equal('evidence clock', evidence.clock, { timeMs: 1000 });
      c.equal('evidence lifecycle', evidence.lifecycle, { state: 'mounted', disposed: false });
      c.ok(
        'evidence is JSON-serializable',
        JSON.stringify(JSON.parse(JSON.stringify(evidence))) === JSON.stringify(evidence),
      );
    }

    current = { ...CARD, html: '<main data-ui-part="root">No button</main>' };
    const rebuilt = await session.rebuild();
    c.equal(
      'rebuild without a required part fails',
      rebuilt.ok ? 'ok' : rebuilt.error.code,
      'preview-scenario-missing-part',
    );
    current = CARD;
    const retried = await session.retry();
    c.ok(
      'retry after restoring the part mounts again',
      retried.ok && session.state === 'mounted',
      session.state,
    );

    const disposed = session.dispose();
    c.ok('dispose succeeds', disposed.ok);
    c.equal('state is disposed', session.state, 'disposed');
    const afterDispose = await captureUiPreview(session, adapter(host));
    c.equal(
      'capture after dispose is capture-not-ready',
      afterDispose.ok ? 'ok' : afterDispose.error.code,
      'capture-not-ready',
    );
    return { checks: () => c.items };
  },
});
