// Shared configuration of the baseline harness: tools, cases and matched settings.

export type Tool = 'im' | 'qf' | 'qw';
export const TOOLS: readonly Tool[] = ['im', 'qf', 'qw'];

export const TOOL_NAMES: Readonly<Record<Tool, string>> = {
  im: 'Instant Meshes',
  qf: 'QuadriFlow',
  qw: 'QuadWild',
};

/** Sharp-feature threshold handed to every tool that accepts one; equals the evaluator's SHARP_DIHEDRAL_DEG. */
export const SHARP_DEG = 30;

export interface BaselineCase {
  readonly id: string;
  /** Requested output face count. Each tool's actual count is reported next to it. */
  readonly targetFaces: number;
}

/** L4 ready cases that are real surfaces (the broken-quad and the grid-cube duplicates of the box are not inputs). */
export const BASELINE_CASES: readonly BaselineCase[] = [
  { id: 'brep-box-quad', targetFaces: 600 },
  { id: 'brep-sphere-quad', targetFaces: 600 },
  { id: 'brep-torus', targetFaces: 800 },
  { id: 'brep-cylinder-sharp', targetFaces: 800 },
  { id: 'lumpy-sphere-tri', targetFaces: 800 },
  { id: 'f1-fandisk', targetFaces: 1000 },
  { id: 'f2-pipe-tee', targetFaces: 3000 },
  { id: 'f3-twisted-bracket', targetFaces: 1000 },
];
