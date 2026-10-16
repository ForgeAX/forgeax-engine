import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Execute the verifier's actual preparation phase with process-owned source
// commands. This tests scheduling/retirement, not Engine build correctness;
// the complete real SDK archive verification remains the delivery gate.
const verifier = readFileSync('scripts/forgeax/verify-sdk.mjs', 'utf8');
const start = verifier.indexOf('const sourceBuildPnpm =');
const end = verifier.indexOf('const initializedSdk =', start);
assert.ok(start >= 0 && end > start);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const prepare = new AsyncFunction(
  'selected',
  'sdkStage',
  'sourceRoot',
  'sourceEnv',
  'sourcePnpm',
  'consume',
  `${verifier.slice(start, end)}\nreturn consume();`,
);

async function journey(includeSource) {
  const children = [];
  const commands = [];
  const pending = [];
  const run = (args) => {
    commands.push(args);
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30)']);
    children.push(child);
    const completion = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`source exit ${code}`)),
      );
    });
    pending.push(completion);
    return completion;
  };
  let snapshot;
  const failure = new Error('consumer failure');
  try {
    await assert.rejects(
      prepare(
        () => includeSource,
        (_label, operation) => operation(),
        '/source',
        {},
        run,
        () => {
          snapshot = children.map((child) => child.exitCode);
          throw failure;
        },
      ),
      (error) => error === failure,
    );
  } finally {
    // The red baseline starts source work without joining it. Retain that
    // observation, then retire every fixture child rather than leaking it.
    while (pending.some((_task, index) => children[index].exitCode === null))
      await Promise.allSettled([...pending]);
  }
  return { snapshot, commands };
}

test('a consumer failure cannot remove a source root beneath an active source command', async () => {
  const { snapshot, commands } = await journey(true);
  assert.deepEqual(snapshot, [0, 0, 0, 0]);
  assert.deepEqual(commands, [
    ['install', '--frozen-lockfile', '--ignore-scripts'],
    ['build:engine'],
    ['build:tools'],
    ['build:app', 'preview'],
  ]);
});

test('a project-only verifier starts no source process', async () => {
  assert.deepEqual(await journey(false), { snapshot: [], commands: [] });
});
