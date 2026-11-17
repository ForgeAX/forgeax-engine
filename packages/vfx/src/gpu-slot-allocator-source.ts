import { err, ok, type Result } from '@forgeax/engine-types';

/** Persistent GPU slots, independently of the ordinary scheduled spawn stream.
 * A single native dispatch chooses idle slots first, then the largest authored
 * recycle priority. The acquire hook initializes the actual GPU particle. */
export interface GpuSlotAllocatorSource {
  readonly acquire?: string;
  /** Ordered single-invocation control of coupled GPU pools. Managed accessors
   * expose only this emitter's bounded particle/custom slots, never bindings. */
  readonly control?: string;
  readonly state: {
    readonly active: string;
    readonly priority: string;
    readonly cursor: string;
    readonly sequence: string;
  };
  readonly commands: readonly { readonly sequence: string; readonly count: string }[];
  readonly maxCommandCount: number;
}
export interface GpuSlotAllocatorSourceError {
  readonly path: string;
  readonly expected: string;
}
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const identifier = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v) && !v.startsWith('forgeax_');
export function parseGpuSlotAllocatorSource(
  value: unknown,
): Result<GpuSlotAllocatorSource, GpuSlotAllocatorSourceError> {
  const fail = (path: string, expected: string) => err({ path, expected });
  if (
    !record(value) ||
    Object.keys(value).some(
      (k) => !['acquire', 'control', 'state', 'commands', 'maxCommandCount'].includes(k),
    )
  )
    return fail('pool', 'a closed GPU slot allocator declaration');
  const hooksValid = () =>
    !(
      (value.acquire !== undefined && !identifier(value.acquire)) ||
      (value.control !== undefined && !identifier(value.control)) ||
      (value.acquire === undefined && value.control === undefined)
    );
  if (!hooksValid()) return fail('pool.acquire', 'an acquire hook or ordered control hook');
  if (
    !record(value.state) ||
    Object.keys(value.state).sort().join(',') !== 'active,cursor,priority,sequence' ||
    Object.values(value.state).some((v) => !identifier(v)) ||
    new Set(Object.values(value.state)).size !== 4
  )
    return fail('pool.state', 'four distinct custom f32 field identifiers');
  if (
    !Array.isArray(value.commands) ||
    (value.acquire !== undefined ? value.commands.length < 1 : value.commands.length !== 0) ||
    value.commands.length > 16
  )
    return fail(
      'pool.commands',
      'bounded command pairs for acquire, or no commands for control-only pools',
    );
  const commands = value.commands;
  const validateCommands = () => {
    for (let i = 0; i < commands.length; i++) {
      const c = commands[i];
      if (
        !record(c) ||
        Object.keys(c).sort().join(',') !== 'count,sequence' ||
        !identifier(c.sequence) ||
        !identifier(c.count)
      )
        return fail(`pool.commands[${i}]`, 'sequence and count uniform f32 field identifiers');
    }

    return undefined;
  };
  const validateCommandsFailure = validateCommands();
  if (validateCommandsFailure !== undefined) return validateCommandsFailure;
  if (
    !Number.isInteger(value.maxCommandCount) ||
    (value.maxCommandCount as number) < 1 ||
    (value.maxCommandCount as number) > 1024
  )
    return fail('pool.maxCommandCount', 'an integer in [1,1024]');
  return ok(value as unknown as GpuSlotAllocatorSource);
}
