import type { WaterOperationObserver } from './contracts.js';

export interface WaterOperationScope {
  end(): void;
}

export function beginWaterOperation(
  observer: WaterOperationObserver | undefined,
  operation: string,
): WaterOperationScope | undefined {
  try {
    return observer?.begin(operation);
  } catch {
    return undefined;
  }
}

export function endWaterOperation(scope: WaterOperationScope | undefined): void {
  try {
    scope?.end();
  } catch {
    // Host diagnostics cannot change Water's query result or exception.
  }
}
