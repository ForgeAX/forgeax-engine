import { createProfiler } from '@forgeax/engine-profiler';
import { describe, expect, it } from 'vitest';

import { buildIntrospectDoc } from '../introspect';

describe('remote profiler introspection projection', () => {
  it('derives root names from the supplied live roots', () => {
    const profiler = createProfiler();
    const doc = buildIntrospectDoc('127.0.0.1', 5732, {
      world: {},
      renderer: {},
      assets: {},
      profiler,
    }) as {
      roots: Record<string, { available: boolean }>;
    };

    expect(Object.keys(doc.roots)).toEqual(['world', 'renderer', 'assets', 'profiler']);
    expect(Object.values(doc.roots).every((root) => root.available)).toBe(true);
    expect(doc.roots.profiler).toMatchObject({
      operations: {
        startCapture: 'profiler.startCapture({ frameLimit, eventLimit })',
        latestCapture: expect.stringContaining('after the host reaches the frame boundary'),
      },
    });
  });

  it('does not invent optional roots that are absent from the live context', () => {
    const doc = buildIntrospectDoc('127.0.0.1', 5732, {
      world: {},
      renderer: {},
      assets: {},
    }) as { roots: Record<string, unknown> };

    expect(doc.roots).toEqual({
      world: expect.any(Object),
      renderer: expect.any(Object),
      assets: expect.any(Object),
    });
    expect('profiler' in doc.roots).toBe(false);
    expect('rhiCapture' in doc.roots).toBe(false);
  });

  it('does not project a profiler-shaped root for a recorder stand-in', () => {
    const doc = buildIntrospectDoc('127.0.0.1', 5732, {
      world: {},
      renderer: {},
      assets: {},
      profiler: { startCapture() {}, latestCapture() {}, phaseCatalog: {} },
    }) as { roots: Record<string, unknown>; capabilities: { profiler: { enabled: boolean } } };

    expect(doc.roots.profiler).toBeUndefined();
    expect(doc.capabilities.profiler.enabled).toBe(false);
  });
});
