import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function stateProjectionAliases(root) {
  const aliases = {};
  for (const directory of readdirSync(resolve(root, 'packages'))) {
    const owner = resolve(root, 'packages', directory);
    const manifestPath = resolve(owner, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const [subpath, value] of Object.entries(manifest.exports ?? {})) {
      const target = typeof value === 'object' ? (value.types ?? value.import) : value;
      if (typeof target !== 'string') continue;
      const source = resolve(
        owner,
        target.replace(/^\.\/dist\//, './src/').replace(/\.d\.ts$|\.mjs$|\.js$/, '.ts'),
      );
      if (existsSync(source))
        aliases[manifest.name + (subpath === '.' ? '' : subpath.slice(1))] = source;
    }
  }
  return aliases;
}
