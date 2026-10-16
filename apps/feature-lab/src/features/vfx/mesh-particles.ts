import { topologyVisual } from './support/topology-visual';

export default topologyVisual('mesh', {
  title: 'Mesh particles',
  catalog: 'Mesh particles',
  summary:
    'A GPU emitter with a mesh renderer: each particle instances a cube MeshAsset with its own GPU-written orientation and scale, drawn indexed-indirect.',
  expect:
    'ON: a column of spinning green cubes rising at the left-center. OFF (session mask off): the cubes disappear.',
});
