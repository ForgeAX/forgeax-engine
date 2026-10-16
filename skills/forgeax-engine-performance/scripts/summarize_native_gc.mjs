import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { emitJson, loadJson, pointer, requireFact, runCli } from './lib.mjs';

/** Native durations and boundary counters remain separate from sampled JS stacks. */
function summarizeNativeGcTrace(trace, markers) {
  const events = trace.traceEvents;
  assert(Array.isArray(events), 'Native trace events are required');
  const threads = new Map();
  for (const marker of markers) {
    assert(
      typeof marker.targetId === 'string' && typeof marker.realm === 'string',
      'Owned trace markers require a sampled target and realm',
    );
    const matches = events.filter(
      (event) => event.name === marker.name && event.cat?.includes('user_timing'),
    );
    assert.equal(matches.length, 1, `Owned thread marker must occur exactly once: ${marker.name}`);
    const event = matches[0],
      key = `${event.pid}:${event.tid}`;
    assert(!threads.has(key), 'Two owned realms cannot silently share one trace thread');
    assert(Number.isFinite(event.ts), 'Thread marker timestamp is invalid');
    threads.set(key, {
      targetId: marker.targetId,
      realm: marker.realm,
      markerTs: event.ts,
      minor: [],
      major: [],
      finalization: [],
      cppgc: [],
      counters: [],
      untimedTaskEvents: { finalization: 0, cppgcSweep: 0 },
    });
  }
  assert(threads.size > 0, 'Native GC requires authenticated owned thread markers');
  for (const event of events) {
    const row = threads.get(`${event.pid}:${event.tid}`);
    if (!row || event.ts < row.markerTs) continue;
    if (event.name === 'V8.GCTraceGCNVP') {
      assert(Number.isFinite(event.ts), 'Invalid native GC counter clock');
      const data = JSON.parse(event.args?.value);
      for (const field of ['allocated', 'promoted'])
        assert(
          Number.isFinite(data[field]) && data[field] >= 0,
          `Invalid native GC ${field} counter`,
        );
      row.counters.push({ ts: event.ts, allocated: data.allocated, promoted: data.promoted });
    }
    let category;
    if (event.name === 'MinorGC') category = row.minor;
    else if (event.name === 'MajorGC') category = row.major;
    else if (event.name === 'ThreadControllerImpl::RunTask') {
      const source = `${event.args?.src_file ?? ''} ${event.args?.src_func ?? ''}`;
      if (source.includes('FinalizationRegistryCleanupTask')) category = row.finalization;
      else if (source.includes('cppgc') && /sweep/i.test(source)) category = row.cppgc;
      // Chromium also emits instant RunTask records. They have no measured
      // duration; count them separately rather than assigning zero CPU/wall time.
      if (category !== undefined && event.ph === 'I') {
        row.untimedTaskEvents[category === row.finalization ? 'finalization' : 'cppgcSweep']++;
        continue;
      }
    }
    if (category === undefined) continue;
    assert.equal(event.ph, 'X', 'Native GC durations require complete trace events');
    assert(
      Number.isFinite(event.ts) && Number.isFinite(event.dur) && event.dur >= 0,
      'Invalid native GC wall duration',
    );
    assert(
      event.tdur === undefined || (Number.isFinite(event.tdur) && event.tdur >= 0),
      'Invalid native GC CPU duration',
    );
    for (const field of ['usedHeapSizeBefore', 'usedHeapSizeAfter'])
      assert(
        event.args?.[field] === undefined ||
          (Number.isFinite(event.args[field]) && event.args[field] >= 0),
        'Invalid native GC heap usage',
      );
    category.push({
      startUs: event.ts,
      wallMs: event.dur / 1000,
      cpuMs: event.tdur === undefined ? null : event.tdur / 1000,
      heapUsedBeforeBytes: event.args?.usedHeapSizeBefore ?? null,
      heapUsedAfterBytes: event.args?.usedHeapSizeAfter ?? null,
    });
  }
  const durations = (rows) => ({
    count: rows.length,
    wallMs: rows.reduce((sum, row) => sum + row.wallMs, 0),
    cpuMs: rows.every((row) => row.cpuMs !== null)
      ? rows.reduce((sum, row) => sum + row.cpuMs, 0)
      : null,
    maxWallMs: rows.reduce((max, row) => Math.max(max, row.wallMs), 0),
    events: rows,
  });
  const profiles = [...threads.values()].map((row) => {
    row.counters.sort((a, b) => a.ts - b.ts);
    for (let index = 1; index < row.counters.length; index++)
      assert(
        row.counters[index].ts > row.counters[index - 1].ts,
        'Native GC boundaries must advance',
      );
    // The first counter covers allocations before its boundary, potentially
    // before tracing began. Only subsequent boundary-to-boundary deltas qualify.
    const intervals = row.counters.slice(1);
    const windowUs = row.counters.length < 2 ? null : row.counters.at(-1).ts - row.counters[0].ts;
    const allocatedBytes =
      windowUs === null ? null : intervals.reduce((sum, row) => sum + row.allocated, 0);
    return {
      targetId: row.targetId,
      realm: row.realm,
      minor: durations(row.minor),
      major: durations(row.major),
      finalization: durations(row.finalization),
      cppgcSweep: durations(row.cppgc),
      untimedTaskEvents: row.untimedTaskEvents,
      boundaryCounters: {
        count: row.counters.length,
        excludesFirstCounter: true,
        tailUnobserved: true,
        windowMs: windowUs === null ? null : windowUs / 1000,
        allocatedBytes,
        promotedBytes:
          windowUs === null ? null : intervals.reduce((sum, row) => sum + row.promoted, 0),
        allocatedMiBPerSecond: windowUs > 0 ? allocatedBytes / 1048576 / (windowUs / 1e6) : null,
      },
    };
  });
  return {
    profiles,
    limitation:
      'Native complete-event wall/CPU durations are not additive to sampled JS GC or one another. GC counters cover only consecutive observed boundaries, omit the first counter and leave the tail unobserved. Promotion and allocation are not resident memory. Missing thread CPU clocks remain null; background GC tasks on other threads are excluded.',
  };
}

/** Terminal heap-profile reads can force GC; only the CPU interval qualifies. */
export function summarizeNativeGc(trace, markers, window) {
  const wholeTrace = summarizeNativeGcTrace(trace, markers);
  if (window === undefined) return wholeTrace;
  assert(
    Number.isFinite(window.startTime) &&
      Number.isFinite(window.endTime) &&
      window.endTime > window.startTime,
    'Invalid native GC observation window',
  );
  const names = new Set(markers.map((marker) => marker.name));
  for (const event of trace.traceEvents)
    if (names.has(event.name))
      assert(event.ts <= window.startTime, 'Native marker and CPU profile clocks disagree');
  const traceEvents = trace.traceEvents.filter(
    (event) =>
      names.has(event.name) ||
      (Number.isFinite(event.ts) &&
        event.ts >= window.startTime &&
        event.ts < window.endTime &&
        (event.ph !== 'X' || event.ts + event.dur <= window.endTime)),
  );
  return {
    ...summarizeNativeGcTrace({ traceEvents }, markers),
    observationWindow: { ...window, durationMs: (window.endTime - window.startTime) / 1000 },
    wholeTrace,
    limitation:
      wholeTrace.limitation +
      ' Primary profiles require complete events inside the common CPU interval. Terminal heap-sampling forced GC and events crossing its edges remain in wholeTrace, which is not natural workload GC.',
  };
}

runCli(import.meta.url, async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      markers: { type: 'string' },
      'markers-pointer': { type: 'string', default: '' },
      'trace-pointer': { type: 'string', default: '' },
      'start-us': { type: 'string' },
      'end-us': { type: 'string' },
      output: { type: 'string' },
    },
  });
  if (values.help) {
    console.log(
      'node summarize_native_gc.mjs TRACE --markers MARKERS [--markers-pointer /markers] [--trace-pointer /trace] [--start-us N --end-us N] [--output FILE]',
    );
    return;
  }
  requireFact(positionals.length === 1 && values.markers, 'Require trace and markers files');
  requireFact(
    (values['start-us'] === undefined) === (values['end-us'] === undefined),
    'Supply both window boundaries',
  );
  const trace = await loadJson(positionals[0]),
    markers = await loadJson(values.markers);
  const window =
    values['start-us'] === undefined
      ? undefined
      : { startTime: Number(values['start-us']), endTime: Number(values['end-us']) };
  await emitJson(
    {
      kind: 'native-gc-summary',
      inputSha256: trace.sha256,
      markersSha256: markers.sha256,
      ...summarizeNativeGc(
        pointer(trace.value, values['trace-pointer']),
        pointer(markers.value, values['markers-pointer']),
        window,
      ),
    },
    values.output,
    [...positionals, values.markers],
  );
});
