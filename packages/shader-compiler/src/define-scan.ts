// define-scan — TS-layer `#define NAME` conflict pre-scan for the naga_oil
// composition graph (feat-20260512-naga-oil-composition-hmr M3 T-12).
//
// Why the TS layer owns this check rather than naga_oil: research R-07
// flagged naga_oil's internal HashMap silently overwrites the same
// `#define NAME` value from a later module. AI users need an explicit
// structured error (plan-strategy D-07) rather than a silent last-write-wins
// semantics. This scanner runs before compose_shader so conflicts surface as
// `shader-define-conflict` via the T-13 error-mapper pathway (plan-strategy
// D-07 + §5 Fail Fast).
//
// Form:
// - Input: `{ [moduleId]: wgslSource }` map spanning the entry module plus
//   every companion module in `options.imports`.
// - Output: array of `{ defineName, sites }` conflict records. Empty array =
//   no conflicts (happy path).
// - Multi-declaration within the same module is benign (idempotent) and is
//   NOT reported — we count DISTINCT moduleIds per defineName.
//
// Regex: `^\s*#define\s+(\w+)` per line. Intentionally ignores the value
// portion — non-boolean values are a separate concern handled by T-14's
// define-value reject pathway (plan-strategy D-05).
//
// Anchors: plan-strategy §2 D-07 (TS-layer pre-scan, not naga_oil side);
// requirements §AC-07 (sites.length === 2 happy fixture); research R-07
// (naga_oil HashMap silent override); architecture principles #5 Fail Fast.

import type { ShaderDefineConflictDetail } from '@forgeax/engine-types';

const DEFINE_RE = /^\s*#define\s+(\w+)/;

export function scanDefineConflicts(modules: Record<string, string>): ShaderDefineConflictDetail[] {
  // Per-define aggregate: set of moduleIds that declared it.
  const perDefine = new Map<string, Set<string>>();

  for (const [moduleId, source] of Object.entries(modules)) {
    for (const line of source.split(/\r?\n/)) {
      const match = DEFINE_RE.exec(line);
      if (!match) continue;
      const name = match[1];
      if (name === undefined) continue;
      let sites = perDefine.get(name);
      if (!sites) {
        sites = new Set<string>();
        perDefine.set(name, sites);
      }
      sites.add(moduleId);
    }
  }

  const conflicts: ShaderDefineConflictDetail[] = [];
  for (const [defineName, sites] of perDefine) {
    if (sites.size < 2) continue;
    conflicts.push({
      code: 'shader-define-conflict',
      defineName,
      sites: [...sites].map((moduleId) => ({ moduleId })),
    });
  }
  return conflicts;
}
