import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { loadDocumentReference } from '../src/app/document-reference.ts';
import { once } from 'node:events';
import { randomFillSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { preparePackProgram } from '@forgeax/engine/pack/runtime';
import { createViewService } from '../src/app/service.mjs';
import { installNetworkRuntime } from '../src/app/network-runtime.ts';
import { MCP_NATIVE_IMPORT_SOURCE } from '../src/contract.ts';
import { readResourceBytes } from '../src/app/resource-bytes.ts';

const large = randomFillSync(Buffer.alloc(400001));
const checksum = bytes => { let hash=2166136261; for(const byte of bytes) hash=Math.imul(hash^byte,16777619)>>>0; return hash; };
const programFixture = await build({
  stdin: { contents: `export { createMcpProgramHosts } from './src/app/program-host.ts';`, resolveDir: resolve(import.meta.dirname, '..') },
  bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'McpProgramHostFixture', target: 'es2022',
});
const previewSource = await readFile(new URL('../dist/preview-runtime.mjs', import.meta.url), 'utf8');
const previewProgram = preparePackProgram({ entry: 'preview.mjs', export: 'default', modules: { 'preview.mjs': previewSource } }).unwrap();
const counterProgram = preparePackProgram({ entry: 'counter.mjs', export: 'next', modules: {
  'counter.mjs': 'export let value = 0; export function next() { return ++value; } export const meta = { url: import.meta.url, absolute: import.meta.resolve("https://assets.fixture.invalid/value.bin") }; export function relativeResourceRejected() { try { new URL("./not-admitted.bin", import.meta.url); return false; } catch (error) { return error instanceof TypeError; } }',
} }).unwrap();
let base, documentHtml, service, browser;
const bootstrap = MCP_NATIVE_IMPORT_SOURCE;
const entry = () => `const HTTP_BATCH_SIZE=16; const MCP_NATIVE_IMPORT_SOURCE=${JSON.stringify(bootstrap)};
const readResourceBytes=${readResourceBytes.toString()};
const nativeFetch=fetch.bind(globalThis);
const invoke=async args => { const response=await nativeFetch(${JSON.stringify(base + '/tool')},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(args)}); if(!response.ok)throw new Error(await response.text());return response.json(); };
(${installNetworkRuntime.toString()})(globalThis,invoke,${JSON.stringify(base + '/index.html')});
${programFixture.outputFiles[0].text}
const programs=async()=>{const fixturePrograms=await(await fetch(${JSON.stringify(base+'/programs.json')})).json();const hosts=McpProgramHostFixture.createMcpProgramHosts(globalThis,invoke,ref=>readResourceBytes(ref,invoke));try{const host=hosts.create({},async()=>{throw new Error('fixture programs declare no external imports');});const preview=await host.importModule(await host.publish(fixturePrograms.preview,{}));const counterUrl=await host.publish(fixturePrograms.counter,{});const counter=await host.importModule(counterUrl);return {preview:preview.default.name,prepare:preview.preparePlatform.name,counter:[counter.next(),counter.next(),counter.value],meta:{...counter.meta,publishedUrl:counterUrl.split('#')[0],relativeRejected:counter.relativeResourceRejected()}};}finally{hosts.dispose();}};
globalThis.runFixturePrograms=programs;
globalThis.fixture={async imports(){const url='data:text/javascript,export const value=42;export const token={};';const first=await __fxMcpImport(url);const second=await __fxMcpImport(url);const blob=URL.createObjectURL(new Blob(['export const value=43'],{type:'text/javascript'}));try{return {value:first.value,same:first===second,blob:(await __fxMcpImport(blob)).value};}finally{URL.revokeObjectURL(blob);}},async bytes(){const data=new Uint8Array(await(await fetch(${JSON.stringify(base+'/large.bin')})).arrayBuffer());return {bytes:data.length,hash:(${checksum.toString()})(data)};},async worker(){return new Promise((resolve,reject)=>{const worker=new Worker(${JSON.stringify(base + '/worker.mjs')},{type:'module'});const timer=setTimeout(()=>{worker.terminate();reject(new Error('Worker import timed out'));},10000);worker.onmessage=e=>{clearTimeout(timer);worker.terminate();resolve(e.data);};worker.onerror=e=>reject(new Error(e.message));worker.postMessage('start');});}};`;
const server = createServer(async (request, response) => {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-headers', 'content-type');
  try {
    if (request.method === 'OPTIONS') { response.end(); return; }
    if (request.url === '/tool') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(await service.invoke(JSON.parse(Buffer.concat(chunks))))); return;
    }
    if (request.url === '/large.bin') { response.setHeader('content-type','application/octet-stream');response.end(large);return; }
    if (request.url === '/programs.json') { response.setHeader('content-type', 'application/json');response.end(JSON.stringify({ preview: previewProgram, counter: counterProgram }));return; }
    if (request.url === '/entry.mjs' || request.url === '/worker.mjs') {
      response.setHeader('content-type', 'text/javascript');
      response.end(request.url === '/entry.mjs' ? entry() : `self.onmessage=async()=>{const url='data:text/javascript,export const value=44';try{const data=new Uint8Array(await(await fetch(${JSON.stringify(base+'/large.bin')})).arrayBuffer());self.postMessage({value:(await import(url)).value,bytes:data.length,hash:(${checksum.toString()})(data)});}catch(error){self.postMessage({error:String(error)});}}`); return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(request.url === '/document' ? documentHtml : request.url === '/index.html'
      ? '<html><head><meta charset="utf-8"></head><body><script type="module" src="/entry.mjs"></script></body></html>'
      : '<iframe sandbox="allow-scripts" src="/document"></iframe>');
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  service = createViewService({ root: '/native-import-fixture', request: async () => ({ ok: true, value: { url: base, presentationId: 'native-import-fixture' } }) });
  const reference = await loadDocumentReference(args => service.invoke(args), base + '/index.html');
  documentHtml = new TextDecoder().decode(await readResourceBytes(reference, args => service.invoke(args)));
  browser = await chromium.launch({ executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE,
    headless: true, args: ['--disable-gpu'], chromiumSandbox: true });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const consoleErrors = []; page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.goto(base);
  const frame = page.frameLocator('iframe').locator('html');
  try {
    await frame.evaluate(() => new Promise((resolve, reject) => {
      const timer = setInterval(() => { if (globalThis.fixture) { clearInterval(timer); resolve(); } }, 10);
      setTimeout(() => { clearInterval(timer); reject(new Error('Runtime fixture not installed')); }, 10000);
    }));
  } catch (error) {
    console.error(JSON.stringify({ stage: 'runtime-fixture', errors, consoleErrors }));
    throw error;
  }
  assert.deepEqual(await frame.evaluate(() => globalThis.fixture.imports()), { value: 42, same: true, blob: 43 });
  const loadedPrograms = await frame.evaluate(() => globalThis.runFixturePrograms());
  assert.deepEqual([loadedPrograms.preview, loadedPrograms.prepare, loadedPrograms.counter], ['forgeax.mcp.preview', 'forgeax.mcp.preview.platform', [1, 2, 2]]);
  assert.match(loadedPrograms.meta.url, /^blob:/);
  assert.equal(loadedPrograms.meta.url, loadedPrograms.meta.publishedUrl);
  assert.equal(loadedPrograms.meta.absolute, 'https://assets.fixture.invalid/value.bin');
  assert.equal(loadedPrograms.meta.relativeRejected, true, 'relative resource paths must not silently resolve against the virtual graph or project');
  assert.deepEqual(await frame.evaluate(() => globalThis.fixture.bytes()), { bytes:large.length,hash:checksum(large) });
  assert.deepEqual(await frame.evaluate(() => globalThis.fixture.worker()), { value: 44,bytes:large.length,hash:checksum(large) });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, loadedPrograms, boundary: 'actual remote compiler, produced preview/program Blob execution, isolated document and Worker native module imports; no Engine/GPU qualification' }));
} finally { await browser?.close(); service?.close(); await new Promise(resolve => server.close(resolve)); }
