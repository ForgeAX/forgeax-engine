/**
 * Project the boolean conditional surface that naga_oil resolves too late for
 * imported modules. Known `#ifdef`/`#ifndef` branches and the engine's simple
 * `#if NAME == true|false` expressions are folded; unknown `#if` expressions
 * remain intact for naga_oil. Explicit author axes or `all` also remove active
 * boolean directives. The stack tracks every conditional kind so a
 * nested numeric `#if` cannot steal an outer `#ifdef`'s `#else`.
 */

export function projectShaderConditionals(
  source: string,
  defines: Readonly<Record<string, boolean>> = {},
  flattenTrueAxes: readonly string[] | 'all' = [],
): string {
  if (flattenTrueAxes !== 'all' && Object.keys(defines).length === 0) return source;
  type ConditionalFrame = {
    disabled: boolean;
    seenElse: boolean;
    removed: boolean;
    opaque: boolean;
  };
  const stack: ConditionalFrame[] = [];
  const parentDisabled = (): boolean => stack.some((frame) => frame.disabled);
  const lines = source.split(/\r?\n/);
  const out: string[] = [];

  const flatten = (axis: string): boolean =>
    flattenTrueAxes === 'all' || flattenTrueAxes.includes(axis);
  const knownIfCondition = (line: string): { name: string; enabled: boolean } | undefined => {
    const match = /^\s*#if\s+(!?)(\w+)(?:\s*==\s*(true|false))?\s*$/.exec(line);
    if (match === null || (match[1] === '!' && match[3] !== undefined)) return undefined;
    const name = match[2] ?? '';
    const actual = defines[name];
    // Bare/negated boolean axes belong to complete specialization or explicitly
    // flattened author axes. Other expressions remain naga_oil's responsibility.
    if (match[3] === undefined && !flatten(name)) return undefined;
    if (actual === undefined && flattenTrueAxes !== 'all' && !flatten(name)) return undefined;
    const expected = match[3] === undefined ? match[1] !== '!' : match[3] === 'true';
    return { name, enabled: (actual ?? false) === expected };
  };

  for (const line of lines) {
    const ifdefMatch = /^\s*#ifdef\s+(\w+)/.exec(line);
    const ifndefMatch = /^\s*#ifndef\s+(\w+)/.exec(line);
    const knownCondition = knownIfCondition(line);
    if (ifdefMatch !== null || ifndefMatch !== null || knownCondition !== undefined) {
      const name = ifdefMatch?.[1] ?? ifndefMatch?.[1] ?? knownCondition?.name;
      const condition =
        knownCondition?.enabled ??
        (name === undefined
          ? false
          : ifdefMatch !== null
            ? (defines[name] ?? false)
            : !(defines[name] ?? false));
      const disabled = parentDisabled() || !condition;
      const removed = disabled || (name !== undefined && flatten(name));
      stack.push({ disabled, seenElse: false, removed, opaque: false });
      if (!removed) out.push(line);
      continue;
    }
    if (/^\s*#if\s+/.test(line)) {
      const disabled = parentDisabled();
      stack.push({ disabled, seenElse: false, removed: disabled, opaque: true });
      if (!disabled) out.push(line);
      continue;
    }
    if (/^\s*#else\b/.test(line)) {
      const top = stack[stack.length - 1];
      if (top === undefined) {
        out.push(line);
        continue;
      }
      if (top.seenElse) continue;
      top.seenElse = true;
      if (top.opaque) {
        if (!top.removed && !parentDisabled()) out.push(line);
        continue;
      }
      const outerDisabled = stack.slice(0, -1).some((frame) => frame.disabled);
      if (!outerDisabled) top.disabled = !top.disabled;
      // A removed known branch has no matching directive in the projected
      // source; its else-body is now the active body and must flow through.
      if (!top.removed) out.push(line);
      continue;
    }
    if (/^\s*#endif\b/.test(line)) {
      const top = stack.pop();
      if (top === undefined || !top.removed) out.push(line);
      continue;
    }
    if (parentDisabled()) continue;
    out.push(line);
  }
  return out.join('\n');
}
