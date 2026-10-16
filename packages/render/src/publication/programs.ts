import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { MaterialArtifactRegistry, ShaderRegistry } from '@forgeax/engine-shader';
import type { MaterialSnapshot } from '../render-system-extract';
import { type RenderPublication, RenderPublicationError } from './contract';
import type { PreparedRenderPublication } from './receiver';

function sameSchemaValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object')
    return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right) && left.length !== right.length) return false;
  // Schema values are plain records and numeric arrays. An unsupported legacy
  // default retains its received schema rather than losing data through JSON.
  if (
    !Array.isArray(left) &&
    (Object.getPrototypeOf(left) !== Object.prototype ||
      Object.getPrototypeOf(right) !== Object.prototype)
  )
    return false;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(
    (key) =>
      Object.hasOwn(right, key) &&
      sameSchemaValue(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
      ),
  );
}

/** Native clones lose realm-local schema admission; the selected program remains its owner. */
export function rebindPublicationMaterialSchemas(
  registry: ShaderRegistry,
  input: PreparedRenderPublication,
): PreparedRenderPublication {
  if (input.frame.renderables.length === 0) return input;
  const materials = new Map<MaterialSnapshot, MaterialSnapshot>();
  const rebind = (material: MaterialSnapshot): MaterialSnapshot => {
    const known = materials.get(material);
    if (known !== undefined) return known;
    const schema = material.materialParamSchema;
    const shader =
      material.materialShaderId === undefined
        ? undefined
        : registry.findMaterialArtifact(material.materialShaderId);
    // Full content includes defaults and author metadata. A merged schema or
    // another Pass's ABI must not be replaced merely because field types match.
    const rebound =
      schema !== undefined &&
      shader?.ok === true &&
      schema !== shader.value.paramSchema &&
      sameSchemaValue(schema, shader.value.paramSchema)
        ? { ...material, materialParamSchema: shader.value.paramSchema }
        : material;
    materials.set(material, rebound);
    return rebound;
  };
  const snapshots = new Map(
    input.frame.renderables.map((row) => [
      row,
      { ...row, material: rebind(row.material), materials: row.materials.map(rebind) },
    ]),
  );
  return {
    ...input,
    frame: { ...input.frame, renderables: [...snapshots.values()] },
    operations: input.operations.map((operation) =>
      operation.kind === 'update' && operation.snapshot !== undefined
        ? { ...operation, snapshot: snapshots.get(operation.snapshot) ?? operation.snapshot }
        : operation,
    ),
  };
}

/** Admit immutable producer artifacts before the full Renderer prepares their pipelines. */
export function installPublicationPrograms(
  assets: AssetRegistry,
  programs: RenderPublication['programs'],
): void {
  if (programs.length === 0) return;
  const validation = new MaterialArtifactRegistry();
  let shaders: ShaderRegistry | undefined;
  const keys = new Set<string>();
  for (const row of programs) {
    if (keys.has(row.key) || (row.artifact !== undefined && row.artifact.key !== row.key))
      throw new RenderPublicationError({
        reason: 'shape',
        subject: 'duplicate or mismatched program key',
      });
    keys.add(row.key);
    const previous = assets.shaderRegistry.findMaterialArtifact(row.key);
    // The installed schema and program already own their immutable derivation.
    // A Worker clone still compares all published content; its key alone is
    // not evidence. The registry also owns the complete immutable receipt.
    if (
      previous.ok &&
      (previous.value.source !== row.shader.source ||
        !sameSchemaValue(previous.value.paramSchema, row.shader.paramSchema) ||
        !sameSchemaValue(previous.value.receipt, row.shader.receipt))
    ) {
      throw new RenderPublicationError({
        reason: 'shape',
        subject: `conflicting immutable shader ${row.key}`,
      });
    }
    if (!previous.ok) {
      shaders ??= new ShaderRegistry({ manifestUrl: undefined });
      shaders.installMaterialArtifact(row.key, row.shader);
    }
    if (row.artifact !== undefined) {
      const existing = assets.getMaterialArtifact(row.key);
      if (existing !== undefined) validation.register(existing).unwrap();
      validation.register(row.artifact).unwrap();
    }
  }
  if (shaders !== undefined) assets.shaderRegistry.installMaterialArtifactsFrom(shaders);
  for (const row of programs) {
    if (row.artifact !== undefined) assets.materialArtifactRegistry.register(row.artifact).unwrap();
  }
}
