import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');

describe('CSS injection', () => {
  it('inlines relative @import rules before injecting a style tag', async () => {
    const bundled = await build({
      absWorkingDir: root,
      entryPoints: [resolve(root, 'packages/view-components/src/styles.css')],
      bundle: true,
      write: false,
      outfile: 'injected.css',
    });
    const css = bundled.outputFiles[0].text;
    assert.match(css, /--fx-color-surface-canvas/);
    assert.doesNotMatch(css, /@import\s+['"]\.\//);
  });

});
