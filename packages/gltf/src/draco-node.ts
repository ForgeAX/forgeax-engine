import { createDecoderModule } from 'draco3dgltf';
import { createDracoDecoder } from './draco-adapter.js';
export const dracoDecoder = createDracoDecoder(createDecoderModule);
