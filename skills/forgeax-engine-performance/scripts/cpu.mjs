#!/usr/bin/env node
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { calibrateCpuSampler } from './calibrate_cpu_sampler.mjs';
import captureCpuTimeline from './capture_cpu_timeline.mjs';
import { serveCpuReportCli } from './cpu_report_server.mjs';
import { selectCpuTimeline, queryCpuTimeline } from './cpu_query.mjs';
import { emitJson, loadJson, requireFact, runCli } from './lib.mjs';
import { CPU_REPORT_OPTIONS, renderCpuTimeline } from './render_cpu_timeline.mjs';
import { createSourceFunctionNameResolver } from './source_function_names.mjs';
import { symbolizeNodes } from './source_maps.mjs';

/** One report route for existing capture directories and individual profiles. */
export async function reportCpu(args, { quiet = false } = {}) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { ...CPU_REPORT_OPTIONS, dist: { type: 'string' }, 'engine-root': { type: 'string' } },
  });
  if (values.help) return renderCpuTimeline(['--help']);
  requireFact(positionals.length === 1, 'Require a capture directory or CPU profile');
  const input = resolve(positionals[0]),
    directory = (await stat(input)).isDirectory();
  if (directory) {
    requireFact(!values.report && !values.frames, 'Capture directory owns its report/frame paths');
    values.report = join(input, 'capture-report.json');
    values.frames = join(input, 'sampled-frames.json');
    if (
      !values.maps &&
      (await stat(join(input, 'source-symbols.json')).then(
        (s) => s.isFile(),
        () => false,
      ))
    )
      values.maps = join(input, 'source-symbols.json');
  }
  const profilePath = directory ? join(input, 'cpu-profiles.json') : input;
  values['out-dir'] ??= directory
    ? join(input, 'view')
    : join(dirname(input), parse(basename(input)).name + '-cpu');
  requireFact(
    !(await stat(values['out-dir']).then(
      () => true,
      () => false,
    )),
    'Output directory already exists',
  );
  requireFact(
    Boolean(values.dist) === Boolean(values['engine-root']),
    'Supply --dist and --engine-root together for authenticated source names',
  );
  requireFact(!(values.maps && values.dist), 'Choose supplied maps or frozen-build symbolization');
  let maps;
  if (values.dist) {
    requireFact(
      values.report && values.frames,
      'Source recovery requires same-capture report and frames',
    );
    const raw = await loadJson(profilePath),
      report = (await loadJson(values.report)).value;
    requireFact(Array.isArray(raw.value.profiles), 'Source recovery requires a capture envelope');
    const engineRoot = resolve(values['engine-root']),
      ts = createRequire(join(engineRoot, 'package.json'))('typescript');
    const resolveSourceFunctionName = createSourceFunctionNameResolver(ts);
    maps = {
      complete: true,
      rawSha256: raw.sha256,
      gameCommit: report.gameCommit,
      engineCommit: report.engineCommit,
      commonWindow: report.cpu.commonWindow,
      nameRecovery: {
        parser: 'typescript',
        version: ts.version,
        boundary:
          'Authenticated map sourcesContent; lexical function or declared system name; raw name retained',
      },
      profiles: [],
    };
    for (const row of raw.value.profiles) {
      const result = await symbolizeNodes({
        nodes: row.profile.nodes,
        scriptDigests: row.scriptDigests,
        baseUrl: report.url,
        distDirectory: resolve(values.dist),
        engineDirectory: engineRoot,
        resolveSourceFunctionName,
      });
      maps.profiles.push({
        target: row.target,
        scriptDigests: row.scriptDigests,
        symbols: [...result.symbols].map(([nodeId, source]) => ({ nodeId, source })),
        authenticatedFiles: result.authenticatedFiles,
        coverage: result.coverage,
      });
    }
  }
  const forwarded = [profilePath];
  for (const [key, value] of Object.entries(values))
    if (!['dist', 'engine-root', 'help'].includes(key) && value !== undefined)
      forwarded.push('--' + key, String(value));
  return renderCpuTimeline(forwarded, { maps, quiet });
}

/** Public project-play adapter: capture, then produce the reusable report. */
export default async function cpu(play) {
  const receipt = await captureCpuTimeline(play);
  const args = [receipt.output];
  if (process.env.FORGEAX_CPU_DIST)
    args.push(
      '--dist',
      process.env.FORGEAX_CPU_DIST,
      '--engine-root',
      process.env.FORGEAX_CPU_ENGINE_ROOT ?? process.cwd(),
    );
  const view = await reportCpu(args, { quiet: true });
  return { ...receipt, view };
}

runCli(import.meta.url, async () => {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help') {
    process.stdout.write(
      'CPU workbench\n  cpu.mjs serve REPORT_DIRECTORY [--port 0]\n  cpu.mjs report CAPTURE_DIRECTORY|PROFILE.json [--out-dir NEW_DIRECTORY] [--dist FROZEN_GAME_DIST --engine-root ENGINE_ROOT] [--report REPORT --frames FRAMES --maps MAPS] [--from-ms N --to-ms N]\n  cpu.mjs query timeline.json [--view functions|intervals|tree|completions] [--target NAME_OR_ID] [--completion-index N] [--from-ms N --to-ms N] [--node-id N | --search TEXT] [--sort FIELD --limit 100 --offset 0] [--direction top-down|bottom-up] [--output NEW_JSON]\n  cpu.mjs calibrate --help\n  forgeax project play /absolute/path/cpu.mjs ...\nLive defaults: 1 us request, 3000 ms diagnostic window, all JS targets, separate profiler-off controls. FORGEAX_CPU_OUTPUT is a new absolute capture directory. FORGEAX_CPU_TARGET=forgeax-render selects focused detail. Set FORGEAX_CPU_DIST and optional FORGEAX_CPU_ENGINE_ROOT for authenticated original names. Capture produces view/timeline.html, timeline.svg, timeline.json, analysis.json, call-tree.svg, call-trees.json and timeline.trace.json automatically; no browser dependency is installed by these tools.\n',
    );
    return;
  }
  if (command === 'serve') return serveCpuReportCli(args);
  if (command === 'report') return reportCpu(args);
  if (command === 'calibrate') return calibrateCpuSampler(args);
  if (command === 'query') {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: Object.fromEntries(
        [
          'view',
          'target',
          'completion-index',
          'from-ms',
          'to-ms',
          'node-id',
          'search',
          'sort',
          'limit',
          'offset',
          'direction',
          'output',
        ].map((k) => [k, { type: 'string' }]),
      ),
    });
    requireFact(positionals.length === 1, 'Require a normalized timeline.json');
    const input = await loadJson(positionals[0]);
    const options = {
      view: values.view,
      target: values.target,
      search: values.search,
      sort: values.sort,
      direction: values.direction,
    };
    for (const [flag, key] of [
      ['completion-index', 'completionIndex'],
      ['from-ms', 'fromMs'],
      ['to-ms', 'toMs'],
      ['node-id', 'nodeId'],
      ['limit', 'limit'],
      ['offset', 'offset'],
    ])
      if (values[flag] !== undefined) options[key] = Number(values[flag]);
    const result = queryCpuTimeline(selectCpuTimeline(input.value, options), options);
    return emitJson({ inputSha256: input.sha256, ...result }, values.output, positionals, {
      exclusive: true,
    });
  }
  throw Error('Unknown CPU command: ' + command);
});
