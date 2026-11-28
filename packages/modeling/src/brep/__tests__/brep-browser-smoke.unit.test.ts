import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { build } from 'tsup';
import { describe, expect, it } from 'vitest';
import { brepClosure, SRC } from '../../__tests__/digest-guard';

const entry = `${SRC}brep/index.ts`;

let cached: Promise<string> | undefined;

/** The shipped entry as a minified browser IIFE, built by the package's own bundler. */
function bundle(): Promise<string> {
  cached ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), 'brep-smoke-'));
    try {
      await build({
        entry: { brep: entry },
        outDir: dir,
        format: ['iife'],
        globalName: 'brep',
        platform: 'browser',
        target: 'es2022',
        minify: true,
        sourcemap: false,
        dts: false,
        clean: false,
        silent: true,
        config: false,
        noExternal: [/.*/],
        outExtension: () => ({ js: '.js' }),
      });
      return readFileSync(join(dir, 'brep.js'), 'utf8');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
  return cached;
}

describe('./brep import smoke (browser and Worker)', () => {
  it('bundles for the browser platform: no Node module in the closure', async () => {
    const text = await bundle();
    // A guarded `process.getBuiltinModule('node:x')` probe is a string, not an import: it is absent
    // in a browser, and the next test runs the bundle without Node globals.
    const loaded = text.replace(/getBuiltinModule\?\.\(["']node:[\w/]+["']\)/g, '');
    expect(loaded).not.toMatch(/node:|require\(/);
    for (const file of brepClosure().keys()) {
      expect(file.endsWith('.ts')).toBe(true);
    }
  });

  it('runs in a context with no Node globals and builds, validates and tessellates a box', async () => {
    const text = await bundle();
    const context = createContext({});
    expect(runInContext('typeof process + typeof Buffer + typeof require', context)).toBe(
      'undefinedundefinedundefined',
    );
    const brep = runInContext(`${text}; brep`, context) as typeof import('../index');
    const shape = brep.box({ size: [1, 2, 3] });
    expect(shape.ok).toBe(true);
    if (!shape.ok) return;
    expect(brep.validate(shape.value).ok).toBe(true);
    const mesh = brep.tessellate(shape.value);
    expect(mesh.ok && mesh.value.faceCount).toBe(6);
  });

  it('the bundle is small and game code that never imports ./brep pays nothing', async () => {
    const text = await bundle();
    // Measured on this branch: the minified ./brep bundle is 405,211 bytes after the merged v2 exact-stage
    // features. The bound keeps headroom over that measurement and stays far below the main entry
    // (about 2.5 MB unminified), so game code that never imports ./brep does not pull it in by accident.
    expect(text.length).toBeLessThan(450_000);
  });
});
