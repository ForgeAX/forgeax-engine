import { describe, expect, it } from 'vitest';
import {
  createStaticPackProgramHost,
  linkPackProgram,
  loadPackProgram,
  packProgramModuleIdentity,
  preparePackProgram,
  verifyPackProgram,
} from '../program.js';

describe('portable Pack programs', () => {
  it.each([
    'tauri',
    'asset',
    'app+test.v1',
  ])('retains host module identity through the %s module transport', async (scheme) => {
    const modules = {
      'entry.js': "import { token } from 'host'; export const value = token;",
    };
    const program = preparePackProgram({
      entry: 'entry.js',
      export: 'value',
      modules,
      imports: { host: 'accepted' },
    }).unwrap();
    const imports = { host: { identity: 'accepted', url: `${scheme}://localhost/host.mjs` } };
    const token = {};
    const host = createStaticPackProgramHost(
      [{ modules, load: async () => ({ value: token }) }],
      imports,
    );
    expect((await loadPackProgram(program, imports, host)).unwrap()).toBe(token);
    const linked = linkPackProgram(program, `${scheme}://localhost/program/`, imports).unwrap();
    expect(linked.files[0]?.source).toContain(JSON.stringify(imports.host.url));
    expect(linked.entryUrl).toBe(`${scheme}://localhost/program/entry.js`);
    const changed = { host: { ...imports.host, url: `${scheme}://localhost/other.mjs` } };
    expect(packProgramModuleIdentity(program, changed).unwrap()).not.toBe(
      packProgramModuleIdentity(program, imports).unwrap(),
    );
    expect(await loadPackProgram(program, changed, host)).toMatchObject({
      ok: false,
      error: { code: 'pack-program-load-failed' },
    });
    const mismatched = { host: { ...imports.host, identity: 'different' } };
    expect(packProgramModuleIdentity(program, mismatched)).toMatchObject({
      ok: false,
      error: { code: 'pack-program-dependency-unavailable' },
    });
    expect(linkPackProgram(program, `${scheme}://localhost/program/`, mismatched).ok).toBe(false);
  });

  it.each([
    './host.mjs',
    '//localhost/host.mjs',
    'host',
    '1bad:host',
    'tauri:',
    'tauri: ',
  ])('rejects an unavailable absolute host module locator %j', (url) => {
    const program = preparePackProgram({
      entry: 'entry.js',
      export: 'value',
      modules: { 'entry.js': "export { value } from 'host';" },
      imports: { host: 'accepted' },
    }).unwrap();
    const imports = { host: { identity: 'accepted', url } };
    expect(packProgramModuleIdentity(program, imports).ok).toBe(false);
    expect(linkPackProgram(program, 'https://localhost/program/', imports).ok).toBe(false);
  });

  it('loads a published native module and refuses source outside that code package', async () => {
    const modules = { 'entry.js': 'export const value = 7;' };
    const namespace = { value: 7 };
    const host = createStaticPackProgramHost([{ modules, load: async () => namespace }], {});
    const program = preparePackProgram({ entry: 'entry.js', export: 'value', modules }).unwrap();
    expect((await loadPackProgram(program, {}, host)).unwrap()).toBe(7);
    const changed = preparePackProgram({
      entry: program.entry,
      export: program.export,
      modules: { 'entry.js': 'export const value = 8;' },
    }).unwrap();
    expect(await loadPackProgram(changed, {}, host)).toMatchObject({
      ok: false,
      error: { code: 'pack-program-load-failed' },
    });
  });
  it('shares module state across selected exports and entries of the same closure', async () => {
    const modules = {
      'a.js': "export { state as first } from './shared.js';",
      'b.js': "export { state as second } from './shared.js';",
      'shared.js': 'export const state = { count: 0 }; export const same = state;',
    };
    const select = (entry: string, name: string) =>
      preparePackProgram({ entry, export: name, modules }).unwrap();
    const first = (await loadPackProgram(select('a.js', 'first'))).unwrap();
    expect((await loadPackProgram(select('b.js', 'second'))).unwrap()).toBe(first);
    expect((await loadPackProgram(select('shared.js', 'same'))).unwrap()).toBe(first);
    const changed = preparePackProgram({
      entry: 'a.js',
      export: 'first',
      modules: { ...modules, 'shared.js': 'export const state = { count: 1 };' },
    }).unwrap();
    expect((await loadPackProgram(changed)).unwrap()).not.toBe(first);
  });

  it('preserves distinct module instances for identical source at different paths', async () => {
    const program = preparePackProgram({
      entry: 'entry.js',
      export: 'default',
      modules: {
        'entry.js':
          "import { state as a } from './a.js'; import { state as b } from './b.js'; export default [a, b];",
        'a.js': 'export const state = {};',
        'b.js': 'export const state = {};',
      },
    }).unwrap();
    const states = (await loadPackProgram(program)).unwrap() as readonly object[];
    expect(states[0]).not.toBe(states[1]);
  });

  it('ignores unrelated host imports but isolates a changed declared binding', async () => {
    const modules = {
      'a.js':
        "import { token } from 'host'; import { local } from './local.js'; export const state = { token, local }; export const same = state;",
      'local.js': 'export const local = {};',
    };
    const first = preparePackProgram({
      entry: 'a.js',
      export: 'state',
      modules,
      imports: { host: '1' },
    }).unwrap();
    const second = preparePackProgram({
      entry: 'a.js',
      export: 'same',
      modules,
      imports: { host: '1' },
    }).unwrap();
    const host = { identity: '1', url: 'data:text/javascript,export const token = {};' };
    const state = (await loadPackProgram(first, { host })).unwrap();
    expect(
      (
        await loadPackProgram(second, { unused: { identity: 'unused', url: 'ignored' }, host })
      ).unwrap(),
    ).toBe(state);
    const changed = (
      await loadPackProgram(second, { host: { ...host, url: `${host.url}#different` } })
    ).unwrap();
    expect(changed).not.toBe(state);
    expect((changed as { local: object }).local).not.toBe((state as { local: object }).local);
  });

  it('keeps JS bytes intact and executes relative modules after JSON recovery', async () => {
    const modules = {
      'main.mjs':
        "import { scale } from './lib/helper.js'; export const build = (size) => scale * size;",
      'lib/helper.js': 'export const scale = 7;',
    };
    const prepared = preparePackProgram({ entry: 'main.mjs', export: 'build', modules }).unwrap();
    expect(prepared.modules).toEqual(modules);
    expect(Object.isFrozen(prepared.modules)).toBe(true);
    const restored = JSON.parse(JSON.stringify(prepared));
    const loaded = await loadPackProgram(restored);
    expect(loaded.ok).toBe(true);
    expect((loaded.unwrap() as (size: number) => number)(6)).toBe(42);
  });

  it('shares the exact host module identity instead of copying its implementation', async () => {
    const url = 'data:text/javascript,export const token = { name: "existing-component" };';
    const host = await import(/* @vite-ignore */ url);
    const program = preparePackProgram({
      entry: 'plugin.js',
      export: 'default',
      modules: {
        'plugin.js': "import { token } from '@game/components'; export default { token };",
      },
      imports: { '@game/components': 'game-components:sha256:accepted' },
    }).unwrap();
    const missing = await loadPackProgram(program);
    expect(missing).toMatchObject({
      ok: false,
      error: { code: 'pack-program-dependency-unavailable' },
    });
    const wrong = await loadPackProgram(program, {
      '@game/components': { identity: 'different', url },
    });
    expect(wrong.ok).toBe(false);
    const loaded = await loadPackProgram(program, {
      '@game/components': { identity: 'game-components:sha256:accepted', url },
    });
    expect((loaded.unwrap() as { token: unknown }).token).toBe(host.token);
  });

  it('does not evaluate modules while preparing or verifying definitions', async () => {
    const source = 'throw new Error("explicit-execution-only"); export default 1;';
    const prepared = preparePackProgram({
      entry: 'main.js',
      export: 'default',
      modules: { 'main.js': source },
    });
    expect(prepared.ok).toBe(true);
    expect(verifyPackProgram(prepared.unwrap()).ok).toBe(true);
    const executed = await loadPackProgram(prepared.unwrap());
    expect(executed).toMatchObject({ ok: false, error: { code: 'pack-program-load-failed' } });
    if (!executed.ok) expect(executed.error.detail.reason).toContain('explicit-execution-only');
  });

  it.each([
    ['export const x: number = 1;', 'pack-program-invalid'],
    ['export default (', 'pack-program-invalid'],
    ['export const load = (name) => import(name);', 'pack-program-invalid'],
    ["export { missing } from './absent.js';", 'pack-program-dependency-unavailable'],
    ["import './../../../escape.js';", 'pack-program-dependency-unavailable'],
    ["import 'node:fs';", 'pack-program-dependency-unavailable'],
  ])('rejects invalid or incomplete program %s', (source, code) => {
    expect(
      preparePackProgram({ entry: 'main.js', export: 'default', modules: { 'main.js': source } }),
    ).toMatchObject({ ok: false, error: { code } });
  });

  it('checks selected exports only at explicit load and rejects tampered artifacts before evaluation', async () => {
    const prepared = preparePackProgram({
      entry: 'main.js',
      export: 'missing',
      modules: { 'main.js': 'export const value = 12;' },
    }).unwrap();
    expect(await loadPackProgram(prepared)).toMatchObject({
      ok: false,
      error: { code: 'pack-program-load-failed' },
    });
    const changed = { ...prepared, modules: { 'main.js': 'throw new Error("must not execute");' } };
    expect(await loadPackProgram(changed)).toMatchObject({
      ok: false,
      error: { code: 'pack-program-integrity-mismatch' },
    });
  });

  it('canonicalizes module order and includes export and host dependency identities in the digest', () => {
    const source = {
      entry: 'a.js',
      export: 'default',
      modules: { 'a.js': 'export default 1;', 'b.js': 'export default 2;' },
    };
    const base = preparePackProgram(source).unwrap();
    const reordered = preparePackProgram({
      ...source,
      modules: { 'b.js': source.modules['b.js'], 'a.js': source.modules['a.js'] },
    }).unwrap();
    expect(reordered.digest).toBe(base.digest);
    expect(preparePackProgram({ ...source, export: 'other' }).unwrap().digest).not.toBe(
      base.digest,
    );
    expect(
      preparePackProgram({ ...source, imports: { '@game/component': '1' } }).unwrap().digest,
    ).not.toBe(base.digest);
  });
});
