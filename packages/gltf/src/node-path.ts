export interface NamedNode {
  readonly name?: string;
  readonly children?: readonly number[];
}

export function buildNodeParentMap(nodes: readonly NamedNode[]): ReadonlyMap<number, number> {
  const parents = new Map<number, number>();
  for (let index = 0; index < nodes.length; index++) {
    for (const child of nodes[index]?.children ?? []) parents.set(child, index);
  }
  return parents;
}

export function resolveNamedNodePath(
  nodes: readonly NamedNode[],
  parents: ReadonlyMap<number, number>,
  nodeIndex: number,
):
  | { readonly ok: true; readonly value: readonly string[] }
  | {
      readonly ok: false;
      readonly reason: 'name-missing' | 'hierarchy-cycle';
      readonly nodeIndex: number;
    } {
  const reversed: string[] = [];
  const visited = new Set<number>();
  let current: number | undefined = nodeIndex;
  while (current !== undefined) {
    if (visited.has(current)) {
      return { ok: false, reason: 'hierarchy-cycle', nodeIndex: current };
    }
    visited.add(current);
    const name = nodes[current]?.name;
    if (name === undefined || name.length === 0) {
      return { ok: false, reason: 'name-missing', nodeIndex: current };
    }
    reversed.push(name);
    current = parents.get(current);
  }
  return { ok: true, value: reversed.reverse() };
}
