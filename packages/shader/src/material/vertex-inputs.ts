import { stripWgslComments } from '@forgeax/engine-types';

/** One `@location` input the selected vertex entry declares. */
export interface DeclaredVertexInput {
  readonly location: number;
  readonly name: string;
}

const LOCATION_FIELD =
  /@location\s*\(\s*(\d+)u?\s*\)(?:\s*@\w+(?:\s*\([^)]*\))?)*\s*([A-Za-z_]\w*)\s*:/gu;

function entryParameterList(code: string, entry: string): string | undefined {
  const match = new RegExp(`@vertex\\s+fn\\s+${entry}\\s*\\(`, 'u').exec(code);
  if (match === null) return undefined;
  const open = match.index + match[0].length - 1;
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === '(') depth += 1;
    if (code[index] !== ')') continue;
    depth -= 1;
    if (depth === 0) return code.slice(open + 1, index);
  }
  return undefined;
}

function topLevelParameters(list: string): string[] {
  const parameters: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index <= list.length; index += 1) {
    const character = list[index];
    if (character === '<' || character === '(') depth += 1;
    else if (character === '>' || character === ')') depth -= 1;
    else if ((character === ',' && depth === 0) || index === list.length) {
      const parameter = list.slice(start, index).trim();
      if (parameter.length > 0) parameters.push(parameter);
      start = index + 1;
    }
  }
  return parameters;
}

function parameterInputScope(code: string, parameter: string): string {
  if (/@location\s*\(/u.test(parameter)) return parameter;
  const type = /:\s*([A-Za-z_]\w*)\s*$/u.exec(parameter)?.[1];
  if (type === undefined) return '';
  return new RegExp(`\\bstruct\\s+${type}\\s*\\{([^}]*)\\}`, 'u').exec(code)?.[1] ?? '';
}

/**
 * Vertex inputs read by `entry`: inline `@location` parameters plus the
 * `@location` fields of struct-typed parameters. Builtins carry no slot. An
 * entry that cannot be found declares nothing here, so the guard never
 * rejects a module it cannot read.
 */
export function declaredMaterialVertexInputs(source: string, entry: string): DeclaredVertexInput[] {
  if (!/^[A-Za-z_]\w*$/u.test(entry)) return [];
  const code = stripWgslComments(source);
  const list = entryParameterList(code, entry);
  if (list === undefined) return [];
  const inputs: DeclaredVertexInput[] = [];
  for (const parameter of topLevelParameters(list)) {
    if (/^@builtin\s*\(/u.test(parameter)) continue;
    for (const field of parameterInputScope(code, parameter).matchAll(LOCATION_FIELD)) {
      // Detach short facts: a sliced identifier must not retain complete WGSL.
      inputs.push({
        location: Number(field[1]),
        name: JSON.parse(JSON.stringify(field[2] ?? '')) as string,
      });
    }
  }
  return inputs;
}
