import { perfettoHtml } from './perfetto_view.mjs';
export { PERFETTO_UI, perfettoUiUrl } from './perfetto_view.mjs';

export function cpuPerfettoHtml(model, trace, options = {}) {
  const metadata = {
    identity: model.identity,
    captureScope: model.captureScope,
    startMs: model.startMs,
    endMs: model.endMs,
    fromMs: options.fromMs ?? model.initialView?.fromMs ?? model.startMs,
    toMs: options.toMs ?? model.initialView?.toMs ?? model.endMs,
    frames: model.frameIntervals.map((f) => ({
      id: f.current.frameId,
      startMs: f.startMs,
      endMs: f.endMs,
    })),
    interpretation: model.interpretation,
  };
  return perfettoHtml(
    {
      ...metadata,
      title: 'CPU timeline',
      links: [
        ['timeline.svg', 'Static timeline SVG'],
        ['timeline-inspector.html', 'Call trees / AI details'],
        ['timeline.trace.json', 'Download trace'],
      ],
      hint: 'Sampled JS targets; widths are estimates, completion gaps are receipt intervals.',
    },
    trace,
    { ...options, normalizeSource: normalizeCpuInput.toString() },
  );
}

function normalizeCpuInput(value, convert) {
  if (value.kind !== 'sampled-cpu-timeline' || value.schemaVersion !== 1 || !convert)
    throw Error('Unsupported normalized timeline');
  return {
    trace: convert(value),
    metadata: {
      identity: value.identity,
      captureScope: value.captureScope,
      startMs: value.startMs,
      endMs: value.endMs,
      fromMs: value.startMs,
      toMs: value.endMs,
      frames: value.frameIntervals.map((f) => ({
        id: f.current.frameId,
        startMs: f.startMs,
        endMs: f.endMs,
      })),
    },
  };
}
