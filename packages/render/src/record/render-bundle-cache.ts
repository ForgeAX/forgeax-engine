import type {
  RenderBundle,
  RenderBundleEncoderDescriptor,
  RhiDevice,
  RhiRenderCommands,
  RhiRenderPassEncoder,
  TextureFormat,
} from '@forgeax/engine-rhi';

type Method = keyof RhiRenderCommands;
type Command = { readonly method: Method; readonly args: readonly unknown[] };
type DynamicState = 'setViewport' | 'setScissorRect' | 'setBlendConstant' | 'setStencilReference';

/** Mutable hit/miss tally; one lookup per recorded segment that draws. */
export interface RenderBundleCounters {
  hits: number;
  misses: number;
}

/** A view retains only scene passes observed in its current or preceding rendered frame. */
export interface SceneRenderBundleState {
  frameNumber: number;
  renderBundleCaches?:
    | {
        frameNumber: number;
        readonly passes: Map<string, { cache: RenderBundleCache; frameNumber: number }>;
      }
    | undefined;
}

export function sceneRenderBundleCache(
  state: SceneRenderBundleState,
  name: string,
  descriptor: RenderBundleEncoderDescriptor,
): RenderBundleCache {
  // A one-shot descriptor must survive both comparison and replacement.
  // Ordinary array descriptors take the allocation-free path.
  if (descriptor.colorFormats !== undefined && !Array.isArray(descriptor.colorFormats)) {
    descriptor = { ...descriptor, colorFormats: [...descriptor.colorFormats] };
  }
  state.renderBundleCaches ??= { frameNumber: -1, passes: new Map() };
  const retained = state.renderBundleCaches;
  const caches = retained.passes;
  // Prune at the first lookup of each frame. No retired graph keeps this map.
  if (retained.frameNumber !== state.frameNumber) {
    for (const [key, entry] of caches) {
      if (entry.frameNumber !== retained.frameNumber) caches.delete(key);
    }
    retained.frameNumber = state.frameNumber;
  }
  const cached = caches.get(name);
  if (cached?.cache.matches(descriptor)) {
    cached.frameNumber = state.frameNumber;
    return cached.cache;
  }
  const cache = new RenderBundleCache(descriptor);
  caches.set(name, { cache, frameNumber: state.frameNumber });
  return cache;
}

interface Segment {
  readonly commands: Command[];
  readonly preludeLength: number;
  bundle: RenderBundle | undefined;
}

/** Consecutive frames with more changed than matching drawing segments before backing off. */
const IDLE_FRAMES_BEFORE_BACKOFF = 4;
const MAX_BYPASS_FRAMES = 64;
// A shared pipeline can span the whole scene. Keep local mesh changes from
// invalidating that entire command stream, without making one bundle per draw.
const MAX_SEGMENT_DRAWS = 128;

function equalArgs(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    const value = a[index];
    const other = b[index];
    if (Array.isArray(value) && Array.isArray(other)) {
      if (value.length !== other.length) return false;
      for (let offset = 0; offset < value.length; offset++) {
        if (value[offset] !== other[offset]) return false;
      }
    } else if (value !== other) {
      return false;
    }
  }
  return true;
}

function overwrittenPrelude(segment: Segment, index: number): boolean {
  if (index >= segment.preludeLength) return false;
  const inherited = segment.commands[index];
  if (inherited === undefined) return false;
  for (let at = segment.preludeLength; at < segment.commands.length; at++) {
    const current = segment.commands[at];
    if (current === undefined || current.method.startsWith('draw')) break;
    if (current.method !== inherited.method) continue;
    if (
      (current.method === 'setBindGroup' || current.method === 'setVertexBuffer') &&
      current.args[0] !== inherited.args[0]
    )
      continue;
    return true;
  }
  return false;
}

function equalCommands(a: Segment, b: Segment): boolean {
  let left = 0;
  let right = 0;
  while (true) {
    while (overwrittenPrelude(a, left)) left++;
    while (overwrittenPrelude(b, right)) right++;
    const previous = a.commands[left++];
    const current = b.commands[right++];
    if (previous === undefined || current === undefined) return previous === current;
    if (previous.method !== current.method || !equalArgs(previous.args, current.args)) return false;
  }
}

function indirectAnchor(commands: readonly Command[]): Command | undefined {
  return commands.find(
    (command) => command.method === 'drawIndirect' || command.method === 'drawIndexedIndirect',
  );
}

function replay(commands: readonly Command[], target: RhiRenderCommands, from = 0): void {
  for (let index = from; index < commands.length; index++) {
    const command = commands[index];
    if (command !== undefined) Reflect.apply(target[command.method], target, command.args);
  }
}

function recordBundle(segment: Segment, target: RhiRenderCommands): void {
  let nextIndex = 0;
  for (const command of segment.commands) {
    const index = nextIndex++;
    // A bundle retains every referenced resource even when a later setter
    // overwrites it. Omit only synthesized dead state, so deleting another
    // batch can retire its buffers without invalidating this bundle.
    if (!overwrittenPrelude(segment, index)) {
      Reflect.apply(target[command.method], target, command.args);
    }
  }
}

/**
 * One view-owned scene pass cache holds ordered command segments. A segment
 * starts at each `setPipeline` after a draw, after 128 draws, at a retained
 * full-sized physical indirect boundary after a mismatch, or after a command a
 * bundle cannot hold. It is prefixed with the pipeline, bind group and
 * vertex/index state it inherits, so it is self-contained under WebGPU's
 * state reset after `executeBundles`. No asset or World revisions: physical
 * handles and draw arguments are the command authority.
 *
 * A segment is admitted after two matching frames and invalidated on its own
 * mismatch, so local mesh changes cannot invalidate an unbounded run. Consecutive
 * bundles share one `executeBundles`. A pass that re-records most drawing
 * segments on several consecutive frames backs off to the direct path for a
 * bounded, growing number of frames. A small stable subset cannot keep a
 * mostly changing pass in the cache: executed bundles reset WebGPU state and
 * replay their preludes, so a pass split into many small bundles costs more
 * queue time than direct encoding, on top of the proxy's per-command
 * compare. A pass with at least as many matching as changed segments resets
 * the backoff.
 */
export class RenderBundleCache {
  private device: RhiDevice | undefined;
  private segments: Segment[] = [];
  private idleFrames = 0;
  private bypassFrames = 0;
  private backoff = 0;
  private readonly descriptor: RenderBundleEncoderDescriptor & {
    readonly colorFormats: readonly (TextureFormat | null | undefined)[];
  };

  constructor(descriptor: RenderBundleEncoderDescriptor) {
    this.descriptor = { ...descriptor, colorFormats: [...(descriptor.colorFormats ?? [])] };
  }

  matches(descriptor: RenderBundleEncoderDescriptor): boolean {
    const formats = this.descriptor.colorFormats;
    let index = 0;
    for (const format of descriptor.colorFormats ?? []) {
      if (index >= formats.length || format !== formats[index++]) return false;
    }
    return (
      index === formats.length &&
      this.descriptor.depthStencilFormat === descriptor.depthStencilFormat &&
      (this.descriptor.sampleCount ?? 1) === (descriptor.sampleCount ?? 1) &&
      (this.descriptor.depthReadOnly ?? false) === (descriptor.depthReadOnly ?? false) &&
      (this.descriptor.stencilReadOnly ?? false) === (descriptor.stencilReadOnly ?? false)
    );
  }

  encode(
    device: RhiDevice,
    pass: RhiRenderPassEncoder,
    record: (pass: RhiRenderPassEncoder) => void,
    counters?: RenderBundleCounters,
  ): void {
    if (this.device !== device) {
      this.device = device;
      this.reset();
    }
    if (this.bypassFrames > 0) {
      this.bypassFrames -= 1;
      record(pass);
      return;
    }
    const retainedSegments = this.segments;
    // Built only after an ordinal miss. The actual buffer/offset finds a
    // candidate; its complete command stream remains the reuse authority.
    let byIndirect: Map<unknown, Map<number, number | undefined>> | undefined;
    const indirectSegmentIndex = (buffer: unknown, offset: number): number | undefined => {
      if (byIndirect === undefined) {
        byIndirect = new Map();
        let nextIndex = 0;
        for (const segment of retainedSegments) {
          const index = nextIndex++;
          const draw = indirectAnchor(segment.commands);
          if (draw === undefined) continue;
          let offsets = byIndirect.get(draw.args[0]);
          if (offsets === undefined) {
            offsets = new Map();
            byIndirect.set(draw.args[0], offsets);
          }
          const offset = draw.args[1] as number;
          // Repeated physical starts cannot identify one retained boundary.
          offsets.set(offset, offsets.has(offset) ? undefined : index);
        }
      }
      return byIndirect.get(buffer)?.get(offset);
    };
    const physicalSegment = (segment: Segment): Segment | undefined => {
      const anchor = indirectAnchor(segment.commands);
      if (anchor === undefined) return undefined;
      const index = indirectSegmentIndex(anchor.args[0], anchor.args[1] as number);
      const candidate = index === undefined ? undefined : retainedSegments[index];
      return candidate !== undefined && equalCommands(candidate, segment) ? candidate : undefined;
    };
    const nextSegments: Segment[] = [];
    const pending: RenderBundle[] = [];
    let reusedSegments = 0;
    let drawSegments = 0;
    let missedSegments = 0;

    // Tracked pass state, used as each segment's inherited prelude.
    let pipeline: Command | undefined;
    const groups: (Command | undefined)[] = [];
    const vertexBuffers: (Command | undefined)[] = [];
    let indexBuffer: Command | undefined;
    // True while the pass holds exactly the tracked state (no bundle since
    // the last direct emission), so a direct segment may skip its prelude.
    let passStateCurrent = true;
    let inOcclusion = false;

    let open = false;
    let retained: Segment | undefined;
    let fresh: Command[] | undefined;
    let cursor = 0;
    let preludeLength = 0;
    let drawCount = 0;
    let recoveredBoundary = -1;

    const push = (method: Method, args: readonly unknown[]): Command => {
      if (fresh === undefined) {
        const old = retained?.commands[cursor];
        if (old !== undefined && old.method === method && equalArgs(old.args, args)) {
          cursor++;
          return old;
        }
        fresh = retained === undefined ? [] : retained.commands.slice(0, cursor);
      }
      const command = { method, args };
      fresh.push(command);
      cursor++;
      return command;
    };
    const pushTracked = (command: Command | undefined) => {
      if (command !== undefined) push(command.method, command.args);
    };
    const openSegment = (withPipeline: boolean) => {
      open = true;
      retained = retainedSegments[nextSegments.length];
      fresh = undefined;
      cursor = 0;
      drawCount = 0;
      if (withPipeline) pushTracked(pipeline);
      for (const group of groups) pushTracked(group);
      for (const vertex of vertexBuffers) pushTracked(vertex);
      pushTracked(indexBuffer);
      preludeLength = cursor;
    };
    const flushBundles = () => {
      if (pending.length === 0) return;
      const executed = pass.executeBundles(pending.splice(0));
      if (!executed.ok) throw executed.error;
      passStateCurrent = false;
    };
    const emitDirect = (commands: readonly Command[], prelude: number) => {
      flushBundles();
      replay(commands, pass, passStateCurrent ? prelude : 0);
      passStateCurrent = true;
    };
    const closeSegment = () => {
      if (!open) return;
      open = false;
      let matched =
        fresh === undefined &&
        retained !== undefined &&
        cursor === retained.commands.length &&
        preludeLength === retained.preludeLength;
      const segment: Segment =
        matched && retained !== undefined
          ? retained
          : {
              commands: fresh ?? retained?.commands.slice(0, cursor) ?? [],
              preludeLength,
              bundle: undefined,
            };
      if (!matched && drawCount > 0 && !inOcclusion) {
        const previous = physicalSegment(segment);
        if (previous !== undefined) {
          matched = true;
          // Only synthesized, already validated inherited setters can be
          // omitted when the current segment overwrites them before drawing.
          // Every explicit command still participates in the full comparison.
          segment.bundle = previous.bundle;
        }
      }
      if (drawCount === 0 || inOcclusion) {
        emitDirect(segment.commands, preludeLength);
        return;
      }
      // Direct-only work cannot admit a bundle on the following frame.
      nextSegments.push(segment);
      drawSegments += 1;
      if (matched) {
        reusedSegments += 1;
        if (segment.bundle !== undefined) {
          if (counters !== undefined) counters.hits += 1;
        } else {
          if (counters !== undefined) counters.misses += 1;
          const encoder = device.createRenderBundleEncoder(this.descriptor);
          if (!encoder.ok) throw encoder.error;
          recordBundle(segment, encoder.value);
          const finished = encoder.value.finish();
          if (!finished.ok) throw finished.error;
          segment.bundle = finished.value;
        }
        pending.push(segment.bundle);
        return;
      }
      missedSegments += 1;
      if (counters !== undefined) counters.misses += 1;
      emitDirect(segment.commands, preludeLength);
    };
    const barrier = () => {
      closeSegment();
      flushBundles();
    };
    const bundled = (method: Method, args: readonly unknown[]): void => {
      if (
        drawCount > 0 &&
        !inOcclusion &&
        fresh !== undefined &&
        (method === 'drawIndirect' || method === 'drawIndexedIndirect')
      ) {
        // Share physicalSegment's lazy index only after an ordinal mismatch.
        // Restore full-sized boundaries in order, at most once each. Recovering
        // short prefixes would accumulate a new segment on every front insert.
        const boundary = indirectSegmentIndex(args[0], args[1] as number);
        const previous = boundary === undefined ? undefined : retainedSegments[boundary];
        if (
          boundary !== undefined &&
          boundary > recoveredBoundary &&
          previous?.commands.reduce(
            (count, command) => count + (command.method.startsWith('draw') ? 1 : 0),
            0,
          ) === MAX_SEGMENT_DRAWS
        ) {
          recoveredBoundary = boundary;
          closeSegment();
        }
      }
      if (method === 'setPipeline' && open && drawCount > 0) closeSegment();
      if (!open) openSegment(method !== 'setPipeline');
      const command = push(method, args);
      switch (method) {
        case 'setPipeline':
          pipeline = command;
          break;
        case 'setBindGroup':
          groups[args[0] as number] = command;
          break;
        case 'setVertexBuffer':
          vertexBuffers[args[0] as number] = command;
          break;
        case 'setIndexBuffer':
          indexBuffer = command;
          break;
        default:
          drawCount += 1;
          if (drawCount === MAX_SEGMENT_DRAWS) closeSegment();
      }
    };
    const state = (method: DynamicState, args: unknown[]) => {
      barrier();
      Reflect.apply(pass[method], pass, args);
    };
    const proxy: RhiRenderPassEncoder = {
      setPipeline: (...args) => bundled('setPipeline', args),
      setVertexBuffer: (...args) => bundled('setVertexBuffer', args),
      setIndexBuffer: (...args) => bundled('setIndexBuffer', args),
      setBindGroup: (
        index,
        group,
        offsets?: readonly number[] | Uint32Array,
        start?: number,
        length?: number,
      ) => {
        const first = offsets instanceof Uint32Array ? (start ?? 0) : 0;
        const count =
          offsets instanceof Uint32Array ? (length ?? offsets.length) : (offsets?.length ?? 0);
        if (
          !Number.isSafeInteger(first) ||
          !Number.isSafeInteger(count) ||
          first < 0 ||
          count < 0 ||
          first + count > (offsets?.length ?? 0)
        ) {
          // Preserve the backend's original overload and validation. Never clamp
          // invalid slices into a different, potentially valid binding.
          barrier();
          Reflect.apply(pass.setBindGroup, pass, [index, group, offsets, start, length]);
          return;
        }
        const old = open ? retained?.commands[cursor] : undefined;
        const previous = old?.method === 'setBindGroup' ? old.args[2] : undefined;
        let selected: number[];
        if (
          Array.isArray(previous) &&
          previous.length === count &&
          previous.every((n, i) => n === offsets?.[first + i])
        ) {
          selected = previous;
        } else {
          selected = [];
          for (let i = 0; i < count; i++) selected.push(offsets?.[first + i] as number);
        }
        // The selected offset values have already matched the retained snapshot.
        // Consume that command directly instead of allocating its argument tuple
        // and comparing every offset again in push/equalArgs. Recheck the cursor
        // because reading an authored offset accessor can itself record work.
        if (
          fresh === undefined &&
          open &&
          old !== undefined &&
          retained?.commands[cursor] === old &&
          old.args.length === 3 &&
          old.args[0] === index &&
          old.args[1] === group &&
          selected === previous
        ) {
          cursor++;
          groups[index] = old;
          return;
        }
        bundled('setBindGroup', [index, group, selected]);
      },
      draw: (...args) => bundled('draw', args),
      drawIndexed: (...args) => bundled('drawIndexed', args),
      drawIndirect: (...args) => bundled('drawIndirect', args),
      drawIndexedIndirect: (...args) => bundled('drawIndexedIndirect', args),
      pushDebugGroup: (...args) => {
        barrier();
        pass.pushDebugGroup(...args);
      },
      popDebugGroup: () => {
        barrier();
        pass.popDebugGroup();
      },
      insertDebugMarker: (...args) => {
        barrier();
        pass.insertDebugMarker(...args);
      },
      setViewport: (...args) => state('setViewport', args),
      setScissorRect: (...args) => state('setScissorRect', args),
      setBlendConstant: (...args) => state('setBlendConstant', args),
      setStencilReference: (...args) => state('setStencilReference', args),
      // Query regions stay on the direct path: their draws are never bundled.
      beginOcclusionQuery: (...args) => {
        barrier();
        inOcclusion = true;
        return pass.beginOcclusionQuery(...args);
      },
      endOcclusionQuery: () => {
        barrier();
        inOcclusion = false;
        return pass.endOcclusionQuery();
      },
      executeBundles: (bundles) => {
        barrier();
        // WebGPU clears pipeline, bind group and vertex/index state here.
        pipeline = undefined;
        groups.length = 0;
        vertexBuffers.length = 0;
        indexBuffer = undefined;
        passStateCurrent = true;
        return pass.executeBundles(bundles);
      },
      end: () => {
        barrier();
        pass.end();
      },
    };
    try {
      record(proxy);
      barrier();
    } catch (error) {
      this.reset();
      throw error;
    }
    this.segments = nextSegments;
    if (drawSegments > 0 && missedSegments > reusedSegments) {
      this.idleFrames += 1;
      if (this.idleFrames >= IDLE_FRAMES_BEFORE_BACKOFF) {
        this.bypassFrames = Math.min(MAX_BYPASS_FRAMES, IDLE_FRAMES_BEFORE_BACKOFF << this.backoff);
        this.backoff += 1;
        this.idleFrames = 0;
        this.segments = [];
      }
    } else if (reusedSegments > 0) {
      this.idleFrames = 0;
      this.backoff = 0;
    }
  }

  private reset(): void {
    this.segments = [];
    this.idleFrames = 0;
    this.bypassFrames = 0;
    this.backoff = 0;
  }
}
