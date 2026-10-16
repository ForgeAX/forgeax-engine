#!/usr/bin/env node
// lint-brand-cast.mjs — 业务代码 brand cast 蔓延对策（R7 / D-P15）
//
// 强制约束：`as Vec2|3|4 / as Mat3|4 / as Quat / as Color` 只允许出现在
// packages/math/src/ 内（工厂函数收口）；其它任何位置出现即视为绕过 brand 类型。
//
// 退出码：
//   0 — 业务代码无 brand cast，clean
//   1 — 命中越界 cast，列出文件路径供 reviewer 检查
//
// 关联：plan-strategy §3.1 R7 + D-P15；research §Finding 7.4 R7 grep lint 兜底模板；
//       wiki/typescript-branded-types §2.2 cast 收口。
//
// Cross-platform: pure Node fs walk (no system grep) — runs on Windows dev box.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { grepHits } from './brand-lint-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..'); // packages/math/scripts -> repo root

// `as Vec[234]` / `as Mat[34]` / `as Quat` / `as Color`, \b word boundary.
const PATTERN = /\bas (Vec[234]|Mat[34]|Quat|Color)\b/;

// Test files legitimately construct branded inputs via cast; the gate guards
// shipping business code only. `// brand-cast-ok` opts a line out (reinterpret
// of an existing view where a factory would force a needless alloc+copy).
const isTest = (rel) => /(^|\/)__tests__\//.test(rel) || /\.test(-d)?\.tsx?$/.test(rel);

const hits = grepHits({
  repoRoot: REPO_ROOT,
  pattern: PATTERN,
  roots: ['packages', 'apps'],
  exts: ['.ts', '.tsx', '.mts', '.cts'],
  excludeDirs: ['node_modules', 'dist'],
  // packages/math/src/ is the legal cast site (factory functions).
  excludePath: (rel) => rel.startsWith('packages/math/src/') || isTest(rel),
  skipMarker: 'brand-cast-ok',
});

if (hits.length > 0) {
  console.log("❌ brand cast lint 越界：业务代码不允许 'as Vec*/Mat*/Quat/Color'");
  for (const h of hits) console.log(h);
  process.exit(1);
}

console.log("✅ brand cast lint clean (packages/math/src/ 外无 'as Vec*/Mat*/Quat/Color')");
process.exit(0);
