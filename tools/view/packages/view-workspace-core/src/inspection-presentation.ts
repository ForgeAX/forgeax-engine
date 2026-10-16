import type { WorkspaceAsset, WorkspaceInspection } from './contract.ts';
type InspectionRow = { label: string; value: string };

function displayInspectionValue(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function addInspectionRow(rows: InspectionRow[], label: string, value: unknown) {
  const displayed = displayInspectionValue(value);
  if (displayed === undefined) return;
  rows.push(Object.freeze({ label, value: displayed }));
}

/** Identity rows for a serialized inspection. Kind-specific facts use meta projections. */
export function workspaceInspectionFactRows(inspection: WorkspaceInspection | null | undefined) {
  if (!inspection || typeof inspection !== 'object' || Array.isArray(inspection)) {
    return Object.freeze([]);
  }
  const asset: Partial<WorkspaceAsset> = inspection.asset && typeof inspection.asset === 'object' ? inspection.asset : {};
  const rows: InspectionRow[] = [];
  addInspectionRow(rows, 'GUID', inspection.guid ?? asset.guid);
  addInspectionRow(rows, 'Kind', asset.kind);
  addInspectionRow(rows, 'Name', asset.name);
  addInspectionRow(rows, 'Path', asset.path);
  addInspectionRow(rows, 'Source', inspection.source?.path ?? asset.sourcePath);
  addInspectionRow(rows, 'Revision', inspection.revision ?? asset.revision ?? inspection.source?.revision);
  addInspectionRow(rows, 'Package', asset.packageId ?? asset.packageUrl);
  if (inspection.ddc?.state) addInspectionRow(rows, 'DDC', inspection.ddc.state);
  return Object.freeze(rows);
}

export function workspaceInspectionMetaRows(inspection: WorkspaceInspection | null | undefined, keys: readonly string[] | undefined) {
  const meta = inspection?.meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return Object.freeze([]);
  const rows: InspectionRow[] = [];
  for (const key of keys ?? []) {
    addInspectionRow(rows, key, meta[key]);
  }
  return Object.freeze(rows);
}

export function unwrapWorkspaceInspection(result: unknown): WorkspaceInspection | null {
  if (!result || typeof result !== 'object') return null;
  const payload = 'inspection' in result && result.inspection !== undefined ? result.inspection : result;
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as WorkspaceInspection : null;
}
