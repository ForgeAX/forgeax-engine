import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { loadDocumentReference } from '../src/app/document-reference.ts';
import { once } from 'node:events';
import { randomFillSync } from 'node:crypto';
import { chromium } from 'playwright';
import { createViewService } from '../src/app/service.mjs';
import { installNetworkRuntime } from '../src/app/network-runtime.ts';
import { MCP_NATIVE_IMPORT_SOURCE } from '../src/contract.ts';
import { readResourceBytes } from '../src/app/resource-bytes.ts';

const large = randomFillSync(Buffer.alloc(400001));
const checksum = bytes => { let hash=2166136261; for(const byte of bytes) hash=Math.imul(hash^byte,16777619)>>>0; return hash; };
let base, documentHtml, service, browser;
const bootstrap = MCP_NATIVE_IMPORT_SOURCE;
const entry = () => `const HTTP_BATCH_SIZE=16; const MCP_NATIVE_IMPORT_SOURCE=${JSON.stringify(bootstrap)};
const readResourceBytes=${readResourceBytes.toString()};
const nativeFetch=fetch.bind(globalThis);
const invoke=async args => { const response=await nativeFetch(${JSON.stringify(base + '/tool')},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(args)}); if(!response.ok)throw new Error(await response.text());return response.json(); };
(${installNetworkRuntime.toString()})(globalThis,invoke,${JSON.stringify(base + '/index.html')});
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
    if (request.url === '/entry.mjs' || request.url === '/worker.mjs') {
      response.setHeader('content-type', 'text/javascript');
      response.end(request.url === '/entry.mjs' ? entry() : `self.onmessage=async()=>{const url='data:text/javascript,export const value=44';try{const data=new Uint8Array(await(await fetch(${JSON.stringify(base+'/large.bin')})).arrayBuffer());self.postMessage({value:(await import(url)).value,bytes:data.length,hash:(${checksum.toString()})(data)});}catch(error){self.postMessage({error:String(error)});}}`); return;
    }
    response.setHeader('content-type', 'text/html');
    response.end(request.url === '/document' ? documentHtml : request.url === '/index.html'
      ? '<html><head></head><body><script type="module" src="/entry.mjs"></script></body></html>'
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
  await page.goto(base);
  const frame = page.frameLocator('iframe').locator('html');
  await frame.evaluate(() => new Promise((resolve, reject) => {
    const timer = setInterval(() => { if (globalThis.fixture) { clearInterval(timer); resolve(); } }, 10);
    setTimeout(() => { clearInterval(timer); reject(new Error('Runtime fixture not installed')); }, 10000);
  }));
  assert.deepEqual(await frame.evaluate(() => globalThis.fixture.imports()), { value: 42, same: true, blob: 43 });
  assert.deepEqual(await frame.evaluate(() => globalThis.fixture.bytes()), { bytes:large.length,hash:checksum(large) });
  assert.deepEqual(await frame.evaluate(() => globalThis.fixture.worker()), { value: 44,bytes:large.length,hash:checksum(large) });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, boundary: 'actual remote compiler + isolated document and Worker native module imports; no Engine/GPU qualification' }));
} finally { await browser?.close(); service?.close(); await new Promise(resolve => server.close(resolve)); }
