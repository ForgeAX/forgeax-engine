import { stripWgslComments } from '@forgeax/engine-types';

/**
 * Project the boolean conditional surface that naga_oil resolves too late for
 * imported modules. Known `#ifdef`/`#ifndef` branches and the engine's simple
 * `#if NAME == true|false` expressions are folded; unknown `#if` expressions
 * remain intact for naga_oil. Explicit author axes or `all` also remove active
 * boolean directives. The stack tracks every conditional kind so a
 * nested numeric `#if` cannot steal an outer `#ifdef`'s `#else`.
 */

/** Return only real preprocessor directive lines, with comments removed. */
export function shaderDirectiveLines(source: string): string[] {
  return stripWgslComments(source)
    .split(/\r?\n/)
    .filter((line) => /^\s*#/.test(line));
}

interface ConditionalFrame {
  disabled: boolean;
  seenElse: boolean;
  removed: boolean;
  opaque: boolean;
}

type FlattenedAxes = readonly string[] | 'all';

interface ConditionalProjection {
  readonly defines: Readonly<Record<string, boolean>>;
  readonly flattenTrueAxes: FlattenedAxes;
  readonly stack: ConditionalFrame[];
  readonly output: string[];
}

function isFlattenedAxis(axis: string, axes: FlattenedAxes): boolean {
  return axes === 'all' || axes.includes(axis);
}

function hasDisabledParent(stack: readonly ConditionalFrame[]): boolean {
  return stack.some((frame) => frame.disabled);
}

function knownIfCondition(
  line: string,
  defines: Readonly<Record<string, boolean>>,
  flattenTrueAxes: FlattenedAxes,
): { readonly name: string; readonly enabled: boolean } | undefined {
  const match = /^\s*#if\s+(!?)(\w+)(?:\s*==\s*(true|false))?\s*$/.exec(line);
  if (match === null || (match[1] === '!' && match[3] !== undefined)) return undefined;
  const name = match[2] ?? '';
  const actual = defines[name];
  // Bare/negated boolean axes belong to complete specialization or explicitly
  // flattened author axes. Other expressions remain naga_oil's responsibility.
  if (match[3] === undefined && !isFlattenedAxis(name, flattenTrueAxes)) return undefined;
  if (actual === undefined && flattenTrueAxes !== 'all' && !isFlattenedAxis(name, flattenTrueAxes))
    return undefined;
  const expected = match[3] === undefined ? match[1] !== '!' : match[3] === 'true';
  return { name, enabled: (actual ?? false) === expected };
}

function openKnownConditional(
  line: string,
  directiveLine: string,
  state: ConditionalProjection,
): boolean {
  const ifdefMatch = /^\s*#ifdef\s+(\w+)/.exec(directiveLine);
  const ifndefMatch = /^\s*#ifndef\s+(\w+)/.exec(directiveLine);
  const condition = knownIfCondition(directiveLine, state.defines, state.flattenTrueAxes);
  if (ifdefMatch === null && ifndefMatch === null && condition === undefined) return false;
  const name = ifdefMatch?.[1] ?? ifndefMatch?.[1] ?? condition?.name;
  const enabled =
    condition?.enabled ??
    (name === undefined
      ? false
      : ifdefMatch !== null
        ? (state.defines[name] ?? false)
        : !(state.defines[name] ?? false));
  const disabled = hasDisabledParent(state.stack) || !enabled;
  const removed = disabled || (name !== undefined && isFlattenedAxis(name, state.flattenTrueAxes));
  state.stack.push({ disabled, seenElse: false, removed, opaque: false });
  if (!removed) state.output.push(line);
  return true;
}

function openOpaqueConditional(line: string, state: ConditionalProjection): void {
  const disabled = hasDisabledParent(state.stack);
  state.stack.push({ disabled, seenElse: false, removed: disabled, opaque: true });
  if (!disabled) state.output.push(line);
}

function processElse(line: string, state: ConditionalProjection): void {
  const top = state.stack[state.stack.length - 1];
  if (top === undefined) {
    state.output.push(line);
    return;
  }
  if (top.seenElse) return;
  top.seenElse = true;
  if (top.opaque) {
    if (!top.removed && !hasDisabledParent(state.stack)) state.output.push(line);
    return;
  }
  if (state.stack.slice(0, -1).every((frame) => !frame.disabled)) top.disabled = !top.disabled;
  // A removed known branch has no matching directive in the projected source;
  // its else-body is now the active body and must flow through.
  if (!top.removed) state.output.push(line);
}

function processEndif(line: string, state: ConditionalProjection): void {
  const top = state.stack.pop();
  if (top === undefined || !top.removed) state.output.push(line);
}

function preserveOrdinaryLine(
  line: string,
  directiveLine: string,
  state: ConditionalProjection,
): void {
  if (hasDisabledParent(state.stack)) {
    // Naga Oil extracts entry #define metadata without evaluating the enclosing
    // conditional scope. Preserve it so projected source keeps the effective map.
    if (/^\s*#\s*define\s+\w+\b/.test(directiveLine)) state.output.push(line);
    return;
  }
  state.output.push(line);
}

function projectConditionalLine(
  line: string,
  directiveLine: string,
  state: ConditionalProjection,
): void {
  if (openKnownConditional(line, directiveLine, state)) return;
  if (/^\s*#if\s+/.test(directiveLine)) {
    openOpaqueConditional(line, state);
    return;
  }
  if (/^\s*#else\b/.test(directiveLine)) {
    processElse(line, state);
    return;
  }
  if (/^\s*#endif\b/.test(directiveLine)) {
    processEndif(line, state);
    return;
  }
  preserveOrdinaryLine(line, directiveLine, state);
}

export function projectShaderConditionals(
  source: string,
  defines: Readonly<Record<string, boolean>> = {},
  flattenTrueAxes: FlattenedAxes = [],
): string {
  if (flattenTrueAxes !== 'all' && Object.keys(defines).length === 0) return source;
  const state: ConditionalProjection = {
    defines,
    flattenTrueAxes,
    stack: [],
    output: [],
  };
  const lines = source.split(/\r?\n/);
  const directiveLines = stripWgslComments(source).split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    projectConditionalLine(line, directiveLines[index] ?? line, state);
  }
  return state.output.join('\n');
}
