import type { RenderFeatureWorkPlan } from '@forgeax/engine-render';

type Pass = RenderFeatureWorkPlan['passes'][number];
type Compute = Extract<Pass, { readonly kind: 'compute' }>;
type Bindings = Extract<
  RenderFeatureWorkPlan['resources'][number],
  { readonly kind: 'compute-bindings' }
>;

interface Batch {
  readonly program: string;
  readonly passes: Compute[];
  /** Owned resource names (read once each, as the original observation order). */
  readonly resources: string[];
  /** Cleared once the batch is flushed; stale owner entries are then absent. */
  live: boolean;
}
// Coalescing is synchronous and non-reentrant. Resource tables persist across
// calls and are overwritten in place (Map.clear/delete would release and regrow
// their hash tables every frame); entries are validated by batch liveness or
// group serial and the tables are dropped once they exceed a bounded size.
const TABLE_LIMIT = 8192;
const pendingScratch = new Map<string, Batch>();
let ownerScratch = new Map<string, Batch>();
let copySources = new Map<string, number>();
let copyDestinations = new Map<string, number>();
let copyGroup = 0;

/**
 * These programs are proven by the stock producer to have only private Player
 * storage and no data-interface/provider aliases. Keep every dispatch and its
 * original binding, while delaying independent work into one compute encoder.
 * Copies and unknown work remain barriers wherever they can observe that work.
 */
export function coalesceVfxComputePasses(
  passes: readonly Pass[],
  privatePrograms: ReadonlySet<string>,
  bindings: (name: string) => Bindings | undefined,
): readonly Pass[] {
  if (privatePrograms.size === 0 || passes.length < 2) return passes;
  // Copies only flush pending compute batches; without a private compute pass
  // there is nothing to batch and the order is returned unchanged.
  if (!passes.some((pass) => pass.kind === 'compute' && privatePrograms.has(pass.program)))
    return passes;
  const output: Pass[] = [];
  const pending = pendingScratch;
  const resourceOwners = ownerScratch;
  try {
    return coalesceComputeInto(passes, privatePrograms, bindings, output, pending, resourceOwners);
  } finally {
    // Every batch is flushed (dead) on success; an exception may leave live
    // batches, so the pending table is dropped and owners are revalidated.
    for (const batch of pending.values()) {
      batch.live = false;
      batch.passes.length = 0;
      batch.resources.length = 0;
    }
    pending.clear();
    if (resourceOwners.size > TABLE_LIMIT) ownerScratch = new Map();
  }
}

function coalesceComputeInto(
  passes: readonly Pass[],
  privatePrograms: ReadonlySet<string>,
  bindings: (name: string) => Bindings | undefined,
  output: Pass[],
  pending: Map<string, Batch>,
  resourceOwners: Map<string, Batch>,
): readonly Pass[] {
  const owner = (resource: string): Batch | undefined => {
    const batch = resourceOwners.get(resource);
    return batch?.live === true ? batch : undefined;
  };
  const flush = (batch: Batch): void => {
    pending.delete(batch.program);
    batch.live = false;
    try {
      emit(batch);
    } finally {
      // A dead batch may stay in the persistent owner table; it keeps no passes.
      batch.passes.length = 0;
      batch.resources.length = 0;
    }
  };
  const emit = (batch: Batch): void => {
    const first = batch.passes[0];
    if (first === undefined) return;
    if (batch.passes.length === 1) {
      output.push(first);
      return;
    }
    const dispatches: Compute['dispatches'][number][] = [];
    for (const pass of batch.passes)
      for (const dispatch of pass.dispatches) {
        if (dispatch.kind !== 'direct') throw new Error('Only direct stock work may be batched');
        dispatches.push({
          ...dispatch,
          bindings: pass.bindings,
          workgroups:
            pass.enabled === false
              ? ([0, dispatch.workgroups[1] ?? 1, dispatch.workgroups[2] ?? 1] as const)
              : dispatch.workgroups,
        });
      }
    output.push({
      ...first,
      name: `${first.name}.batch`,
      enabled: batch.passes.some((pass) => pass.enabled !== false),
      dispatches,
    });
  };
  const flushAll = () => {
    for (const batch of pending.values()) flush(batch);
  };
  for (const pass of passes) {
    if (pass.kind === 'copy') {
      for (const copy of pass.copies) {
        const source = owner(copy.source);
        if (source !== undefined) flush(source);
        const destination = owner(copy.destination);
        if (destination !== undefined) flush(destination);
      }
      output.push(pass);
      continue;
    }
    const declared = pass.kind === 'compute' ? bindings(pass.bindings) : undefined;
    if (
      pass.kind !== 'compute' ||
      !privatePrograms.has(pass.program) ||
      declared?.program !== pass.program ||
      !pass.dispatches.every(
        (dispatch) => dispatch.kind === 'direct' && dispatch.bindings === undefined,
      )
    ) {
      flushAll();
      output.push(pass);
      continue;
    }
    const previous = pending.get(pass.program);
    const batch = previous ?? { program: pass.program, passes: [], resources: [], live: true };
    for (const entry of declared.entries) {
      const prior = owner(entry.resource);
      if (prior !== undefined && prior.program !== pass.program) flush(prior);
      // Repeated spawn/update dispatches share these exact current resources.
      // Keep the existing owner rather than inserting it again for every pass.
      if (prior !== batch) {
        batch.resources.push(entry.resource);
        resourceOwners.set(entry.resource, batch);
      }
    }
    // Preserve pending insertion order after every conflicting owner is flushed.
    if (previous === undefined) pending.set(pass.program, batch);
    batch.passes.push(pass);
  }
  flushAll();
  return output;
}

/** Consecutive stock resets stay ordered in one copy node, with live per-copy gates. */
export function coalesceVfxCopyPasses(passes: readonly Pass[]): readonly Pass[] {
  if (passes.length < 2) return passes;
  try {
    return coalesceCopiesInto(passes, copySources, copyDestinations);
  } finally {
    if (copySources.size > TABLE_LIMIT || copyDestinations.size > TABLE_LIMIT) {
      copySources = new Map();
      copyDestinations = new Map();
    }
  }
}

function coalesceCopiesInto(
  passes: readonly Pass[],
  sources: Map<string, number>,
  destinations: Map<string, number>,
): readonly Pass[] {
  const output: Pass[] = [];
  let pending: Extract<Pass, { readonly kind: 'copy' }>[] = [];
  // Names belong to the pending group only while they carry its serial.
  let group = ++copyGroup;
  const flush = (): void => {
    const first = pending[0];
    if (first === undefined) return;
    if (pending.length === 1) output.push(first);
    else {
      const copies: Extract<Pass, { readonly kind: 'copy' }>['copies'][number][] = [];
      for (const pass of pending)
        for (const copy of pass.copies)
          copies.push({ ...copy, enabled: pass.enabled !== false && copy.enabled !== false });
      output.push({
        ...first,
        name: `${first.name}.batch`,
        enabled: pending.some(
          (pass) => pass.enabled !== false && pass.copies.some((copy) => copy.enabled !== false),
        ),
        copies,
      });
    }
    pending = [];
    group = ++copyGroup;
  };
  for (const pass of passes) {
    if (pass.kind === 'copy') {
      // A graph copy node is one usage scope: read/write aliases require
      // ordered nodes even though their native commands are sequential.
      for (const copy of pass.copies)
        if (destinations.get(copy.source) === group || sources.get(copy.destination) === group) {
          flush();
          break;
        }
      pending.push(pass);
      for (const copy of pass.copies) {
        sources.set(copy.source, group);
        destinations.set(copy.destination, group);
      }
    } else {
      flush();
      output.push(pass);
    }
  }
  flush();
  return output;
}
