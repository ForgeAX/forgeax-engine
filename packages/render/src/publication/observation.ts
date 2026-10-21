/** Private, opt-in source-side evidence. Never included in a RenderPublication. */
export const SOURCE_PREPARATION_PROTOCOL = 'source-preparation-observation-v1';
type SourcePreparationPhase =
  | 'selection'
  | 'extract'
  | 'templates'
  | 'feature'
  | 'packet'
  | 'clone'
  | 'candidate'
  | 'transfer-list'
  | 'send'
  | 'accept';
export interface SourcePreparationControl {
  protocol: typeof SOURCE_PREPARATION_PROTOCOL;
  enabled: boolean;
  token: string;
  /** Collector assertion, not a runtime source-authentication substitute. */
  build: string;
  worldIdentity: string;
  maxAttempts: number;
  attempts: number;
  skipped: number;
  dropped: number;
  failures: number;
  probeWallMs: number;
  observerWallMs: number;
  clockCalls: number;
  clockFailures: number;
  cancelled: boolean;
  finalizationWallMs: number;
  outcomes: Record<'accepted' | 'discarded' | 'prepare-error' | 'retired', number>;
  result?: unknown;
}
type ObservationGlobal = typeof globalThis & {
  __forgeaxFramePhaseDiagnostics?: { sourcePreparation?: SourcePreparationControl };
};

/** Absent/disabled means no allocation, clock, wrapper, or extra World read. */
export function beginSourcePreparation(
  world: { readonly identity: string },
  source: string,
  epoch: number,
  revision: number,
  frameId: number | undefined,
  baseline: boolean,
) {
  let control: SourcePreparationControl | undefined;
  try {
    control = (globalThis as ObservationGlobal).__forgeaxFramePhaseDiagnostics?.sourcePreparation;
    if (
      control?.enabled !== true ||
      control.protocol !== SOURCE_PREPARATION_PROTOCOL ||
      control.worldIdentity !== world.identity ||
      baseline ||
      control.result !== undefined
    )
      return undefined;
    if (control.attempts >= Math.min(120, control.maxAttempts)) {
      control.enabled = false;
      control.dropped++;
      return undefined;
    }
    control.attempts++;
  } catch {
    return undefined;
  }
  const owner = control;
  const worldIdentity = world.identity;
  let clocks = 0,
    clockFailures = 0;
  const now = () => {
    clocks++;
    try {
      return performance.now();
    } catch {
      clockFailures++;
      return Number.NaN;
    }
  };
  const begin = now();
  let cursor = begin,
    phase: SourcePreparationPhase = 'selection',
    overheadMs = 0,
    operations = 0,
    closed = false,
    runtimeMeshes = 0,
    meshMutation = false,
    omitted = 0;
  const phases: Partial<Record<SourcePreparationPhase, number>> = {};
  const counts: Record<string, number> = {};
  const facts: Record<string, number | boolean> = {};
  const rows: {
    handle: number;
    runtime: boolean;
    verticesBytes: number | null;
    indicesBytes: number | null;
  }[] = [];
  // Every observer mutation is bracketed; these intervals are excluded from phases.
  // This is observer wall cost, not an estimate of unobserved execution speed.
  const observe = (write: (at: number) => void) => {
    if (closed) return undefined;
    try {
      const at = now();
      if (!Number.isFinite(at) || at < cursor) clockFailures++;
      else phases[phase] = (phases[phase] ?? 0) + at - cursor;
      operations++;
      write(at);
      const end = now();
      if (!Number.isFinite(end) || end < at) clockFailures++;
      else overheadMs += end - at;
      cursor = end;
      return end - at;
    } catch {
      // Instrumentation must never replace the original return/error.
      try {
        owner.failures++;
      } catch {
        /* Foreign control. */
      }
      return undefined;
    }
  };
  return {
    phase(next: SourcePreparationPhase) {
      observe(() => {
        phase = next;
      });
    },
    count(reason: string, inserted?: boolean) {
      observe(() => {
        // Reasons are fixed source literals; no entity/provider serialization.
        if (reason === 'mesh-filter-write') meshMutation = true;
        counts[reason] = (counts[reason] ?? 0) + 1;
        if (inserted === true)
          counts[`${reason}:inserted`] = (counts[`${reason}:inserted`] ?? 0) + 1;
      });
    },
    fact(name: string, value: number | boolean) {
      observe(() => {
        facts[name] = value;
        if (
          (name === 'pendingMeshContent' && typeof value === 'number' && value > 0) ||
          (name === 'runtimeNewMesh' && value === true)
        )
          meshMutation = true;
      });
    },
    mesh(handle: number, runtime: boolean, cloned: object) {
      observe(() => {
        if (runtime) runtimeMeshes++;
        if (rows.length >= 64) {
          omitted++;
          return;
        }
        // Inspect only the already-owned clone. Never re-read the source mesh.
        const bytes = (name: string) => {
          const descriptor = Object.getOwnPropertyDescriptor(cloned, name);
          const value = descriptor && 'value' in descriptor ? descriptor.value : undefined;
          return ArrayBuffer.isView(value) ? value.byteLength : null;
        };
        rows.push({
          handle,
          runtime,
          verticesBytes: bytes('vertices'),
          indicesBytes: bytes('indices'),
        });
      });
    },
    finish(status: 'accepted' | 'discarded' | 'prepare-error' | 'retired') {
      if (closed) return;
      const finalizationMs = observe((at) => {
        owner.outcomes[status]++;
        owner.probeWallMs += at - begin;
        owner.observerWallMs += overheadMs;
        if (runtimeMeshes === 0 || !meshMutation) {
          owner.skipped++;
          return;
        }
        const result = {
          protocol: SOURCE_PREPARATION_PROTOCOL,
          token: owner.token,
          buildAssertion: owner.build,
          worldIdentity,
          source,
          epoch,
          revision,
          frameId: frameId ?? null,
          beginMs: begin,
          endMs: at,
          timeOriginMs: performance.timeOrigin,
          status: owner.cancelled ? 'cancelled' : status,
          runtimeMeshes,
          meshMutation,
          phases,
          counts,
          facts,
          rows,
          omitted,
          clock: { domain: 'EngineWorker-performance', calls: clocks, failures: clockFailures },
          observer: { wallMs: overheadMs, operations, intrusive: true, includesFinalExport: false },
          limitation:
            'Reason counts overlap. Runtime means an emitted mesh without a Catalog GUID, not proof every such mesh changed. Phase wall is not CPU; no receiver replay, GPU fence, or net savings claim. Clone bytes cover top-level views only, not total payload or unique buffers.',
        };
        // Fixed metadata only, never World/mesh dumps. Overflow is explicit.
        const encoded = JSON.stringify(result);
        owner.result =
          new TextEncoder().encode(encoded).byteLength <= 16384
            ? result
            : {
                protocol: SOURCE_PREPARATION_PROTOCOL,
                token: owner.token,
                status: 'unavailable',
                reason: 'byte-budget',
                worldIdentity,
                source,
                epoch,
                revision,
                frameId: frameId ?? null,
                omitted: rows.length + omitted,
                maxBytes: 16384,
              };
        owner.enabled = false;
      });
      closed = true;
      try {
        owner.clockCalls += clocks;
        owner.clockFailures += clockFailures;
        if (Number.isFinite(finalizationMs)) owner.finalizationWallMs += finalizationMs ?? 0;
      } catch {
        /* A foreign observer cannot change transaction completion. */
      }
    },
  };
}
export type SourcePreparationObservation = NonNullable<ReturnType<typeof beginSourcePreparation>>;
