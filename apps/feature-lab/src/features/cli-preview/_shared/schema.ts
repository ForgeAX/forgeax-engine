import type { ToolSchema } from '@forgeax/engine/tool-runtime';

export function numberField<K extends string>(key: K): ToolSchema<Record<K, number>> {
  return {
    describe: `{ ${key}: number }`,
    parse(value) {
      const field = (value as Record<string, unknown> | null)?.[key];
      return typeof field === 'number' && Number.isFinite(field)
        ? { ok: true, value: { [key]: field } as Record<K, number> }
        : { ok: false, error: `$.${key}: expected a finite number` };
    },
  };
}
