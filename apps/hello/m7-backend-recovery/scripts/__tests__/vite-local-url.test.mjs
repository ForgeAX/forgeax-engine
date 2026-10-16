import assert from 'node:assert/strict';
import test from 'node:test';
import { viteLocalUrl } from '../vite-local-url.mjs';

test('waits for the complete ANSI-colored Vite URL across stdout chunks', () => {
  const first = '\u001b[32mLocal:\u001b[39m  \u001b[36mhttp://127.0.0.1:';
  const second = '\u001b[1m5173\u001b[22m/\u001b[39m\n';
  assert.equal(viteLocalUrl(first), undefined);
  assert.equal(viteLocalUrl(first + second), 'http://127.0.0.1:5173');
});
