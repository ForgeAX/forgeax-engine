import type OriginalFunction from 'three/src/nodes/parsers/GLSLNodeFunction.js';
import OriginalParser from 'three/src/nodes/parsers/GLSLNodeParser.js';
import type { NodeFunctionInput } from './node-descriptors';

/** Parsed inputs have the same real fields as the public CPU input descriptor. */
export interface GLSLNodeParser extends Omit<OriginalParser, 'parseFunction'> {
  parseFunction(source: string): Omit<OriginalFunction, 'inputs'> & { inputs: NodeFunctionInput[] };
}
export const GLSLNodeParser = OriginalParser as unknown as Omit<
  typeof OriginalParser,
  'prototype'
> & {
  new (): GLSLNodeParser;
  readonly prototype: GLSLNodeParser;
};
