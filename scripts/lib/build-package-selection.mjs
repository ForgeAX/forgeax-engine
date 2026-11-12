/** Select the existing production/build dependency closure, never test peers. */
export function buildPackageSelection(packages, dependencies, args) {
  if (args.length === 0) return packages;
  const selected = new Set();
  const known = new Set(packages.map((pkg) => pkg.manifest.name));
  function visit(name) {
    if (!known.has(name)) throw new Error(`Unknown build target: ${name}`);
    if (selected.has(name)) return;
    selected.add(name);
    for (const dependency of dependencies.get(name) ?? []) visit(dependency);
  }
  for (const arg of args) {
    if (!arg.startsWith('--target=')) throw new Error(`Unknown build option: ${arg}`);
    visit(arg.slice('--target='.length));
  }
  return packages.filter((pkg) => selected.has(pkg.manifest.name));
}
