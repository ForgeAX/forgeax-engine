import { resolve } from 'node:path';
import MagicString from 'magic-string';
import { normalizePath, type Plugin } from 'vite';

/** Link the URL-loaded bootstrap into the same content-addressed module graph as the page. */
export function executionBootstrapEntry(generatedRoot: string): Plugin {
  const host = normalizePath(resolve(generatedRoot, 'main.ts'));
  const bootstrap = resolve(generatedRoot, 'execution-bootstrap.ts');
  return {
    name: 'forgeax:execution-bootstrap-entry',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      if (normalizePath(id.split('?')[0] ?? id) !== host) return null;
      const pattern =
        /new URL\(\s*(['"])\.\/execution-bootstrap\.ts\1\s*,\s*import\.meta\.url\s*,?\s*\)/g;
      const matches = [...code.matchAll(pattern)];
      if (matches.length === 0) return null;
      const reference = this.emitFile({
        type: 'chunk',
        id: bootstrap,
        name: 'execution-bootstrap',
        preserveSignature: 'strict',
      });
      const output = new MagicString(code);
      for (const match of matches) {
        if (match.index === undefined) continue;
        output.overwrite(
          match.index,
          match.index + match[0].length,
          `new URL(import.meta.ROLLUP_FILE_URL_${reference}, import.meta.url)`,
        );
      }
      return { code: output.toString(), map: output.generateMap({ hires: true }) };
    },
  };
}
