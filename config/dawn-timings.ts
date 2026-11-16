import { readFileSync } from 'node:fs';
import ledger from '../scripts/ci/dawn-file-seconds.json' with { type: 'json' };

export type DawnTimingSnapshot = {
  readonly runId: number;
  readonly files: Readonly<Record<string, number | undefined>>;
  readonly owners: Readonly<Record<string, number | undefined>>;
  readonly reservedFiles?: Readonly<Record<string, number | undefined>>;
  readonly reservedOwners?: Readonly<Record<string, number | undefined>>;
};

function readSnapshot(runId: number): DawnTimingSnapshot {
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error('Invalid Dawn timing run ID');
  const source = new URL(`../scripts/ci/dawn-timing-snapshots/${runId}.json`, import.meta.url);
  const snapshot = JSON.parse(readFileSync(source, 'utf8')) as DawnTimingSnapshot;
  if (snapshot.runId !== runId) throw new Error('Dawn timing snapshot identity mismatch');
  return snapshot;
}

/** Historical observations have one archive; aggregate maxima retain older measurements. */
export function readDawnTimings() {
  return {
    ...ledger,
    // New complete files use explicit deadline reserves until measured.
    // Measurements stay authoritative and the historical archive stays intact.
    planningFiles: { ...ledger.fileReserves, ...ledger.files },
    latestRun: readSnapshot(ledger.latestRun),
    previousRun: readSnapshot(ledger.previousRun),
    replayRuns: ledger.replayRuns.map(readSnapshot),
  };
}
