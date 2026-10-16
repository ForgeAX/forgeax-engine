import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const script = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'smoke-browser.mjs');

function runVariant(variant) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, FORGEAX_FALSIFY_VARIANT: variant },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => resolveResult({ code, output }));
  });
}

test('FALSIFY hidden target forced visible makes hidden-render fail', { skip: !process.env.FORGEAX_RUN_FALSIFICATION }, async (t) => {
  const result = await runVariant('hidden-target-visible');
  t.assert.notStrictEqual(result.code, 0);
  t.assert.match(result.output, /hidden-target-visible|hidden-render-output/);
});

test('FALSIFY shadow gate bypass makes hidden-shadow fail', { skip: !process.env.FORGEAX_RUN_FALSIFICATION }, async (t) => {
  const result = await runVariant('shadow-gate-bypass');
  t.assert.notStrictEqual(result.code, 0);
  t.assert.match(result.output, /shadow-gate-bypass|hidden-shadow-output/);
});
