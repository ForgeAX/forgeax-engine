import { describe, expect, it } from 'vitest';
import { buildIntrospectDoc } from '../introspect';

describe('plugin introspection projection', () => {
  it('projects desired and live plugin state without adding a remote method', () => {
    const document = buildIntrospectDoc('127.0.0.1', 5732, {
      world: {},
      renderer: {},
      assets: {},
      plugins: {
        desired: [{ id: 'root', name: './assets/plugin.ts', realm: 'engine' }],
        live: [{ id: 'root', name: './assets/plugin.ts', state: 'active' }],
      },
    }) as {
      roots: Record<string, { available: boolean; type: string }>;
      methods: readonly { name: string }[];
    };

    expect(document.roots.plugins).toMatchObject({
      available: true,
      type: 'PluginProjection',
    });
    expect(document.methods.map((method) => method.name)).toEqual(['eval', 'introspect']);
  });

  it('omits plugin state when no live projection is supplied', () => {
    const document = buildIntrospectDoc('127.0.0.1', 5732, {
      world: {},
      renderer: {},
      assets: {},
    }) as {
      roots: Record<string, unknown>;
    };

    expect(document.roots.plugins).toBeUndefined();
  });
});
