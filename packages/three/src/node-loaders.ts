import UpstreamNodeLoader from 'three/src/loaders/nodes/NodeLoader.js';
import UpstreamNodeMaterialLoader from 'three/src/loaders/nodes/NodeMaterialLoader.js';
import UpstreamNodeObjectLoader from 'three/src/loaders/nodes/NodeObjectLoader.js';
import type Node from 'three/src/nodes/core/Node.js';
import type { NodeJSONIntermediateOutputData } from 'three/src/nodes/core/Node.js';
import type { LoadingManager, Material, Texture } from 'three/src/Three.Core.js';

import type {
  NodeLoaderContract,
  NodeMaterialLoaderContract,
  NodeObjectLoaderContract,
} from './node-loader-types';

// Preserve the source implementations; only the inherited registry declaration changes.
const NodeLoaderSource = UpstreamNodeLoader as unknown as {
  new (manager?: LoadingManager): NodeLoaderContract;
};
const NodeMaterialLoaderSource = UpstreamNodeMaterialLoader as unknown as {
  new (manager?: LoadingManager): NodeMaterialLoaderContract;
};
const NodeObjectLoaderSource = UpstreamNodeObjectLoader as unknown as {
  new (manager?: LoadingManager): NodeObjectLoaderContract;
};

type SerializedNode = NodeJSONIntermediateOutputData & { type: string };

/** JSON encodes the Physical default Infinity as null; the source parser retains null. */
function materialJson(input: unknown): unknown {
  const json = input as Record<string, unknown>;
  return json.type === 'MeshPhysicalNodeMaterial' && json.attenuationDistance === null
    ? { ...json, attenuationDistance: Infinity }
    : input;
}
export class NodeMaterialLoader extends NodeMaterialLoaderSource {
  override parse(json: unknown): Material {
    return super.parse(materialJson(json));
  }
}

/** r187 Node.uuid is getter-only; restore its existing backing field during hydration. */
export class NodeLoader extends NodeLoaderSource {
  private restoreIdentity(json: SerializedNode): Node {
    const node = this.createNodeFromType(json.type);
    Reflect.set(node, '_uuid', json.uuid);
    return node;
  }

  private hydrate(node: Node, json: SerializedNode, nodes: Record<string, Node>): void {
    node.deserialize({ ...json, meta: { nodes, textures: this.textures } });
  }

  override parseNodes(input: unknown): Record<string, Node> {
    const nodes: Record<string, Node> = {};
    if (input === undefined) return nodes;
    const json = input as SerializedNode[];
    for (const entry of json) nodes[entry.uuid] = this.restoreIdentity(entry);
    for (const entry of json) {
      const node = nodes[entry.uuid];
      if (node !== undefined) this.hydrate(node, entry, nodes);
    }
    return nodes;
  }

  override parse(input: unknown): Node {
    const json = input as SerializedNode;
    const node = this.restoreIdentity(json);
    this.hydrate(node, json, this.parseNodes(json.nodes));
    return node;
  }
}

/** ObjectLoader still owns scene, geometry, texture and material hydration. */
export class NodeObjectLoader extends NodeObjectLoaderSource {
  override parseMaterials(
    json: unknown,
    textures: Record<string, Texture>,
  ): Record<string, Material> {
    const input = json === undefined ? undefined : (json as unknown[]).map(materialJson);
    return super.parseMaterials(input, textures);
  }

  override parseNodes(json: unknown, textures: Record<string, Texture>): Record<string, Node> {
    return new NodeLoader(this.manager).setNodes(this.nodes).setTextures(textures).parseNodes(json);
  }
}
