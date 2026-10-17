import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { attachViewportPageInputGate } from '../packages/view-plugin-viewport/src/page-input-gate.ts';

describe('attachViewportPageInputGate', () => {
  it('disables Engine scene input when the viewport page is hidden', () => {
    const allowed = [];
    const page = {
      getAttribute(name) {
        return name === 'aria-hidden' ? this.hidden : null;
      },
      hidden: 'true',
    };
    const element = {
      closest(selector) {
        return selector === '[data-forgeax-view-dock-page]' ? page : null;
      },
      ownerDocument: {
        documentElement: {
          dataset: { forgeaxViewActivePage: 'material' },
        },
      },
    };
    const restore = attachViewportPageInputGate({
      element,
      input: { preview: { setInputAllowed: (value) => allowed.push(value) } },
      pageType: 'scene',
    });
    assert.equal(allowed.at(-1), false);
    page.hidden = 'false';
    element.ownerDocument.documentElement.dataset.forgeaxViewActivePage = 'scene';
    restore();
    assert.equal(allowed.at(-1), true);
  });
});
