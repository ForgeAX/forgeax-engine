import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { bundlePhoneGlLink } from './bundle_phone_gl_link.mjs';

const { values } = parseArgs({ options: { out: { type: 'string' }, 'engine-root': { type: 'string' } } });
if (!values.out) throw Error('Usage: node verify_phone_gl_link_browser.mjs --out NEW_DIRECTORY [--engine-root CHECKOUT]');
const out = resolve(values.out);
const engine = resolve(values['engine-root'] ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
const { chromium } = createRequire(join(engine, 'package.json'))('playwright');
const prefix = await bundlePhoneGlLink(engine);
await mkdir(out);
const sourceIdentity = { manifestSha256: createHash('sha256').update('collector fixture manifest').digest('hex'),
  entrySha256: createHash('sha256').update('collector fixture entry').digest('hex') };
const portProbe = createServer();
await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const receiver = spawn('python3', [fileURLToPath(new URL('./receive_phone_gl_report.py', import.meta.url)),
  '--port', String(port), '--path', '/collector-webgl-check', '--out', join(out, 'transfer'),
  '--manifest-sha256', sourceIdentity.manifestSha256, '--entry-sha256', sourceIdentity.entrySha256, '--deadline', '60']);
let receiverOutput = '', receiverError = '';
receiver.stdout.on('data', data => { receiverOutput += data; });
receiver.stderr.on('data', data => { receiverError += data; });
const receiverExit = new Promise(resolve => {
  receiver.once('exit', code => resolve(code));
  receiver.once('error', () => resolve(null));
});
let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('receiver did not become ready')), 10000);
    function ready() {
      if (receiverOutput.includes('"status": "listening"')) { clearTimeout(timer); resolve(); }
    }
    receiver.stdout.on('data', ready);
    receiver.once('error', error => { clearTimeout(timer); reject(error); });
    receiverExit.then(code => {
      if (!receiverOutput.includes('"status": "listening"')) {
        clearTimeout(timer); reject(Error(`receiver exited ${code}: ${receiverError}`));
      }
    });
    ready();
  });
  browser = await chromium.launch({ channel: 'chrome-beta', headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], chromiumSandbox: true });
  const page = await browser.newPage();
  // Same-origin page permits the browser transport without disabling CORS or sandboxing.
  // The receiver intentionally returns 501 to GET; only the explicit POST is accepted.
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.evaluate(() => { globalThis.wx = {
    createCanvas: () => document.createElement('canvas'),
    request(options) {
      const controller = new AbortController();
      fetch(options.url, { method: options.method, headers: options.header, body: options.data,
        signal: controller.signal }).then(async response => {
        options.success({ statusCode: response.status, data: await response.json() });
      }).catch(error => options.fail({ errMsg: String(error) }));
      return { abort: () => controller.abort() };
    },
  }; });
  await page.addScriptTag({ content: prefix.replace('__FORGEAX_PROBE_OPTIONS__', JSON.stringify({
    deadlineMs: 30000, source: sourceIdentity, reportUrl: `http://127.0.0.1:${port}/collector-webgl-check`,
  })) });
  const result = await page.evaluate(() => {
    const createCanvas = wx.createCanvas;
    const canvas = wx.createCanvas();
    const gl = canvas.getContext('webgl2');
    if (!gl) throw Error('Real WebGL2 required');
    const vertex = '#version 300 es\nout vec2 varyingValue; void main() { varyingValue = vec2(1); gl_Position = vec4(0, 0, 0, 1); }';
    const fragments = [
      '#version 300 es\nprecision highp float; in vec2 varyingValue; out vec4 color; void main() { color = vec4(varyingValue, 0, 1); }',
      '#version 300 es\nprecision highp float; in vec3 varyingValue; out vec4 color; void main() { color = vec4(varyingValue, 1); }',
    ];
    const statuses = [];
    for (const fragment of fragments) {
      const program = gl.createProgram();
      const shaders = [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]].map(([stage, source]) => {
        const shader = gl.createShader(stage);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) throw Error(gl.getShaderInfoLog(shader));
        gl.attachShader(program, shader);
        return shader;
      });
      gl.linkProgram(program);
      statuses.push({ link: gl.getProgramParameter(program, gl.LINK_STATUS), log: gl.getProgramInfoLog(program) });
      for (const shader of shaders) gl.deleteShader(shader);
      gl.deleteProgram(program);
    }
    return { statuses, expectedSources: [vertex, ...fragments], report: globalThis.__forgeaxPhoneGlLinkReport,
      restored: wx.createCanvas !== createCanvas && !Object.hasOwn(canvas, 'getContext')
        && !Object.hasOwn(gl, 'linkProgram') && !Object.hasOwn(gl, 'getProgramParameter'),
      glError: gl.getError() };
  });
  await page.waitForFunction(() => globalThis.__forgeaxPhoneGlLinkReport.transfer
    && globalThis.__forgeaxPhoneGlLinkReport.transfer.status !== 'pending');
  result.report = await page.evaluate(() => globalThis.__forgeaxPhoneGlLinkReport);
  await writeFile(join(out, 'observed.json'), JSON.stringify(result, null, 2) + '\n');
  assert.deepEqual(result.statuses.map(row => row.link), [true, false]);
  assert.notEqual(result.statuses[1].log, '');
  assert.equal(result.report.reason, 'link-not-true');
  assert.equal(result.restored, true);
  assert.equal(result.glError, 0);
  const links = result.report.records.filter(row => row.phase === 'link');
  assert.deepEqual(links.map(row => row.linkStatus), [{ type: 'boolean', value: true }, { type: 'boolean', value: false }]);
  const consumed = result.report.records.filter(row => row.phase === 'consumer-link-status');
  assert.deepEqual(consumed.map(row => [row.context, row.link, row.linkStatus]),
    links.map(row => [row.context, row.link, row.linkStatus]));
  assert.equal(result.report.records.some(row => row.phase === 'consumer-link-status-unavailable'), false);
  assert.equal(links[1].infoLog.value, result.statuses[1].log);
  assert.ok(links.every(row => row.shaders.length === 2 && row.shaders.every(shader => shader.compileStatus.value === true)));
  for (const source of result.expectedSources) {
    const hash = createHash('sha256').update(source).digest('hex');
    const saved = result.report.sources.find(row => row.sha256 === hash);
    assert.equal(saved?.text, source);
    assert.equal(saved.bytes, Buffer.byteLength(source));
  }
  assert.ok(links[0].caps.MAX_VERTEX_ATTRIBS.value >= 16);
  assert.equal(result.report.artifact.status, 'unavailable');
  assert.equal(result.report.transfer.status, 'sent');
  assert.equal(await receiverExit, 0, receiverError);
  const transferred = await readFile(join(out, 'transfer/report.json'));
  assert.equal(transferred.length, result.report.transfer.bytes);
  assert.equal(createHash('sha256').update(transferred).digest('hex'), result.report.transfer.sha256);
  const received = JSON.parse(transferred);
  assert.deepEqual(received.sources, result.report.sources);
  assert.deepEqual(received.source, sourceIdentity);
  assert.deepEqual(received.records, result.report.records);
  await writeFile(join(out, 'result.json'), JSON.stringify({ status: 'pass', chromiumSandbox: true,
    scope: 'diagnostic collector and loopback transfer only; browser request adapter with real desktop WebGL2, not native wx.request or an Engine/phone rendering pass',
    links: links.length, consumers: consumed.length, sources: result.report.sources.length, transfer: result.report.transfer,
    restored: true, glError: result.glError }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'pass', out, links: links.length, sources: result.report.sources.length }));
} finally {
  await browser?.close();
  if (receiver.exitCode === null) receiver.kill('SIGTERM');
  await receiverExit;
  await writeFile(join(out, 'receiver.log'), receiverOutput + receiverError);
}
