import type { ExecutionFaultMessage } from './protocol';

/** Error custom properties do not survive the native Error structured clone. */
export function serializableDetail(cause: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof cause === 'function' || typeof cause === 'symbol') return String(cause);
  if (typeof cause !== 'object' || cause === null) return cause;
  if (seen.has(cause)) return '[Circular]';
  seen.add(cause);
  if (Array.isArray(cause)) return cause.map((value) => serializableDetail(value, seen));
  const fields =
    cause instanceof Error
      ? {
          ...cause,
          name: cause.name,
          message: cause.message,
          stack: cause.stack,
          cause: cause.cause,
          code: Reflect.get(cause, 'code'),
          expected: Reflect.get(cause, 'expected'),
          hint: Reflect.get(cause, 'hint'),
          detail: Reflect.get(cause, 'detail'),
        }
      : cause;
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, serializableDetail(value, seen)]),
  );
}

/** Keep producer guidance as data across realm boundaries. */
export function workerError(
  cause: unknown,
): Pick<ExecutionFaultMessage, 'code' | 'expected' | 'hint' | 'detail'> {
  const value =
    typeof cause === 'object' && cause !== null ? (cause as Record<string, unknown>) : {};
  return {
    code: typeof value.code === 'string' ? value.code : 'render-worker-failed',
    expected:
      typeof value.expected === 'string'
        ? value.expected
        : 'Render Worker completes the requested operation',
    hint:
      typeof value.hint === 'string'
        ? value.hint
        : 'inspect the original cause and repair the failing producer',
    detail: serializableDetail(value.detail === undefined ? cause : value.detail),
  };
}
