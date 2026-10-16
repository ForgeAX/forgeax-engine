import { describe, expect, it, vi } from 'vitest';
import { createBrowserFrontendPlatform } from '../platform.js';

describe('browser frontend capability boundary', () => {
  it('provides ordinary runtime capabilities without document navigation', () => {
    const window = {
      document: {},
      fetch: vi.fn(),
    } as unknown as Window & typeof globalThis;
    const platform = createBrowserFrontendPlatform(window);
    expect(platform.window).toBe(window);
    expect(platform.document).toBe(window.document);
    expect(platform.connectHost).toBeTypeOf('function');
    expect(platform.createFrame).toBeTypeOf('function');
    expect(platform).not.toHaveProperty('navigate');
  });
});
