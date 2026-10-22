import type { RenderFeatureWorkPlan } from '@forgeax/engine-render';

type Pass = RenderFeatureWorkPlan['passes'][number];
type Compute = Extract<Pass, { readonly kind: 'compute' }>;
type Bindings = Extract<
  RenderFeatureWorkPlan['resources'][number],
  { readonly kind: 'compute-bindings' }
>;

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
  interface Batch {
    readonly program: string;
    readonly passes: Compute[];
    readonly resources: string[];
  }
  const output: Pass[] = [];
  const pending = new Map<string, Batch>();
  const resourceOwners = new Map<string, Batch>();
  const flush = (batch: Batch): void => {
    pending.delete(batch.program);
    for (const resource of batch.resources) resourceOwners.delete(resource);
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
        const source = resourceOwners.get(copy.source);
        if (source !== undefined) flush(source);
        const destination = resourceOwners.get(copy.destination);
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
    const batch = previous ?? { program: pass.program, passes: [], resources: [] };
    for (const entry of declared.entries) {
      const prior = resourceOwners.get(entry.resource);
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
  const output: Pass[] = [];
  let pending: Extract<Pass, { readonly kind: 'copy' }>[] = [];
  const sources = new Set<string>();
  const destinations = new Set<string>();
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
    sources.clear();
    destinations.clear();
  };
  for (const pass of passes) {
    if (pass.kind === 'copy') {
      // A graph copy node is one usage scope: read/write aliases require
      // ordered nodes even though their native commands are sequential.
      if (
        pass.copies.some((copy) => destinations.has(copy.source) || sources.has(copy.destination))
      )
        flush();
      pending.push(pass);
      for (const copy of pass.copies) {
        sources.add(copy.source);
        destinations.add(copy.destination);
      }
    } else {
      flush();
      output.push(pass);
    }
  }
  flush();
  return output;
}
