import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { parseAst, Visitor } from 'vite';
import { describe, expect, it } from 'vitest';
import type { DistManifest } from '../dist.js';
import {
  bundleSingleHtmlEntry,
  type SingleHtmlBundle,
  type SingleHtmlBundleArtifact,
  writeSingleHtml,
} from '../single-html.js';

async function fixture(): Promise<{
  readonly root: string;
  readonly dist: string;
  readonly manifest: DistManifest;
}> {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-single-html-fixture-'));
  const dist = resolve(root, 'dist');
  await mkdir(resolve(dist, 'assets'), { recursive: true });
  await Promise.all([
    writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({
        id: 'single-html-fixture',
        name: 'Single HTML Fixture',
        schemaVersion: '1.0.0',
        entry: 'main.ts',
        roots: {},
      }),
    ),
    writeFile(
      resolve(dist, 'index.html'),
      '<!doctype html><html><head><link rel="stylesheet" href="./style.css"><style>.inline{background:url(./font.woff2)}</style></head><body><img id="logo" src="./logo.svg"><script type="module" src="./assets/app.js"></script></body></html>',
    ),
    writeFile(resolve(dist, 'style.css'), '.fixture{background:url(./font.woff2)}'),
    writeFile(resolve(dist, 'font.woff2'), Buffer.from([1, 2, 3, 4])),
    writeFile(
      resolve(dist, 'logo.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"><script>safe</script></svg>',
    ),
    writeFile(
      resolve(dist, 'assets/app.js'),
      "const marker = '</script>'; const replacement = '$&'; document.body.dataset.marker = marker + replacement;",
    ),
  ]);
  const artifacts: DistManifest['artifacts'] = [
    { path: 'style.css', mediaType: 'text/css', bytes: 0, sha256: '' },
    { path: 'font.woff2', mediaType: 'font/woff2', bytes: 0, sha256: '' },
    { path: 'logo.svg', mediaType: 'image/svg+xml', bytes: 0, sha256: '' },
    { path: 'assets/app.js', mediaType: 'text/javascript', bytes: 0, sha256: '' },
  ];
  const manifest: DistManifest = {
    schemaVersion: '1.0.0',
    project: { id: 'single-html-fixture', name: 'Single HTML Fixture' },
    base: './',
    runtime: { packIndexUrl: 'pack-index.json', shaderManifestUrl: 'shaders/manifest.json' },
    artifacts,
  };
  await writeFile(resolve(dist, 'forgeax-dist.json'), JSON.stringify(manifest));
  return { root, dist, manifest };
}

/** Deterministic incompressible bytes (xorshift32). */
function noise(length: number, seed: number): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  let x = seed >>> 0 || 1;
  for (let index = 0; index < length; index += 1) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    bytes[index] = x & 0xff;
  }
  return bytes;
}

describe('single HTML delivery', () => {
  it('bundles the module, embeds resources, escapes script sentinels, and writes a checksum', async () => {
    const { root, dist, manifest } = await fixture();
    const indexHtml = await readFile(resolve(dist, 'index.html'), 'utf8');
    const bundle = await bundleSingleHtmlEntry(dist, indexHtml);
    expect(bundle.ok).toBe(true);
    if (!bundle.ok) return;
    const output = resolve(root, 'release', 'fixture.html');
    const result = await writeSingleHtml({
      distRoot: dist,
      output,
      manifest,
      bundle: bundle.value,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const html = await readFile(output, 'utf8');
    expect(html).toContain('__forgeaxSingleHtml');
    expect(html).not.toContain("const marker = '</script>'");
    expect(html).not.toContain('src="./assets/app.js"');
    expect(html).toContain('data:font/woff2;base64');
    expect(html).toContain('data:image/svg+xml;base64');
    expect(await readFile(`${output}.sha256`, 'utf8')).toContain(result.value.html.sha256);
  });

  it('stores equal resource bytes once while retaining every path and media type', async () => {
    const { root, dist, manifest } = await fixture();
    const bytes = noise(16 * 1024, 27);
    const paths = ['first.bin', 'second.wasm'];
    try {
      await Promise.all(paths.map((path) => writeFile(resolve(dist, path), bytes)));
      const result = await writeSingleHtml({
        distRoot: dist,
        output: resolve(root, 'release', 'deduplicated.html'),
        manifest: {
          ...manifest,
          artifacts: [
            ...manifest.artifacts,
            ...paths.map((path, index) => ({
              path,
              mediaType: index === 0 ? 'application/octet-stream' : 'application/wasm',
              bytes: bytes.byteLength,
              sha256: '',
            })),
          ],
        },
        bundle: { entrySource: 'globalThis.__entryRuns = 1;', artifacts: [] },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const html = await readFile(result.value.html.path, 'utf8');
      const source = html.match(/id="forgeax-asset-payload"[^>]*>([\s\S]*?)<\/script>/)?.[1];
      const entries = JSON.parse(source ?? '[]') as {
        readonly path: string;
        readonly mime: string;
        readonly index: number;
      }[];
      const first = entries.find(({ path }) => path === paths[0]);
      const second = entries.find(({ path }) => path === paths[1]);
      expect(first?.mime).toBe('application/octet-stream');
      expect(second?.mime).toBe('application/wasm');
      expect(first?.index).toBeDefined();
      expect(second?.index).toBe(first?.index);
      expect(html.split(bytes.toString('base64'))).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when a local stylesheet resource is outside the verified closure', async () => {
    const { dist, manifest } = await fixture();
    await writeFile(
      resolve(dist, 'index.html'),
      '<html><head><link rel="stylesheet" href="./missing.css"></head><body></body></html>',
    );
    const bundle: {
      readonly entrySource: string;
      readonly artifacts: readonly SingleHtmlBundleArtifact[];
    } = { entrySource: '', artifacts: [] };
    const result = await writeSingleHtml({
      distRoot: dist,
      output: resolve(dist, '../bad.html'),
      manifest,
      bundle,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('single-html-css-asset-missing');
  });

  it('bundles an inline module entry instead of treating its source as a path', async () => {
    const { dist } = await fixture();
    const bundle = await bundleSingleHtmlEntry(
      dist,
      '<html><body><script type="module">document.body.dataset.inline = "true";</script></body></html>',
    );
    expect(bundle.ok).toBe(true);
    if (bundle.ok) expect(bundle.value.entrySource).toContain('dataset.inline');
  });

  it('bundles ordered local module entries with one evaluation of their shared dependency', async () => {
    const { dist } = await fixture();
    await writeFile(
      resolve(dist, 'assets/shared.js'),
      'globalThis.__singleHtmlOrder.push("shared");',
    );
    await writeFile(
      resolve(dist, 'assets/first.js'),
      'import "./shared.js"; globalThis.__singleHtmlOrder.push("first");',
    );
    await writeFile(
      resolve(dist, 'assets/second.js'),
      'import "./shared.js"; globalThis.__singleHtmlOrder.push("second");',
    );
    const result = await bundleSingleHtmlEntry(
      dist,
      '<script type="module" src="./assets/first.js"></script><script type="module" src="./assets/second.js"></script>',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const order: string[] = [];
    new Function('globalThis', result.value.entrySource)({ __singleHtmlOrder: order });
    expect(order).toEqual(['shared', 'first', 'second']);
  });

  it('packages prebuilt worker graphs without recursively rebuilding cyclic worker references', async () => {
    const { dist } = await fixture();
    await writeFile(
      resolve(dist, 'assets/app.js'),
      'globalThis.worker = new Worker(new URL("./engine.js", import.meta.url), {type:"module"});',
    );
    await writeFile(
      resolve(dist, 'assets/engine.js'),
      'import "./shared.js"; globalThis.createRender = () => new Worker(new URL(`render.js`, import.meta.url).href, {type:"module"});',
    );
    await writeFile(
      resolve(dist, 'assets/render.js'),
      'import "./shared.js"; globalThis.createEngine = () => new Worker(new URL("./engine.js", import.meta.url), {type:"module"});',
    );
    await writeFile(resolve(dist, 'assets/shared.js'), 'globalThis.workerDependency = "ready";');
    const result = await bundleSingleHtmlEntry(
      dist,
      '<script type="module" src="./assets/app.js"></script>',
    );
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBe(true);
    if (!result.ok) return;
    expect(result.value.entrySource).toContain(
      'forgeax-resource:///__forgeax-bundle/assets/engine.js',
    );
    for (const name of ['engine', 'render']) {
      const worker = result.value.artifacts.find(
        (row) => row.path === `__forgeax-bundle/assets/${name}.js`,
      );
      expect(worker).toBeDefined();
      const source = Buffer.from(worker?.bytes ?? []).toString('utf8');
      expect(source).toContain('workerDependency');
      expect(source).not.toContain('import "./shared.js"');
    }
  });

  it('closes generated chunks that statically import a raw dist dependency', async () => {
    const { root, dist, manifest } = await fixture();
    const dependency = Buffer.from(
      'export const value = 42; export const createWorker = () => new Worker(new URL(`worker.js`, import.meta.url).href, {type: "module"});',
    );
    await writeFile(resolve(dist, 'assets/dependency.js'), dependency);
    await writeFile(resolve(dist, 'assets/worker.js'), 'postMessage(42);');
    const result = await writeSingleHtml({
      distRoot: dist,
      output: resolve(root, 'release', 'cross-namespace.html'),
      manifest: {
        ...manifest,
        artifacts: [
          ...manifest.artifacts,
          {
            path: 'assets/dependency.js',
            mediaType: 'text/javascript',
            bytes: dependency.length,
            sha256: '',
          },
        ],
      },
      bundle: {
        entrySource: '',
        artifacts: [
          {
            path: '__forgeax-bundle/assets/worker.js',
            mediaType: 'text/javascript',
            bytes: Buffer.from('postMessage(42);'),
          },
          {
            path: '__forgeax-bundle/assets/lazy.js',
            mediaType: 'text/javascript',
            bytes: Buffer.from(
              'import {value} from "./dependency.js"; globalThis.lazyValue = value;',
            ),
          },
        ],
      },
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBe(true);
  });

  it('writes a large single-html closure with lazy resource nodes and a matching digest', async () => {
    const { root, dist, manifest } = await fixture();
    // Incompressible bytes stay stored as they are (compressible ones are gzip-stored).
    const large = noise(8 * 1024 * 1024, 17);
    const worker = Buffer.from(
      "new Worker(new URL('./nested-worker.js', import.meta.url), { type: 'module' });\n",
    );
    const nestedWorker = Buffer.from('postMessage({ kind: "nested-ready" });\n');
    const largeManifest: DistManifest = {
      ...manifest,
      artifacts: [
        ...manifest.artifacts,
        {
          path: 'large.bin',
          mediaType: 'application/octet-stream',
          bytes: large.length,
          sha256: '',
        },
        { path: 'worker.js', mediaType: 'text/javascript', bytes: worker.length, sha256: '' },
        {
          path: 'nested-worker.js',
          mediaType: 'text/javascript',
          bytes: nestedWorker.length,
          sha256: '',
        },
      ],
    };
    await writeFile(resolve(dist, 'large.bin'), large);
    await writeFile(resolve(dist, 'worker.js'), worker);
    await writeFile(resolve(dist, 'nested-worker.js'), nestedWorker);
    try {
      const output = resolve(root, 'release', 'large.html');
      const bundle: SingleHtmlBundle = {
        entrySource: "new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });",
        artifacts: [],
      };
      const result = await writeSingleHtml({
        distRoot: dist,
        output,
        manifest: largeManifest,
        bundle,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const html = await readFile(output, 'utf8');
      const payloadMarker = 'data-forgeax-asset-payload';
      expect(html.match(new RegExp(payloadMarker, 'g'))).toHaveLength(1);
      const encodedLarge = large.toString('base64');
      expect(html).toContain(encodedLarge);
      const bootstrapStart = html.indexOf('<script type="application/javascript">');
      const bootstrapEnd = html.indexOf('</script>', bootstrapStart);
      expect(bootstrapStart).toBeGreaterThanOrEqual(0);
      expect(bootstrapEnd).toBeGreaterThan(bootstrapStart);
      expect(html.slice(bootstrapStart, bootstrapEnd)).not.toContain(encodedLarge.slice(0, 256));
      const digest = createHash('sha256').update(html).digest('hex');
      expect(result.value.html.sha256).toBe(digest);
      expect(await readFile(`${output}.sha256`, 'utf8')).toBe(`${digest}  ${basename(output)}\n`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('converges production preload helpers and audits every emitted JavaScript artifact', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-single-html-production-shape-'));
    const dist = resolve(root, 'dist');
    await mkdir(resolve(dist, 'assets'), { recursive: true });
    try {
      await Promise.all([
        writeFile(
          resolve(dist, 'index.html'),
          '<html><body><script type="module" src="./assets/app.js"></script></body></html>',
        ),
        writeFile(
          resolve(dist, 'assets/preload-helper-production.js'),
          'export function __vitePreload(loader, deps, base) { return loader(); }',
        ),
        writeFile(resolve(dist, 'assets/optional.js'), 'export const value = 42;'),
        writeFile(
          resolve(dist, 'assets/app.js'),
          `import { __vitePreload as compile } from './preload-helper-production.js';
const __vite__mapDeps = (indexes) => indexes.map((index) => ['optional.js'][index]);
const optional = './optional.js';
const compileSource = (compile, entry) => compile('depth_pyramid_seed', entry.wgsl);
const prewarm = compileSource((label, source) => source, { wgsl: 'shader-code' });
globalThis.__prewarm = prewarm;
const result = await compile(() => import(optional), __vite__mapDeps([0]), import.meta.url);
new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }).postMessage(result.value);
`,
        ),
        writeFile(
          resolve(dist, 'assets/worker.js'),
          `const optional = './optional.js';
self.onmessage = async () => self.postMessage((await import(optional)).value);
`,
        ),
      ]);

      const indexHtml = await readFile(resolve(dist, 'index.html'), 'utf8');
      const bundle = await bundleSingleHtmlEntry(dist, indexHtml);
      expect(bundle.ok).toBe(true);
      if (!bundle.ok) return;

      expect(bundle.value.entrySource).toContain('globalThis.__forgeaxImport');
      expect(bundle.value.entrySource).toContain('void 0');
      expect(bundle.value.entrySource).toMatch(
        /compile\(\s*['"]depth_pyramid_seed['"]\s*,\s*entry\.wgsl\s*\)/,
      );
      const javascript = [
        bundle.value.entrySource,
        ...bundle.value.artifacts
          .filter((artifact) => /\.(?:c?js|mjs)$/i.test(artifact.path))
          .map((artifact) => Buffer.from(artifact.bytes).toString('utf8')),
      ];
      expect(javascript.some((source) => source.includes('new Worker'))).toBe(true);
      let nativeDynamicImports = 0;
      for (const source of javascript) {
        new Visitor({
          ImportExpression() {
            nativeDynamicImports += 1;
          },
        }).visit(parseAst(source));
      }
      expect(nativeDynamicImports).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
