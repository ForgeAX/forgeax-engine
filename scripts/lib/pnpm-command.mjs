import { extname, join } from 'node:path';

/** Reuse the package-manager entry supplied by the owning pnpm process. */
export function pnpmCommand(env = process.env) {
  const manager =
    env.npm_execpath ?? (env.COREPACK_ROOT ? join(env.COREPACK_ROOT, 'dist/pnpm.js') : undefined);
  if (!manager) {
    if (process.platform === 'win32')
      throw new Error('Windows package lifecycle requires a pnpm entry; launch through pnpm exec');
    return ['pnpm'];
  }
  return ['.js', '.cjs', '.mjs'].includes(extname(manager))
    ? [process.execPath, manager]
    : [manager];
}
