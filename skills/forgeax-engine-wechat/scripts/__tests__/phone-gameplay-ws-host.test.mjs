import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('real ws carrier preserves Python observed-debug gate, clock bound and hashed POST', async (t) => {
  const require = createRequire(
    await realpath(join(process.cwd(), 'node_modules/tsup/dist/index.js')),
  );
  const { build } = require('esbuild'),
    { WebSocket } = require('ws');
  const scripts = fileURLToPath(new URL('..', import.meta.url));
  const temporary = await mkdtemp(join(tmpdir(), 'forgeax-gameplay-ws-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const bundle = join(temporary, 'host.mjs');
  await build({
    entryPoints: [join(scripts, 'phone_gameplay_ws_host.mjs')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    alias: { ws: require.resolve('ws') },
    banner: {
      js:
        "import {createRequire as __createRequire} from 'node:module';const require=__createRequire(import.meta.url);" +
        "const timeout=AbortSignal.timeout.bind(AbortSignal);AbortSignal.timeout=(ms)=>{process.stderr.write('[deadline]'+ms+'\\n');return timeout(ms)};",
    },
  });
  const reserve = createServer();
  await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const source = { manifestSha256: 'a'.repeat(64) },
    runId = 'gameplay_ws_contract_20261013';
  const phone = { controlUrl: `http://127.0.0.1:${port}/ws_contract`, runId, reportSource: source };
  const python = spawn(
    'python3',
    [
      '-u',
      '-c',
      `
import json, sys, threading, time
from pathlib import Path
from run_phone_gameplay_benchmark import GameplayControl
phone=json.loads(sys.argv[1]); out=Path(sys.argv[2]); cancel=threading.Event()
control=GameplayControl(phone,out,cancel,deadline=15,max_uncertainty_ms=100)
control.timeline={'durationMs':4000,'phases':[{'name':'walk','startMs':0,'endMs':4000}]}
try:
 control.start(sys.argv[3],sys.argv[4]); print(json.dumps({'listening':True}),flush=True)
 control.wait(control.ready,10); control.input_ready.set()
 start=control.start_capture()
 assert start>time.monotonic()
 assert (out/'ready.json').exists()
 control.input={'session':{'execution':{'releaseStatus':'no-contact-started'}}}; control.released.set()
 control.wait(control.finished,10,ignore_cancel=True)
finally: control.close()
`,
      JSON.stringify(phone),
      temporary,
      process.execPath,
      bundle,
    ],
    { cwd: scripts, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const exited = once(python, 'exit');
  t.after(() => {
    if (python.exitCode === null) python.kill();
  });
  let stderr = '';
  python.stderr.on('data', (value) => {
    stderr += value;
  });
  const lines = createInterface({ input: python.stdout });
  assert.equal(JSON.parse((await lines[Symbol.asyncIterator]().next()).value).listening, true);
  const ws = new WebSocket(`${phone.controlUrl.replace('http:', 'ws:')}/control`);
  t.after(() => ws.terminate());
  await once(ws, 'open');
  async function message(stage, detail = {}) {
    const response = once(ws, 'message');
    ws.send(
      JSON.stringify({ kind: 'forgeax-phone-gameplay-control/1', runId, source, stage, ...detail }),
    );
    return JSON.parse(String((await response)[0]));
  }
  assert.equal(
    (
      await message('ready', {
        observation: {},
        debug: { policy: 'unchanged', before: { atMs: 0, appBaseInfo: { enableDebug: true } } },
      })
    ).action,
    'arm',
  );
  const accepted = await message('armed', { arm: { nowMs: 0, startMs: 2000, endMs: 6000 } });
  assert.equal(accepted.action, 'accepted');
  assert.ok(accepted.synchronization.uncertaintyMs <= 100);
  assert.equal((await message('release')).action, 'released');
  ws.close();
  await once(ws, 'close');
  const body = JSON.stringify({
    kind: 'forgeax-phone-gameplay',
    schemaVersion: 'forgeax-phone-gameplay/1',
    runId,
    source,
    mode: 'timed',
    status: 'partial',
    finishedAt: Date.now(),
    failure: 'protocol-test-only',
  });
  const sha256 = createHash('sha256').update(body).digest('hex');
  const response = await fetch(`${phone.controlUrl}/report`, {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'x-forgeax-report-bytes': String(Buffer.byteLength(body)),
      'x-forgeax-report-sha256': sha256,
    },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).sha256, sha256);
  assert.equal((await exited)[0], 0, stderr);
  assert.deepEqual(
    [
      ...(await readFile(join(temporary, 'transport-stderr.txt'), 'utf8')).matchAll(
        /\[deadline\](\d+)/g,
      ),
    ].map((match) => Number(match[1])),
    [125000, 25000, 25000, 15000],
    'Only ready forwarding admits the longer review preparation',
  );
  assert.equal(await readFile(join(temporary, 'phone-report.json'), 'utf8'), body);
});
