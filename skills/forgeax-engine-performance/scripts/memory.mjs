#!/usr/bin/env node
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { Session } from 'node:inspector/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadEchartsRuntime } from './echarts_runtime.mjs';
import { loadHeapSymbols, selectedHeap } from './heap_profile.mjs';
import { loadJson, pointer, requireFact, runCli } from './lib.mjs';
import { decodeMemoryModel, encodeMemoryModel } from './memory_codec.mjs';
import {
  allocationMemoryModel,
  defaultMemoryNode,
  inspectMemory,
  memoryMetric,
  rankMemory,
  snapshotMemoryModel,
} from './memory_model.mjs';
import { memoryHtml, memorySvg, memoryTreemapSvg } from './memory_view.mjs';

export async function reportMemory(
  inputPath,
  {
    outDir,
    profilePointer = '',
    symbolsPath,
    captureMetadata,
    metric,
    htmlViewer = 'svg',
    echartsJs,
  } = {},
) {
  requireFact(outDir, 'Require a new output directory');
  requireFact(
    !(await stat(outDir).then(
      () => true,
      () => false,
    )),
    'Output directory already exists',
  );
  requireFact(['svg', 'echarts'].includes(htmlViewer), 'html-viewer must be svg or echarts');
  const runtime = htmlViewer === 'echarts' ? await loadEchartsRuntime(echartsJs) : null;
  const input = await loadJson(inputPath);
  let value = pointer(input.value, profilePointer);
  let model;
  if (value?.kind === 'memory-explorer') model = decodeMemoryModel(value);
  else if (value?.snapshot?.meta) {
    requireFact(!symbolsPath, 'Snapshot census does not use allocation stack symbols');
    model = snapshotMemoryModel(value);
  } else {
    const selected = selectedHeap(value),
      { symbols } = await loadHeapSymbols(input, symbolsPath, profilePointer);
    model = allocationMemoryModel(selected.profile, { metadata: selected.metadata, symbols });
  }
  model.producerOk = value.ok ?? model.producerOk ?? null;
  model.metric = memoryMetric(model, metric).name;
  inspectMemory(model);
  model.initialNodeId = defaultMemoryNode(model);
  model.initialSelection =
    'Skip wrapper prefixes only while one child carries at least 99.5% of the selected metric; Root retains the entire capture';
  if (model.input) model.inputs = [...(model.inputs ?? []), model.input];
  if (captureMetadata) model.captureMetadata = captureMetadata;
  model.input = { path: resolve(inputPath), sha256: input.sha256, profilePointer };
  const svg = memoryTreemapSvg(model, model.initialNodeId),
    folders = memorySvg(model, model.initialNodeId);
  // The raw snapshot can be released before encoding its normalized graph.
  input.value = null;
  value = null;
  const serialized = JSON.stringify(encodeMemoryModel(model, { consume: true }));
  const html = memoryHtml(model, inspectMemory.toString(), serialized, { runtime });
  await mkdir(outDir);
  for (const [name, body] of [
    ['memory.json', serialized],
    ['memory.html', html],
    ['memory.svg', svg],
    ['memory-folders.svg', folders],
    [
      'summary.json',
      JSON.stringify({
        kind: model.kind,
        mode: model.mode,
        input: model.input,
        inputs: model.inputs ?? [],
        captureMetadata: model.captureMetadata ?? null,
        summary: model.summary,
        countLabel: model.countLabel,
        metric: model.metric,
        viewer: runtime ? { name: 'echarts', runtime: runtime.receipt } : { name: 'svg' },
        metadata: model.metadata ?? null,
        producerOk: model.producerOk,
        interpretation: model.interpretation,
      }),
    ],
  ])
    await writeFile(join(outDir, name), body, { flag: 'wx' });
  return { directory: outDir, mode: model.mode, summary: model.summary };
}

/** Explicit diagnostic of an owned Node workload; no business allocation hooks or forced GC. */
export async function captureMemory({
  modulePath,
  outDir,
  samplingInterval = 32768,
  mode = 'allocations',
  metric = 'bytes',
}) {
  requireFact(
    isAbsolute(modulePath) && isAbsolute(outDir),
    'Capture module and output must be absolute paths',
  );
  requireFact(
    Number.isSafeInteger(samplingInterval) && samplingInterval > 0,
    'Sampling interval must be positive bytes',
  );
  requireFact(
    ['allocations', 'objects', 'both'].includes(mode),
    'Capture mode must be allocations, objects or both',
  );
  memoryMetric({}, metric);
  const sampleAllocations = mode !== 'objects',
    snapshot = mode !== 'allocations';
  await mkdir(outDir);
  const session = new Session();
  session.connect();
  let sampling = false,
    value;
  const report = {
    kind: 'node-memory-diagnostic',
    ok: false,
    node: process.version,
    v8: process.versions.v8,
    modulePath,
    mode,
    samplingInterval: sampleAllocations ? samplingInterval : null,
    includesCollectedByMinorGC: sampleAllocations ? true : null,
    includesCollectedByMajorGC: sampleAllocations ? true : null,
    snapshotRequested: snapshot,
    failures: [],
    interpretation: sampleAllocations
      ? 'Sampling covers this entire Node isolate during module import and its default async workload. No per-allocation business instrumentation or forced GC. Sampling still adds overhead; optional snapshot blocks execution and may collect garbage. External and GPU memory are not fully covered.'
      : 'Object-only mode leaves allocation sampling off. Snapshot covers this Node isolate, including workload and VM/tool overhead; it blocks and may trigger GC. Shallow bytes are not dominator retention, RSS or GPU memory.',
  };
  try {
    await session.post('HeapProfiler.enable');
    if (sampleAllocations) {
      await session.post('HeapProfiler.startSampling', {
        samplingInterval,
        includeObjectsCollectedByMinorGC: true,
        includeObjectsCollectedByMajorGC: true,
      });
      sampling = true;
    }
    const start = performance.now(),
      module = await import(pathToFileURL(modulePath).href);
    requireFact(
      typeof module.default === 'function',
      'Workload module must export a default function',
    );
    value = await module.default();
    if (sampleAllocations) {
      const { profile } = await session.post('HeapProfiler.stopSampling');
      sampling = false;
      const envelope = {
        ok: true,
        node: process.version,
        v8: process.versions.v8,
        workload: modulePath,
        profile,
        samplingInterval,
        durationMs: performance.now() - start,
        includesCollectedByMinorGC: true,
        includesCollectedByMajorGC: true,
      };
      await writeFile(join(outDir, 'allocation.json'), JSON.stringify(envelope), { flag: 'wx' });
    }
    if (snapshot) {
      const chunks = [];
      const onChunk = (event) => chunks.push(event.params.chunk);
      session.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
      try {
        await session.post('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
      } finally {
        session.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
      }
      await writeFile(join(outDir, 'objects.heapsnapshot'), chunks.join(''), { flag: 'wx' });
    }
    if (sampleAllocations)
      report.allocation = await reportMemory(join(outDir, 'allocation.json'), {
        outDir: join(outDir, 'allocations'),
        metric,
        captureMetadata: { node: report.node, v8: report.v8, workload: modulePath, mode },
      });
    if (snapshot)
      report.snapshot = await reportMemory(join(outDir, 'objects.heapsnapshot'), {
        outDir: join(outDir, 'objects'),
        metric,
        captureMetadata: { node: report.node, v8: report.v8, workload: modulePath, mode },
      });
    report.phaseOrder = [
      sampleAllocations ? 'sample workload' : 'drive workload without allocation sampling',
      sampleAllocations ? 'stop sampling' : 'allocation sampler off',
      'optional snapshot',
      'offline model and visuals',
    ];
    // Keep a caller-retained result reachable throughout the optional snapshot.
    report.retainedResultType = typeof value;
    report.ok = true;
    return report;
  } catch (error) {
    report.failures.push({ message: error.message });
    throw error;
  } finally {
    if (sampling) {
      try {
        const { profile } = await session.post('HeapProfiler.stopSampling');
        report.partialAllocation = join(outDir, 'allocation.partial.json');
        await writeFile(
          report.partialAllocation,
          JSON.stringify({
            ok: false,
            profile,
            samplingInterval,
            includesCollectedByMinorGC: true,
            includesCollectedByMajorGC: true,
            failures: report.failures,
          }),
          { flag: 'wx' },
        );
      } catch (error) {
        report.failures.push({ phase: 'save partial allocation', message: error.message });
      }
    }
    await session.post('HeapProfiler.disable').catch(() => {});
    session.disconnect();
    value = undefined;
    await writeFile(join(outDir, 'capture-report.json'), JSON.stringify(report), { flag: 'wx' });
  }
}

runCli(import.meta.url, async () => {
  const [command, ...args] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      'out-dir': { type: 'string' },
      'profile-pointer': { type: 'string', default: '' },
      symbols: { type: 'string' },
      node: { type: 'string' },
      limit: { type: 'string', default: '100' },
      offset: { type: 'string', default: '0' },
      module: { type: 'string' },
      'interval-bytes': { type: 'string', default: '32768' },
      mode: { type: 'string', default: 'allocations' },
      metric: { type: 'string' },
      'html-viewer': { type: 'string', default: 'svg' },
      'echarts-js': { type: 'string' },
      by: { type: 'string', default: 'self' },
      query: { type: 'string', default: '' },
    },
  });
  if (!command || command === '--help' || values.help) {
    process.stdout.write(
      'Memory explorer\n  memory.mjs report INPUT --out-dir NEW_DIRECTORY [--profile-pointer /profiles/0/heap] [--symbols AUTHENTICATED_SYMBOLS] [--metric bytes|count] [--html-viewer svg|echarts --echarts-js LOCAL_RUNTIME]\n  memory.mjs inspect memory.json [--node ID] [--limit 100 --offset 0] [--metric bytes|count]\n  memory.mjs rank memory.json [--metric bytes|count] [--by self|total] [--query NAME] [--limit 100 --offset 0]\n  memory.mjs capture --module ABS_WORKLOAD_MODULE --out-dir NEW_ABSOLUTE_DIRECTORY [--interval-bytes 32768] [--mode allocations|objects|both] [--metric bytes|count]\nReport accepts V8 sampled allocation profiles, V8 heap snapshots or normalized memory JSON. Generates memory.json, offline memory.html, treemap memory.svg, folder memory-folders.svg and summary.json. Capture samples an owned Node workload (default function); full object snapshot is explicit and intrusive. No forced GC. ECharts is an opt-in offline viewer; provide its local runtime and adjacent package LICENSE/NOTICE. Count sorts and sizes visuals by recorded samples or captured V8 nodes; byte sampling is size-biased, not an allocation event census. Statistical samples are not every allocation; snapshot folder bytes are shallow, not dominator retention.\n',
    );
    return;
  }
  let result;
  if (command === 'report') {
    requireFact(positionals.length === 1, 'Require one memory input');
    result = await reportMemory(positionals[0], {
      outDir: values['out-dir'],
      profilePointer: values['profile-pointer'],
      symbolsPath: values.symbols,
      htmlViewer: values['html-viewer'],
      echartsJs: values['echarts-js'],
      metric: values.metric,
    });
  } else if (command === 'inspect') {
    requireFact(positionals.length === 1, 'Require normalized memory JSON');
    result = inspectMemory(decodeMemoryModel((await loadJson(positionals[0])).value), values.node, {
      offset: Number(values.offset),
      metric: values.metric,
      limit: Number(values.limit),
    });
  } else if (command === 'rank') {
    requireFact(positionals.length === 1, 'Require normalized memory JSON');
    result = rankMemory(decodeMemoryModel((await loadJson(positionals[0])).value), {
      metric: values.metric,
      by: values.by,
      query: values.query,
      offset: Number(values.offset),
      limit: Number(values.limit),
    });
  } else if (command === 'capture') {
    requireFact(
      positionals.length === 0 && values.module && values['out-dir'],
      'Require capture module and output',
    );
    result = await captureMemory({
      modulePath: values.module,
      outDir: values['out-dir'],
      samplingInterval: Number(values['interval-bytes']),
      mode: values.mode,
      metric: values.metric,
    });
  } else throw Error('Unknown memory command: ' + command);
  process.stdout.write(JSON.stringify(result) + '\n');
});
