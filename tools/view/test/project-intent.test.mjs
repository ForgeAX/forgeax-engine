import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveProjectIntent, withProjectIntent } from '../src/view-start.ts';
import { contract } from '../src/commands.ts';

test('project intent is explicit, URL-local and separately discovered from backend root', () => {
  assert.equal(resolveProjectIntent([]), undefined);
  assert.throws(() => resolveProjectIntent(['--project', '--json']), /directory/);
  const base = { phase: 'ready', url: 'http://127.0.0.1:8000/' };
  const first = withProjectIntent(base, '/one space/#game');
  const second = withProjectIntent(base, '/two');
  assert.equal(new URL(first.url).searchParams.get('project'), '/one space/#game');
  assert.equal(new URL(second.url).searchParams.get('project'), '/two');
  assert.equal(base.url, 'http://127.0.0.1:8000/');
  assert.ok(JSON.parse(contract.commands[0].argsSchema).properties.project);
  assert.equal(JSON.parse(contract.commands[1].argsSchema).properties.project, undefined);
});
