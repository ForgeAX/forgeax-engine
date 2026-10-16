import type { RunIdentity, LeaseTarget } from './carrier-contract.ts';

export type RunBinding = { root: string; runId: string };
/** Only the cached Engine observation fields presented by this product panel. */
export type RunObservation = {
  status?: { phase?: string; runId?: string; revision?: number; inputVersion?: string };
  image?: { capturedAt?: string; revision?: number; frameId?: number; png?: string };
  droppedLogs?: number;
  logs?: readonly { sequence: number; level: string; text: string }[];
};
export type DisplayStatusInput = {
  status?: string; state?: string; occupancy?: { run: RunIdentity } | null;
  run?: RunIdentity | null; target?: LeaseTarget | null; error?: unknown;
  observation?: RunObservation | null; binding?: RunBinding | null;
};
export type DisplayState = Required<Pick<DisplayStatusInput, 'run' | 'target' | 'observation' | 'binding'>> & { status: string; error: string | null };

export class ViewDisplayStatus {
  declare state: DisplayState;
  declare readonly listeners: Set<() => void>;
  constructor() {
    this.state = { status: 'idle', run: null, target: null, error: null, binding: null, observation: null };
    this.listeners = new Set();
  }

  update(snapshot: DisplayStatusInput = {}) {
    const state = snapshot.status ?? snapshot.state;
    const status =
      state === 'occupied'
        ? 'running'
        : state === 'ready'
          ? 'idle'
          : state ?? (snapshot.occupancy ? 'running' : 'idle');
    this.state = {
      status,
      run: snapshot.run ?? snapshot.occupancy?.run ?? null,
      target: snapshot.target ?? null,
      error: snapshot.error ? String(snapshot.error) : null,
      observation: snapshot.observation ?? null,
      binding: snapshot.binding ?? null,
    };
    for (const listener of this.listeners) listener();
  }

  getSnapshot = () => this.state;

  snapshot() {
    return this.state;
  }

  renderStatus() {
    if (this.state.error) return `View connection error: ${this.state.error}`;
    if (this.state.status === 'unavailable') return 'View unavailable';
    if (this.state.status === 'stopping') return 'View stopping';
    return this.state.status === 'running' ? 'View ready (running)' : 'View ready (idle)';
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose() {
    this.listeners.clear();
  }
}
