import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PackageId } from './guid.js';
import {
  normalizeParameterValue,
  type PackParameterDefinition,
  parsePackSourceJson,
} from './pack-authoring.js';
import { packSourceFailure, readPackAuthoringDeclaration } from './pack-authoring-literals.js';
import { listPackSources } from './pack-source-index.js';

/** The new static editor resolves the existing parent chain without importing its modules. */
export async function readPackAuthoringParent(
  root: string,
  parent: string,
  sourceRoots?: readonly string[],
): Promise<{
  readonly parameters: readonly PackParameterDefinition[];
  readonly sourcePath: string;
  readonly source: string;
  readonly paths: readonly string[];
}> {
  const inventory = await listPackSources(root, 200, sourceRoots);
  if (inventory.hasMore)
    throw packSourceFailure(
      parent,
      'static parent inventory is incomplete; use the existing instance authoring entry',
    );
  const sources = new Map<string, { sourcePath: string; source: string }>();
  for (const item of inventory.sources) {
    const source = await readFile(resolve(root, item.sourcePath), 'utf8');
    let packageId = item.packageId;
    if (item.format === 'pack.ts') {
      const declaration = readPackAuthoringDeclaration(item.sourcePath, source);
      if (declaration.ok) packageId = declaration.value.packageId;
    }
    if (!packageId) continue;
    if (sources.has(packageId))
      throw packSourceFailure(item.sourcePath, 'duplicate parent package identity');
    sources.set(packageId, { sourcePath: item.sourcePath, source });
  }
  const seen = new Set<string>();
  const paths: string[] = [];
  const visit = (
    id: string,
  ): { parameters: readonly PackParameterDefinition[]; sourcePath: string; source: string } => {
    if (seen.has(id)) throw packSourceFailure(id, 'cyclic Pack parent chain');
    seen.add(id);
    const source = sources.get(id);
    if (!source) throw packSourceFailure(id, 'parent has no static authoring declaration');
    paths.push(source.sourcePath);
    if (source.sourcePath.endsWith('.pack.ts')) {
      const declaration = readPackAuthoringDeclaration(source.sourcePath, source.source).unwrap();
      if (!declaration.parameters.length)
        throw packSourceFailure(source.sourcePath, 'parent has no parameters');
      return { ...source, parameters: declaration.parameters };
    }
    const parsed = parsePackSourceJson(JSON.parse(source.source)).unwrap();
    if (parsed.format !== 'instance')
      throw packSourceFailure(source.sourcePath, 'direct Pack cannot be an instance parent');
    const inherited = visit(PackageId.format(parsed.parent));
    const parameters = inherited.parameters.map((parameter) => ({
      ...parameter,
      default: normalizeParameterValue(
        parameter,
        parsed.values[parameter.name] ?? parameter.default,
        parameter.name,
      ).unwrap(),
    }));
    for (const name of Object.keys(parsed.values))
      if (!parameters.some((parameter) => parameter.name === name))
        throw packSourceFailure(source.sourcePath, `unknown instance parameter ${name}`);
    return { ...inherited, parameters };
  };
  return { ...visit(parent), paths };
}
