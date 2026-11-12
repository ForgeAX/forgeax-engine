import { createHash } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const scripts = dirname(fileURLToPath(import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function buildWorkerProbe({ engineRoot, out, runId, appid = 'touristappid', reportUrl, timeoutMs = 20000 }) {
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(runId ?? '')) throw Error('invalid run ID');
  if (!/^(wx[0-9a-f]{16}|touristappid)$/.test(appid)) throw Error('invalid local AppID');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw Error('timeout must be 1000..60000 ms');
  if (reportUrl !== undefined) {
    const match = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})(\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)$/.exec(reportUrl);
    if (!match || match[0] !== reportUrl || Number(match[1]) < 1 || Number(match[1]) > 65535) throw Error('report URL must be an explicit loopback endpoint');
  }
  const engine = resolve(engineRoot), destination = resolve(out);
  const { build } = createRequire(await realpath(join(engine, 'node_modules/tsup/dist/index.js')))('esbuild');
  const hostRequire = createRequire(join(engine, 'packages/platform-wechat/package.json'));
  const alias = {
    '@noble/hashes/sha2.js': hostRequire.resolve('@noble/hashes/sha2.js'),
    '@exodus/bytes/utf8.js': join(dirname(hostRequire.resolve('@exodus/bytes/utf8.js')), 'utf8.js'),
  };
  const bundle = async (entry, external = []) => {
    const result = await build({ entryPoints: [join(scripts, 'fixtures/worker-capability', entry)],
      bundle: true, write: false, format: 'iife', platform: 'neutral', target: 'chrome70', alias, external });
    return result.outputFiles[0].contents;
  };
  const main = await bundle('game.js', ['./options.js']);
  const worker = await bundle('worker.js');
  const source = { entrySha256: hash(main), workerSha256: hash(worker) };
  const options = { runId, source, timeoutMs, ...(reportUrl === undefined ? {} : { reportUrl }) };
  const outputs = {
    'game.js': main,
    'workers/probe.js': worker,
    'options.js': Buffer.from(`module.exports=${JSON.stringify(options)};\n`),
    'game.json': Buffer.from(`${JSON.stringify({ deviceOrientation: 'landscape', workers: 'workers' })}\n`),
    'project.config.json': Buffer.from(`${JSON.stringify({ appid, compileType: 'game',
      projectname: 'ForgeAX Worker capability probe', setting: { es6: false, enhance: false, minified: false, urlCheck: false } }, null, 2)}\n`),
  };
  const files = Object.fromEntries(Object.entries(outputs).map(([name, bytes]) => [name, { bytes: bytes.length, sha256: hash(bytes) }]));
  const manifest = { kind: 'forgeax-worker-probe-build', schema: 1, runId, source, timeoutMs, files };
  await mkdir(destination, { mode: 0o700 });
  await mkdir(join(destination, 'workers'), { mode: 0o700 });
  for (const [name, bytes] of Object.entries(outputs)) await writeFile(join(destination, name), bytes, { flag: 'wx', mode: 0o600 });
  await writeFile(join(destination, 'probe-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { out: destination, ...manifest };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { 'engine-root': { type: 'string' }, out: { type: 'string' },
    'run-id': { type: 'string' }, appid: { type: 'string' }, 'report-url': { type: 'string' },
    'timeout-ms': { type: 'string' }, help: { type: 'boolean' } } });
  const usage = 'node build_worker_probe.mjs --engine-root PATH --out NEW_DIRECTORY --run-id ID [--appid LOCAL_APPID] [--report-url http://127.0.0.1:PORT/PATH] [--timeout-ms 20000]';
  if (values.help) console.log(usage);
  else {
    if (!values['engine-root'] || !values.out || !values['run-id']) throw Error(usage);
    console.log(JSON.stringify(await buildWorkerProbe({ engineRoot: values['engine-root'], out: values.out,
      runId: values['run-id'], appid: values.appid, reportUrl: values['report-url'],
      timeoutMs: values['timeout-ms'] === undefined ? 20000 : Number(values['timeout-ms']) })));
  }
}
