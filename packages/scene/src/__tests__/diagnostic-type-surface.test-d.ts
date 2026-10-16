import type * as SceneSurface from '../index';

type DiagnosticSurface = Pick<SceneSurface.SceneHierarchyDiagnostic, 'code' | 'detail'>;
const diagnosticSurface: DiagnosticSurface | undefined = undefined;
void diagnosticSurface;

// These names were duplicate projections of the SceneError code/detail owners.
// @ts-expect-error hierarchy diagnostics use SceneErrorCode directly.
export type RemovedDiagnosticCode = SceneSurface['SceneHierarchyDiagnosticCode'];
// @ts-expect-error hierarchy diagnostics use SceneErrorDetail directly.
export type RemovedDiagnosticDetail = SceneSurface['SceneHierarchyDiagnosticDetail'];
