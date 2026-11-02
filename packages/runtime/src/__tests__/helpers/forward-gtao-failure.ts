export interface ForwardGtaoFailureContext {
  readonly backend: string;
  readonly manifestSummary?: unknown;
  readonly registryArtifacts?: unknown;
  readonly cameraConfig?: unknown;
  readonly operation: string;
  readonly receipt?: unknown;
  readonly frameTrace?: unknown;
  readonly readback?: unknown;
  readonly rendererErrors?: readonly unknown[];
  readonly diagnostics?: unknown;
}

export type ForwardGtaoFailureWriter = (path: string, contents: string) => Promise<unknown>;

export type ForwardGtaoCandidateFaultSnapshot = Readonly<{
  readonly event: unknown;
  readonly error: unknown;
  readonly inspection: {
    readonly frame: { readonly deviceGeneration: number };
  };
}>;

export type VerifiedForwardGtaoCandidateFault = Readonly<{
  readonly event: unknown;
  readonly evidence: unknown;
  readonly snapshot: ForwardGtaoCandidateFaultSnapshot;
  readonly candidateGeneration: number;
}>;

const MAX_FAILURE_DEPTH = 8;
const MAX_FAILURE_ITEMS = 64;
const MAX_FAILURE_STRING = 16_384;

function field(value: object, key: string): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function errorLike(value: Record<string, unknown>): boolean {
  return typeof value.message === 'string' || typeof value.code === 'string';
}

function boundedString(value: string): string {
  return value.length <= MAX_FAILURE_STRING
    ? value
    : `${value.slice(0, MAX_FAILURE_STRING)}...[truncated ${value.length - MAX_FAILURE_STRING} chars]`;
}

function safeTypeName(value: object): string {
  try {
    const constructorValue = Reflect.get(value, 'constructor');
    return typeof constructorValue?.name === 'string' ? constructorValue.name : 'non-plain-object';
  } catch {
    return 'non-plain-object';
  }
}

function serializeFailureArray(
  value: readonly unknown[],
  seen: WeakSet<object>,
  depth: number,
): unknown[] {
  const items = value
    .slice(0, MAX_FAILURE_ITEMS)
    .map((item) => serializeFailureValue(item, seen, depth + 1));
  if (value.length > MAX_FAILURE_ITEMS) {
    items.push({ omittedItems: value.length - MAX_FAILURE_ITEMS });
  }
  return items;
}

function serializeErrorFields(
  value: object,
  seen: WeakSet<object>,
  depth: number,
): Record<string, unknown> {
  const serialized: Record<string, unknown> = {};
  for (const key of ['name', 'message', 'code', 'expected', 'hint', 'detail', 'cause'] as const) {
    const member = field(value, key);
    if (member !== undefined) {
      serialized[key] = serializeFailureValue(member, seen, depth + 1);
    }
  }
  return serialized;
}

function serializePlainRecord(
  value: object,
  record: Record<string, unknown>,
  seen: WeakSet<object>,
  depth: number,
): Record<string, unknown> {
  const keys = Object.keys(record);
  const serialized: Record<string, unknown> = {};
  for (const key of keys.slice(0, MAX_FAILURE_ITEMS)) {
    serialized[key] = serializeFailureValue(field(value, key), seen, depth + 1);
  }
  if (keys.length > MAX_FAILURE_ITEMS) {
    serialized.omittedKeys = keys.length - MAX_FAILURE_ITEMS;
  }
  return serialized;
}

function serializeFailureObject(value: object, seen: WeakSet<object>, depth: number): unknown {
  if (Array.isArray(value)) return serializeFailureArray(value, seen, depth);
  const record = value as Record<string, unknown>;
  if (errorLike(record)) return serializeErrorFields(value, seen, depth);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return { omittedNonPlainObject: safeTypeName(value) };
  }
  return serializePlainRecord(value, record, seen, depth);
}

function serializeFailureValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return typeof value === 'string' ? boundedString(value) : value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'undefined') return null;
  if (typeof value !== 'object') return String(value);
  if (depth >= MAX_FAILURE_DEPTH) return { truncated: 'maximum nested failure depth' };
  if (seen.has(value)) return { truncated: 'circular or repeated failure value' };
  seen.add(value);
  try {
    return serializeFailureObject(value, seen, depth);
  } finally {
    seen.delete(value);
  }
}

export function describeForwardGtaoFailure(failure: unknown): unknown {
  return serializeFailureValue(failure, new WeakSet(), 0);
}

function member(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined;
  }
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function sameSerializedValue(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function candidateFaultFailure(message: string, cause?: unknown): Error {
  return cause === undefined ? new Error(message) : new Error(message, { cause });
}

export function requireNoForwardGtaoRendererErrors(
  errors: readonly unknown[],
  boundary: string,
): void {
  if (errors.length === 0) return;
  throw candidateFaultFailure(
    `unconfirmed renderer errors before ${boundary}: ${JSON.stringify(
      errors.map(describeForwardGtaoFailure),
    )}`,
    errors[0],
  );
}

/** Verifies the one captured injection event without mutating pending renderer errors. */
export function verifyForwardGtaoCandidateFault(input: {
  readonly errors: readonly unknown[];
  readonly snapshots: readonly ForwardGtaoCandidateFaultSnapshot[];
}): VerifiedForwardGtaoCandidateFault {
  if (input.errors.length !== 1) {
    throw candidateFaultFailure(
      `expected exactly one candidate-failure renderer event, received ${input.errors.length}`,
      input.errors[0],
    );
  }
  if (input.snapshots.length !== 1) {
    throw candidateFaultFailure(
      `expected exactly one candidate-failure snapshot, received ${input.snapshots.length}`,
    );
  }
  const event = input.errors[0];
  const snapshot = input.snapshots[0];
  if (event === undefined || snapshot === undefined || snapshot.event !== event) {
    throw candidateFaultFailure('candidate-failure snapshot does not identify the pending event');
  }

  const evidence = describeForwardGtaoFailure(event);
  if (!sameSerializedValue(snapshot.error, evidence)) {
    throw candidateFaultFailure('candidate-failure snapshot does not preserve the complete event');
  }

  const details = member(event, 'detail');
  const cause = member(details, 'cause');
  const causeDetails = member(cause, 'detail');
  const candidateGeneration = member(causeDetails, 'candidateGeneration');
  const deviceGeneration = member(causeDetails, 'deviceGeneration');
  const passNames = member(causeDetails, 'passNames');
  if (
    member(event, 'code') !== 'graph-build-failed' ||
    member(cause, 'code') !== 'gtao-candidate-preparation-fault-injected' ||
    member(causeDetails, 'phase') !== 'post-allocation-before-promotion' ||
    !Number.isSafeInteger(candidateGeneration) ||
    typeof candidateGeneration !== 'number' ||
    candidateGeneration <= 0 ||
    deviceGeneration !== snapshot.inspection.frame.deviceGeneration ||
    !Array.isArray(passNames) ||
    !passNames.includes('gtao-calc-compute') ||
    !passNames.includes('ssao-blur')
  ) {
    throw candidateFaultFailure(
      `candidate-failure renderer event has an unexpected cause or phase: ${JSON.stringify(evidence)}`,
      event,
    );
  }

  return Object.freeze({ event, evidence, snapshot, candidateGeneration });
}

/** Removes only the exact event previously verified by verifyForwardGtaoCandidateFault. */
export function consumeVerifiedForwardGtaoCandidateFault(
  errors: unknown[],
  verified: VerifiedForwardGtaoCandidateFault,
): void {
  if (
    errors.length !== 1 ||
    errors[0] !== verified.event ||
    !sameSerializedValue(describeForwardGtaoFailure(verified.event), verified.evidence) ||
    verified.snapshot.event !== verified.event
  ) {
    throw candidateFaultFailure(
      `pending renderer errors no longer contain exactly the verified candidate failure: ${JSON.stringify(
        errors.map(describeForwardGtaoFailure),
      )}`,
      errors[0],
    );
  }
  errors.splice(0, 1);
}

/** Applies the test draw's error policy with the receipt and trace just validated for this frame. */
export function throwForForwardGtaoRendererErrors(input: {
  readonly errors: readonly unknown[];
  readonly output: unknown;
  readonly receipt: unknown;
  readonly frameTrace: unknown;
}): void {
  if (input.errors.length === 0) return;
  throw new Error(
    `Renderer event failure: ${JSON.stringify({
      errors: input.errors.map(describeForwardGtaoFailure),
      output: input.output,
      receipt: input.receipt,
      frameTrace: input.frameTrace,
    })}`,
    { cause: input.errors[0] },
  );
}

export function forwardGtaoFailureReport(
  failure: unknown,
  context: ForwardGtaoFailureContext,
): Record<string, unknown> {
  return {
    schema: 'forgeax::forward-gtao-failure::1',
    backend: context.backend,
    manifestSummary: serializeFailureValue(context.manifestSummary ?? null, new WeakSet(), 0),
    registryArtifacts: serializeFailureValue(context.registryArtifacts ?? [], new WeakSet(), 0),
    cameraConfig: serializeFailureValue(context.cameraConfig ?? null, new WeakSet(), 0),
    failingOperation: context.operation,
    receipt: serializeFailureValue(context.receipt ?? { status: 'not-obtained' }, new WeakSet(), 0),
    frameTrace: serializeFailureValue(context.frameTrace ?? null, new WeakSet(), 0),
    readback: serializeFailureValue(
      context.readback ?? { status: 'not-obtained' },
      new WeakSet(),
      0,
    ),
    rendererErrors: serializeFailureValue(context.rendererErrors ?? [], new WeakSet(), 0),
    diagnostics: serializeFailureValue(
      context.diagnostics ?? { status: 'not-obtained' },
      new WeakSet(),
      0,
    ),
    failure: describeForwardGtaoFailure(failure),
  };
}

/** Best-effort evidence writing must never replace the original renderer failure. */
export async function writeForwardGtaoFailureReport(input: {
  readonly writeFile: ForwardGtaoFailureWriter;
  readonly path: string;
  readonly failure: unknown;
  readonly context: ForwardGtaoFailureContext;
}): Promise<Record<string, unknown>> {
  const report = forwardGtaoFailureReport(input.failure, input.context);
  try {
    await input.writeFile(input.path, JSON.stringify(report, null, 2));
  } catch (writeFailure) {
    console.error(
      '[forward-gtao-failure-report] write failed',
      JSON.stringify({ path: input.path, error: describeForwardGtaoFailure(writeFailure) }),
    );
  }
  return report;
}
