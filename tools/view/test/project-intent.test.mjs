import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveProjectIntent } from '../src/view-start.ts';
import { contract } from '../src/commands.ts';

test('project roots are explicit command inputs and separately discovered from the backend root', () => {
  assert.equal(resolveProjectIntent([]), undefined);
  assert.throws(() => resolveProjectIntent(['--project', '--json']), /directory/);
  assert.equal(resolveProjectIntent(['--project', '/one space/#game']), '/one space/#game');
  assert.ok(JSON.parse(contract.commands[0].argsSchema).properties.project);
  assert.equal(JSON.parse(contract.commands[1].argsSchema).properties.project, undefined);
});
