/** Ordered axis identities shared by constraint math and retained presentation. */
export const GIZMO_AXES = [
  { handle: 'X', direction: [1, 0, 0] },
  { handle: 'Y', direction: [0, 1, 0] },
  { handle: 'Z', direction: [0, 0, 1] },
] as const;

export const GIZMO_PLANES = [
  { handle: 'XY', axes: [0, 1], normalAxis: 2 },
  { handle: 'YZ', axes: [1, 2], normalAxis: 0 },
  { handle: 'XZ', axes: [0, 2], normalAxis: 1 },
] as const;

/** Plane handle edges in units of the displayed gizmo radius. */
export const GIZMO_PLANE_MIN = 0.22;
export const GIZMO_PLANE_MAX = 0.46;

export type GizmoHandle =
  | (typeof GIZMO_AXES)[number]['handle']
  | (typeof GIZMO_PLANES)[number]['handle']
  | 'XYZ';
