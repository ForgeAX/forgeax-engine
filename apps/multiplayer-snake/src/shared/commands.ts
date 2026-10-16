export const MAX_COMMAND_BYTES = 16;

export type Direction = 'up' | 'right' | 'down' | 'left';

export interface DirectionCommand {
  readonly direction: Direction;
}
export interface JoinCommand {
  readonly kind: 'join';
}
export interface ReadyCommand {
  readonly kind: 'ready';
}
export type SnakeCommand = JoinCommand | ReadyCommand | DirectionCommand;

export type CommandErrorCode = 'command-malformed' | 'command-too-large';

export interface CommandError {
  readonly code: CommandErrorCode;
  readonly expected: string;
  readonly hint: string;
}

export type CommandResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: CommandError };

const directions: readonly Direction[] = ['up', 'right', 'down', 'left'];

export function encodeDirectionCommand(command: DirectionCommand): CommandResult<Uint8Array> {
  const direction = directions.indexOf(command.direction);
  return direction === -1 ? malformed() : { ok: true, value: new Uint8Array([1, direction]) };
}

export function encodeCommand(command: SnakeCommand): CommandResult<Uint8Array> {
  if ('kind' in command)
    return { ok: true, value: new Uint8Array([command.kind === 'join' ? 0 : 2]) };
  return encodeDirectionCommand(command);
}

export function decodeDirectionCommand(data: Uint8Array): CommandResult<DirectionCommand> {
  if (data.byteLength > MAX_COMMAND_BYTES) return tooLarge();
  if (data.byteLength !== 2 || data[0] !== 1) return malformed();
  const direction = directions[data[1] ?? -1];
  return direction === undefined ? malformed() : { ok: true, value: { direction } };
}

export function decodeCommand(data: Uint8Array): CommandResult<SnakeCommand> {
  if (data.byteLength > MAX_COMMAND_BYTES) return tooLarge();
  if (data.byteLength === 1 && data[0] === 0) return { ok: true, value: { kind: 'join' } };
  if (data.byteLength === 1 && data[0] === 2) return { ok: true, value: { kind: 'ready' } };
  const direction = decodeDirectionCommand(data);
  return direction.ok ? direction : direction;
}

export function processReadyCommands(
  messages: readonly RawDirectionMessage[],
  connected: ReadonlySet<number>,
): Set<number> {
  const ready = new Set<number>();
  for (const message of messages) {
    if (!connected.has(message.sessionId)) continue;
    const decoded = decodeCommand(message.data);
    if (decoded.ok && 'kind' in decoded.value && decoded.value.kind === 'ready')
      ready.add(message.sessionId);
  }
  return ready;
}

export interface RawDirectionMessage {
  readonly sessionId: number;
  readonly data: Uint8Array;
}

export function processJoinCommands(
  messages: readonly RawDirectionMessage[],
  connected: ReadonlySet<number>,
): Set<number> {
  const joined = new Set<number>();
  for (const message of messages) {
    if (!connected.has(message.sessionId)) continue;
    const decoded = decodeCommand(message.data);
    if (decoded.ok && 'kind' in decoded.value && decoded.value.kind === 'join')
      joined.add(message.sessionId);
  }
  return joined;
}

export function processCommands(
  messages: readonly RawDirectionMessage[],
  currentDirections: ReadonlyMap<number, Direction>,
): Map<number, Direction> {
  const accepted = new Map<number, Direction>();
  for (const message of messages) {
    if (accepted.has(message.sessionId)) continue;
    const decoded = decodeDirectionCommand(message.data);
    const current = currentDirections.get(message.sessionId);
    if (!decoded.ok || current === undefined || isOpposite(current, decoded.value.direction))
      continue;
    accepted.set(message.sessionId, decoded.value.direction);
  }
  return accepted;
}

export function isOpposite(left: Direction, right: Direction): boolean {
  return (
    (left === 'up' && right === 'down') ||
    (left === 'down' && right === 'up') ||
    (left === 'left' && right === 'right') ||
    (left === 'right' && right === 'left')
  );
}

function malformed<T>(): CommandResult<T> {
  return {
    ok: false,
    error: {
      code: 'command-malformed',
      expected: 'a two-byte direction command',
      hint: 'send a command produced by encodeDirectionCommand',
    },
  };
}

function tooLarge<T>(): CommandResult<T> {
  return {
    ok: false,
    error: {
      code: 'command-too-large',
      expected: `at most ${MAX_COMMAND_BYTES} command bytes`,
      hint: 'bound raw input before decoding',
    },
  };
}
