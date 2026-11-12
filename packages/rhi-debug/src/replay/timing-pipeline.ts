import type { Buffer, MappedBuffer, QuerySet, RhiError } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import type { RhiDebugError } from '../errors';
import {
  closedPasses,
  createQuerySets,
  encodeTimedFrame,
  QUERIES_PER_SET,
  type ReplayRunOptions,
  type TimedReplay,
  type TimingHost,
  timedReplay,
  timestampPeriod,
  timingFailure,
} from './timing';

/** Replays per timestamp bank; two banks alternate so one reads back while the other runs. */
export const DEFAULT_PIPELINE_DEPTH = 4;

const QUERY_RESOLVE_COPY_SRC = 0x200 | 0x4;
const MAP_READ_COPY_DST = 0x1 | 0x8;
const MAP_MODE_READ = 0x1;
const RESOLVE_ALIGNMENT = 256;

interface Bank {
  readonly index: number;
  readonly resolve: Buffer;
  readonly staging: Buffer;
  jobs: number[];
  pending: Promise<Result<MappedBuffer, RhiError>> | undefined;
}

interface Layout {
  readonly queries: number;
  readonly stride: number;
  readonly period: number;
}

/**
 * Replay `jobs` back to back without waiting on the GPU between replays.
 * Each replay resolves its timestamps into its own slot of a bank; a bank is
 * copied to a staging buffer and mapped as soon as its last replay is
 * submitted, then drained only when the bank is reused, so the queue always
 * holds the other bank's replays and the GPU stays busy. Needs a host in
 * steady mode, whose resets restore state on the GPU instead of reloading it.
 */
export async function replayPipelined(
  host: TimingHost,
  jobs: readonly ReplayRunOptions[],
  depth = DEFAULT_PIPELINE_DEPTH,
  signal?: AbortSignal,
): Promise<Result<TimedReplay[], RhiDebugError>> {
  const { context } = host;
  const period = timestampPeriod(context);
  if (!period.ok) return period;
  const queries = closedPasses(host.index).length * 2;
  const layout: Layout = {
    queries,
    stride: Math.ceil(Math.max(8, queries * 8) / RESOLVE_ALIGNMENT) * RESOLVE_ALIGNMENT,
    period: period.value,
  };
  const slots = Math.max(1, Math.min(depth, jobs.length));
  const banks: Bank[] = [];
  try {
    for (let b = 0; b < 2; b++) {
      const bank = createBank(host, layout, slots, b);
      if (!bank.ok) return bank;
      banks.push(bank.value);
    }
    const results: TimedReplay[] = [];
    for (let job = 0; job < jobs.length; job++) {
      const bank = banks[Math.floor(job / slots) % 2] as Bank;
      const slot = job % slots;
      if (slot === 0) {
        const drained = await drain(host, bank, layout, jobs, results);
        if (!drained.ok) return drained;
      }
      const ran = await runSlot(host, bank, layout, slot, jobs[job] as ReplayRunOptions, signal);
      if (!ran.ok) return ran;
      bank.jobs.push(job);
      if (slot === slots - 1 || job === jobs.length - 1) {
        const mapped = startReadback(host, bank, layout);
        if (!mapped.ok) return mapped;
      }
    }
    for (const bank of banks) {
      const drained = await drain(host, bank, layout, jobs, results);
      if (!drained.ok) return drained;
    }
    return ok(results);
  } finally {
    for (const bank of banks) {
      context.device.destroyBuffer(bank.resolve);
      context.device.destroyBuffer(bank.staging);
    }
  }
}

function createBank(
  host: TimingHost,
  layout: Layout,
  slots: number,
  bankIndex: number,
): Result<Bank, RhiDebugError> {
  const { device } = host.context;
  const size = layout.stride * slots;
  const resolve = device.createBuffer({ size, usage: QUERY_RESOLVE_COPY_SRC });
  if (!resolve.ok) return timingFailure(`timestamp bank: ${resolve.error.hint}`);
  const staging = device.createBuffer({ size, usage: MAP_READ_COPY_DST });
  if (!staging.ok) {
    device.destroyBuffer(resolve.value);
    return timingFailure(`timestamp staging: ${staging.error.hint}`);
  }
  return ok({
    index: bankIndex,
    resolve: resolve.value,
    staging: staging.value,
    jobs: [],
    pending: undefined,
  });
}

async function runSlot(
  host: TimingHost,
  bank: Bank,
  layout: Layout,
  slot: number,
  options: ReplayRunOptions,
  signal: AbortSignal | undefined,
): Promise<Result<void, RhiDebugError>> {
  const { context } = host;
  const reset = await host.reset();
  if (!reset.ok) return reset;
  const sets = freshQuerySets(host, layout, `replay:timing:bank${bank.index}:slot${slot}`);
  if (!sets.ok) return sets;
  const encoded = await encodeTimedFrame(host, options, sets.value, signal);
  if (!encoded.ok) return encoded;
  const encoder = context.device.createCommandEncoder({ label: 'rhi-debug:timing-resolve' });
  if (!encoder.ok) return timingFailure(`timestamp resolve encoder: ${encoder.error.hint}`);
  for (const [setIndex, id] of sets.value.entries()) {
    const first = setIndex * QUERIES_PER_SET;
    const count = Math.min(QUERIES_PER_SET, layout.queries - first);
    const querySet = context.table.get(id)?.resource.value as QuerySet;
    const offset = slot * layout.stride + first * 8;
    const resolved = encoder.value.resolveQuerySet(querySet, 0, count, bank.resolve, offset);
    if (!resolved.ok) return timingFailure(`timestamp resolve: ${resolved.error.hint}`);
  }
  const finished = encoder.value.finish();
  if (!finished.ok) return timingFailure(`timestamp resolve finish: ${finished.error.hint}`);
  const submitted = context.device.queue.submit([finished.value]);
  return submitted.ok ? ok(undefined) : timingFailure(`timestamp submit: ${submitted.error.hint}`);
}

/**
 * Replace the slot's query sets with new ones. A reused set would keep the
 * previous replay's ticks in queries this replay leaves unwritten, hiding
 * missing timestamps; a new set resolves those to zero.
 */
function freshQuerySets(
  host: TimingHost,
  layout: Layout,
  prefix: string,
): Result<string[], RhiDebugError> {
  const { context } = host;
  for (let set = 0; set * QUERIES_PER_SET < layout.queries; set++) {
    const previous = context.table.get(`${prefix}:set:${set}`)?.resource;
    if (previous?.kind === 'query-set') context.device.destroyQuerySet(previous.value);
  }
  const created = createQuerySets(context, layout.queries, prefix);
  if (!created.ok) return created;
  for (const id of created.value) host.keep?.(id);
  return created;
}

function startReadback(host: TimingHost, bank: Bank, layout: Layout): Result<void, RhiDebugError> {
  const { device } = host.context;
  const size = bank.jobs.length * layout.stride;
  const encoder = device.createCommandEncoder({ label: 'rhi-debug:timing-readback' });
  if (!encoder.ok) return timingFailure(`timestamp readback encoder: ${encoder.error.hint}`);
  encoder.value.copyBufferToBuffer(bank.resolve, 0, bank.staging, 0, size);
  const finished = encoder.value.finish();
  if (!finished.ok) return timingFailure(`timestamp readback finish: ${finished.error.hint}`);
  const submitted = device.queue.submit([finished.value]);
  if (!submitted.ok) return timingFailure(`timestamp readback submit: ${submitted.error.hint}`);
  bank.pending = bank.staging.mapAsync(MAP_MODE_READ, 0, size);
  return ok(undefined);
}

async function drain(
  host: TimingHost,
  bank: Bank,
  layout: Layout,
  jobs: readonly ReplayRunOptions[],
  results: TimedReplay[],
): Promise<Result<void, RhiDebugError>> {
  if (bank.pending === undefined) return ok(undefined);
  const mapped = await bank.pending;
  bank.pending = undefined;
  if (!mapped.ok) return timingFailure(`timestamp map: ${mapped.error.code}`);
  try {
    const range = mapped.value.getMappedRange(0, bank.jobs.length * layout.stride);
    if (!range.ok) return timingFailure(`timestamp mapped range: ${range.error.code}`);
    const passes = closedPasses(host.index);
    for (const [slot, job] of bank.jobs.entries()) {
      const start = slot * layout.stride;
      const ticks = new BigUint64Array(range.value.slice(start, start + layout.queries * 8));
      const skipped = new Set(jobs[job]?.skip?.passIndices ?? []);
      results[job] = timedReplay(ticks, passes, skipped, layout.period);
    }
  } finally {
    mapped.value.unmap();
  }
  bank.jobs = [];
  return ok(undefined);
}
