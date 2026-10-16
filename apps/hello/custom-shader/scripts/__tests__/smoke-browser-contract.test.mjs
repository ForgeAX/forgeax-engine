import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseViteServerUrl } from '../server-url.mjs';

const script = readFileSync(fileURLToPath(new URL('../smoke-browser.mjs', import.meta.url)), 'utf8');
const semanticScript = readFileSync(
  fileURLToPath(new URL('../smoke-material-semantics.mjs', import.meta.url)),
  'utf8',
);

test('custom-shader browser smoke respects the explicit headless override', () => {
  assert.match(script, /const browserHeadless = !\['0', 'false'\]\.includes\(/);
  assert.match(script, /headless: browserHeadless/);
  assert.doesNotMatch(script, /headless: true/);
});

test('custom-shader browser smoke parses ANSI-colored Vite Local output', () => {
  const output = '\u001b[1mLocal\u001b[22m: \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m';
  assert.equal(parseViteServerUrl(output), 'http://localhost:5173/');
});

test('custom-shader browser smoke waits for non-empty readback', () => {
  assert.match(script, /diagnostics\.readback\.nonZeroBytes > 0/);
});

test('semantic browser witness consumes the carrier WebGPU field', () => {
  assert.match(semanticScript, /evidence\?\.browserCarrier\?\.webgpu === true/);
  assert.doesNotMatch(semanticScript, /evidence\.renderDiagnostics\?\.readback/);
});

test('semantic material witness declares the forward pass tag used by Standard', () => {
  assert.match(semanticScript, /tags: \{ LightMode: 'Forward' \}/);
});

test('custom-shader browser smoke projects engine-owned readback evidence', () => {
  assert.match(script, /webgpu: evidence\.webgpu/);
  assert.match(script, /renderDiagnostics: evidence\.renderDiagnostics/);
});

test('custom-shader browser smoke validates the expected material GUID from app evidence', () => {
  assert.match(script, /evidence\.rootGuid\?\.toLowerCase\(\) ===/);
  assert.doesNotMatch(script, /evidence\.materialIdentity\?\.materialGuid/);
});
