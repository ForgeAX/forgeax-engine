import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { err } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { serializeBridgeResult } from '../internal/browser-remote-bridge';

const BRIDGE_SOURCE = fileURLToPath(
  new URL('../internal/browser-remote-bridge.ts', import.meta.url),
);
const CREATE_APP_SOURCE = fileURLToPath(new URL('../browser.ts', import.meta.url));

describe('browser remote profiler bridge', () => {
  const bridge = readFileSync(BRIDGE_SOURCE, 'utf8');
  const createApp = readFileSync(CREATE_APP_SOURCE, 'utf8');

  it('propagates the explicit profiler root through the existing bridge context', () => {
    expect(bridge).toContain('readonly profiler?: unknown');
    expect(bridge).toContain('profiler,');
    expect(bridge).toContain('profiler: profiler');
  });

  it('keeps the bridge opt-in and free of a static remote dependency', () => {
    expect(createApp).toContain('VITE_FORGEAX_ENGINE_BRIDGE');
    expect(createApp).toContain("import('./internal/browser-remote-bridge')");
    expect(bridge).not.toMatch(/^import .*@forgeax\/engine-remote/m);
  });

  it('keeps profiler failures in the JSON-safe eval envelope', () => {
    expect(bridge).toContain("code: typeof e.code === 'string' ? e.code : 'script-runtime-error'");
    expect(bridge).toContain('detail');
    expect(bridge).toContain('script-result-unserializable');
  });

  it('identifies rejected Result prototypes without accepting them as plain JSON', () => {
    const failure = { code: 'capture-unavailable', detail: { cause: 'worker terminated' } };
    expect(serializeBridgeResult({ ok: true, value: err(failure) })).toMatchObject({
      ok: false,
      error: { code: 'script-result-unserializable', detail: { cause: 'custom object prototype' } },
    });
    expect(serializeBridgeResult({ ok: true, value: { ok: false, error: failure } })).toEqual({
      ok: true,
      value: { ok: false, error: failure },
    });
  });

  it('reports an unserializable result as an eval failure', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    for (const value of [
      cyclic,
      undefined,
      () => 42,
      { run: () => 42 },
      { missing: undefined },
      { nonFinite: Number.NaN },
      { nonFinite: Number.POSITIVE_INFINITY },
    ]) {
      expect(serializeBridgeResult({ ok: true, value })).toMatchObject({
        ok: false,
        error: { code: 'script-result-unserializable' },
      });
    }
    expect(serializeBridgeResult({ ok: true, value: 7 })).toEqual({ ok: true, value: 7 });
  });
});
