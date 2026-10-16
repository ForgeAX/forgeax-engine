import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rhiDebugSourceRoot = fileURLToPath(new URL('../packages/rhi-debug/src/', import.meta.url));
const rhiDebugSourceEntry = fileURLToPath(
  new URL('../packages/rhi-debug/src/index.ts', import.meta.url),
);
const rhiDebugSourceAlias = {
  find: /^@forgeax\/engine-rhi-debug$/,
  replacement: rhiDebugSourceEntry,
} as const;

export function createRhiDebugSourceAliases(): readonly [typeof rhiDebugSourceAlias] {
  if (!rhiDebugSourceEntry.startsWith(rhiDebugSourceRoot) || !existsSync(rhiDebugSourceEntry)) {
    throw new Error(
      `rhi-debug source alias must resolve inside packages/rhi-debug/src: ${rhiDebugSourceEntry}`,
    );
  }
  return [rhiDebugSourceAlias];
}
