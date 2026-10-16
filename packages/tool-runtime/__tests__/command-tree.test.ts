import { describe, expect, it } from 'vitest';
import {
  createToolCommandRegistry,
  defineCommand,
  ToolCommandError,
  type ToolContribution,
} from '../src/index.js';

const schema = { parse: (value: unknown) => ({ ok: true as const, value }) };

function command(path: readonly string[], value: string): ToolContribution {
  return defineCommand(
    {
      path,
      title: value,
      summary: `${value} summary`,
      realm: 'build',
      argsSchema: schema,
      resultSchema: schema,
      evidence: [],
    },
    async () => value,
  );
}

describe('ToolCommandRegistry', () => {
  it('projects immediate help and an explicit recursive tree from one registry', async () => {
    const registry = createToolCommandRegistry([
      command(['project', 'check'], 'check'),
      command(['project', 'plugin', 'list'], 'list'),
    ]);

    expect(registry.help().nodes).toEqual([
      { name: 'project', path: 'project', summary: 'check summary' },
    ]);
    expect(registry.help('project').nodes).toEqual([
      { name: 'check', path: 'project check', summary: 'check summary' },
      { name: 'plugin', path: 'project plugin', summary: 'list summary' },
    ]);
    expect(registry.help('project', true).nodes.find((node) => node.name === 'plugin')).toMatchObject({
      children: [
        { name: 'list', path: 'project plugin list', summary: 'list summary' },
      ],
    });

    const run = registry.run('project check', {});
    expect(run).toBeDefined();
    await expect(run?.terminal).resolves.toMatchObject({ outcome: 'succeeded', result: 'check' });
  });

  it('rejects duplicate and leaf/group collisions during assembly', () => {
    expect(() =>
      createToolCommandRegistry([command(['project', 'check'], 'a'), command(['project', 'check'], 'b')]),
    ).toThrowError(ToolCommandError);
    expect(() =>
      createToolCommandRegistry([command(['project'], 'a'), command(['project', 'check'], 'b')]),
    ).toThrowError(ToolCommandError);
  });

  it('reports an unknown path without mutating the registry', () => {
    const registry = createToolCommandRegistry([command(['project', 'check'], 'check')]);
    expect(() => registry.help('project missing')).toThrowError(/tool-command-not-found/);
    expect(registry.get('project check')).toBeDefined();
    expect(registry.get('project missing')).toBeUndefined();
  });
});
