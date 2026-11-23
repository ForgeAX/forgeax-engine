import type { RecordStore } from '@forgeax/engine-platform';
import { createBrowserSaveRecords } from '@forgeax/engine-platform-browser';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { GameProjectionValue } from './game-context';

export interface GameSave {
  readonly version: number;
  readonly data: GameProjectionValue;
}

export interface GameSaveFailure {
  readonly code: 'invalid-slot' | 'invalid-save' | 'storage-unavailable';
  readonly slot: string;
  readonly cause?: unknown;
}

export interface GameSaves {
  read(slot: string): Promise<Result<GameSave | null, GameSaveFailure>>;
  write(slot: string, save: GameSave): Promise<Result<void, GameSaveFailure>>;
}

export interface GameSaveStorage {
  read(slot: string): Promise<string | null>;
  write(slot: string, bytes: string): Promise<void>;
}

const validSlot = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const maxSaveBytes = 1024 * 1024;

function validSave(save: unknown): save is GameSave {
  if (save === null || typeof save !== 'object' || Array.isArray(save)) return false;
  const record = save as Record<string, unknown>;
  return (
    Number.isSafeInteger(record.version) &&
    Number(record.version) > 0 &&
    Object.hasOwn(record, 'data')
  );
}

function checkSize(bytes: string): void {
  if (new TextEncoder().encode(bytes).byteLength > maxSaveBytes)
    throw new RangeError('Game saves must be at most 1 MiB');
}

/** Persistence is project-scoped. The game owns interpretation and migration of its data. */
export function createGameSaves(storage: GameSaveStorage): GameSaves {
  return {
    async read(slot) {
      if (!validSlot.test(slot)) return err({ code: 'invalid-slot', slot });
      let bytes: string | null;
      try {
        bytes = await storage.read(slot);
      } catch (cause) {
        return err({ code: 'storage-unavailable', slot, cause });
      }
      if (bytes === null) return ok(null);
      try {
        checkSize(bytes);
        const save: unknown = JSON.parse(bytes);
        if (!validSave(save)) return err({ code: 'invalid-save', slot });
        return ok(save);
      } catch (cause) {
        return err({ code: 'invalid-save', slot, cause });
      }
    },
    async write(slot, save) {
      if (!validSlot.test(slot)) return err({ code: 'invalid-slot', slot });
      let bytes: string;
      try {
        bytes = JSON.stringify(save, (_key, value: unknown) => {
          if (
            value === undefined ||
            typeof value === 'function' ||
            typeof value === 'symbol' ||
            (typeof value === 'number' && !Number.isFinite(value))
          )
            throw new TypeError('A game save contains a value outside JSON');
          return value;
        });
        checkSize(bytes);
        if (!validSave(JSON.parse(bytes))) return err({ code: 'invalid-save', slot });
      } catch (cause) {
        return err({ code: 'invalid-save', slot, cause });
      }
      try {
        await storage.write(slot, bytes);
        return ok(undefined);
      } catch (cause) {
        return err({ code: 'storage-unavailable', slot, cause });
      }
    },
  };
}

export function createRecordGameSaves(records: RecordStore): GameSaves {
  const signal = new AbortController().signal;
  return createGameSaves({
    async read(slot) {
      const bytes = (await records.read(slot, signal)).unwrap();
      return bytes === undefined ? null : new TextDecoder().decode(bytes);
    },
    async write(slot, value) {
      (await records.replace(slot, new TextEncoder().encode(value), signal)).unwrap();
    },
  });
}

/** Browser pages and Engine Workers share the same project slots on the current origin. */
export function createBrowserGameSaves(
  readFactory: () => IDBFactory | undefined,
  projectId: string,
): GameSaves {
  return createRecordGameSaves(createBrowserSaveRecords(readFactory, projectId));
}
