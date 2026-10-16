import { afterEach, expect, it, vi } from 'vitest';
import { classifyUiAuthoring, parseCssAuthoring, validateUiAuthoring } from '../authoring/index.js';
import { createUiImporter, importUiSource } from '../importer/index.js';
import { createUiLoader } from '../loader.js';
import { mountUi } from '../mount.js';

it('locates the public portable CSS profile while retaining browser-only authoring', () => {
  const css = '.panel { text-overflow: ellipsis; }';
  const portable = parseCssAuthoring(css, 'hud.ui.css');
  expect(portable.diagnostics).toContainEqual(
    expect.objectContaining({
      code: 'unsupported-css-property',
      severity: 'error',
      hint: expect.stringContaining('forgeax project check --json'),
    }),
  );
  expect(parseCssAuthoring(css, 'hud.ui.css', { browserExtensions: ['css'] }).diagnostics).toEqual(
    [],
  );
});

const source = {
  guid: 'browser-hud',
  sourcePath: 'hud.ui.html',
  html: '<section class="panel">Score</section>',
  css: '.panel { backdrop-filter: blur(10px); }',
  browserExtensions: ['backdrop-filter'] as const,
};
const browserSource = {
  ...source,
  guid: 'browser-css-hud',
  browserExtensions: ['css', 'backdrop-filter'] as const,
  css: `.panel {
    border-image: linear-gradient(red, blue) 1;
    text-overflow: ellipsis; outline-offset: 2px; appearance: none;
    fill: currentColor; stroke: red; stroke-width: 2;
    -webkit-font-smoothing: none; -moz-osx-font-smoothing: unset;
    scrollbar-width: thin; overscroll-behavior: contain;
    filter: grayscale(.25) brightness(.72); position: sticky;
    backdrop-filter: blur(10px);
  }
  .panel::before { content: attr(data-mark); }
  .panel::-webkit-scrollbar { width: 4px; }
  @media (prefers-contrast: more) { .panel { color: white; } }`,
};
afterEach(() => vi.unstubAllGlobals());

it('admits explicit browser CSS without claiming portable implementation support', () => {
  expect(classifyUiAuthoring(browserSource)).toMatchObject({
    category: 'runtime-bound',
    blocking: false,
  });
  expect(classifyUiAuthoring({ ...browserSource, browserExtensions: [] }).blocking).toBe(true);
});

it.each([
  ['.panel { width: red; }', 'css-invalid-value'],
  ['.panel { made-up-property: 1; }', 'unknown-css-property'],
  ['.panel { color: red;', 'css-syntax-error'],
  ['@import "other.css";', 'runtime-css-rule'],
  ['.panel { background: url(https://example.com/image.png); }', 'runtime-url'],
  ['.panel { background: url(../escape.png); }', 'root-absolute-url'],
])('retains source diagnostics for browser CSS %s', (css, code) => {
  const result = classifyUiAuthoring({ ...browserSource, css });
  expect(result.blocking).toBe(true);
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code, sourcePath: 'hud.ui.css' }),
  );
});

it('keeps browser CSS companion escape and HTML scripting outside the asset boundary', async () => {
  const escaped = await validateUiAuthoring({
    ...browserSource,
    css: '.panel { background: url(media/%2e%2e/%2e%2e/outside.png); }',
    readCompanion: async () => ({ ok: true }),
  });
  expect(escaped).toMatchObject({ ok: false, error: { code: 'source-validation-failed' } });
  for (const html of ['<script>window.run()</script>', '<button onclick="run()">Run</button>'])
    expect(classifyUiAuthoring({ ...browserSource, html }).blocking).toBe(true);
});

it('checks receiving CSS capabilities before mount and preserves authored browser CSS', () => {
  const root = document.createElement('div');
  root.innerHTML = '<p>Existing UI</p>';
  expect(mountUi(browserSource, { root, layer: 1 })).toMatchObject({
    ok: false,
    error: { code: 'invalid-environment' },
  });
  expect(root.innerHTML).toBe('<p>Existing UI</p>');
  const supports = vi.fn(
    (property: string, value?: string) =>
      property === 'selector(:host)' || (property === 'display' && value === 'grid'),
  );
  vi.stubGlobal('CSS', { supports });
  expect(mountUi(browserSource, { root, layer: 1 })).toMatchObject({
    ok: false,
    error: {
      code: 'invalid-environment',
      detail: { diagnostics: [expect.objectContaining({ actual: 'backdrop-filter' })] },
    },
  });
  expect(root.innerHTML).toBe('<p>Existing UI</p>');
  supports.mockImplementation(
    (property, value) =>
      property === 'selector(:host)' ||
      (property === 'display' && value === 'grid') ||
      (property === 'backdrop-filter' && value === 'blur(1px)'),
  );
  const mounted = mountUi(browserSource, { root, layer: 1 });
  if (!mounted.ok) throw mounted.error;
  const css = mounted.value.host.shadowRoot?.querySelector('style')?.textContent;
  expect(css).toContain('text-overflow:ellipsis');
  expect(css).toContain('filter:grayscale(.25) brightness(.72)');
  expect(css).toContain('.panel::-webkit-scrollbar');
  expect(css).toContain('content:attr(data-mark)');
  expect(css).toContain('-moz-osx-font-smoothing:unset');
  mounted.value.dispose();
  expect(root.innerHTML).toBe('<p>Existing UI</p>');
});

it('keeps declared browser source distinct from portable support and validates CSS values', () => {
  expect(classifyUiAuthoring(source)).toMatchObject({ category: 'runtime-bound', blocking: false });
  const invalid = classifyUiAuthoring({ ...source, css: '.panel { backdrop-filter: blur(red); }' });
  expect(invalid.blocking).toBe(true);
  expect(invalid.diagnostics).toContainEqual(
    expect.objectContaining({ code: 'css-invalid-value', sourcePath: 'hud.ui.css' }),
  );
  expect(classifyUiAuthoring({ ...source, browserExtensions: [] }).diagnostics).toContainEqual(
    expect.objectContaining({ code: 'unsupported-css-property' }),
  );
});

it.each([
  source,
  browserSource,
])('preserves $guid requirements through both import paths and the publication loader', async (source) => {
  const direct = importUiSource(source);
  if (!direct.ok) throw direct.error;
  const imported = await createUiImporter().import({
    source: 'hud.ui.html',
    subAssets: [{ guid: source.guid, sourceIndex: 0, kind: 'ui' }],
    importSettings: { browserExtensions: source.browserExtensions },
    readSource: async () => ({ ok: true, value: new TextEncoder().encode(source.html) }),
    readSibling: async () => ({ ok: true, value: new TextEncoder().encode(source.css) }),
    decodeImage: async () => {
      throw new Error('UI retains companions');
    },
  });
  if (!imported.ok) throw imported.error;
  for (const result of [direct, imported]) {
    const asset = result.value.assets[0];
    if (!asset) throw new Error('missing imported UI');
    const loaded = createUiLoader().load({ ...asset, artifacts: {} });
    if (!loaded.ok) throw loaded.error;
    expect(loaded.value).toMatchObject({
      browserExtensions: source.browserExtensions,
      css: source.css,
    });
  }
  expect(
    createUiLoader().load({ ...source, browserExtensions: ['arbitrary-browser-css'] }),
  ).toMatchObject({ ok: false, error: { code: 'invalid-asset' } });
});

it('rejects an unavailable extension before changing the receiving tree and retains its source range', () => {
  const root = document.createElement('div');
  root.innerHTML = '<p>Existing UI</p>';
  const result = mountUi(source, { root, layer: 1 });
  if (result.ok || result.error.code !== 'invalid-environment')
    throw new Error('Expected unavailable browser extension');
  const diagnostic = result.error.detail.diagnostics?.[0];
  expect(diagnostic).toMatchObject({
    code: 'ui-browser-extension-unavailable',
    sourcePath: 'hud.ui.css',
    actual: 'backdrop-filter',
  });
  expect(source.css.slice(diagnostic?.sourceRange.start, diagnostic?.sourceRange.end)).toBe(
    'backdrop-filter: blur(10px)',
  );
  expect(root.innerHTML).toBe('<p>Existing UI</p>');
});
