import type { RenderBundle } from '@forgeax/engine-rhi';
import { err, ok, type Result, RhiError } from '@forgeax/engine-rhi';
import {
  type PrimitiveReflection,
  samePrimitiveReflection,
} from '../reflection/primitive-bindings';
import { publishReadonlyMap } from './shadow-projection-publication';

export interface RetainedRasterInputPreparation {
  isCurrent(): boolean;
  publish(): Result<void, RhiError>;
  release(): void;
}

interface RetainedPassInputs {
  readonly identities: readonly unknown[];
  readonly blocks: ReadonlyMap<object, RetainedRasterBlock>;
}

interface RetainedPassState {
  readonly inputs: RetainedPassInputs;
  readonly fixed?: FixedRasterInputs | undefined;
  frame: number;
}

function stalePreparation(): RhiError {
  return new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'unchanged retained raster facts and their input preparation',
    hint: 'release this private retained projection and prepare at an idle recording boundary',
  });
}

type MaterialOwner = {
  readonly group: object;
  readonly offset: number;
  readonly reflection?: PrimitiveReflection | undefined;
  readonly program?: string | undefined;
};
export type ClassOwner = { readonly pipeline: object; readonly mesh: object };

/** Resolutions belong only to this encode and are discarded with it. */
class ResolvedOwners<K, V> {
  readonly #memo = new Map<K, { expected: V; actual: V | undefined }>();
  constructor(
    private readonly resolve: (key: K, expected: V) => V | undefined,
    private readonly equal: (actual: V | undefined, expected: V) => boolean,
    private readonly sameRequest?: (prior: V, next: V) => boolean,
  ) {}
  matches(expected: ReadonlyMap<K, V>): boolean {
    for (const [key, owner] of expected) {
      let resolution = this.#memo.get(key);
      if (resolution === undefined || this.sameRequest?.(resolution.expected, owner) === false) {
        resolution = { expected: owner, actual: this.resolve(key, owner) };
        this.#memo.set(key, resolution);
      }
      if (!this.equal(resolution.actual, owner)) return false;
    }
    return true;
  }
}

function sameMaterial(actual: MaterialOwner | undefined, expected: MaterialOwner): boolean {
  return (
    actual?.group === expected.group &&
    actual.offset === expected.offset &&
    actual.program === expected.program &&
    samePrimitiveReflection(actual.reflection, expected.reflection)
  );
}

function sameClass(actual: ClassOwner | undefined, expected: ClassOwner): boolean {
  return actual?.pipeline === expected.pipeline && actual.mesh === expected.mesh;
}

/** Recorded inputs and output of one contiguous bundled run of live batches. */
export interface RetainedRasterBlock {
  /** The command identities of the run's live batches, in encode order. */
  readonly commands: readonly object[];
  readonly materialConflict?: boolean;
  /** Ordered physical-buffer and material-selection facts of this run. */
  readonly physical: readonly unknown[];
  readonly materials: ReadonlyMap<number, MaterialOwner>;
  readonly classes: ReadonlyMap<object, ClassOwner>;
  readonly bundle: RenderBundle | undefined;
  readonly draws: number;
}

/** Mutable only while the pass owns a private native recording. */
export interface RasterRunRecording extends RetainedRasterBlock {
  materialConflict?: boolean;
  readonly materials: Map<number, MaterialOwner>;
  readonly classes: Map<object, ClassOwner>;
  bundle: RenderBundle | undefined;
  draws: number;
}

/** A live batch's command identity; owners without one are their own identity. */
function commandOf(live: object): object {
  return (live as { readonly command?: object }).command ?? live;
}

function sameList(left: readonly unknown[], right: readonly unknown[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++)
    if (!Object.is(left[index], right[index])) return false;
  return true;
}

function publishRun(recording: RasterRunRecording): RetainedRasterBlock {
  Object.defineProperties(recording, {
    commands: { value: Object.freeze([...recording.commands]) },
    physical: { value: Object.freeze([...recording.physical]) },
    materials: {
      value: publishReadonlyMap(
        new Map(
          Array.from(recording.materials, ([key, value]) => [key, Object.freeze({ ...value })]),
        ),
      ),
    },
    classes: {
      value: publishReadonlyMap(
        new Map(
          Array.from(recording.classes, ([key, value]) => [key, Object.freeze({ ...value })]),
        ),
      ),
    },
  });
  return Object.freeze(recording);
}

function sameOwners<K, V>(
  left: ReadonlyMap<K, V>,
  right: ReadonlyMap<K, V>,
  equal: (actual: V | undefined, expected: V) => boolean,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, owner] of right) if (!equal(left.get(key), owner)) return false;
  return true;
}

function sameRun(recording: RasterRunRecording, previous: RetainedRasterBlock): boolean {
  return (
    recording.materialConflict === previous.materialConflict &&
    recording.bundle === previous.bundle &&
    recording.draws === previous.draws &&
    sameList(recording.commands, previous.commands) &&
    sameList(recording.physical, previous.physical) &&
    sameOwners(recording.materials, previous.materials, sameMaterial) &&
    sameOwners(recording.classes, previous.classes, sameClass)
  );
}

function samePasses(
  current: ReadonlyMap<object, RetainedPassState>,
  before: ReadonlyMap<object, RetainedPassState>,
): boolean {
  if (current.size !== before.size) return false;
  for (const [key, expected] of before)
    if (current.get(key)?.inputs !== expected.inputs) return false;
  return true;
}

type FactConsumer = (value: unknown) => void;
/** Emit all facts synchronously; the reader must not retain the consumer. */
type ReadFacts = (live: object, consume: FactConsumer) => void;

/** The native producer's immutable live projection and captured pass bindings. */
export interface FixedRasterInputs {
  readonly lives: readonly object[];
  readonly bindings: readonly unknown[];
}

function sameFacts(
  lives: readonly object[],
  start: number,
  end: number,
  read: ReadFacts,
  expected: readonly unknown[],
): boolean {
  let cursor = 0;
  let same = true;
  const consume = (value: unknown): void => {
    if (!Object.is(expected[cursor++], value)) same = false;
  };
  // Finish the reads after a mismatch too, preserving their order and failures.
  for (let index = start; index < end; index++) read(lives[index] as object, consume);
  return same && cursor === expected.length;
}

/**
 * One pass encode's view of its retained runs. A run whose live owners,
 * physical buffers and re-resolved material, pipeline and mesh groups all
 * match replays its bundle without visiting its batches. Owners are resolved
 * at most once per encode.
 */
export class RetainedPassEncode {
  #next: Map<object, RetainedRasterBlock> | undefined = new Map();
  #recorded: Map<object, RasterRunRecording> | undefined;
  readonly #materials: ResolvedOwners<number, MaterialOwner>;
  readonly #classes: ResolvedOwners<object, ClassOwner>;
  constructor(
    private readonly previous: RetainedPassInputs | undefined,
    resolveMaterial: (slot: number, program?: string) => MaterialOwner | undefined,
    resolveClass: (rasterClass: object) => ClassOwner | undefined,
    private readonly fixedLives?: readonly object[],
  ) {
    this.#materials = new ResolvedOwners(
      (slot, owner) => resolveMaterial(slot, owner.program),
      sameMaterial,
      (prior, next) => prior.program === next.program,
    );
    this.#classes = new ResolvedOwners(resolveClass, sameClass);
  }

  /** A fixed producer also proves the run boundary, without scanning its batches. */
  fixedRunLength(lives: readonly object[], start: number): number {
    const first = lives[start];
    if (this.fixedLives !== lives || first === undefined) return 0;
    return this.previous?.blocks.get(commandOf(first))?.commands.length ?? 0;
  }

  /** Retained output of the run `lives[start..end)`, if every input still matches. */
  reuse(
    lives: readonly object[],
    start: number,
    end: number,
    physicalOf: ReadFacts,
  ): RetainedRasterBlock | undefined {
    const first = lives[start];
    const block = first === undefined ? undefined : this.previous?.blocks.get(commandOf(first));
    if (block === undefined || block.materialConflict || block.commands.length !== end - start)
      return undefined;
    if (this.fixedLives !== lives) {
      for (let index = start; index < end; index++)
        if (block.commands[index - start] !== commandOf(lives[index] as object)) return undefined;
      if (!sameFacts(lives, start, end, physicalOf, block.physical)) return undefined;
    }
    if (!this.#materials.matches(block.materials) || !this.#classes.matches(block.classes))
      return undefined;
    this.openBlocks().set(commandOf(first as object), block);
    return block;
  }

  /** Start recording the run `lives[start..end)`; its bundle is attached when flushed. */
  record(
    lives: readonly object[],
    start: number,
    end: number,
    physicalOf: ReadFacts,
  ): RasterRunRecording {
    const next = this.openBlocks();
    const physical: unknown[] = [];
    const append = (value: unknown): void => {
      physical.push(value);
    };
    const commands: object[] = [];
    for (let index = start; index < end; index++) {
      physicalOf(lives[index] as object, append);
      commands.push(commandOf(lives[index] as object));
    }
    const block: RasterRunRecording = {
      commands,
      physical,
      materials: new Map(),
      classes: new Map(),
      bundle: undefined,
      draws: 0,
    };
    const key = commandOf(lives[start] as object);
    this.#recorded ??= new Map();
    this.#recorded.set(key, block);
    next.set(key, block);
    return block;
  }

  private openBlocks(): Map<object, RetainedRasterBlock> {
    if (this.#next === undefined) throw stalePreparation();
    return this.#next;
  }

  /** Transfer only this encode's runs and keep the accepted identity on unchanged replay. */
  finish(identities: readonly unknown[]): RetainedPassInputs {
    const next = this.openBlocks();
    const { previous } = this;
    const recorded = this.#recorded;
    this.#next = undefined;
    this.#recorded = undefined;
    if (recorded !== undefined) {
      for (const [key, block] of recorded) {
        if (next.get(key) !== block) continue;
        const retained = previous?.blocks.get(key);
        next.set(
          key,
          retained !== undefined && sameRun(block, retained) ? retained : publishRun(block),
        );
      }
    }
    if (
      previous !== undefined &&
      next.size === previous.blocks.size &&
      sameList(identities, previous.identities)
    ) {
      let reused = true;
      for (const [key, block] of next) {
        if (previous.blocks.get(key) === block) continue;
        reused = false;
        break;
      }
      if (reused) return previous;
    }
    return Object.freeze({
      identities: Object.freeze([...identities]),
      blocks: publishReadonlyMap(next),
    });
  }
}

/**
 * The retained runs of each pass key. Pass identities (view, tables, indirect
 * buffer, regions, formats, raster classes) gate every run; entries unused in
 * the current or previous frame are released, so no older plan or frame
 * owner stays reachable.
 */
export class RetainedRasterEncodes {
  #passes = new Map<object, RetainedPassState>();
  #preparingInputs: RetainedRasterInputPreparation | undefined;
  #frame = 0;

  /** Capture in the caller's idle Production boundary; preserves unchanged ordinary replays. */
  prepareInputs(
    replaceIdentities: ReadonlyMap<unknown, unknown>,
    replaceBundle: (bundle: RenderBundle) => RenderBundle | undefined,
    current: () => boolean,
    replacePass: (values: readonly unknown[]) => readonly unknown[] = (values) => values,
  ): Result<RetainedRasterInputPreparation, RhiError> {
    if (this.#preparingInputs !== undefined) return err(stalePreparation());
    let before: Map<object, RetainedPassState> | undefined = new Map(this.#passes);
    let next: Map<object, RetainedPassState> | undefined = new Map();
    let owner: RetainedRasterEncodes | undefined = this;
    let observe: (() => boolean) | undefined = current;
    let mapPass: typeof replacePass | undefined = replacePass;
    let mapBundle: ((bundle: RenderBundle) => RenderBundle | undefined) | undefined = replaceBundle;
    let ready = false;
    let closed = false;
    let observing = false;
    const live = () => {
      const active = owner;
      if (closed || active === undefined || active.#preparingInputs !== api || observe?.() !== true)
        return false;
      return (
        !closed &&
        active.#preparingInputs === api &&
        before !== undefined &&
        samePasses(active.#passes, before)
      );
    };
    const check = () => {
      if (!live()) throw stalePreparation();
    };
    const release = () => {
      closed = true;
      ready = false;
      before = undefined;
      next = undefined;
      observe = undefined;
      mapPass = undefined;
      mapBundle = undefined;
      if (owner !== undefined && owner.#preparingInputs === api) owner.#preparingInputs = undefined;
      owner = undefined;
    };
    const api: RetainedRasterInputPreparation = Object.freeze({
      isCurrent: () => {
        if (observing) return false;
        observing = true;
        try {
          return ready && live();
        } finally {
          observing = false;
        }
      },
      publish: () => {
        if (observing) return err(stalePreparation());
        observing = true;
        try {
          if (!ready || !live() || next === undefined || owner === undefined)
            return err(stalePreparation());
          const active = owner;
          // Unchanged frames may have refreshed the age of a retained pass.
          for (const [key, entry] of next) {
            const entryState = active.#passes.get(key);
            if (entryState === undefined) return err(stalePreparation());
            entry.frame = entryState.frame;
          }
          active.#passes = next;
          release();
          return ok(undefined);
        } finally {
          observing = false;
        }
      },
      release,
    });
    this.#preparingInputs = api;
    let accepted = false;
    try {
      check();
      // Own the remap before walking immutable passes. Lookups cannot reenter
      // the renderer. Keep the currency checks around borrowed callbacks.
      const remaps = new Map(replaceIdentities);
      const identity = (value: unknown) => remaps.get(value) ?? value;
      check();
      for (const [key, { inputs: entry, frame }] of before) {
        const blocks = new Map<object, RetainedRasterBlock>();
        const pass = Array.from(mapPass?.(entry.identities) ?? entry.identities);
        check();
        const identities = Object.freeze(pass.map(identity));
        for (const [command, block] of entry.blocks) {
          const physical = Object.freeze(block.physical.map(identity));
          let replacement: RenderBundle | undefined;
          if (block.bundle !== undefined) {
            check();
            replacement = mapBundle?.(block.bundle);
            check();
          }
          // Changed facts cannot certify an unmapped native command. A caller
          // may explicitly return the old bundle only when it proved it reusable.
          if (
            block.bundle !== undefined &&
            replacement === undefined &&
            (!sameList(identities, entry.identities) || !sameList(physical, block.physical))
          )
            throw stalePreparation();
          const bundle = replacement ?? block.bundle;
          const classes = new Map(
            [...block.classes].map(([key, value]) => [
              key,
              Object.freeze({
                pipeline: identity(value.pipeline) as object,
                mesh: identity(value.mesh) as object,
              }),
            ]),
          );
          blocks.set(
            command,
            Object.freeze({ ...block, physical, bundle, classes: publishReadonlyMap(classes) }),
          );
        }
        next.set(key, {
          inputs: Object.freeze({ identities, blocks: publishReadonlyMap(blocks) }),
          frame,
        });
      }
      check();
      ready = true;
      accepted = true;
      return ok(api);
    } catch (cause) {
      if (cause instanceof RhiError) return err(cause);
      throw cause;
    } finally {
      if (!accepted) release();
    }
  }

  beginFrame(): void {
    this.#frame++;
    for (const [key, entry] of this.#passes)
      if (entry.frame < this.#frame - 1) this.#passes.delete(key);
  }

  begin(
    key: object,
    identities: readonly unknown[],
    resolveMaterial: (slot: number, program?: string) => MaterialOwner | undefined,
    resolveClass: (rasterClass: object) => ClassOwner | undefined,
    fixed?: FixedRasterInputs,
  ): RetainedPassEncode {
    const entry = this.#passes.get(key);
    const previous =
      entry !== undefined && sameList(entry.inputs.identities, identities)
        ? entry.inputs
        : undefined;
    // A failed encode leaves no partially recorded runs behind.
    this.#passes.delete(key);
    const previousFixed = previous === undefined ? undefined : entry?.fixed;
    const fixedLives =
      fixed !== undefined &&
      previousFixed?.lives === fixed.lives &&
      sameList(previousFixed.bindings, fixed.bindings)
        ? fixed.lives
        : undefined;
    return new RetainedPassEncode(previous, resolveMaterial, resolveClass, fixedLives);
  }

  finish(
    key: object,
    identities: readonly unknown[],
    encode: RetainedPassEncode,
    fixed?: FixedRasterInputs,
  ): void {
    this.#passes.set(key, { inputs: encode.finish(identities), fixed, frame: this.#frame });
  }

  clear(): void {
    this.#preparingInputs?.release();
    this.#passes.clear();
  }

  get size(): number {
    return this.#passes.size;
  }
}

/** Resolved material owner of a prepared material binding. */
export function materialOwner(
  prepared:
    | {
        readonly group: object;
        readonly byteOffset: number;
        readonly reflection?: PrimitiveReflection | undefined;
      }
    | undefined,
  program?: string,
): MaterialOwner | undefined {
  return prepared === undefined
    ? undefined
    : {
        group: prepared.group,
        offset: prepared.byteOffset,
        program,
        reflection: prepared.reflection,
      };
}

/** Resolved pipeline and group(2) owner of a raster class. */
export function classOwner(
  pipeline: { readonly ok: boolean; readonly value?: unknown },
  mesh: object | undefined,
): ClassOwner | undefined {
  if (
    !pipeline.ok ||
    mesh === undefined ||
    typeof pipeline.value !== 'object' ||
    pipeline.value === null
  )
    return undefined;
  const current = pipeline.value;
  return { pipeline: current, mesh };
}

/** Physical vertex and index handles of a live raster batch. */
export function livePhysical(live: object, consume: FactConsumer): void {
  const binding = (
    live as { readonly meshBinding: { readonly vertex: unknown; readonly index: unknown } }
  ).meshBinding;
  consume(binding.vertex);
  consume(binding.index);
}

interface RunLive {
  readonly meshBinding: { readonly vertex: unknown; readonly index: unknown };
  readonly materialBindingClass: string;
  readonly batch: {
    readonly key: { readonly materialSlot: number };
    readonly binding?: { readonly material: object };
  };
}

/**
 * Per-live facts a replayed run depends on: physical buffers and the material
 * slot and selection it resolves through this frame's (in-place) slot table.
 */
export function runFacts(
  eligible: (live: object) => boolean,
  slotsByBinding: ReadonlyMap<object, ReadonlyMap<string, number>>,
  selected: ReadonlySet<number> | undefined,
): ReadFacts {
  return (owner, consume) => {
    livePhysical(owner, consume);
    const live = owner as RunLive;
    const material = live.batch.binding?.material;
    const slot = !eligible(owner)
      ? undefined
      : slotsByBinding.size === 0
        ? live.batch.key.materialSlot
        : material === undefined
          ? undefined
          : slotsByBinding.get(material)?.get(live.materialBindingClass);
    consume(slot === undefined ? -1 : selected?.has(slot) === false ? -2 - slot : slot);
  };
}
