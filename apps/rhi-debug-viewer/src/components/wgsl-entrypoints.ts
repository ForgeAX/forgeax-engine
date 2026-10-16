// wgsl-entrypoints.ts — list the entry-point functions declared in a WGSL module.
//
// A shader module can bundle several entry points (e.g. a forward `fs_main` and a
// deferred `fs_gbuffer`). The Pipeline panel shows the whole module source, so it
// annotates which entry the selected draw actually runs — otherwise the unused
// gbuffer entry reads as if this draw output a gbuffer.

export type WgslStage = 'vertex' | 'fragment' | 'compute';

export interface WgslEntryPoint {
  readonly stage: WgslStage;
  readonly name: string;
}

// @stage [ ...other attributes... ] fn name — attributes (e.g. @workgroup_size(8))
// may sit between the stage attribute and `fn`, and newlines may separate them.
const ENTRY_RE = /@(vertex|fragment|compute)\b[\s\S]*?\bfn\s+([A-Za-z_]\w*)/g;

/**
 * Extract the entry-point functions ({stage, name}) declared in WGSL source, in
 * source order. Best-effort textual scan (not a full parser): matches the stage
 * attribute followed by the next `fn <name>`, tolerating intervening attributes
 * and whitespace.
 */
export function findWgslEntryPoints(wgsl: string): WgslEntryPoint[] {
  const out: WgslEntryPoint[] = [];
  ENTRY_RE.lastIndex = 0;
  let m: RegExpExecArray | null = ENTRY_RE.exec(wgsl);
  while (m !== null) {
    out.push({ stage: m[1] as WgslStage, name: m[2] as string });
    m = ENTRY_RE.exec(wgsl);
  }
  return out;
}
