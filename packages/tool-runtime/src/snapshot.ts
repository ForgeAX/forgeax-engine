import type { SnapshotRef, ToolTerminal } from './types.js';

export function terminalSnapshot<TResult>(
  terminal: ToolTerminal<TResult>,
): SnapshotRef | undefined {
  return terminal.snapshotAfter;
}

export function isSnapshotRef(value: unknown): value is SnapshotRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    Number.isSafeInteger(Reflect.get(value, 'revision')) &&
    Reflect.get(value, 'revision') >= 0 &&
    typeof Reflect.get(value, 'digest') === 'string' &&
    Reflect.get(value, 'digest').length > 0
  );
}
