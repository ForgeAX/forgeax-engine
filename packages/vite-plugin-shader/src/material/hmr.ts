export class MaterialHmrGraph {
  private readonly reverseDeps = new Map<string, Set<string>>();

  replace(importer: string, dependencies: readonly string[]): void {
    for (const [dependency, importers] of this.reverseDeps) {
      importers.delete(importer);
      if (importers.size === 0) this.reverseDeps.delete(dependency);
    }
    this.record(importer, dependencies);
  }

  record(importer: string, dependencies: readonly string[]): void {
    for (const dependency of dependencies) {
      let importers = this.reverseDeps.get(dependency);
      if (importers === undefined) {
        importers = new Set<string>();
        this.reverseDeps.set(dependency, importers);
      }
      importers.add(importer);
    }
  }

  collect(seed: string): string[] {
    const visited = new Set<string>();
    const importers: string[] = [];
    const pending = [seed];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) break;
      for (const importer of this.reverseDeps.get(current) ?? []) {
        if (visited.has(importer)) continue;
        visited.add(importer);
        importers.push(importer);
        pending.push(importer);
      }
    }
    return importers;
  }
}
