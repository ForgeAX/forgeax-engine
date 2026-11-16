#!/usr/bin/env node
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { digest, loadJson, pointer, requireFact, runCli } from './lib.mjs';
import { buildGpuReport, validateGpuReport } from './gpu_model.mjs';
import { loadGpuRuntime, setupGpuRuntime } from './gpu_runtime.mjs';
import { gpuReportHtml, gpuOverviewSvg } from './gpu_view.mjs';
import { gpuTimingReport, gpuTimingHtml, gpuTimingSvg } from './gpu_timing.mjs';
import { serveReport } from './report_server.mjs';
import { gpuImages } from './gpu_images.mjs';

const FILES = new Map([
  ['gpu.html', 'text/html; charset=utf-8'],
  ['gpu.json', 'application/json'],
  ['gpu.svg', 'image/svg+xml'],
  ['timeline.html', 'text/html; charset=utf-8'],
  ['timeline.trace.json', 'application/json'],
  ['timing.json', 'application/json'],
  ['gpu-timing.svg', 'image/svg+xml'],
  ...[
    'gpu-resources.png',
    'gpu-resource-counts.png',
    'gpu-resource-spans.png',
    'gpu-overview.png',
    'gpu-pipeline.png',
    'gpu-pipeline-view.png',
    'gpu-timing.png',
  ].map((f) => [f, 'image/png']),
]);
export async function serveGpuReport(directory, options = {}) {
  const entry = await stat(join(directory, 'gpu.html')).then(
    () => 'gpu.html',
    () => 'timeline.html',
  );
  return serveReport(directory, { ...options, entry, files: FILES });
}
export async function loadGpuCapture(path, { rhiModule } = {}) {
  if (!path.endsWith('.rhitape')) {
    const raw = (await loadJson(path)).value;
    if (raw.kind === 'gpu-report') return validateGpuReport(raw);
    return buildGpuReport(raw.frameModel, raw.identity);
  }
  const modulePath = resolve(rhiModule ?? join(process.cwd(), 'packages/rhi-debug/dist/index.mjs'));
  const { decodeTape, buildFrameModel } = await import(pathToFileURL(modulePath).href);
  const bytes = await readFile(path),
    decoded = decodeTape(new Uint8Array(bytes));
  requireFact(decoded.ok, 'RHI tape decode failed: ' + JSON.stringify(decoded.error));
  return buildGpuReport(buildFrameModel(decoded.value), {
    tapeDigest: 'sha256:' + digest(bytes),
    decoderModuleSha256: digest(await readFile(modulePath)),
  });
}
async function generateReport(input, values) {
  const directory = resolve(values['out-dir'] ?? input.replace(/\.[^.]+$/, '') + '-gpu');
  requireFact(
    !(await stat(directory).then(
      () => true,
      () => false,
    )),
    'Output directory already exists',
  );
  let files, summary;
  if (values.command === 'timing') {
    const raw = await loadJson(input),
      frame = pointer(raw.value, values.pointer ?? '');
    const report = gpuTimingReport(frame, {
      sourceSha256: raw.sha256,
      inputPointer: values.pointer ?? '',
    });
    files = [
      ['timing.json', JSON.stringify(report, null, 2)],
      ['timeline.trace.json', JSON.stringify(report.trace)],
      ['timeline.html', gpuTimingHtml(report, { ui: values['perfetto-ui'] })],
      ['gpu-timing.svg', gpuTimingSvg(report)],
    ];
    const {
      timed,
      measuredTimestampEnvelopeMs,
      measuredIntervalUnionMs,
      repeatedCoverageMs,
      equalTickExecutions,
    } = report.coverage;
    summary = {
      timed,
      measuredTimestampEnvelopeMs,
      measuredIntervalUnionMs,
      repeatedCoverageMs,
      equalTickExecutions,
      measuredPassCount: frame.measuredPassCount,
      executedPassCount: frame.executedPassCount,
    };
  } else {
    const report = await loadGpuCapture(input, { rhiModule: values['rhi-module'] });
    const runtime = await loadGpuRuntime(values['runtime-dir']);
    files = [
      ['gpu.json', JSON.stringify(report, null, 2)],
      ['gpu.html', gpuReportHtml(report, runtime)],
      ['gpu.svg', gpuOverviewSvg(report)],
    ];
    summary = report.summary;
  }
  await mkdir(directory, { recursive: true });
  for (const [name, content] of files)
    await writeFile(join(directory, name), content + '\n', { flag: 'wx' });
  return { directory, files: files.map(([name]) => name), summary };
}
async function queryGpu(input, values) {
  const r = validateGpuReport((await loadJson(input)).value);
  let rows;
  if (values['work-index'] !== undefined) {
    const work = r.works.find((w) => w.workIndex === Number(values['work-index']));
    requireFact(work, 'Unknown workIndex');
    rows = { work, uses: r.uses.filter((u) => u.workIndex === work.workIndex) };
  } else
    rows = r.resources
      .filter(
        (x) =>
          (!values.search ||
            (x.label + ' ' + x.resourceId + ' ' + x.kind)
              .toLowerCase()
              .includes(values.search.toLowerCase())) &&
          (!values.state || x.state === values.state),
      )
      .sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1))
      .slice(0, Number(values.limit ?? 30));
  return { identity: r.identity, summary: r.summary, rows };
}
export async function main(args = process.argv.slice(2)) {
  const command = args[0];
  if (!command || args.includes('--help')) {
    process.stdout.write(
      'GPU tools\n  setup [--runtime-dir DIR] (one-time pinned, integrity-checked runtimes)\n  report FRAME.rhitape|FRAME_MODEL_ENVELOPE.json --out-dir DIR [--rhi-module RHI_DEBUG_DIST] [--runtime-dir DIR]\n  timing INPUT.json --pointer /observation/frame --out-dir DIR [--perfetto-ui URL]\n  query GPU.json [--search NAME] [--state live] [--limit 30] [--work-index N]\n  serve DIR [--port 0]\n  images DIR [--playwright-module PATH]\nReports always include a static SVG and interactive HTML; images additionally exports framework-rendered PNGs.\n',
    );
    return;
  }
  const { values, positionals } = parseArgs({
    args: args.slice(1),
    allowPositionals: true,
    options: Object.fromEntries(
      [
        'runtime-dir',
        'out-dir',
        'rhi-module',
        'pointer',
        'perfetto-ui',
        'port',
        'search',
        'state',
        'limit',
        'work-index',
        'playwright-module',
      ].map((k) => [k, { type: 'string' }]),
    ),
  });
  if (command === 'setup') {
    requireFact(!positionals.length, 'setup takes no input');
    const r = await setupGpuRuntime(values['runtime-dir']);
    process.stdout.write(
      JSON.stringify({ status: 'ready', directory: r.directory, packages: r.manifest.packages }) +
        '\n',
    );
    return;
  }
  requireFact(positionals.length === 1, 'Require one input file or report directory');
  const input = resolve(positionals[0]);
  if (['report', 'timing'].includes(command)) {
    process.stdout.write(
      JSON.stringify(await generateReport(input, { ...values, command })) + '\n',
    );
    return;
  }
  if (command === 'query') {
    const limit = Number(values.limit ?? 30);
    requireFact(Number.isInteger(limit) && limit >= 1 && limit <= 10000, 'Invalid query limit');
    process.stdout.write(JSON.stringify(await queryGpu(input, values), null, 2) + '\n');
    return;
  }
  requireFact(['serve', 'images'].includes(command), 'Unknown GPU command');
  const { server, url } = await serveGpuReport(input, { port: Number(values.port ?? 0) });
  if (command === 'images') {
    try {
      process.stdout.write(
        JSON.stringify(
          await gpuImages(input, url, { playwrightModule: values['playwright-module'] }),
        ) + '\n',
      );
    } finally {
      await new Promise((done) => server.close(done));
    }
    return;
  }
  process.stdout.write(JSON.stringify({ status: 'serving', url, directory: input }) + '\n');
  const stop = () => server.close();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
runCli(import.meta.url, main);
