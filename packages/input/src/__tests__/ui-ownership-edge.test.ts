// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { resolveUiOwnership } from '../ui-ownership';

describe('UI ownership fallback paths', () => {
  it('reports target fallback when composedPath is unavailable', () => {
    const root = document.createElement('div');
    const child = document.createElement('input');
    root.append(child);
    const event = new Event('keydown');
    Object.defineProperty(event, 'target', { configurable: true, value: child });
    Object.defineProperty(event, 'composedPath', { configurable: true, value: undefined });

    expect(resolveUiOwnership(event, root)).toEqual({
      owned: true,
      source: 'target-fallback',
    });
  });

  it('returns an explicit unknown result for targetless events', () => {
    const root = document.createElement('div');
    const event = new Event('keydown');
    Object.defineProperty(event, 'target', { configurable: true, value: null });
    Object.defineProperty(event, 'composedPath', { configurable: true, value: undefined });

    expect(resolveUiOwnership(event, root)).toEqual({
      owned: false,
      source: 'target-fallback',
    });
  });
});
