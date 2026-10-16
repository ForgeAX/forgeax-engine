import type { ExecutionBootstrapEntry } from '@forgeax/engine-app';
import {
  querySubmittedTerrainHeight,
  type FrameReceipt,
  type SubmittedTerrainHeightRequest,
} from '@forgeax/engine-render';
import { terrainBootstrapData } from './identity.ts';
import baseEntry from './worker-bootstrap.ts';

// Fixture observation borrows the real completed receipt. It contributes no
// renderer state or alternate query authority.
const entry: ExecutionBootstrapEntry = async (data) => {
  const prepared = await baseEntry(data);
  return {
    ...prepared,
    async configureRenderer(renderer) {
      await prepared.configureRenderer?.(renderer);
      let completedFrames = 0;
      let latest: FrameReceipt | undefined;
      let request: SubmittedTerrainHeightRequest | undefined;
      const failures: unknown[] = [];
      const recoveries: unknown[] = [];
      let awaitingRecovery = false;
      let disposed = false;
      const channel = new BroadcastChannel(terrainBootstrapData(data).channel);
      const temporal = () => renderer.inspect().temporal;
      channel.onmessage = ({ data: message }) => {
        if (disposed || message?.kind !== 'engine-proof' || typeof message.token !== 'string')
          return;
        if (message.request !== undefined) request = message.request;
        channel.postMessage({
          kind: 'engine-proof',
          token: message.token,
          value: {
            completedFrames,
            lastFrame: latest?.frameId,
            temporal: temporal(),
            failures: [...failures],
            recoveries: [...recoveries],
          },
        });
      };
      const draw = renderer.draw.bind(renderer);
      renderer.draw = (input) => {
        const before = temporal();
        const result = draw(input);
        if (!result.ok) {
          const after = temporal();
          awaitingRecovery = true;
          const receipt = latest;
          if (receipt !== undefined && request !== undefined) {
            void querySubmittedTerrainHeight(receipt, request).then((query) => {
              if (!disposed)
                failures.push({
                  code: result.error.code,
                  frameId: receipt.frameId,
                  before,
                  after,
                  query,
                });
            });
          } else
            failures.push({
              code: result.error.code,
              before,
              after,
              missingCompletedReceipt: true,
            });
        } else if (result.value.presentation === 'ready') {
          const receipt = result.value;
          const firstRetry = awaitingRecovery;
          awaitingRecovery = false;
          const submittedTemporal = temporal();
          void receipt.completed.then(async (completed) => {
            if (disposed || !completed.ok) return;
            completedFrames++;
            latest = receipt;
            if (firstRetry) {
              const query =
                request === undefined
                  ? undefined
                  : await querySubmittedTerrainHeight(receipt, request);
              if (!disposed)
                recoveries.push({ frameId: receipt.frameId, temporal: submittedTemporal, query });
            }
          });
        }
        return result;
      };
      const dispose = renderer.dispose.bind(renderer);
      renderer.dispose = () => {
        disposed = true;
        channel.close();
        return dispose();
      };
    },
  };
};
export default entry;
