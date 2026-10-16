import { describe, expect, it, vi } from 'vitest';
import type { UiAsset } from '../../asset.js';
import {
  createUiPreviewSession,
  type UiPreviewAssetSource,
  type UiPreviewScenario,
} from '../session.js';

const asset: UiAsset = {
  guid: 'scenario-guid',
  html: '<div data-ui-part="root"><button data-ui-part="button">go</button></div>',
  css: '',
};

function source(): UiPreviewAssetSource {
  return { invalidate: () => {}, loadByGuid: async () => ({ ok: true, value: asset }) };
}

function scenario(overrides: Partial<UiPreviewScenario> = {}): UiPreviewScenario {
  return {
    requiredParts: ['root', 'button'],
    prepare: async ({ instance, signal }) => {
      const root = instance.host.shadowRoot?.querySelector('[data-ui-part="root"]');
      const button = instance.host.shadowRoot?.querySelector('[data-ui-part="button"]');
      if (!root || !button)
        return {
          ok: false,
          error: {
            code: 'preview-scenario-missing-part',
            expected: 'required UI parts',
            hint: 'restore the declared data-ui-part nodes',
            detail: { message: 'required part missing', part: !root ? 'root' : 'button' },
          },
        };
      signal.addEventListener('abort', () => button.removeAttribute('data-ready-listener'), {
        once: true,
      });
      button.setAttribute('data-ready-listener', 'true');
      return { ok: true, value: { parts: { root, button }, ready: true } };
    },
    ...overrides,
  };
}

describe('preview scenario failures', () => {
  it('reports ready facts and runs signal-bound cleanup', async () => {
    const root = document.createElement('div');
    const session = createUiPreviewSession({
      guid: asset.guid,
      assets: source(),
      root,
      rect: { width: 200, height: 100 },
      scenario: scenario(),
    });
    const opened = await session.open();
    expect(opened.ok).toBe(true);
    const button = opened.ok
      ? opened.value.host.shadowRoot?.querySelector('[data-ui-part="button"]')
      : null;
    expect(button?.getAttribute('data-ready-listener')).toBe('true');
    session.dispose();
    expect(button?.getAttribute('data-ready-listener')).toBe(null);
  });

  it('returns structured missing-part and thrown-prepare failures', async () => {
    const missing = scenario({ requiredParts: ['root', 'missing'] });
    const missingSession = createUiPreviewSession({
      guid: asset.guid,
      assets: source(),
      root: document.createElement('div'),
      rect: { width: 200, height: 100 },
      scenario: missing,
    });
    const missingResult = await missingSession.open();
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) expect(missingResult.error.code).toBe('preview-scenario-missing-part');

    const thrown = scenario({
      prepare: vi.fn(() => {
        throw new Error('scenario boom');
      }),
    });
    const thrownSession = createUiPreviewSession({
      guid: asset.guid,
      assets: source(),
      root: document.createElement('div'),
      rect: { width: 200, height: 100 },
      scenario: thrown,
    });
    const thrownResult = await thrownSession.open();
    expect(thrownResult.ok).toBe(false);
    if (!thrownResult.ok) expect(thrownResult.error.code).toBe('preview-scenario-failed');
  });

  it('times out a scenario that never resolves instead of silently mounting', async () => {
    const never: UiPreviewScenario = {
      requiredParts: ['root'],
      prepare: () => new Promise(() => {}),
    };
    const session = createUiPreviewSession({
      guid: asset.guid,
      assets: source(),
      root: document.createElement('div'),
      rect: { width: 200, height: 100 },
      scenario: never,
      scenarioTimeoutMs: 10,
    });
    const result = await session.open();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('preview-scenario-timeout');
    expect(session.state).toBe('failed');
  });
});
