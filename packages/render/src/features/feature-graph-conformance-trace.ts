export type FeatureGraphConformanceScalar = string | number | boolean | null;

export type FeatureGraphConformanceEvent = Readonly<{
  readonly recordFrameNumber: number;
  readonly featureIdentity: string;
  readonly stage:
    | 'host-plan-declared'
    | 'host-plan-published'
    | 'host-plan-failed'
    | 'typed-plan-input'
    | 'typed-plan-validated'
    | 'standard-scene-selection'
    | 'graph-decision'
    | 'graph-passes'
    | 'candidate-lifecycle';
  readonly details: Readonly<
    Record<string, FeatureGraphConformanceScalar | readonly FeatureGraphConformanceScalar[]>
  >;
}>;

export interface FeatureGraphConformanceTraceState {
  readonly featureIdentity: string;
  recordFrameNumber: number | undefined;
  readonly events: FeatureGraphConformanceEvent[];
  droppedEvents: number;
}

const MAX_FEATURE_GRAPH_TRACE_EVENTS_PER_FRAME = 64;
const MAX_FEATURE_GRAPH_TRACE_ARRAY_ITEMS = 32;
const MAX_FEATURE_GRAPH_TRACE_STRING = 256;

export function createFeatureGraphConformanceTrace(
  featureIdentity: string,
): FeatureGraphConformanceTraceState {
  return { featureIdentity, recordFrameNumber: undefined, events: [], droppedEvents: 0 };
}

export function isFeatureGraphConformanceEnabled(
  state: FeatureGraphConformanceTraceState | undefined,
  featureIdentity: string,
): state is FeatureGraphConformanceTraceState {
  return state !== undefined && state.featureIdentity === featureIdentity;
}

function boundedScalar(value: FeatureGraphConformanceScalar): FeatureGraphConformanceScalar {
  if (typeof value !== 'string' || value.length <= MAX_FEATURE_GRAPH_TRACE_STRING) return value;
  return `${value.slice(0, MAX_FEATURE_GRAPH_TRACE_STRING)}...[truncated]`;
}

function boundedDetails(
  details: FeatureGraphConformanceEvent['details'],
): FeatureGraphConformanceEvent['details'] {
  const result: Record<
    string,
    FeatureGraphConformanceScalar | readonly FeatureGraphConformanceScalar[]
  > = {};
  for (const [key, value] of Object.entries(details).slice(
    0,
    MAX_FEATURE_GRAPH_TRACE_ARRAY_ITEMS,
  )) {
    if (Array.isArray(value)) {
      result[key] = Object.freeze(
        value
          .slice(0, MAX_FEATURE_GRAPH_TRACE_ARRAY_ITEMS)
          .map((item) => boundedScalar(item as FeatureGraphConformanceScalar)),
      );
    } else {
      result[key] = boundedScalar(value as FeatureGraphConformanceScalar);
    }
  }
  return Object.freeze(result);
}

export function recordFeatureGraphConformanceEvent(
  state: FeatureGraphConformanceTraceState | undefined,
  event: FeatureGraphConformanceEvent,
): void {
  if (!isFeatureGraphConformanceEnabled(state, event.featureIdentity)) return;
  if (state.recordFrameNumber !== event.recordFrameNumber) {
    state.recordFrameNumber = event.recordFrameNumber;
    state.events.length = 0;
    state.droppedEvents = 0;
  }
  if (state.events.length >= MAX_FEATURE_GRAPH_TRACE_EVENTS_PER_FRAME) {
    state.events.shift();
    state.droppedEvents += 1;
  }
  state.events.push(Object.freeze({ ...event, details: boundedDetails(event.details) }));
}

export function readFeatureGraphConformanceTrace(
  state: FeatureGraphConformanceTraceState | undefined,
):
  | Readonly<{
      readonly featureIdentity: string;
      readonly retainedRecordFrameNumber: number | null;
      readonly droppedEvents: number;
      readonly events: readonly FeatureGraphConformanceEvent[];
    }>
  | undefined {
  if (state === undefined) return undefined;
  return Object.freeze({
    featureIdentity: state.featureIdentity,
    retainedRecordFrameNumber: state.recordFrameNumber ?? null,
    droppedEvents: state.droppedEvents,
    events: Object.freeze([...state.events]),
  });
}
