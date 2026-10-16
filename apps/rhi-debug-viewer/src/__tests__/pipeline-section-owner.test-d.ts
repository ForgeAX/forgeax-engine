import { selectedShaderPreview } from '../components/PipelineState';
import type { ViewerModel } from '../viewer-model';

declare const model: ViewerModel;

const selection = selectedShaderPreview(model, 0, 'fragment');
if (selection !== null) {
  selection.tapeDigest satisfies string;
  selection.workIndex satisfies number;
  selection.stage satisfies 'vertex' | 'fragment' | 'compute' | null;
  selection.shaderModuleId satisfies string;
  selection.source satisfies string;
}
