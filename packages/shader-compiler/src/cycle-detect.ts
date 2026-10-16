// cycle-detect — DFS-based import cycle detector for the naga_oil composition
// graph (feat-20260512-naga-oil-composition-hmr M3 T-11).
//
// Why this lives in the TS layer rather than naga_oil: plan-strategy §2 D-03
// picks path A for AC-06 — the engine-side DFS runs before the wasm composer
// call so we can construct the complete cycle chain with first/last repetition
// (D-04) that AI users need for jump-to-source navigation. naga_oil on its own
// surfaces ImportNotFound for self-loops but does not hand back the full ring
// for multi-hop cycles in a shape compatible with our ShaderCircularImportDetail
// contract.
//
// Algorithm — classic tri-colour DFS (Introduction to Algorithms §22.3):
//   - white: node not yet visited
//   - gray:  node on the current DFS stack (active frame)
//   - black: node + its descendants fully explored
//
// A back edge from the current node to a gray ancestor is a cycle. The
// ancestor chain is walked back via the parent map to materialise the
// complete cycle with the first / last element repeated (D-04 form
// ['a','b','c','a']).
//
// The function iterates over every node as a DFS root so disconnected SCCs
// are both visited (fixture (e)). Missing adjacency entries default to the
// empty neighbour list so callers can pass sparse maps where only edge
// producers show up as keys.
//
// Anchors: plan-strategy §2 D-03 path A + D-04 first/last repetition;
// requirements §AC-06 (cycle non-empty, multi-hop complete); architecture
// principles #5 Fail Fast (fast structural rejection before wasm call).

type Colour = 0 | 1 | 2; // 0=white, 1=gray, 2=black

const WHITE: Colour = 0;
const GRAY: Colour = 1;
const BLACK: Colour = 2;

export function detectCycle(graph: Record<string, string[]>): string[] | null {
  const colour = new Map<string, Colour>();
  const parent = new Map<string, string | null>();

  // Enumerate the node universe: keys plus any reachable-via-edge neighbours.
  const nodes = new Set<string>();
  for (const [k, neighbours] of Object.entries(graph)) {
    nodes.add(k);
    for (const n of neighbours) {
      nodes.add(n);
    }
  }

  for (const node of nodes) {
    if (!colour.has(node)) {
      colour.set(node, WHITE);
      parent.set(node, null);
    }
  }

  for (const root of nodes) {
    if (colour.get(root) !== WHITE) continue;
    const cycle = dfs(root, graph, colour, parent);
    if (cycle !== null) return cycle;
  }
  return null;
}

function dfs(
  root: string,
  graph: Record<string, string[]>,
  colour: Map<string, Colour>,
  parent: Map<string, string | null>,
): string[] | null {
  // Iterative DFS using an explicit stack of (node, neighbourIndex) frames so
  // deep graphs do not blow the JS call stack (Bevy shader libs can nest).
  const stack: Array<{ node: string; idx: number }> = [];
  colour.set(root, GRAY);
  stack.push({ node: root, idx: 0 });

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    // Non-null assertion is safe — we just checked length > 0.
    if (!frame) break;
    const neighbours = graph[frame.node] ?? [];
    if (frame.idx >= neighbours.length) {
      // All neighbours explored — blacken and pop.
      colour.set(frame.node, BLACK);
      stack.pop();
      continue;
    }
    const next = neighbours[frame.idx];
    frame.idx += 1;
    if (next === undefined) continue;
    const nextColour = colour.get(next) ?? WHITE;
    if (nextColour === WHITE) {
      colour.set(next, GRAY);
      parent.set(next, frame.node);
      stack.push({ node: next, idx: 0 });
    } else if (nextColour === GRAY) {
      // Back edge — cycle found. Reconstruct the chain using the parent map
      // from frame.node up to `next`, then append `next` at both ends.
      return reconstructCycle(frame.node, next, parent);
    }
    // BLACK: cross edge — no cycle via this path, keep going.
  }
  return null;
}

function reconstructCycle(
  tailNode: string,
  cycleStart: string,
  parent: Map<string, string | null>,
): string[] {
  // Self-loop: tailNode === cycleStart and the back edge closed on itself.
  if (tailNode === cycleStart) {
    return [cycleStart, cycleStart];
  }
  const chain: string[] = [cycleStart];
  let cursor: string | null = tailNode;
  const path: string[] = [];
  while (cursor !== null && cursor !== cycleStart) {
    path.push(cursor);
    cursor = parent.get(cursor) ?? null;
  }
  // Path currently reads tailNode -> ... -> child(cycleStart).
  // Desired shape: [cycleStart, ..., tailNode, cycleStart] (D-04 first/last
  // repetition with forward-chronological order).
  path.reverse();
  chain.push(...path);
  chain.push(cycleStart);
  return chain;
}
