// parse-scene.ts — FBX JSON POD to ScenePod bridge (t29).

import type { SceneEntityPod, ScenePod } from '@forgeax/engine-types';

export interface FbxRawNode {
  readonly name: string;
  readonly transform: {
    readonly translation: [number, number, number];
    readonly rotation: [number, number, number, number];
    readonly scale: [number, number, number];
  };
  readonly meshIndex: number;
  readonly children: readonly number[];
}

export interface FbxRawNodes {
  readonly nodes?: readonly FbxRawNode[];
  readonly lodGroups?: readonly FbxRawLodGroup[];
}

export interface FbxRawLodGroup {
  readonly children?: readonly {
    readonly meshIndex?: unknown;
    readonly distance?: unknown;
    readonly display?: unknown;
  }[];
  readonly threshold?: unknown;
  readonly mode?: unknown;
  readonly relative?: unknown;
  readonly displayMode?: unknown;
}

export type FbxNodePathResult =
  | { readonly ok: true; readonly value: readonly string[] }
  | {
      readonly ok: false;
      readonly reason: 'name-missing' | 'path-invalid' | 'hierarchy-cycle';
      readonly nodeIndex: number;
    };

export function buildFbxNodePaths(
  nodes: readonly { readonly name?: string; readonly children?: readonly number[] }[],
): readonly FbxNodePathResult[] {
  const parents = new Map<number, number>();
  for (let index = 0; index < nodes.length; index++) {
    for (const child of nodes[index]?.children ?? []) parents.set(child, index);
  }
  return nodes.map((_, index) => {
    const reversed: string[] = [];
    const visited = new Set<number>();
    let current: number | undefined = index;
    while (current !== undefined) {
      if (visited.has(current)) {
        return { ok: false, reason: 'hierarchy-cycle', nodeIndex: current };
      }
      visited.add(current);
      const name = nodes[current]?.name;
      if (name === undefined || name.length === 0) {
        return { ok: false, reason: 'name-missing', nodeIndex: current };
      }
      if (name.includes('/')) {
        return { ok: false, reason: 'path-invalid', nodeIndex: current };
      }
      reversed.push(name);
      current = parents.get(current);
    }
    return { ok: true, value: reversed.reverse() };
  });
}

export function parseScene(rawNodes: FbxRawNodes): ScenePod {
  const nodes = rawNodes.nodes ?? [];
  const entities: SceneEntityPod[] = nodes.map((n) => ({
    name: n.name,
    transform: {
      translation: n.transform.translation,
      rotation: n.transform.rotation,
      scale: n.transform.scale,
    },
    meshIndex: n.meshIndex >= 0 ? n.meshIndex : null,
    children: n.children,
  }));

  return {
    entities,
    rootEntityIndex: 0,
  };
}
