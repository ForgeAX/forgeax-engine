import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { it } from 'node:test';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { inspectorEntityFromInspection } from '../packages/view-plugin-inspector/src/inspection.ts';
import { nativeCloudAssets, nativeCloudInspection } from './support/inspector-native-cloud.fixture.mjs';

const root = resolve(import.meta.dirname, '..');
const { outputFiles } = await build({
  stdin: { contents: `import { setLocale } from './packages/view-plugin-inspector/src/i18n/index.ts';
setLocale('en');
export { AssetReferenceField } from './packages/view-components/src/AssetReferenceField.tsx';
export { InspectorAssetReference } from './packages/view-plugin-inspector/src/ui/InspectorAssetReference.tsx';`, resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
  loader: { '.css': 'empty' },
  external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
});
const compiled = { exports: {} };
new Function('require', 'module', 'exports', outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
const { AssetReferenceField, InspectorAssetReference } = compiled.exports;
const value = { guid: 'cloud-material', name: 'Reference Cloud', kind: 'cloud-material' };
const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const button = (html, label) => (html.match(/<button\b[^>]*>/g) ?? []).find(tag => tag.includes(`aria-label="${label}"`));

it('read-only references omit authoring actions and expose one enabled directory command', () => {
  const html = render(AssetReferenceField, { value, readOnly: true, onOpen() {}, onReveal() {},
    onBrowse() {}, onUseSelection() {}, onClear() {} });
  assert.equal(button(html, 'Use selected asset'), undefined);
  assert.equal(button(html, 'Browse to Asset'), undefined);
  const reveal = button(html, 'Reveal in Content Browser');
  assert(reveal);
  assert.doesNotMatch(reveal, /\sdisabled(?:=|\s|>)/);
  assert.equal((html.match(/data-testid="asset-reference-field"/g) ?? []).length, 1);
});

it('the default reference mode retains its existing authoring and browse controls', () => {
  const html = render(AssetReferenceField, { value, onOpen() {}, onReveal() {}, onBrowse() {}, onUseSelection() {}, onClear() {} });
  for (const label of ['Use selected asset', 'Browse to Asset', 'Reveal in Content Browser']) {
    const control = button(html, label);
    assert(control, label);
    assert.doesNotMatch(control, /\sdisabled(?:=|\s|>)/, label);
  }
});

it('Inspector resource facts opt into read-only navigation with the existing browse callback', () => {
  const html = render(InspectorAssetReference, { reference: { guid: value.guid, kind: value.kind,
    rawValue: 1030, status: 'resolved', asset: { ...value, path: 'assets/clouds/clouds.pack.ts' } },
  openAsset() {}, browseAsset() {}, inline: true });
  assert.equal(button(html, 'Use selected asset'), undefined);
  assert.equal(button(html, 'Browse to Asset'), undefined);
  const reveal = button(html, 'Reveal in Content Browser');
  assert(reveal);
  assert.doesNotMatch(reveal, /\sdisabled(?:=|\s|>)/);
});

it('read-only unresolved references keep navigation disabled without authoring affordances', () => {
  const html = render(AssetReferenceField, { readOnly: true, value: { name: 'Unresolved material', kind: 'cloud-material' } });
  assert.equal(button(html, 'Use selected asset'), undefined);
  assert.match(button(html, 'Reveal in Content Browser'), /\sdisabled(?:=|\s|>)/);
  assert.match(html, /Asset identity unavailable/);
});

it('renders atomic Native Play material identities as read-only navigable facts', () => {
  const source = inspectorEntityFromInspection(nativeCloudInspection, nativeCloudAssets);
  for (const field of source.components[0].fields) {
    const html = render(InspectorAssetReference, { reference: field.resource, openAsset() {}, browseAsset() {}, inline: true });
    assert.doesNotMatch(html, /Asset identity unavailable/);
    assert.match(html, new RegExp(field.key === 'material' ? 'material/cloud-band' : 'instance/cloud-band-wide'));
    assert.doesNotMatch(button(html, 'Reveal in Content Browser'), /\sdisabled(?:=|\s|>)/);
    assert.equal(button(html, 'Use selected asset'), undefined);
  }
});
