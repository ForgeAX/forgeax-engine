import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserStartupDiagnostics } from '../browser-startup-diagnostics.mjs';

test('disabled startup diagnostics add no hooks or timer', () => {
  assert.deepEqual(browserStartupDiagnostics('root', false), []);
});

test('an unfinished server retains its named startup phase and bounded heap evidence', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const output = [];
  t.mock.method(process.stderr, 'write', (line) => {
    output.push(line);
    return true;
  });
  const [start] = browserStartupDiagnostics('browser', true);
  start.configResolved();
  start.configureServer();
  t.mock.timers.tick(60_000);
  const observation = JSON.parse(output.at(-1).split('[browser-startup] ')[1]);
  assert.equal(observation.owner, 'browser');
  assert.equal(observation.phase, 'configure-server');
  assert.equal(observation.pid, process.pid);
  assert.ok(observation.heapUsedBytes > 0);
  assert.deepEqual(Object.keys(observation).sort(), [
    'elapsedMs',
    'heapUsedBytes',
    'owner',
    'phase',
    'pid',
  ]);
  start.closeBundle();
});

test('settled startup and early close cancel their diagnostic timer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const output = [];
  t.mock.method(process.stderr, 'write', (line) => {
    output.push(line);
    return true;
  });
  const [start, ready] = browserStartupDiagnostics('root', true);
  start.configResolved();
  const configured = start.configureServer();
  configured();
  start.buildStart.handler();
  ready.buildStart.handler();
  const count = output.length;
  t.mock.timers.tick(120_000);
  assert.equal(output.length, count);
  assert.match(output.at(-1), /"phase":"build-ready"/);
  start.closeBundle();
  const [early] = browserStartupDiagnostics('early-close', true);
  early.configResolved();
  early.closeBundle();
  const closedCount = output.length;
  t.mock.timers.tick(120_000);
  assert.equal(output.length, closedCount);
});
