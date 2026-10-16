import { err, type FbxError, fbxErr, ok, type Result } from '../errors.js';

export interface FbxLodGroupInput {
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

export interface FbxLodGroupPod {
  readonly childMeshIndices: readonly number[];
  readonly nativeThreshold?: number;
  readonly nativeMode?: string;
  readonly nativeDistances?: readonly number[];
  readonly nativeDisplays?: readonly string[];
  readonly relativeDistances?: boolean;
  readonly displayMode?: string;
}

/** Project one native FbxLODGroup without inventing distance semantics. */
export function parseFbxLodGroup(
  input: FbxLodGroupInput,
): Result<
  FbxLodGroupPod,
  Extract<FbxError, { readonly code: 'fbx-lod-display-mode-unsupported' }>
> {
  if (input.displayMode === 'eShow' || input.displayMode === 'eHide') {
    return err(fbxErr('fbx-lod-display-mode-unsupported', { displayMode: input.displayMode }));
  }
  const children = input.children ?? [];
  const forcedDisplay = children.find(
    (child) => child.display === 'show' || child.display === 'hide',
  )?.display;
  if (forcedDisplay !== undefined) {
    return err(
      fbxErr('fbx-lod-display-mode-unsupported', {
        displayMode: forcedDisplay === 'show' ? 'eShow' : 'eHide',
      }),
    );
  }
  const childMeshIndices: number[] = [];
  for (const child of children) {
    if (!Number.isInteger(child.meshIndex) || (child.meshIndex as number) < 0) {
      return err(fbxErr('fbx-lod-display-mode-unsupported', { displayMode: 'eShow' }));
    }
    childMeshIndices.push(child.meshIndex as number);
  }
  if (childMeshIndices.length === 0) {
    return err(fbxErr('fbx-lod-display-mode-unsupported', { displayMode: 'eShow' }));
  }
  const value: FbxLodGroupPod = { childMeshIndices };
  const nativeDistances = children.flatMap((child) =>
    typeof child.distance === 'number' && Number.isFinite(child.distance) ? [child.distance] : [],
  );
  const nativeDisplays = children.flatMap((child) =>
    typeof child.display === 'string' ? [child.display] : [],
  );
  return ok({
    ...value,
    ...(typeof input.threshold === 'number' && Number.isFinite(input.threshold)
      ? { nativeThreshold: input.threshold }
      : {}),
    ...(typeof input.mode === 'string' ? { nativeMode: input.mode } : {}),
    ...(nativeDistances.length === children.length ? { nativeDistances } : {}),
    ...(nativeDisplays.length === children.length ? { nativeDisplays } : {}),
    ...(typeof input.relative === 'boolean' ? { relativeDistances: input.relative } : {}),
    ...(typeof input.displayMode === 'string' ? { displayMode: input.displayMode } : {}),
  });
}
