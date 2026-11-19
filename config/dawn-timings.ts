import { readFileSync } from 'node:fs';
import ledger from '../scripts/ci/dawn-file-seconds.json' with { type: 'json' };
import { DAWN_ORDINARY_FILE_FAMILIES } from '../scripts/ci/dawn-gate-roster.mjs';

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

/** Fold split-file receipts into one logical cost without rewriting raw observations. */
export function dawnFileOwnerCosts(files: Readonly<Record<string, number | undefined>>) {
  const costs = new Map(
    Object.entries(files).filter((entry): entry is [string, number] => entry[1] !== undefined),
  );
  for (const family of DAWN_ORDINARY_FILE_FAMILIES) {
    const members = [family.anchor, ...family.children];
    if (!members.some((file) => costs.has(file))) continue;
    const seconds = members.reduce((sum, file) => sum + (costs.get(file) ?? 0), 0);
    for (const child of family.children) costs.delete(child);
    costs.set(family.anchor, seconds);
  }
  return costs;
}

/** Select matching core receipts without loading historical snapshots. */
export function dawnPlanningOwnerCosts(environment = process.env) {
  return new Map(
    Object.entries({
      ...ledger.owners,
      ...(environment.FORGEAX_CI_CORE_VALIDATION === '1' &&
      environment.FORGEAX_DAWN_LIGHTWEIGHT === '1'
        ? ledger.coreProfile.owners
        : {}),
    }),
  );
}

export function dawnPlanningFileCosts(environment = process.env) {
  const planningFiles = new Map<string, number>(
    Object.entries({
      ...ledger.fileReserves,
      ...ledger.files,
      ...(environment.FORGEAX_CI_CORE_VALIDATION === '1' &&
      environment.FORGEAX_DAWN_LIGHTWEIGHT === '1'
        ? ledger.coreProfile.files
        : {}),
    }),
  );
  for (const family of DAWN_ORDINARY_FILE_FAMILIES) {
    const seconds = dawnFileOwnerCosts(Object.fromEntries(planningFiles)).get(family.anchor);
    if (seconds === undefined) throw new Error('Dawn file family has no complete forecast');
    // The sequencer collapses these files before planning, then expands them
    // together on one physical lane. Charge extra process startup only once.
    planningFiles.set(family.anchor, seconds + family.additionalProcessReserveSeconds);
    for (const child of family.children) planningFiles.set(child, seconds);
  }
  return planningFiles;
}

/** Historical observations retain their original source and roster. */
export function readDawnTimings() {
  const planningFiles = dawnPlanningFileCosts();
  return {
    ...ledger,
    // Explicit current forecasts may raise placement above an older observation.
    // They never rewrite measurements or the source-qualified replay archive.
    planningFiles: Object.fromEntries(planningFiles),
    planningOwners: Object.fromEntries(dawnPlanningOwnerCosts()),
    latestRun: readSnapshot(ledger.latestRun),
    previousRun: readSnapshot(ledger.previousRun),
    replayRuns: ledger.replayRuns.map(readSnapshot),
  };
}
