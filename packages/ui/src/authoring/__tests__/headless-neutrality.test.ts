import { describe, expect, it } from 'vitest';

describe('authoring headless boundary', () => {
  it('loads the authoring entry without browser globals', async () => {
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    Reflect.deleteProperty(globalThis, 'document');
    Reflect.deleteProperty(globalThis, 'window');
    try {
      const module = await import('../index.js');
      const result = await module.validateUiAuthoring({
        sourcePath: 'node.ui.html',
        html: '<div>Node</div>',
        css: '.node { color: red; }',
      });
      expect(result.ok).toBe(true);
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    } finally {
      if (previousDocument !== undefined)
        Object.defineProperty(globalThis, 'document', {
          value: previousDocument,
          configurable: true,
        });
      if (previousWindow !== undefined)
        Object.defineProperty(globalThis, 'window', { value: previousWindow, configurable: true });
    }
  });

  it('does not import preview or editor modules from authoring source', async () => {
    const module = await import('../index.js');
    expect('createUiPreviewSession' in module).toBe(false);
    expect('mountUi' in module).toBe(false);
  });
});
