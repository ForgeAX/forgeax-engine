import { describe, expect, it } from 'vitest';
import { serializeBrowserConsoleValue } from '../scripts/serialize-browser-console-value.mjs';

describe('template smoke browser console evidence', () => {
  it('preserves nested Error messages, codes, causes, and bounded stacks', () => {
    const cause = new Error('missing generated plugin entry');
    cause.code = 'ERR_MODULE_NOT_FOUND';
    const outer = new Error('game root activation failed', { cause });

    const serialized = serializeBrowserConsoleValue({ cause: outer });

    expect(serialized.cause).toMatchObject({
      name: 'Error',
      message: 'game root activation failed',
      cause: {
        name: 'Error',
        message: 'missing generated plugin entry',
        code: 'ERR_MODULE_NOT_FOUND',
      },
    });
    expect(serialized.cause.stack.length).toBeLessThanOrEqual(4_000);
  });
});
