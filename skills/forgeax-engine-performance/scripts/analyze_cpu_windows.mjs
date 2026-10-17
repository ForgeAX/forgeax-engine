#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { cpuProfileGraph } from './analyze_cpu_profile.mjs';
import { cpuSampleTimeline } from './cpu_timeline.mjs';
import { canonical, emitJson, loadJson, requireFact, runCli } from './lib.mjs';

export function intersectCpuAnchors(before, after, timeOriginMs) {
  requireFact(
    Array.isArray(before) && before.length > 0 && Array.isArray(after) && after.length > 0,
    'Require nonempty before and after clock anchors',
  );
  requireFact(Number.isFinite(timeOriginMs), 'Require frame performance.timeOrigin');
  const anchors = [...before, ...after];
  for (const anchor of anchors) {
    requireFact(
      Number.isFinite(anchor.offsetLowerMs) &&
        Number.isFinite(anchor.offsetUpperMs) &&
        anchor.offsetLowerMs <= anchor.offsetUpperMs &&
        anchor.timeOriginMs === timeOriginMs,
      'Invalid anchor interval or different page time origin',
    );
    if (
      anchor.pageNowMs !== undefined ||
      anchor.chromeBeforeMs !== undefined ||
      anchor.chromeAfterMs !== undefined
    ) {
      requireFact(
        Number.isFinite(anchor.pageNowMs) &&
          Number.isFinite(anchor.chromeBeforeMs) &&
          Number.isFinite(anchor.chromeAfterMs) &&
          anchor.chromeBeforeMs <= anchor.chromeAfterMs &&
          Math.abs(anchor.chromeBeforeMs - anchor.pageNowMs - anchor.offsetLowerMs) < 0.001 &&
          Math.abs(anchor.chromeAfterMs - anchor.pageNowMs - anchor.offsetUpperMs) < 0.001,
        'Clock anchor does not match its measured round trip',
      );
    }
  }
  const lower = Math.max(...anchors.map((a) => a.offsetLowerMs));
  const upper = Math.min(...anchors.map((a) => a.offsetUpperMs));
  requireFact(lower <= upper, 'Before/after clock anchor intervals do not intersect');
  return {
    method: 'intersection-of-all-before-and-after-page-to-CDP-anchors',
    timeOriginMs,
    anchorCount: anchors.length,
    offsetLowerMs: lower,
    offsetUpperMs: upper,
    offsetMs: (lower + upper) / 2,
    uncertaintyMs: upper - lower,
  };
}

export function analyzeCpuWindow(profile, window, top = 30, symbols = new Map()) {
  requireFact(Number.isSafeInteger(top) && top > 0 && top <= 1000, 'top must be 1..1000');
  const timeline = cpuSampleTimeline(profile);
  const { nodes, symbols: grouped, nodeSymbols, chainFor } = cpuProfileGraph(profile);
  requireFact(
    Number.isFinite(window.startTime) &&
      Number.isFinite(window.endTime) &&
      window.startTime >= profile.startTime &&
      window.endTime <= profile.endTime &&
      window.endTime > window.startTime,
    'Invalid CPU clipping interval',
  );
  const categories = {},
    inclusive = new Map(),
    sourceSelf = new Map();
  let sampledUs = 0,
    scriptSelfMs = 0,
    mappedSelfMs = 0,
    selectedSampleCount = 0;
  for (const sample of timeline.intervals) {
    // Validate even excluded samples; malformed loading data is not hidden by LIVE clipping.
    const chain = chainFor(sample.id);
    const weight = Math.max(
      0,
      Math.min(sample.endTime, window.endTime) - Math.max(sample.startTime, window.startTime),
    );
    if (sample.position === 0 || weight === 0) continue;
    selectedSampleCount++;
    sampledUs += weight;
    const frame = nodes.get(sample.id).callFrame,
      ms = weight / 1000;
    const category = ['(idle)', '(program)', '(garbage collector)', '(root)'].includes(
      frame.functionName,
    )
      ? frame.functionName
      : frame.url
        ? 'script'
        : 'native-or-unattributed';
    categories[category] = (categories[category] ?? 0) + ms;
    grouped.get(nodeSymbols.get(sample.id)).selfMs += ms;
    for (const key of new Set(chain.map((id) => nodeSymbols.get(id))))
      grouped.get(key).inclusiveMs += ms;
    for (const id of chain) inclusive.set(id, (inclusive.get(id) ?? 0) + ms);
    if (frame.url) {
      scriptSelfMs += ms;
      const source = symbols.get(sample.id);
      if (source) mappedSelfMs += ms;
      const file = source?.file ?? '(unmapped script)';
      sourceSelf.set(file, (sourceSelf.get(file) ?? 0) + ms);
    }
  }
  const rows = [...grouped.values()].filter((row) => row.inclusiveMs > 0);
  const ranked = (field) =>
    rows
      .slice()
      .sort((a, b) => b[field] - a[field])
      .slice(0, top);
  const inclusiveNodes = [...nodes.values()]
    .map((node) => ({
      nodeId: node.id,
      ...node.callFrame,
      source: symbols.get(node.id) ?? null,
      inclusiveMs: inclusive.get(node.id) ?? 0,
    }))
    .filter((row) => row.inclusiveMs > 0)
    .sort((a, b) => b.inclusiveMs - a.inclusiveMs)
    .slice(0, top);
  const mappedRows = [...nodes.values()].map((node) => ({
    nodeId: node.id,
    ...node.callFrame,
    source: symbols.get(node.id) ?? null,
  }));
  return {
    timeUnit: 'ms',
    coordinateBase: 0,
    rawSampleCount: profile.samples.length,
    selectedSampleCount,
    profileDurationMs: (profile.endTime - profile.startTime) / 1000,
    window,
    windowDurationMs: (window.endTime - window.startTime) / 1000,
    sampledMs: sampledUs / 1000,
    unsampledMs: (window.endTime - window.startTime - sampledUs) / 1000,
    firstSampleDelayMs: timeline.intervals[0].delta / 1000,
    categories,
    timeline: timeline.audit,
    sourceCoverage: {
      status: symbols.size ? 'supplied-raw-hash-bound-symbols' : 'generated-coordinates-only',
      scriptSelfMs,
      mappedSelfMs,
      fraction: scriptSelfMs > 0 ? mappedSelfMs / scriptSelfMs : null,
    },
    topSelf: ranked('selfMs').map((row) => ({
      ...row,
      sources: mappedRows
        .filter(
          (node) =>
            node.functionName === row.functionName &&
            node.url === row.url &&
            node.lineNumber === row.lineNumber &&
            node.columnNumber === row.columnNumber,
        )
        .map((node) => node.source),
    })),
    topInclusive: inclusiveNodes,
    topSourceSelf: [...sourceSelf]
      .map(([file, selfMs]) => ({ file, selfMs }))
      .sort((a, b) => b.selfMs - a.selfMs)
      .slice(0, top),
  };
}

function frameBoundary(value) {
  requireFact(
    value &&
      Number.isFinite(value.completedAtMs) &&
      Number.isSafeInteger(value.frameId) &&
      typeof value.worldIdentity === 'string' &&
      value.worldIdentity.length > 0 &&
      Number.isSafeInteger(value.deviceGeneration),
    'Require completed frame identity and page clock',
  );
}

export function analyzeCaptureWindows(raw, report, frames, maps, rawSha256, top = 30) {
  requireFact(Array.isArray(raw.profiles) && raw.profiles.length > 0, 'Require captured profiles');
  requireFact(
    Array.isArray(raw.failures) &&
      raw.failures.length === 0 &&
      Array.isArray(report.cpu?.failures) &&
      report.cpu.failures.length === 0,
    'Incomplete CPU target capture',
  );
  const targets = new Set();
  for (const entry of raw.profiles) {
    requireFact(
      typeof entry.target?.targetId === 'string' &&
        entry.target.targetId.length > 0 &&
        !targets.has(entry.target.targetId),
      'Missing or duplicate original CPU target identity',
    );
    targets.add(entry.target.targetId);
  }
  const common = {
    startTime: Math.max(...raw.profiles.map((e) => e.profile.startTime)),
    endTime: Math.min(...raw.profiles.map((e) => e.profile.endTime)),
  };
  requireFact(
    Number.isFinite(common.startTime) &&
      Number.isFinite(common.endTime) &&
      common.endTime > common.startTime,
    'Profiles have no common CDP clock interval',
  );
  requireFact(
    canonical(report.cpu?.commonWindow) === canonical(common),
    'Report and raw CPU common intervals differ',
  );
  const clock = intersectCpuAnchors(
    report.coldFirelineCpu?.anchorsBefore,
    report.coldFirelineCpu?.anchorsAfter,
    frames.timeOrigin,
  );
  requireFact(
    Number.isFinite(frames.firstLiveAt) &&
      Number.isFinite(frames.end) &&
      frames.end > frames.firstLiveAt,
    'Require explicit observed LIVE start and end; startup is not LIVE',
  );
  requireFact(Array.isArray(frames.frames), 'Require captured completed frames');
  const receipts = [...frames.frames];
  if (frames.closingFrame !== undefined) {
    const closing = frames.closingFrame;
    frameBoundary({ ...closing, completedAtMs: closing.at });
    const existing = receipts.find(
      (row) =>
        row.frameId === closing.frameId &&
        row.worldIdentity === closing.worldIdentity &&
        row.deviceGeneration === closing.deviceGeneration,
    );
    requireFact(
      existing === undefined || existing.at === closing.at,
      'Closing receipt conflicts with a captured completion',
    );
    if (existing === undefined) receipts.push(closing);
  }
  const gaps = report.windows?.sampled?.submissionGaps?.worstCompletedGaps;
  requireFact(
    Array.isArray(gaps),
    'Require same diagnostic completed-frame gaps (an empty array is valid)',
  );
  const selections = [{ name: 'live', startMs: frames.firstLiveAt, endMs: frames.end }];
  for (const [index, gap] of gaps.entries()) {
    frameBoundary(gap.previous);
    frameBoundary(gap.current);
    requireFact(
      gap.previous.worldIdentity === gap.current.worldIdentity &&
        gap.previous.deviceGeneration === gap.current.deviceGeneration &&
        gap.current.frameId > gap.previous.frameId &&
        gap.current.completedAtMs > gap.previous.completedAtMs &&
        Math.abs(gap.completedGapMs - (gap.current.completedAtMs - gap.previous.completedAtMs)) <
          0.001,
      'Completed gap boundaries conflict',
    );
    // A gap from another report/capture must not silently become this capture's attribution.
    for (const boundary of [gap.previous, gap.current])
      requireFact(
        receipts.some(
          (row) =>
            row.frameId === boundary.frameId &&
            row.worldIdentity === boundary.worldIdentity &&
            row.deviceGeneration === boundary.deviceGeneration &&
            row.at === boundary.completedAtMs,
        ),
        'Gap boundary is absent from supplied sampled frames',
      );
    selections.push({
      name: `gap-${index + 1}`,
      startMs: gap.previous.completedAtMs,
      endMs: gap.current.completedAtMs,
      frames: { previous: gap.previous, current: gap.current },
    });
  }
  const smoke = report.windows?.sampled?.smokeAppearance;
  if (smoke?.status === 'observed') {
    const receipt = smoke.receipt;
    const observations = frames.smokeObservations;
    const same = (row, other) =>
      row?.at === other?.at &&
      row?.frameId === other?.frameId &&
      row?.worldIdentity === other?.worldIdentity &&
      row?.deviceGeneration === other?.deviceGeneration;
    requireFact(
      receipt &&
        Number.isSafeInteger(receipt.count) &&
        receipt.count > 0 &&
        receipt.at === smoke.observedAtMs &&
        Array.isArray(observations) &&
        observations.some((row) => same(row, receipt) && row.count === receipt.count) &&
        observations.some(
          (row) =>
            row.count === 0 &&
            row.at < receipt.at &&
            row.worldIdentity === receipt.worldIdentity &&
            row.deviceGeneration === receipt.deviceGeneration,
        ),
      'First smoke requires its captured positive receipt and preceding same-World zero',
    );
    const boundary =
      'HUD smoke observation; creation, visibility and exclusive cause are unobserved';
    const addSmokeGap = (name, from, to) => {
      const currentIndex = receipts.findIndex(
        (row) =>
          row.at === to &&
          row.worldIdentity === receipt.worldIdentity &&
          row.deviceGeneration === receipt.deviceGeneration,
      );
      const current = receipts[currentIndex];
      const previous = receipts[currentIndex - 1];
      frameBoundary({ ...previous, completedAtMs: previous?.at });
      frameBoundary({ ...current, completedAtMs: current?.at });
      requireFact(
        previous &&
          current &&
          previous.at < current.at &&
          previous.worldIdentity === current.worldIdentity &&
          previous.deviceGeneration === current.deviceGeneration &&
          previous.frameId < current.frameId &&
          (from === undefined || previous.at === from),
        'Smoke gap endpoints must be adjacent captured completed receipts',
      );
      return {
        name,
        startMs: previous.at,
        endMs: current.at,
        boundary,
        observedAtMs: receipt.at,
        frames: { previous, current },
      };
    };
    const observed = addSmokeGap('first-smoke-receipt', undefined, receipt.at);
    requireFact(same(observed.frames.current, receipt), 'Smoke receipt identity differs');
    selections.push(observed);
    const gap = smoke.longestInterval;
    if (gap !== undefined) {
      const longest = addSmokeGap('first-smoke-longest-gap', gap.fromMs, gap.toMs);
      requireFact(
        longest.frames.current.frameId === gap.frameId &&
          Math.abs(longest.endMs - longest.startMs - gap.ms) < 0.001,
        'Smoke longest gap duration or frame identity differs',
      );
      selections.push(longest);
    }
  }
  const mapsByTarget = new Map();
  if (maps !== undefined) {
    requireFact(
      maps.rawSha256 === rawSha256 &&
        maps.complete === true &&
        maps.gameCommit === report.gameCommit &&
        maps.engineCommit === report.engineCommit &&
        canonical(maps.commonWindow) === canonical(common) &&
        Array.isArray(maps.profiles),
      'Symbol map identity, completeness or raw SHA256 differs',
    );
    for (const mapping of maps.profiles) {
      const id = mapping.target?.targetId;
      const entry = raw.profiles.find((row) => row.target.targetId === id);
      requireFact(
        entry &&
          canonical(mapping.target) === canonical(entry.target) &&
          !mapsByTarget.has(id) &&
          canonical(mapping.scriptDigests) === canonical(entry.scriptDigests),
        'Symbol target or captured script identities differ',
      );
      const symbols = new Map();
      const nodeIds = new Set(entry.profile.nodes.map((node) => node.id));
      requireFact(Array.isArray(mapping.symbols), 'Require supplied symbol entries');
      for (const symbol of mapping.symbols) {
        requireFact(
          !symbols.has(symbol.nodeId) &&
            nodeIds.has(symbol.nodeId) &&
            typeof symbol.source?.file === 'string',
          'Invalid or repeated source symbol',
        );
        symbols.set(symbol.nodeId, symbol.source);
      }
      mapsByTarget.set(id, symbols);
    }
    requireFact(mapsByTarget.size === raw.profiles.length, 'Missing target symbol mapping');
  }
  const slices = selections.map((selection) => {
    const requested = {
      startTime: (selection.startMs + clock.offsetMs) * 1000,
      endTime: (selection.endMs + clock.offsetMs) * 1000,
    };
    const window = {
      startTime: Math.max(common.startTime, requested.startTime),
      endTime: Math.min(common.endTime, requested.endTime),
    };
    requireFact(window.endTime > window.startTime, 'Selected window has no common CPU coverage');
    const complete =
      window.startTime === requested.startTime && window.endTime === requested.endTime;
    return {
      ...selection,
      requestedCdpMicroseconds: requested,
      coverage: {
        status: complete ? 'complete' : 'partial',
        fraction: (window.endTime - window.startTime) / (requested.endTime - requested.startTime),
        uncertaintyMs: clock.uncertaintyMs,
      },
      profiles: raw.profiles.map((entry) => ({
        target: entry.target,
        realm:
          entry.target.type === 'page'
            ? 'Host'
            : entry.profile.nodes.some((node) =>
                  node.callFrame.url.includes('engine-worker-runtime-'),
                )
              ? 'Engine Worker'
              : entry.profile.nodes.some((node) =>
                    node.callFrame.url.includes('render-worker-runtime-'),
                  )
                ? 'Render Worker'
                : 'Worker',
        ...analyzeCpuWindow(entry.profile, window, top, mapsByTarget.get(entry.target.targetId)),
      })),
    };
  });
  return {
    kind: 'same-capture-cpu-windows',
    diagnosticOnly: true,
    ordinaryFpsAcceptance: false,
    producerReportOk: report.ok ?? null,
    comparable: false,
    comparisonReason:
      'Sampling diagnostic, not a matched performance comparison or frame-cause verdict',
    inputClockUnit: 'CDP microseconds and page performance.now milliseconds',
    outputTimeUnit: 'ms',
    game: report.gameCommit ?? null,
    engine: report.engineCommit ?? null,
    clock,
    commonCdpMicroseconds: common,
    completeness: slices.every((slice) => slice.coverage.status === 'complete')
      ? 'complete'
      : 'partial',
    slices,
    smokeObservation:
      smoke === undefined
        ? { status: 'notCollected' }
        : { status: smoke.status, reason: smoke.reason ?? null },
    interpretation:
      'Each realm is separate. Ending-sample weights can include scheduling delay; first-sample startup and unobserved tail are unsampled. Inclusive stacks overlap and realm times must not be added. Only these supplied same-capture frame gaps and smoke observation receipts are analyzed; an earlier unprofiled gap cannot be attributed.',
  };
}

runCli(import.meta.url, async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      report: { type: 'string' },
      frames: { type: 'string' },
      maps: { type: 'string' },
      output: { type: 'string' },
      top: { type: 'string', default: '30' },
    },
  });
  if (values.help) {
    process.stdout.write(
      'node analyze_cpu_windows.mjs CPU_PROFILES --report REPORT --frames SAMPLED_FRAMES [--maps CPU_NODE_MAPS] [--top 30] [--output FILE]\nOffline adapter for existing Frontline ordinary CPU collector records: report.coldFirelineCpu anchors, cpu.commonWindow, windows.sampled.submissionGaps and observed smokeAppearance; frames.firstLiveAt/end/timeOrigin/frames, optional closingFrame and smokeObservations. No Engine install or live capture. CDP times are us; page clocks/output durations are ms. Refuses missing/nonintersecting anchors or foreign gap/map facts. Partial common-window coverage exits 2. Output defaults to stdout and cannot overwrite inputs.\n',
    );
    return;
  }
  requireFact(
    positionals.length === 1 && values.report && values.frames,
    'Require CPU_PROFILES, --report and --frames',
  );
  const paths = [
    positionals[0],
    values.report,
    values.frames,
    ...(values.maps ? [values.maps] : []),
  ];
  const [raw, report, frames, maps] = await Promise.all(paths.map(loadJson));
  const result = analyzeCaptureWindows(
    raw.value,
    report.value,
    frames.value,
    maps?.value,
    raw.sha256,
    Number(values.top),
  );
  await emitJson(
    {
      inputs: paths.map((path, index) => ({
        path,
        sha256: [raw, report, frames, maps][index].sha256,
      })),
      ...result,
    },
    values.output,
    paths,
  );
  if (result.completeness !== 'complete') process.exitCode = 2;
});
