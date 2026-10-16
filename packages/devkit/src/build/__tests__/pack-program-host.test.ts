import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPackProgram, preparePackProgram } from '@forgeax/engine-pack/runtime';
import { describe, expect, it } from 'vitest';
import { defined } from '../../__tests__/assert-defined.js';
import { createNodePackProgramHost } from '../pack-program-host.js';

describe('native program closure publication', () => {
  it('reuses selected exports with an expanded host table and separates changed actual bindings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-program-bindings-'));
    try {
      const host = createNodePackProgramHost(root);
      const modules = {
        'entry.js':
          "import { state } from './shared.js'; import { token } from 'host'; export const first = { state, token }; export const second = first;",
        'shared.js': 'export const state = {};',
      };
      const select = (name: string) =>
        preparePackProgram({
          entry: 'entry.js',
          export: name,
          modules,
          imports: { host: '1' },
        }).unwrap();
      const binding = { identity: '1', url: 'data:text/javascript,export const token = {};' };
      const first = (await loadPackProgram(select('first'), { host: binding }, host)).unwrap();
      const second = (
        await loadPackProgram(
          select('second'),
          { unused: { identity: 'unused', url: 'ignored' }, host: binding },
          host,
        )
      ).unwrap();
      expect(second).toBe(first);
      const changed = (
        await loadPackProgram(
          select('first'),
          { host: { ...binding, url: `${binding.url}#different` } },
          host,
        )
      ).unwrap();
      expect(changed).not.toBe(first);
      expect((changed as { state: object }).state).not.toBe((first as { state: object }).state);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves cycles, relative import.meta.url and concurrent stable module identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-program-'));
    try {
      const program = preparePackProgram({
        entry: 'main.js',
        export: 'result',
        modules: {
          'main.js':
            "import { read } from './helper.js'; export const value = 7; export const result = { read, url: new URL('./helper.js', import.meta.url).href };",
          'helper.js': "import { value } from './main.js'; export const read = () => value;",
        },
      }).unwrap();
      const host = createNodePackProgramHost(root);
      const loaded = await Promise.all([
        loadPackProgram(program, {}, host),
        loadPackProgram(program, {}, host),
      ]);
      const first = defined(loaded[0]).unwrap() as {
        read(): number;
        url: string;
      };
      expect(first.read()).toBe(7);
      expect(first.url).toMatch(/^file:.*helper\.js$/);
      expect(defined(loaded[1]).unwrap()).toBe(first);
      const helper = preparePackProgram({
        entry: 'helper.js',
        export: 'read',
        modules: program.modules,
      }).unwrap();
      expect((await loadPackProgram(helper, {}, host)).unwrap()).toBe(first.read);
      expect(
        (
          await loadPackProgram(
            JSON.parse(JSON.stringify(program)),
            {},
            createNodePackProgramHost(root),
          )
        ).unwrap(),
      ).toBe(first);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
