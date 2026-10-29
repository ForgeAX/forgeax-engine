import { ownPipelineLibrary, type PipelineLibraryManifest } from '@forgeax/engine-rhi';
import { shaderSourceForDescriptor } from '@forgeax/engine-types';

self.onmessage = ({ data }: MessageEvent<PipelineLibraryManifest>) => {
  const encode = TextEncoder.prototype.encode;
  const copy = String.fromCharCode;
  let encodes = 0;
  let copies = 0;
  TextEncoder.prototype.encode = function (this: TextEncoder, input) {
    encodes++;
    return encode.call(this, input);
  };
  String.fromCharCode = (...units) => {
    copies++;
    return copy(...units);
  };
  try {
    const owned = ownPipelineLibrary(data);
    const first = owned.shaders[0];
    if (first === undefined) throw new Error('Missing fixture source');
    const source = shaderSourceForDescriptor(first);
    if (source === undefined) throw new Error('Missing source owner');
    const reception = { encodes, copies };
    const identity = source.identity;
    self.postMessage({
      reception,
      repeatedIdentity: source.identity === identity,
      encodes,
      copies,
      shared: owned.shaders.every((descriptor) => shaderSourceForDescriptor(descriptor) === source),
      code: first.code,
    });
  } finally {
    TextEncoder.prototype.encode = encode;
    String.fromCharCode = copy;
  }
};
