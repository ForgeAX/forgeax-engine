import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractViteLocalUrl } from '../vite-local-url.mjs';

test('extracts Vite local URL when ANSI styles split the label and port', () => {
  const output =
    '\u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m5202\u001b[22m/\u001b[39m';
  assert.equal(extractViteLocalUrl(output), 'http://localhost:5202/');
});

test('extracts an unstyled Vite local URL', () => {
  assert.equal(extractViteLocalUrl('  Local:   http://127.0.0.1:4173/\n'), 'http://127.0.0.1:4173/');
});
