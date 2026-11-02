import {
  captureModels,
  type JournalEntry,
  type Model,
  model,
  type SourceSite,
  sel,
} from '@forgeax/engine-modeling';
import type { MeshAsset } from '@forgeax/engine/types';

/** One state of the build history: the session right after one operation. */
export interface HistoryStep {
  /** Label of the build stage the step belongs to (for example `S2 body`). */
  readonly stage: string;
  readonly opIndex: number;
  readonly op: string;
  readonly label?: string;
  /** Author call site of the operation (exact when the build source keeps its positions). */
  readonly source?: SourceSite;
  readonly faces: number;
}

export interface ShowHistory {
  readonly steps: readonly HistoryStep[];
  /** Operations in the stage journals, including those that leave no faces. */
  readonly operations: number;
  /** The renderable state after `steps[index]`; faces the step created take the `highlight` slot. */
  mesh(index: number): MeshAsset;
}

/** One build of the history: a Pack build (or its modeling function) and the session to follow. */
export interface HistoryStage {
  readonly label: string;
  readonly build: () => unknown;
  /** Pick the session to replay; default: the rig's source session, else the one that finished. */
  readonly session?: (sessions: readonly Model[]) => Model | undefined;
}

const outputSession = (sessions: readonly Model[]) =>
  sessions.find((s) => s.inspect().output !== undefined) ??
  [...sessions].sort((a, b) => b.journal.length - a.journal.length)[0];

/**
 * Re-run each stage's build with a snapshot after every operation (the kernel's step
 * capture, the same journal `forgeax model replay` renders) and join the stages into
 * one timeline: a whole-machine history runs through every build stage in order.
 */
export async function captureHistory(stages: readonly HistoryStage[]): Promise<ShowHistory> {
  const steps: (HistoryStep & { readonly snapshot: Uint8Array })[] = [];
  let operations = 0;
  for (const stage of stages) {
    const captured = await captureModels(stage.build, { steps: true });
    if (!captured.ok) throw captured.error;
    const { sessions, rigs } = captured.value;
    const session = stage.session?.(sessions) ?? rigs[0]?.source ?? outputSession(sessions);
    if (session === undefined) throw new Error(`history stage ${stage.label} created no modeling session`);
    const snapshots = new Map(session.diagnostics().steps.map((s) => [s.opIndex, s.snapshot]));
    operations += session.journal.length;
    for (const entry of session.journal as readonly JournalEntry[]) {
      const snapshot = snapshots.get(entry.opIndex);
      if (snapshot === undefined || entry.status !== 'ok' || entry.faces === 0) continue;
      steps.push({
        stage: stage.label,
        opIndex: entry.opIndex,
        op: entry.op,
        ...(entry.label === undefined ? {} : { label: entry.label }),
        ...(entry.source === undefined ? {} : { source: entry.source }),
        faces: entry.faces,
        snapshot,
      });
    }
  }
  if (steps.length === 0) throw new Error('the build history has no state with faces');
  const meshes = new Map<number, MeshAsset>();
  return {
    steps: steps.map(({ snapshot: _snapshot, ...step }) => step),
    operations,
    mesh(index) {
      const cached = meshes.get(index);
      if (cached !== undefined) return cached;
      const step = steps[index];
      if (step === undefined) throw new RangeError(`history step ${index} of ${steps.length}`);
      const view = model();
      view.append(step.snapshot);
      if (step.label !== undefined && step.op !== 'append') {
        const created = sel.createdBy(step.label);
        if (view.count(created) > 0) view.assign(created, 'highlight');
      }
      view.uv.project({ mode: 'box', scale: 0.5 });
      let out = view.toMesh({ normals: { mode: 'autoSmooth', angle: 35 } });
      // A mid-build state can carry a channel the build fills only later (uv1 on some faces).
      const channel = out.ok ? undefined : (out.error.detail as { channel?: unknown } | undefined)?.channel;
      if (!out.ok && channel === 'uv1') {
        view.uv.project({ mode: 'box', scale: 0.5, channel });
        out = view.toMesh({ normals: { mode: 'autoSmooth', angle: 35 } });
      }
      if (!out.ok) throw out.error;
      meshes.set(index, out.value.mesh);
      return out.value.mesh;
    },
  };
}
