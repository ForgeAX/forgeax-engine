#!/usr/bin/env node
// lint-brand-runtime.mjs — V8 五铁律 brand 赋值兜底（AC-15 / R1）
//
// 强制约束：brand 字段是纯类型层 phantom，运行时绝不可被赋值。
// 任何 `obj.__vec3 = ...` / `obj.__mat4 = ...` / `obj.__quat = ...` /
// `obj.__color = ...` 都会破坏 V8 elements-kinds 单态化（TypedArray 转 dictionary
// 模式 → 慢 100x）。
//
// 退出码：
//   0 — 全包无 brand 赋值，clean
//   1 — 命中赋值，列出文件供 reviewer 检查
//
// 关联：requirements §AC-15 V8 elements-kinds 五铁律；
//       plan-strategy §3.1 R1 brand 与 V8 兼容性对策；
//       research §Finding 7.4 grep lint；wiki/typescript-branded-types §4.2 反例。
//
// Cross-platform: pure Node fs walk (no system grep) — runs on Windows dev box.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { grepHits } from './brand-lint-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..'); // packages/math/scripts -> repo root

// 匹配赋值语义：.__vec[234] / .__mat[34] / .__quat / .__color 后接可选空格 + '='，
// 且 '=' 之后不是 '='（排除 '==' / '===' 比较与纯类型注释）。
const PATTERN = /\.__(vec[234]|mat[34]|quat|color)\s*=[^=]/;

const hits = grepHits({
  repoRoot: REPO_ROOT,
  pattern: PATTERN,
  roots: ['packages', 'apps'],
  exts: ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs'],
  excludeDirs: ['node_modules', 'dist'],
  // The gate scripts themselves document the forbidden pattern in comments.
  excludePath: (rel) => rel.startsWith('packages/math/scripts/'),
});

if (hits.length > 0) {
  console.log('❌ brand 运行时赋值越界：__vec*/__mat*/__quat/__color 不可赋值（V8 五铁律）');
  for (const h of hits) console.log(h);
  process.exit(1);
}

console.log('✅ brand runtime lint clean (无 .__vec*/__mat*/__quat/__color 赋值)');
process.exit(0);
