// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { isUiOwnedEvent } from '../ui-ownership';

describe('UI event ownership', () => {
  it('uses composedPath for a shadow-dom event', () => {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    const input = document.createElement('input');
    shadow.append(input);
    const event = new Event('keydown', { bubbles: true, composed: true });
    input.dispatchEvent(event);

    expect(isUiOwnedEvent(event, host)).toBe(true);
  });

  it('does not claim an unrelated gameplay event', () => {
    const host = document.createElement('div');
    const canvas = document.createElement('canvas');
    const event = new Event('keydown', { bubbles: true });
    canvas.dispatchEvent(event);

    expect(isUiOwnedEvent(event, host)).toBe(false);
  });

  it('treats a direct root event as owned', () => {
    const host = document.createElement('div');
    const event = new Event('keydown');
    host.dispatchEvent(event);

    expect(isUiOwnedEvent(event, host)).toBe(true);
  });
});
