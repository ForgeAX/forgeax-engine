import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { parseCLI } from 'vitest/node';

/** Browser optimizer globbing omits CLI filters. Admit only exact existing files. */
export function explicitBrowserFiles(rootDir: string): string[] | undefined {
  const files = /(?:^|[/\\])vitest(?:\.mjs)?$/.test(process.argv[1] ?? '')
    ? parseCLI(['vitest', ...process.argv.slice(2)]).filter.map((file) =>
        relative(rootDir, resolve(rootDir, file)).replaceAll('\\', '/'),
      )
    : [];
  return files.length > 0 &&
    files.every(
      (file) =>
        !file.startsWith('../') &&
        !/[*?[\]{}!]/.test(file) &&
        (file.endsWith('.browser.test.ts') ||
          file ===
            'packages/rhi-webgpu/src/__tests__/r32float-capability-generation.integration.test.ts') &&
        existsSync(resolve(rootDir, file)),
    )
    ? files
    : undefined;
}
