import { describe, expect, it } from 'vitest';
import { defineToolCommandContract, isToolCommandContract } from '../src/command-contract.js';
const command = { id: 'game.inspect', title: 'Inspect', summary: 'Inspect game', realm: 'engine' as const, executor: './inspect.ts' };

it.each(['build', 'host', 'engine', 'frontend'] as const)('admits %s command declarations through the serialized contract', (realm) => {
  const value = defineToolCommandContract([{ ...command, realm }]);
  expect(isToolCommandContract(JSON.parse(JSON.stringify(value)))).toBe(true);
});
it('rejects an unsupported serialized realm', () => {
  expect(isToolCommandContract({ schemaVersion: '1.0.0', commands: [{ ...command, realm: 'worker' }] })).toBe(false);
});
describe('cold tool declaration contract', () => {
  it('validates JSON without evaluating accessors or executors', () => {
    const value = defineToolCommandContract([command]);
    expect(isToolCommandContract(JSON.parse(JSON.stringify(value)))).toBe(true);
    const accessor = { ...command, get argsSchema() { throw new Error('must not execute'); } };
    expect(isToolCommandContract({ schemaVersion: '1.0.0', commands: [accessor] })).toBe(false);
  });
  it.each([
    [command, command],
    [command, { ...command, id: 'other', path: ['game', 'inspect'] }],
    [{ ...command, argsSchema: '{invalid}' }],
    [{ ...command, argsSchema: '{"minimum":1e999}' }],
    [{ ...command, argsSchema: undefined }],
    [{ ...command, path: new Array(2) }],
    [{ ...command, evidence: ['unknown'] }],
    [{ ...command, apply() {} }],
  ])('rejects ambiguous or non-JSON declarations %#', (...commands) => {
    expect(isToolCommandContract({ schemaVersion: '1.0.0', commands })).toBe(false);
  });
});
