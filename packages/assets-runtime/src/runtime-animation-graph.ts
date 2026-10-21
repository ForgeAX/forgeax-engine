import {
  type AnimationGraph,
  AssetError,
  type AssetHandle,
  err,
  ok,
  type Result,
} from '@forgeax/engine-types';

/** Admit a complete graph before playback can observe either its topology or its references. */
export function prepareRuntimeAnimationGraph<E>(
  input: AnimationGraph,
  reference: (value: string | number) => Result<number, E>,
): Result<{ value: AnimationGraph; dependencies: readonly number[] }, AssetError | E> {
  const invalid = (expected: string) =>
    err(
      new AssetError({
        code: 'asset-invalid-value',
        expected,
        hint: 'supply an acyclic animation graph with valid nodes, weights and clip references',
      }),
    );
  if (!Array.isArray(input.nodes) || input.nodes.length === 0)
    return invalid('a nonempty animation graph');
  const index = (n: unknown): n is number =>
    typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < input.nodes.length;
  if (!index(input.root)) return invalid('an animation graph root in the node array');
  const nodes = [];
  const dependencies = new Set<number>();
  const edges: (readonly number[])[] = [];
  for (const node of input.nodes) {
    if (
      node === null ||
      typeof node !== 'object' ||
      !Number.isFinite(node.weight) ||
      node.weight < 0
    )
      return invalid('finite nonnegative graph node weights');
    if (node.type === 'clip') {
      if (typeof node.clip !== 'string' && typeof node.clip !== 'number')
        return invalid('a clip reference');
      const linked = reference(node.clip);
      if (!linked.ok) return linked;
      if (linked.value === 0) return invalid('a bound animation clip');
      dependencies.add(linked.value);
      nodes.push({ ...node, clip: linked.value as AssetHandle<'animation-clip'> });
      edges.push([]);
    } else {
      const children =
        node.type === 'blend'
          ? node.children
          : node.type === 'add' && Array.isArray(node.additive)
            ? [node.base, ...node.additive]
            : undefined;
      if (!Array.isArray(children) || !children.every(index))
        return invalid('valid graph node edges');
      nodes.push(node);
      edges.push(children);
    }
  }
  // Kahn's algorithm checks disconnected nodes as well as the selected root.
  const incoming = new Uint32Array(nodes.length);
  for (const children of edges)
    for (const child of children) incoming[child] = (incoming[child] ?? 0) + 1;
  const pending: number[] = [];
  for (let i = 0; i < incoming.length; i++) if (incoming[i] === 0) pending.push(i);
  let visited = 0;
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    visited++;
    for (const child of edges[node] ?? []) {
      incoming[child] = (incoming[child] ?? 0) - 1;
      if (incoming[child] === 0) pending.push(child);
    }
  }
  if (visited !== nodes.length) return invalid('an acyclic animation graph');
  return ok({ value: { ...input, nodes }, dependencies: [...dependencies] });
}
