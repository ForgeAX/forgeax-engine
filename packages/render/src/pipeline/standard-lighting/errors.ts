import type { ClusterBinError } from '../../cluster-binner';
import { StandardClusterIndexOverflowError } from '../../errors/render';

export function fromClusterBinError(error: ClusterBinError): StandardClusterIndexOverflowError {
  return new StandardClusterIndexOverflowError(error.detail.actual, error.detail.capacity);
}
