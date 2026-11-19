import UpstreamInput from 'three/src/nodes/core/NodeFunctionInput.js';
import UpstreamStackTrace from 'three/src/nodes/core/StackTrace.js';

/** Actual r187 fields and nullable array count omitted by the pinned declarations. */
export interface NodeFunctionInput extends Omit<UpstreamInput, 'isNodeFunctionInput'> {
  type: string;
  name: string;
}
export const NodeFunctionInput = UpstreamInput as unknown as {
  readonly isNodeFunctionInput: true;
  new (
    type: string,
    name: string,
    count?: number | null,
    qualifier?: string,
    isConst?: boolean,
  ): NodeFunctionInput;
};

export interface StackTrace extends UpstreamStackTrace {
  getLocation(): string;
  getError(message: string): string;
}
/** r187 calls split() on this input; its declared Error overload does not work. */
export const StackTrace = UpstreamStackTrace as {
  new (message?: string | null): StackTrace;
};
