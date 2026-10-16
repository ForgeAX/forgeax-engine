import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const renderSourceRoot = fileURLToPath(new URL('../packages/render/src/', import.meta.url));

const renderSourceAliases = [
  {
    find: /^@forgeax\/engine-render$/,
    replacement: fileURLToPath(new URL('../packages/render/src/index.ts', import.meta.url)),
  },
  {
    find: '@forgeax/engine-render/authoring',
    replacement: fileURLToPath(new URL('../packages/render/src/authoring.ts', import.meta.url)),
  },
  {
    find: /^@forgeax\/engine-render\/internal$/,
    replacement: fileURLToPath(new URL('../packages/render/src/internal.ts', import.meta.url)),
  },
  {
    find: '@forgeax/engine-render/internal/construct-renderer',
    replacement: fileURLToPath(
      new URL('../packages/render/src/construct-renderer.ts', import.meta.url),
    ),
  },
] as const;

export function createRenderSourceAliases(): readonly (typeof renderSourceAliases)[number][] {
  for (const alias of renderSourceAliases) {
    if (!alias.replacement.startsWith(renderSourceRoot) || !existsSync(alias.replacement)) {
      throw new Error(
        `render source alias must resolve inside packages/render/src: ${alias.replacement}`,
      );
    }
  }
  return renderSourceAliases;
}
