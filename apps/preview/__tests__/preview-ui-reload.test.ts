// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { createPreviewUiRun } from '../src/ui-root';

describe('preview UI run refresh', () => {
  it('removes all hosts on cleanup and recreates a clean root', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const first = createPreviewUiRun(parent);
    const host = document.createElement('div');
    first.uiRoot.append(host);
    first.cleanup();
    expect(parent.querySelector('[data-forgeax-ui-root]')).toBeNull();
    expect(parent.childElementCount).toBe(0);
    const second = createPreviewUiRun(parent);
    expect(parent.querySelectorAll('[data-forgeax-ui-root]').length).toBe(1);
    second.cleanup();
    parent.remove();
  });
});
