export { IMAGE_ERROR_EXPECTED, ImageErrorImpl, imageError } from '@forgeax/engine-types';

export type CubeParserErrorCode =
  | 'cube-header-invalid'
  | 'cube-size-invalid'
  | 'cube-domain-invalid'
  | 'cube-row-invalid'
  | 'cube-data-count-invalid';

export interface CubeParserError {
  readonly code: CubeParserErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly sourceKey: string;
    readonly line?: number;
    readonly field: string;
    readonly actual: unknown;
  };
}

export function cubeParserError(
  code: CubeParserErrorCode,
  sourceKey: string,
  field: string,
  actual: unknown,
  line?: number,
): CubeParserError {
  const lineDetail = line === undefined ? '' : ` at line ${line}`;
  return {
    code,
    expected: `valid .cube source with LUT_3D_SIZE, DOMAIN_MIN/MAX, and exactly N^3 RGB rows${lineDetail}`,
    hint: `repair field ${field} in sourceKey ${sourceKey} and re-run the Node image producer`,
    detail: { sourceKey, field, actual, ...(line === undefined ? {} : { line }) },
  };
}
