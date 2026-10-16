import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const service = 'disabled-by-default-gpu.service';
const decoder = 'disabled-by-default-gpu.decoder';

function statistics(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    p50: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
  };
}

/** Offline CPU service scopes; never hardware GPU time or gameplay FPS. */
export function analyzeChromiumGpuDecoder(trace, { windowUs } = {}) {
  const events = trace?.traceEvents;
  if (!Array.isArray(events)) throw new Error('Expected a Chrome JSON traceEvents array');
  if (
    windowUs !== undefined &&
    (!Array.isArray(windowUs) ||
      windowUs.length !== 2 ||
      !windowUs.every(Number.isFinite) ||
      windowUs[0] >= windowUs[1])
  ) {
    throw new Error('windowUs must contain increasing finite trace timestamps in microseconds');
  }
  const pending = new Map();
  const groups = new Map();
  const coverage = {
    decoderBegins: 0,
    completeSpans: 0,
    selectedSpans: 0,
    unclosedDecoderBegins: 0,
    unmatchedServiceEnds: 0,
    invalidServiceEvents: 0,
  };
  const [lo, hi] = windowUs ?? [-Infinity, Infinity];
  for (const event of events) {
    if (event.cat !== service || (event.ph !== 'b' && event.ph !== 'e')) continue;
    const id =
      event.id2?.local !== undefined
        ? ['local', event.id2.local]
        : event.id2?.global !== undefined
          ? ['global', event.id2.global]
          : event.id !== undefined
            ? ['id', event.id, event.scope]
            : null;
    if (
      !id ||
      !Number.isFinite(event.ts) ||
      event.pid === undefined ||
      event.tid === undefined ||
      typeof event.name !== 'string'
    ) {
      coverage.invalidServiceEvents++;
      continue;
    }
    // IDs can be reused and nested. End events often omit gl_category entirely.
    const key = JSON.stringify([event.pid, event.tid, event.name, id]);
    const stack = pending.get(key) ?? [];
    if (event.ph === 'b') {
      if (event.args?.gl_category === decoder) coverage.decoderBegins++;
      stack.push(event);
      pending.set(key, stack);
      continue;
    }
    const begin = stack.pop();
    if (!begin) {
      coverage.unmatchedServiceEnds++;
      continue;
    }
    if (!stack.length) pending.delete(key);
    if (event.ts < begin.ts) {
      coverage.invalidServiceEvents++;
      continue;
    }
    if (begin.args?.gl_category !== decoder) continue;
    coverage.completeSpans++;
    const zero = event.ts === begin.ts;
    if (!(zero ? begin.ts >= lo && begin.ts < hi : begin.ts < hi && event.ts > lo)) continue;
    coverage.selectedSpans++;
    const groupKey = JSON.stringify([begin.pid, begin.tid, begin.name]);
    const group = groups.get(groupKey) ?? {
      pid: begin.pid,
      tid: begin.tid,
      command: begin.name,
      count: 0,
      clippedWallMs: 0,
      containedWallMs: [],
    };
    group.count++;
    group.clippedWallMs += (Math.min(event.ts, hi) - Math.max(begin.ts, lo)) / 1000;
    if (begin.ts >= lo && event.ts <= hi) group.containedWallMs.push((event.ts - begin.ts) / 1000);
    groups.set(groupKey, group);
  }
  for (const stack of pending.values()) {
    coverage.unclosedDecoderBegins += stack.filter(
      (event) => event.args?.gl_category === decoder,
    ).length;
  }
  const partial =
    coverage.unclosedDecoderBegins ||
    coverage.unmatchedServiceEnds ||
    coverage.invalidServiceEvents;
  return {
    schemaVersion: 'forgeax-chromium-gpu-decoder/1',
    status: coverage.decoderBegins === 0 ? 'unavailable' : partial ? 'partial' : 'complete',
    diagnosticOnly: true,
    scope:
      'Inclusive CPU service wall-clock scopes, not exclusive CPU time, hardware GPU time or FPS. Do not sum nested scopes. Unclosed ranges are excluded; zero-duration complete ranges are retained.',
    windowUs: windowUs ?? null,
    coverage,
    commands: [...groups.values()]
      .map(({ containedWallMs, ...group }) => ({
        ...group,
        containedDurationMs: statistics(containedWallMs),
      }))
      .sort((a, b) => b.clippedWallMs - a.clippedWallMs),
  };
}

/** Resolve one unambiguous pair of performance.mark events on the trace clock. */
export function decoderMarkWindow(trace, beginName, endName) {
  const mark = (name) => {
    const matches = trace.traceEvents.filter(
      (event) =>
        event.cat === 'blink.user_timing' &&
        event.name === name &&
        event.ph === 'I' &&
        Number.isFinite(event.ts),
    );
    if (matches.length !== 1)
      throw new Error(`Expected one performance mark: ${name}; found ${matches.length}`);
    return matches[0];
  };
  const begin = mark(beginName),
    end = mark(endName);
  if (begin.pid !== end.pid || begin.tid !== end.tid || begin.ts >= end.ts) {
    throw new Error('Performance marks must be ordered on the same renderer thread');
  }
  return [begin.ts, end.ts];
}

async function main() {
  const { values } = parseArgs({
    options: {
      trace: { type: 'string' },
      output: { type: 'string' },
      help: { type: 'boolean' },
      'start-us': { type: 'string' },
      'end-us': { type: 'string' },
      'begin-mark': { type: 'string' },
      'end-mark': { type: 'string' },
    },
  });
  if (values.help) {
    process.stdout.write(
      'Usage: node analyze_chromium_gpu_decoder.mjs --trace trace.json [--output analysis.json]\n  [--start-us N --end-us N | --begin-mark NAME --end-mark NAME]\nOffline only. Input is Chrome JSON traceEvents; output preserves missing/partial coverage.\n',
    );
    return;
  }
  if (!values.trace) throw new Error('--trace is required');
  if (values.output && resolve(values.output) === resolve(values.trace))
    throw new Error('Output must not overwrite the raw trace');
  const bytes = await readFile(values.trace);
  const trace = JSON.parse(bytes.toString('utf8'));
  const numeric = values['start-us'] !== undefined || values['end-us'] !== undefined;
  const marked = values['begin-mark'] !== undefined || values['end-mark'] !== undefined;
  if (numeric && marked) throw new Error('Choose numeric bounds or named marks, not both');
  if (numeric && (values['start-us'] === undefined || values['end-us'] === undefined))
    throw new Error('Both --start-us and --end-us are required');
  if (marked && (!values['begin-mark'] || !values['end-mark']))
    throw new Error('Both --begin-mark and --end-mark are required');
  const windowUs = numeric
    ? [Number(values['start-us']), Number(values['end-us'])]
    : marked
      ? decoderMarkWindow(trace, values['begin-mark'], values['end-mark'])
      : undefined;
  const result = {
    ...analyzeChromiumGpuDecoder(trace, { windowUs }),
    input: { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length },
  };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (values.output) await writeFile(values.output, json);
  else process.stdout.write(json);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
