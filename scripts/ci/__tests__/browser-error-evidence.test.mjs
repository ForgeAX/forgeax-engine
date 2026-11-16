import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserErrorEvidence } from '../browser-error-evidence.mjs';

const message = (error, evaluate = async (serialize) => serialize(error)) => ({
  text: () => 'RendererOperationError: graph-build-failed',
  location: () => ({ url: 'http://127.0.0.1/renderer.mjs', lineNumber: 12, columnNumber: 0 }),
  args: () => [{ evaluate }],
});

test('browser errors retain non-enumerable Error details and the structured owning cause', async () => {
  const capture = createBrowserErrorEvidence();
  const error = new Error('the Standard graph builds from active plans');
  error.code = 'graph-build-failed';
  error.detail = { cause: { code: 'resource-usage-invalid', pass: 'scene-data' } };
  error.cause = error;
  capture.consoleError(message(error));
  capture.pageError(error);
  const evidence = await capture.snapshot();
  assert.equal(evidence.records[0].arguments[0].message, error.message);
  assert.equal(evidence.records[0].arguments[0].detail.cause.code, 'resource-usage-invalid');
  assert.equal(evidence.records[0].arguments[0].cause, '[circular]');
  assert.equal(evidence.records[1].message, error.message);
  assert.equal(evidence.pending, 0);
});

test('error evidence bounds retained messages without hiding their omitted count', async () => {
  const capture = createBrowserErrorEvidence();
  for (let i = 0; i < 20; i++) capture.consoleError(message({ index: i, text: 'x'.repeat(10000) }));
  const evidence = await capture.snapshot();
  assert.equal(evidence.records.length, 16);
  assert.equal(evidence.omitted, 4);
  assert.equal(evidence.records[0].arguments[0].text.length, 4000);
});

test('closed browser handles remain diagnostic evidence instead of causing another gate failure', async () => {
  const capture = createBrowserErrorEvidence();
  capture.consoleError(
    message(undefined, async () => {
      throw new Error('target closed');
    }),
  );
  const evidence = await capture.snapshot();
  assert.deepEqual(evidence.records[0].arguments[0], { unavailable: 'target closed' });
});

test('pending console evaluation cannot consume an unbounded gate cleanup', {
  timeout: 3000,
}, async () => {
  const capture = createBrowserErrorEvidence();
  capture.consoleError(message(undefined, () => new Promise(() => {})));
  const evidence = await capture.snapshot();
  assert.equal(evidence.pending, 1);
  assert.equal(evidence.records[0].text, 'RendererOperationError: graph-build-failed');
});
