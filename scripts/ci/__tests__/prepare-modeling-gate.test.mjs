import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ensureGateSubmodules,
  ensurePnpm,
  GATE_SUBMODULES,
  PNPM_MISSING,
  submoduleReferences,
} from '../prepare-modeling-gate.mjs';

const temporary = () => mkdtempSync(join(tmpdir(), 'modeling-gate-'));

function checkout() {
  const base = temporary();
  const commonDir = join(base, 'engine/.git');
  const root = join(base, 'engine/.worktrees/feature');
  mkdirSync(join(commonDir, 'worktrees/feature'), { recursive: true });
  mkdirSync(join(commonDir, 'worktrees/runner/modules/third_party/wgpu/HEAD'), { recursive: true });
  // An uninitialized submodule directory in the root checkout is not a reference.
  mkdirSync(join(base, 'engine/third_party/blitz'), { recursive: true });
  mkdirSync(root, { recursive: true });
  return { base, commonDir, root };
}

test('prefers the root checkout, then module directories, then the View clone', () => {
  const commonDir = '/repo/.git';
  assert.deepEqual(submoduleReferences('tools/view', { commonDir }), [
    { reference: '/repo/tools/view', marker: '/repo/tools/view/.git' },
    { reference: '/repo/.git/modules/tools/view', marker: '/repo/.git/modules/tools/view/HEAD' },
    {
      reference: '/forgeax-view',
      marker: '/forgeax-view/.git',
    },
  ]);
});

test('leaves initialized submodules alone', () => {
  const { root, commonDir } = checkout();
  for (const path of GATE_SUBMODULES) mkdirSync(join(root, path, '.git'), { recursive: true });
  const calls = [];
  assert.deepEqual(
    ensureGateSubmodules({ root, commonDir, spawn: (...args) => calls.push(args) }),
    [],
  );
  assert.deepEqual(calls, []);
});

test('initializes each missing submodule from a local reference', () => {
  const { base, root, commonDir } = checkout();
  mkdirSync(join(base, 'forgeax-view/.git'), { recursive: true });
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, ...args]);
    mkdirSync(join(root, args.at(-1), '.git'), { recursive: true });
    return { status: 0 };
  };
  assert.deepEqual(ensureGateSubmodules({ root, commonDir, spawn }), []);
  const references = calls.map((call) => [
    call.at(-1),
    call.includes('--reference') ? call[call.indexOf('--reference') + 1] : null,
  ]);
  assert.deepEqual(references, [
    ['tools/view', join(base, 'forgeax-view')],
    ['third_party/wgpu', join(commonDir, 'worktrees/runner/modules/third_party/wgpu')],
    // No local copy anywhere: initialize without a reference.
    ['third_party/blitz', null],
  ]);
  assert.ok(calls.every((call) => call.slice(1, 3).join(' ') === '-c protocol.file.allow=always'));
});

test('names each submodule and its command when initialization fails', () => {
  const { root, commonDir } = checkout();
  const failures = ensureGateSubmodules({
    root,
    commonDir,
    spawn: () => ({ status: 128 }),
  });
  assert.equal(failures.length, GATE_SUBMODULES.length);
  for (const [index, path] of GATE_SUBMODULES.entries()) {
    assert.match(failures[index], new RegExp(`the ${path} submodule is missing`));
    assert.match(
      failures[index],
      /run git -c protocol\.file\.allow=always submodule update --init/,
    );
  }
});

test('reports exactly the corepack hint when pnpm cannot run', () => {
  const enoent = Object.assign(new Error('spawnSync pnpm ENOENT'), { code: 'ENOENT' });
  assert.equal(ensurePnpm({ spawn: () => ({ error: enoent, status: null }) }), PNPM_MISSING);
  assert.equal(PNPM_MISSING, 'pnpm not on PATH (use corepack shim)');
  assert.equal(ensurePnpm({ spawn: () => ({ status: 0, stdout: '12.10.1\n' }) }), undefined);
});
