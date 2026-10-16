import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import type { UiAsset } from '../../asset.js';
import { captureUiPreview, type UiPreviewCaptureAdapter } from '../capture.js';
import { createDomPartScenario } from '../scenario.js';
import { createUiPreviewSession } from '../session.js';

const asset: UiAsset = {
  guid: 'capture-determinism',
  html: '<main data-ui-part="root"><button data-ui-part="button">Capture</button></main>',
  css: 'main { width: 100%; height: 100%; }',
};

async function decodeBase64Png(base64: string): Promise<Uint8Array> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function makeAdapter(host: HTMLElement): UiPreviewCaptureAdapter {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const deviceScaleFactor = window.devicePixelRatio;
  const readiness = async () => ({
    viewport: window.innerWidth === viewport.width && window.innerHeight === viewport.height,
    deviceScale: window.devicePixelRatio === deviceScaleFactor,
    fonts: document.fonts.status === 'loaded',
    resources: [...(host.shadowRoot?.querySelectorAll('img') ?? [])].every(
      (image) => image.complete && image.naturalWidth > 0,
    ),
    scenario:
      [...(host.shadowRoot?.querySelectorAll('[data-ui-scenario-ready]') ?? [])].length >= 2,
    clock: true,
    failures: { console: [], page: [], request: [] },
  });
  const screenshot = async () => {
    try {
      const captured = await page.elementLocator(host).screenshot({ base64: true, save: false });
      const base64 = typeof captured === 'string' ? captured : captured.base64;
      if (typeof base64 !== 'string')
        throw new Error(`screenshot payload: ${JSON.stringify(captured)}`);
      return decodeBase64Png(base64);
    } catch (cause) {
      throw new Error(
        `browser screenshot failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  };
  return {
    viewport,
    deviceScaleFactor,
    readiness,
    freezeClock: async () => ({ ok: true, value: { timeMs: 0 } }),
    screenshot,
  };
}

describe('preview capture determinism', () => {
  it('captures identical real PNG bytes and structured evidence for three runs', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = createUiPreviewSession({
      guid: asset.guid,
      assets: { invalidate: () => {}, loadByGuid: async () => ({ ok: true, value: asset }) },
      root,
      rect: { width: 320, height: 180 },
      scenario: createDomPartScenario({ requiredParts: ['root', 'button'] }),
    });
    const opened = await session.open();
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const adapter = makeAdapter(opened.value.host);
    const captures = [];
    for (let index = 0; index < 3; index += 1) {
      const capture = await captureUiPreview(session, adapter);
      captures.push(capture);
    }
    if (!captures.every((result) => result.ok)) throw new Error(JSON.stringify(captures));
    const pngs = captures.flatMap((result) => (result.ok ? [result.value.png] : []));
    expect(pngs).toHaveLength(3);
    expect(pngs[0]?.byteLength).toBeGreaterThan(100);
    expect(Array.from(pngs[0] ?? [])).toEqual(Array.from(pngs[1] ?? []));
    expect(Array.from(pngs[1] ?? [])).toEqual(Array.from(pngs[2] ?? []));
    const evidence = captures.flatMap((result) => (result.ok ? [result.value.evidence] : []));
    expect(evidence[0]?.viewport).toEqual({ width: window.innerWidth, height: window.innerHeight });
    expect(evidence[0]?.deviceScaleFactor).toBe(window.devicePixelRatio);
    expect(evidence[0]?.scenario.ready).toBe(true);
    expect(evidence[0]?.parts).toEqual(['root', 'button']);
    expect(evidence[0]?.lifecycle.disposed).toBe(false);
    expect(evidence[0]?.dom.hostCount).toBe(1);
    expect(evidence[0]?.resources.failures).toEqual([]);
    session.dispose();
    root.remove();
  });
});
