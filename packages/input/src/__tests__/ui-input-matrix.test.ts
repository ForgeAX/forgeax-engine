// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { isUiOwnedEvent } from '../ui-ownership';

describe('UI input ownership matrix', () => {
  it.each(['input', 'select', 'range', 'checkbox', 'contenteditable'])('%s is UI-owned', (kind) => {
    const root = document.createElement('div');
    const element =
      kind === 'contenteditable'
        ? document.createElement('div')
        : kind === 'select'
          ? document.createElement('select')
          : document.createElement('input');
    if (kind === 'contenteditable') element.contentEditable = 'true';
    if (kind === 'range' || kind === 'checkbox') element.setAttribute('type', kind);
    root.append(element);
    const event = new KeyboardEvent('keydown', { bubbles: true, composed: true, key: 'a' });
    element.dispatchEvent(event);
    expect(isUiOwnedEvent(event, root)).toBe(true);
  });

  it('leaves a canvas gameplay event outside the UI root', () => {
    const root = document.createElement('div');
    const canvas = document.createElement('canvas');
    const event = new KeyboardEvent('keydown', { bubbles: true, key: 'a' });
    canvas.dispatchEvent(event);
    expect(isUiOwnedEvent(event, root)).toBe(false);
  });
});
