import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  type CloudParameter,
  type CloudParameterValue,
  cloudMaterialInstanceKind,
  cloudMaterialKind,
  type MediumSample,
  resolveCloudParameters,
} from '@forgeax/engine-render/authoring';
import type { EngineWorkspaceAssetBinding } from './workspace';

export interface WorkspaceCloudMaterialInspection {
  readonly publication?: EngineWorkspaceAssetBinding['publication'];
  readonly meta: {
    readonly kind: 'cloud-material' | 'cloud-material-instance';
    readonly model: 'uniform' | 'program';
    readonly material?: { readonly guid: string; readonly kind: 'cloud-material' };
    readonly sample?: MediumSample;
    readonly cookIdentity: string;
    readonly densityKernelIdentity?: string;
    readonly variants: readonly {
      readonly programIdentity: string;
      readonly programDigest: string;
      readonly compilerIdentity: string;
      readonly staticValues: Readonly<Record<string, boolean>>;
      /** The Registry-resolved static choice, not a rendered-frame observation. */
      readonly selected: boolean;
      readonly renderer?: { readonly programDigest: string };
    }[];
    readonly declaredDependencies: readonly {
      readonly guid: string;
      readonly kind: 'cloud-material' | 'texture';
      readonly declaredBy: 'material' | 'instance';
    }[];
    readonly dependenciesTruncated: boolean;
    readonly parameters: {
      name: string;
      definition: CloudParameter;
      value: CloudParameterValue;
      overridden: boolean;
    }[];
    readonly truncated: boolean;
  };
}

/** Read the decoder-verified closure through the same Registry as ordinary asset inspection. */
export async function inspectWorkspaceCloudMaterial(
  assets: AssetRegistry,
  guid: string,
  kind: 'cloud-material' | 'cloud-material-instance',
  signal?: AbortSignal,
): Promise<WorkspaceCloudMaterialInspection> {
  const options = signal === undefined ? {} : { signal };
  const instanceHandle =
    kind === 'cloud-material-instance'
      ? (await assets.load(guid, cloudMaterialInstanceKind, options)).unwrap()
      : undefined;
  try {
    const instance = instanceHandle ? assets.read(instanceHandle).unwrap() : undefined;
    const handle = (
      await assets.load(instance?.material ?? guid, cloudMaterialKind, options)
    ).unwrap();
    try {
      signal?.throwIfAborted();
      const material = assets.read(handle).unwrap();
      const values = resolveCloudParameters(material.parameters, instance?.overrides ?? {}, {
        guid,
        source: 'workspace inspection',
      }).unwrap();
      const source = assets.source(instanceHandle ?? handle).unwrap();
      const entries = Object.entries(material.parameters);
      const dependencies: WorkspaceCloudMaterialInspection['meta']['declaredDependencies'][number][] =
        [];
      if (instance)
        dependencies.push({
          guid: instance.material,
          kind: 'cloud-material',
          declaredBy: 'instance',
        });
      for (const [name, parameter] of entries) {
        if (parameter.kind !== 'texture') continue;
        dependencies.push({ guid: parameter.default, kind: 'texture', declaredBy: 'material' });
        if (Object.hasOwn(instance?.overrides ?? {}, name)) {
          dependencies.push({
            guid: String(values[name]),
            kind: 'texture',
            declaredBy: 'instance',
          });
        }
      }
      const declaredDependencies = [
        ...new Map(
          dependencies.map((dependency) => [
            `${dependency.declaredBy}:${dependency.kind}:${dependency.guid}`,
            dependency,
          ]),
        ).values(),
      ].sort(
        (left, right) =>
          left.declaredBy.localeCompare(right.declaredBy) ||
          left.kind.localeCompare(right.kind) ||
          left.guid.localeCompare(right.guid),
      );
      return {
        ...(source?.publication ? { publication: structuredClone(source.publication) } : {}),
        meta: {
          kind,
          model: material.model,
          ...(instance ? { material: { guid: instance.material, kind: 'cloud-material' } } : {}),
          ...(material.sample ? { sample: structuredClone(material.sample) } : {}),
          cookIdentity: material.cookIdentity,
          ...(material.densityKernelIdentity === undefined
            ? {}
            : { densityKernelIdentity: material.densityKernelIdentity }),
          variants: material.variants.map((variant) => ({
            programIdentity: variant.programIdentity,
            programDigest: variant.programDigest,
            compilerIdentity: variant.compilerIdentity,
            staticValues: structuredClone(variant.staticValues),
            selected: Object.entries(variant.staticValues).every(
              ([name, value]) => values[name] === value,
            ),
            ...(variant.renderer === undefined
              ? {}
              : { renderer: { programDigest: variant.renderer.programDigest } }),
          })),
          declaredDependencies: declaredDependencies.slice(0, 512),
          dependenciesTruncated: declaredDependencies.length > 512,
          parameters: entries.slice(0, 256).map(([name, definition]) => {
            const value = values[name];
            if (value === undefined) throw new Error(`Missing resolved cloud parameter: ${name}`);
            return {
              name,
              definition: structuredClone(definition),
              value: structuredClone(value),
              overridden: Object.hasOwn(instance?.overrides ?? {}, name),
            };
          }),
          truncated: entries.length > 256,
        },
      };
    } finally {
      assets.release(handle);
    }
  } finally {
    if (instanceHandle) assets.release(instanceHandle);
  }
}
