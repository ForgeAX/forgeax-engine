import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SnapshotField } from './scene-field-snapshot-budget.fixture';

/** Actual returned allocation identities and bytes, independent of the budget helper. */
export function saveSnapshotBudgetEvidence(
  fields: readonly SnapshotField[],
  snapshots: readonly SnapshotField[],
  budget: number,
  accepted: boolean,
  fieldCopies: number,
) {
  const output = process.env.FORGEAX_SNAPSHOT_BUDGET_EVIDENCE;
  if (!output) return;
  mkdirSync(output, { recursive: true });
  const buffers = new Map<ArrayBufferLike, number>();
  const allocations: { id: number; bytes: number; sha256: string; file: string }[] = [];
  const inventory = (field: SnapshotField) => {
    const channels = [
      ['bricks', field.bricks],
      ['values', field.values],
      ...Object.entries(field.surface ?? {}),
    ] as const;
    return channels.map(([name, view]) => {
      let id = buffers.get(view.buffer);
      if (id === undefined) {
        id = buffers.size;
        buffers.set(view.buffer, id);
        const bytes = new Uint8Array(view.buffer);
        const file = `allocation-${id}.bin`;
        writeFileSync(join(output, file), bytes, { flag: 'wx' });
        allocations.push({
          id,
          bytes: bytes.byteLength,
          file,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      }
      return { name, allocation: id, byteOffset: view.byteOffset, byteLength: view.byteLength };
    });
  };
  const source = fields.map(inventory),
    returned = snapshots.map(inventory);
  writeFileSync(
    join(output, 'observation.json'),
    JSON.stringify(
      {
        accepted,
        budget,
        fieldCopies,
        source,
        returned,
        allocations,
        scope:
          'Actual CPU canonical numeric backing admission. Not process heap, GPU, physical GI or performance acceptance.',
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
}
