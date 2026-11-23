import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

const core = fileURLToPath(new URL('./src/addon-core.ts', import.meta.url));
const manifest = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { exports: Record<string, unknown> };
const addons = Object.fromEntries(
  Object.keys(manifest.exports)
    .filter((path) => path.startsWith('./addons/') && path.endsWith('.js'))
    .map((path) => {
      const entry = path.slice(2, -3);
      return [entry, `src/${entry}.ts`];
    }),
);

// Keep r187's numeric kernels and method dispatch. Only their dense element
// storage and the completion of a write participate in source tracking.
const matrixWriteMethods = [
  'set', 'copy', 'copyPosition', 'extractRotation', 'makeRotationFromEuler',
  'lookAt', 'multiplyMatrices', 'multiplyScalar', 'transpose', 'setPosition',
  'invert', 'scale', 'compose', 'makePerspective', 'makeOrthographic',
] as const;
function integrateMatrixStorage(contents: string): string {
  for (const name of matrixWriteMethods) {
    const start = contents.indexOf(`\n\t${name}(`);
    const end = contents.indexOf('\n\t}', start);
    const body = contents.slice(start, end);
    if (start < 0 || end < 0 || !body.includes('const te = this.elements') ||
        !body.endsWith('return this;\n')) {
      throw new Error(`Unexpected Three r187 Matrix4.${name} kernel`);
    }
    const write = body
      .replace('const te = this.elements', 'const elements = this.elements;\n\t\tconst te = matrixStorage(elements)')
      .replace('return this;\n', 'publishMatrixWrite(elements, te);\n\t\treturn this;\n');
    contents = contents.slice(0, start) + write + contents.slice(end);
  }
  return contents.replace(/const ([abm]e) = ([abm]|matrix)\.elements;/g, 'const $1 = matrixStorage($2.elements);')
    .replace('me = m.elements;', 'me = matrixStorage(m.elements);');
}

export default defineConfig({
  ...baseTsupConfig,
  entry: {
    index: 'src/index.ts',
    tsl: 'src/tsl.ts',
    materials: 'src/generated/materials.mjs',
    physical: 'src/generated/physical.mjs',
    'build/index': 'src/build/materials.ts',
    ...addons,
  },
  splitting: true,
  external: [/^@forgeax\/engine-/],
  noExternal: [/^three(?:\/|$)/],
  esbuildPlugins: [
    {
      name: 'three-owned-collections',
      setup(build) {
        const helper = fileURLToPath(new URL('./src/source-collections.ts', import.meta.url));
        const worldPose = fileURLToPath(new URL('./src/source-world-pose.ts', import.meta.url));
        const fields = fileURLToPath(new URL('./src/source-fields.ts', import.meta.url));
        build.onLoad(
          { filter: /[\\/]three[\\/](?:examples[\\/]jsm[\\/]loaders[\\/]GLTFLoader|src[\\/](?:math[\\/](?:Vector3|Quaternion|Matrix4)|core[\\/](?:Object3D|BufferGeometry)|lights[\\/]LightShadow|textures[\\/]Texture|objects[\\/](?:Skeleton|LOD|Mesh|Line|Points)))\.js$/ },
          ({ path }) => {
            let contents = readFileSync(path, 'utf8');
            const replace = (source: string, replacement: string, count: number) => {
              if (contents.split(source).length !== count + 1)
                throw new Error(`Unexpected Three r187 collection allocation in ${path}: ${source}`);
              contents = contents.replaceAll(source, replacement);
            };

            if (path.endsWith('GLTFLoader.js')) {
              replace('const boneInverses = [];', 'const boneInverses = ownedCollection([]);', 1);
              replace('boneInverses.push( mat );', 'mat.elements = ownedCollection(mat.elements); boneInverses.push( mat );', 1);
            } else if (path.endsWith('Matrix4.js')) {
              contents = integrateMatrixStorage(contents);
            } else if (path.endsWith('Object3D.js')) {
              replace('this.children = [];', 'this.children = ownedChildren(this, []);', 1);
              const standardWorldUpdate = [
                'if ( this.matrixAutoUpdate ) this.updateMatrix();',
                'if ( this.matrixWorldNeedsUpdate || force ) {',
              ].join('\n\n\t\t');
              replace(
                standardWorldUpdate,
                'const resolved = resolveSourceWorldPose(this);\n\t\t' +
                  'if ( !resolved && this.matrixAutoUpdate ) this.updateMatrix();\n\n\t\t' +
                  'if ( resolved ) force = true;\n\t\telse if ( this.matrixWorldNeedsUpdate || force ) {',
                2,
              );
              replace('const position = new Vector3();', 'const position = new Vector3(0, 0, 0, poseConstruction);', 1);
              replace('const quaternion = new Quaternion();', 'const quaternion = new Quaternion(0, 0, 0, 1, poseConstruction);', 1);
              replace('const scale = new Vector3( 1, 1, 1 );', 'const scale = new Vector3(1, 1, 1, poseConstruction);', 1);
              for (const field of ['matrix', 'matrixWorld']) {
                const assignment = `this.${field} = new Matrix4();`;
                replace(assignment, `${assignment} this.${field}.elements = ownedCollection(this.${field}.elements);`, 1);
              }
            } else if (path.endsWith('LightShadow.js')) {
              replace('this.camera = camera;', 'this.camera = camera; camera.projectionMatrix.elements = ownedCollection(camera.projectionMatrix.elements);', 1);
              replace('this.matrix = new Matrix4();', 'this.matrix = new Matrix4(); this.matrix.elements = ownedCollection(this.matrix.elements);', 1);
            } else if (path.endsWith('Vector3.js') || path.endsWith('Quaternion.js')) {
              const quaternion = path.endsWith('Quaternion.js');
              const anchor = quaternion ? 'this.isQuaternion = true;' : 'constructor( x = 0, y = 0, z = 0 ) {';
              replace(anchor, `${anchor} if (creatingTrackedPose(arguments[${quaternion ? 4 : 3}])) initializePoseLayout(this, ${quaternion});`, 1);
            } else if (path.endsWith('Skeleton.js')) {
              replace('this.bones = bones.slice( 0 );', 'this.bones = ownedCollection(bones.slice(0));', 1);
              replace('constructor( bones = [], boneInverses = [] )', 'constructor( bones = [], boneInverses = ownedCollection([]) )', 1);
              replace('this.boneInverses = [];','this.boneInverses = ownedCollection([]);',1);
              replace('const inverse = new Matrix4();','const inverse = new Matrix4(); inverse.elements = ownedCollection(inverse.elements);',1);
            } else if (path.endsWith('LOD.js')) {
              replace('value: []', 'value: ownedCollection([])', 1);
            } else if (/[\\/]objects[\\/](Mesh|Line|Points)\.js$/.test(path)) {
              replace('this.morphTargetInfluences = [];','this.morphTargetInfluences = ownedCollection([]);',1);
              replace('this.morphTargetInfluences = source.morphTargetInfluences.slice();',
                'this.morphTargetInfluences = ownedCollection(source.morphTargetInfluences.slice());',1);
            } else if (path.endsWith('Texture.js')) {
              replace('this.mipmaps = [];', 'this.mipmaps = ownedCollection([]);', 1);
              replace('this.mipmaps = source.mipmaps.slice( 0 );',
                'this.mipmaps = ownedCollection(source.mipmaps.slice(0));', 1);
            } else {
              for (const field of ['attributes', 'morphAttributes'])
                replace(`this.${field} = {};`, `this.${field} = ownedCollection({});`, 2);
              replace('this.groups = [];', 'this.groups = ownedCollection([]);', 3);
            }

            return {
              loader: 'js',
              contents: `import { ownedCollection, ownedChildren, poseConstruction, creatingTrackedPose, matrixStorage, publishMatrixWrite } from ${JSON.stringify(helper)};\n${path.endsWith('Object3D.js') ? `import { resolveSourceWorldPose } from ${JSON.stringify(worldPose)};\n` : ''}import { initializePoseLayout } from ${JSON.stringify(fields)};\n${contents}`,
            };
          },
        );
      },
    },
    {
      name: 'three-cpu-identity',
      setup(build) {
        // Addons and the facade must share source constructors, never the facade runtime or a separate upstream bundle.
        build.onResolve({ filter: /^three$/ }, () => ({ path: core }));
      },
    },
  ],
});
