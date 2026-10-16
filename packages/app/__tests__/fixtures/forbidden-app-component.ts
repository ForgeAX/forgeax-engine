// AC-12 grep gate fixture -- counter-example designed to trip every
// banned shape in scripts/check-app-package-no-component.mjs.
//
// This file lives outside packages/app/src/ on purpose: the gate's
// default scan walks `packages/app/src/**`, and the fixture is fed
// to the script via explicit path arguments (verifier flow). If the
// fixture leaked into src/, it would itself fail CI -- a deliberate
// safeguard.
//
// Layout:
//   - Path (a) shapes: every syntactic export ban (a1..a9) emitted
//     as a standalone line inside a multi-line template string. The
//     regex bans use `^\s*export\s+...` with the multi-line flag, so
//     the offending lines need only start at column 0 inside a
//     line; embedding them inside a string keeps the file itself
//     parseable TS.
//   - Path (b) shape: a single `defineComponent({ name: 'App', ... })`
//     call (with a local placeholder defineComponent helper) to
//     trip the ECS registration ban (b1).
//
// Verifier usage:
//   node scripts/check-app-package-no-component.mjs \
//     packages/app/__tests__/fixtures/forbidden-app-component.ts
//   -> exits 1 with the full hit list (a1..a9 + b1).

// Path (a) -- syntactic export bans, one per line at column 0.
// Type-level patterns (`export interface App` / `export type App = ...`)
// are deliberately NOT in the ban list (the canonical `App` handle is a
// type-level interface in `packages/app/src/types.ts`); the fixture
// therefore exercises only the value-level shapes the gate enforces.
// biome-ignore lint/correctness/noUnusedVariables: fixture
const _path_a_fixture = `
export const App = 1
export class App {}
export function App() {}
export default class App {}
export default function App() {}
export { App, foo, bar }
export { foo as App }
`;

// Path (b) -- ECS registration literal ban.
//
// The gate matches the literal `defineComponent(` ahead of `name: 'App'`
// via a 200-char window scan, so this call trips b1.
function defineComponent(_args: { name: string }): unknown {
  return _args;
}
const _b1_dummy = defineComponent({
  name: 'App',
});
void _b1_dummy;
