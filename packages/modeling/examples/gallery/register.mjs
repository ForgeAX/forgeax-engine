// Node loader for the gallery scripts: resolves the kernel's extensionless relative imports, and (only when
// GALLERY_NO_MERGE=1) swaps the planar-boolean coplanar-merge hook for the identity stub in no-merge.ts so the
// "before the merge" state can be rendered without touching src/.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(spec, ctx, next) {
  if (process.env.GALLERY_NO_MERGE === '1' && /\/planar-cross-merge(\.ts)?$/.test(spec)) {
    return next(new URL('./no-merge.ts', import.meta.url).href, ctx);
  }
  if (
    (spec.startsWith('.') || spec.startsWith('/')) &&
    ctx.parentURL &&
    !/\.(m?[jt]s|json)$/.test(spec)
  ) {
    const base = new URL(spec, ctx.parentURL);
    for (const suffix of ['.ts', '/index.ts']) {
      const url = base.href + suffix;
      if (existsSync(fileURLToPath(url))) return next(url, ctx);
    }
  }
  return next(spec, ctx);
}
