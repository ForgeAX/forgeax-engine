// config.define injection + prod constant-fold tests (w12).
//
// AC-07 / C6: config(cfg) injects "1" for dev serve and "0" for production
// build. The production literal lets Vite tree-shake the dev-only endpoint and
// avoids leaving a bare @forgeax/engine-rhi-debug import in preview bundles.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { build, type Plugin } from 'vite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { vitePluginRhiDebug } from '../index';

// The factory returns a Vite plugin; view it through the Plugin type so the
// optional config / configureServer hooks are statically known to the test.
const asPlugin = (): Plugin => vitePluginRhiDebug() as unknown as Plugin;

// ─── config(cfg) hook unit assertion ─────────────────────────────────────────

describe('config(cfg) define injection', () => {
  it('injects import.meta.env.FORGEAX_ENGINE_RHI_DEBUG = "1" for serve', () => {
    const plugin = asPlugin();
    const cfg: { define?: Record<string, string> } = {};
    // Vite calls config(userConfig, env); the hook mutates/returns define.
    const hook = typeof plugin.config === 'function' ? plugin.config : plugin.config?.handler;
    const ret = hook?.call(
      undefined as never,
      cfg as never,
      {
        command: 'serve',
        mode: 'development',
      } as never,
    );
    const define = (ret as { define?: Record<string, string> } | undefined)?.define ?? cfg.define;
    expect(define).toBeDefined();
    expect(define?.['import.meta.env.FORGEAX_ENGINE_RHI_DEBUG']).toBe(JSON.stringify('1'));
  });

  it('injects import.meta.env.FORGEAX_ENGINE_RHI_DEBUG = "0" for build', () => {
    const plugin = asPlugin();
    const hook = typeof plugin.config === 'function' ? plugin.config : plugin.config?.handler;
    const ret = hook?.call(
      undefined as never,
      {} as never,
      {
        command: 'build',
        mode: 'production',
      } as never,
    );
    const define = (ret as { define?: Record<string, string> } | undefined)?.define;
    expect(define?.['import.meta.env.FORGEAX_ENGINE_RHI_DEBUG']).toBe(JSON.stringify('0'));
  });
});

// ─── vite build constant-fold (enabled vs not) ───────────────────────────────

describe('vite build constant-fold (w12)', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'forgeax-vprd-define-'));
    // Entry reads the guard flag and exports it, so the bundler cannot dead-strip
    // the reference; whether it folds to "1" depends on define injection.
    await writeFile(
      join(tmpRoot, 'entry.js'),
      'export const flag = import.meta.env.FORGEAX_ENGINE_RHI_DEBUG;\n',
    );
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function buildCode(withPlugin: boolean): Promise<string> {
    const output = await build({
      root: tmpRoot,
      logLevel: 'silent',
      plugins: withPlugin ? [asPlugin()] : [],
      build: {
        write: false,
        minify: false,
        lib: {
          entry: join(tmpRoot, 'entry.js'),
          formats: ['es'],
          fileName: 'out',
        },
      },
    });
    const arr = Array.isArray(output) ? output : [output];
    const chunks = arr.flatMap((o) => ('output' in o ? o.output : []));
    return chunks.map((c) => ('code' in c ? c.code : '')).join('\n');
  }

  it('with plugin: production bundle folds the flag to the literal "0"', async () => {
    const code = await buildCode(true);
    // define replaces `import.meta.env.FORGEAX_ENGINE_RHI_DEBUG` with "0".
    expect(code).toContain('"0"');
    expect(code).not.toContain('FORGEAX_ENGINE_RHI_DEBUG');
  });

  it('without plugin: bundle retains no FORGEAX_ENGINE_RHI_DEBUG literal residue', async () => {
    const code = await buildCode(false);
    expect(code).not.toContain('FORGEAX_ENGINE_RHI_DEBUG');
  });
});
