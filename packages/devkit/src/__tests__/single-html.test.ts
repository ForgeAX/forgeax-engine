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
    expect(html).toContain('<\\/script>');
    expect(html).not.toContain('src="./assets/app.js"');
    expect(html).toContain('data:font/woff2;base64');
    expect(html).toContain('data:image/svg+xml;base64');
    expect(await readFile(`${output}.sha256`, 'utf8')).toContain(result.value.html.sha256);
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

  it('writes a large single-html closure with lazy resource nodes and a matching digest', async () => {
    const { root, dist, manifest } = await fixture();
    const large = Buffer.allocUnsafe(8 * 1024 * 1024);
    for (let index = 0; index < large.length; index += 1) {
      large[index] = (index * 31 + 17) & 0xff;
    }
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
