import { RenderGraphError } from './errors.js';
import type {
  GraphResourceResolver,
  RenderGraphFrame,
  RenderGraphNativeIssue,
  RenderGraphNativePass,
  RenderGraphPassExecution,
  RenderGraphPassInstrumentation,
  RenderGraphPassInstrumentationScope,
  RenderGraphPassRunner,
  SubgraphPass,
} from './types.js';

let generation = 0;

/** Unique physical pass-owner identity for capture and timing receipts on this renderer realm. */
export function allocateRenderPassGeneration(): number {
  return ++generation;
}

export function safePassScope<FrameCtx extends RenderGraphFrame>(
  instrumentation: RenderGraphPassInstrumentation<FrameCtx> | undefined,
  execution: RenderGraphPassExecution | undefined,
  frame: FrameCtx,
): RenderGraphPassInstrumentationScope | undefined {
  if (instrumentation === undefined || execution === undefined) return undefined;
  try {
    return instrumentation.begin(execution, frame);
  } catch {
    // Instrumentation is diagnostic and cannot change graph execution.
    return undefined;
  }
}

export function safeEndPass(scope: RenderGraphPassInstrumentationScope | undefined): void {
  try {
    scope?.endPass?.();
  } catch {
    // Instrumentation is diagnostic and cannot replace a graph pass result.
  }
}

export function decorateDescriptor<T>(
  scope: RenderGraphPassInstrumentationScope | undefined,
  decorate: ((descriptor: T) => T) | undefined,
  descriptor: T,
): T {
  try {
    return decorate?.call(scope, descriptor) ?? descriptor;
  } catch {
    // Instrumentation is diagnostic and cannot alter the pass descriptor.
    return descriptor;
  }
}

/** Issue one current physical command on the caller's encoder. Borrowed arguments
 * are consumed synchronously. Only observed passes need an execution record. */
export function encodeNativeRenderPass<F extends RenderGraphFrame>(
  frame: F,
  work: RenderGraphNativePass,
  executionIndex: number,
  instrumentation?: RenderGraphPassInstrumentation<F>,
  runPass?: RenderGraphPassRunner,
  pendingPasses?: Set<string>,
): void {
  if (runPass === undefined && instrumentation === undefined) {
    encodeBody(frame, work, undefined);
    frame.nativePassNames?.push(work.name);
    pendingPasses?.delete(work.name);
    return;
  }
  const execution = {
    name: work.name,
    kind: work.kind,
    executionIndex,
    ...(work.profileName === undefined ? {} : { profileName: work.profileName }),
  };
  if (runPass === undefined) {
    encodeBody(frame, work, safePassScope(instrumentation, execution, frame));
    frame.nativePassNames?.push(work.name);
    pendingPasses?.delete(work.name);
  } else {
    runPass(execution, () => {
      encodeBody(frame, work, safePassScope(instrumentation, execution, frame));
      frame.nativePassNames?.push(work.name);
      pendingPasses?.delete(work.name);
    });
  }
}

/** One graph owns one synchronous native recording at a time. Expired callbacks
 * cannot issue work even when another stage is active on the same graph. */
export class NativeCommandRecorder<F extends RenderGraphFrame> {
  private serial = 0;
  private active: F | undefined;
  private cursor: { next: number; readonly pendingPasses?: Set<string> | undefined } | undefined;
  private timing: RenderGraphPassInstrumentation<F> | undefined;
  private runner: RenderGraphPassRunner | undefined;
  private encoding = false;

  constructor(private readonly retired: () => boolean) {}

  private readonly issue: RenderGraphNativeIssue = (recording, work) => {
    const frame = this.active;
    const cursor = this.cursor;
    if (
      frame === undefined ||
      cursor === undefined ||
      recording !== this.serial ||
      this.encoding ||
      this.retired()
    )
      throw new RenderGraphError({
        code: 'resource-descriptor-invalid',
        expected: 'synchronous, non-recursive native commands on a live graph',
        hint: 'issue commands only from the current subgraph recording',
        detail: {
          resourceLabel: 'subgraph',
          field: 'execution',
          expected: 'the current native recording',
        },
      });
    this.encoding = true;
    try {
      encodeNativeRenderPass(
        frame,
        work,
        cursor.next++,
        this.timing,
        this.runner,
        cursor.pendingPasses,
      );
    } finally {
      this.encoding = false;
    }
  };

  run(
    descriptor: Exclude<SubgraphPass<F>, { child: unknown }>,
    frame: F,
    resources: GraphResourceResolver,
    cursor: NonNullable<typeof this.cursor>,
    timing: RenderGraphPassInstrumentation<F> | undefined,
    runner: RenderGraphPassRunner | undefined,
  ): void {
    const recording = ++this.serial;
    if (!Number.isSafeInteger(recording))
      throw new Error('Exhausted native graph recording numbers');
    this.active = frame;
    this.cursor = cursor;
    this.timing = timing;
    this.runner = runner;
    try {
      if (descriptor.commandsDirect !== undefined)
        descriptor.commandsDirect(frame, resources, this.issue, recording);
      else
        descriptor.commands({ frame, resources, execute: (work) => this.issue(recording, work) });
    } finally {
      this.active = this.cursor = this.timing = this.runner = undefined;
    }
  }
}

function encodeBody(
  frame: RenderGraphFrame,
  work: RenderGraphNativePass,
  scope: RenderGraphPassInstrumentationScope | undefined,
): void {
  try {
    switch (work.kind) {
      case 'compute': {
        const descriptor = decorateDescriptor(
          scope,
          scope?.computePassDescriptor,
          work.descriptor ?? { label: work.name },
        );
        const pass = frame.encoder.beginComputePass(
          descriptor.label === work.name ? descriptor : { ...descriptor, label: work.name },
        );
        try {
          work.encode(pass);
        } finally {
          pass.end();
        }
        break;
      }
      case 'raster': {
        const descriptor = decorateDescriptor(scope, scope?.renderPassDescriptor, work.descriptor);
        const pass = frame.encoder.beginRenderPass(descriptor);
        try {
          work.encode(pass);
        } finally {
          pass.end();
        }
        break;
      }
      case 'copy':
        try {
          scope?.beforeCopy?.(frame.encoder);
        } catch {
          // Observation may fail independently of command recording.
        }
        try {
          work.encode(frame.encoder);
        } finally {
          try {
            scope?.afterCopy?.(frame.encoder);
          } catch {
            // Preserve a copy failure.
          }
        }
        break;
    }
  } catch (cause) {
    throw new RenderGraphError({
      code: 'pass-encode-failed',
      expected: `pass '${work.name}' encodes without throwing`,
      hint: 'inspect detail.cause and repair the pass-owned RHI command',
      detail: { passName: work.name, passKind: work.kind, cause },
    });
  } finally {
    safeEndPass(scope);
  }
}
