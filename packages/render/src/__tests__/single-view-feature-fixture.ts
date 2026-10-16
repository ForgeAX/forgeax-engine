import {
  type RenderFeatureFrameInput,
  type RenderFeatureFrameResult,
  type RenderFeatureHost,
  runRenderFeatureFrame,
} from '../features/host';

/** Exercise the real renderer transaction with one view in focused feature tests. */
export function runSingleViewFeatureFrame(
  host: RenderFeatureHost,
  input: Omit<RenderFeatureFrameInput, 'identity' | 'render'>,
): RenderFeatureFrameResult {
  const batch = runRenderFeatureFrame(host, [{ identity: 'main', render: true, ...input }]);
  const view = batch.views.get('main');
  if (view === undefined) throw new Error('single view was not projected');
  return {
    ...view,
    plans: [...batch.frame.plans, ...view.plans],
    preparedResourceBatches: batch.preparedResourceBatches,
    requiresPreparedResourceKey:
      batch.frame.requiresPreparedResourceKey || view.requiresPreparedResourceKey,
    onSubmitted: () => {
      batch.frame.onSubmitted();
      view.onSubmitted();
      batch.onSubmitted();
    },
    onAborted: () => batch.onAborted(),
  };
}
