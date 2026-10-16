// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { isUiOwnedEvent } from '@forgeax/engine-input';

describe('preview input matrix', () => {
  it('applies the same ownership predicate to default and custom listeners', () => {
    const root = document.createElement('div');
    const input = document.createElement('input');
    root.append(input);
    const event = new KeyboardEvent('keydown', { bubbles: true, composed: true, key: 'a' });
    const customEvents: Event[] = [];
    input.addEventListener('keydown', (value) => customEvents.push(value));
    input.dispatchEvent(event);

    expect(isUiOwnedEvent(event, root)).toBe(true);
    expect(customEvents).toHaveLength(1);
  });
});
