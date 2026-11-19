import { request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cpuPerfettoHtml, perfettoUiUrl, PERFETTO_UI } from '../cpu_perfetto_view.mjs';
import { serveCpuReport } from '../cpu_report_server.mjs';
import { buildCpuTimeline, cpuTimelineTrace } from '../render_cpu_timeline.mjs';

const model = () =>
  buildCpuTimeline({
    startTime: 1000,
    endTime: 11000,
    nodes: [
      {
        id: 1,
        callFrame: { functionName: '(root)', url: '', lineNumber: 0, columnNumber: 0 },
        children: [2],
      },
      {
        id: 2,
        callFrame: {
          functionName: 'render',
          url: 'file:///source.mjs',
          lineNumber: 8,
          columnNumber: 2,
        },
      },
    ],
    samples: [2, 2],
    timeDeltas: [1000, 3000],
  });

test('Perfetto wrapper embeds exactly the complete trace and pins its UI with safe script data', () => {
  const data = model();
  data.identity.game = '</script><img src=x>';
  const trace = cpuTimelineTrace(data),
    html = cpuPerfettoHtml(data, trace);
  const payload = html.match(/id="trace-data"[^>]*>([^<]+)</)[1];
  const bytes = gunzipSync(Buffer.from(payload, 'base64'));
  assert.deepEqual(JSON.parse(bytes), trace);
  assert(html.includes(createHash('sha256').update(bytes).digest('hex')));
  assert(html.includes(PERFETTO_UI));
  assert(!html.includes('</script><img'));
  assert(html.includes('dev.perfetto.ExpandAllGroups'));
  assert.match(html, /event\.source\s*!==\s*frame\.contentWindow/);
  assert.match(html, /event\.origin\s*!==\s*origin/);
  assert.match(html, /shareable:\s*false/);
  assert(!trace.traceEvents.some((e) => e.s === 'g'));
  assert.equal(perfettoUiUrl('http://127.0.0.1:9000/ui'), 'http://127.0.0.1:9000/ui/');
  for (const url of [
    'file:///tmp/ui',
    'javascript:alert(1)',
    'https://user:password@host/',
    'https://host/#route',
  ])
    assert.throws(() => perfettoUiUrl(url));
});

test('loopback server serves only report assets and rejects foreign hosts, methods and symlinks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cpu-viewer-'));
  let server;
  try {
    await writeFile(join(dir, 'timeline.html'), 'viewer');
    await writeFile(join(dir, 'private.txt'), 'private');
    await symlink(join(dir, 'private.txt'), join(dir, 'timeline.json'));
    const opened = await serveCpuReport(dir);
    server = opened.server;
    assert.equal(await (await fetch(opened.url)).text(), 'viewer');
    assert.equal((await fetch(opened.url + 'private.txt')).status, 404);
    assert.equal((await fetch(opened.url, { method: 'POST' })).status, 405);
    assert.equal(
      await new Promise((resolve, reject) => {
        const req = httpRequest(opened.url, { headers: { Host: 'foreign.example' } }, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.on('error', reject);
        req.end();
      }),
      403,
    );
    assert.equal(
      (await fetch(opened.url + 'timeline.html', { method: 'HEAD' })).headers.get('content-type'),
      'text/html; charset=utf-8',
    );
    // Symlinks resolving to a differently named allowed-root asset do not expose arbitrary contents.
    assert.equal((await fetch(opened.url + 'timeline.json')).status, 404);
  } finally {
    if (server) await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});

test('normalized timeline report preserves data identities and writes Perfetto as the primary viewer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cpu-perfetto-cli-'));
  try {
    const source = join(dir, 'input.json'),
      out = join(dir, 'view'),
      data = model();
    await writeFile(source, JSON.stringify(data));
    const cli = fileURLToPath(new URL('../cpu.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [cli, 'report', source, '--out-dir', out], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const restored = JSON.parse(await readFile(join(out, 'timeline.json'), 'utf8'));
    assert.deepEqual(restored.tracks, data.tracks);
    assert.deepEqual(restored.identity, data.identity);
    assert(
      (await readFile(join(out, 'timeline.html'), 'utf8')).includes('CPU timeline · Perfetto'),
    );
    assert(
      (await readFile(join(out, 'timeline-inspector.html'), 'utf8')).includes('mountCpuInspector'),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
