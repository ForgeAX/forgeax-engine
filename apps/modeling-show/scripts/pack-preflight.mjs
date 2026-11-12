// Imports one Pack module and evaluates its build() with default parameter values, timing both
// against the Pack build's module budget; the page runner calls it before packaging.
// Sibling reads (readByGuid) are refused: a build that needs them is judged by the package.
// usage: node pack-preflight.mjs <file.pack.ts>  -> one JSON line { ok, importMs, buildMs, error? }
const file = process.argv[2];
const out = { ok: true, importMs: 0, buildMs: 0 };
try {
  let t = performance.now();
  const pack = (await import(file)).default;
  out.importMs = Math.round(performance.now() - t);
  if (typeof pack?.build === 'function') {
    const values = Object.fromEntries((pack.parameters ?? []).map((p) => [p.name, p.default]));
    t = performance.now();
    const result = await pack.build({
      packageId: pack.packageId,
      values,
      readByGuid: async () => ({ ok: false, error: { code: 'preflight-read-refused' } }),
    });
    out.buildMs = Math.round(performance.now() - t);
    const code = result?.ok === false ? (result.error?.code ?? String(result.error)) : undefined;
    if (code !== undefined && !JSON.stringify(result.error).includes('preflight-read-refused')) {
      out.ok = false;
      out.error = `build() returned ${code}: ${String(result.error?.message ?? result.error?.expected ?? '').slice(0, 300)}`;
    }
  }
} catch (error) {
  out.ok = false;
  out.error = String(error?.stack ?? error).slice(0, 800);
}
console.log(JSON.stringify(out));
process.exit(0);
