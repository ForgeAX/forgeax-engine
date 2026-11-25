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
// Compile a storage-only entry from the pinned arithmetic. Public Matrix4 methods retain
// their own inline arithmetic and input feedback independently of admitted Scene arrays.
function extractPoseKernels(contents: string): string {
  const kernels: string[] = [];
  for (const [method, kernel, parameters, first] of [
    ['compose', 'composeElements', 'te, position, quaternion, scale', 'const x = quaternion._x'],
    ['copy', 'copyElements', 'te, me', 'te[ 0 ] = me[ 0 ]'],
    ['multiplyMatrices', 'multiplyElements', 'ae, be, te', 'const a11 = ae[ 0 ]'],
  ] as const) {
    const methodStart = contents.indexOf(`\n\t${method}(`);
    const end = contents.indexOf('\n\t}', methodStart);
    const body = contents.slice(methodStart, end);
    const numericStart = body.indexOf(`\n\t\t${first}`);
    const numericEnd = body.lastIndexOf('\n\t\treturn this;');
    const numeric = body.slice(numericStart, numericEnd);
    if (methodStart < 0 || end < 0 || numericStart < 0 || numericEnd <= numericStart ||
        numeric.includes('this.') || numeric.includes('return '))
      throw new Error(`Unexpected Three r187 Matrix4.${method} arithmetic`);
    if (method === 'multiplyMatrices') {
      // Load each operand only after the other object's getters have run. Coercion
      // on the RHS of a store can change the destination before the actual write.
      const stores = /te\[ (\d+) \] = ([^;]+);/g;
      if (numeric.match(stores)?.length !== 16) throw new Error('Unexpected r187 matrix stores');
      const publicWrite = numeric
        .replace('const a11 =', 'ae = worldMatrixInput(ae);\n\t\tconst a11 =')
        .replace('const b11 =', 'be = worldMatrixInput(be);\n\t\tconst b11 =')
        .replace(stores, 'row.writeLane($1, $2);');
      kernels.push(`function multiplyWorldElements(ae, be, row) {${publicWrite}\n}`);
    }
    kernels.push(`function ${kernel}(${parameters}) {${numeric}\n}`);
  }
  return contents + '\n' + kernels.join('\n') +
    '\ninstallPoseKernels(Matrix4.prototype, composeElements, copyElements, multiplyElements, multiplyWorldElements);\n';
}

// Retain the public receiver for numeric accessors, including getters installed during a read.
function integratePoseRead(
  contents: string, method: string, array: string, owner: string, reads: number,
): string {
  const start = contents.indexOf(`\n\t${method}(`);
  const end = contents.indexOf('\n\t}', start);
  const body = contents.slice(start, end);
  const declaration = `const ${array} = ${owner}.elements;`;
  const element = new RegExp(`\\b${array}\\[ (\\d+) \\]`, 'g');
  if (start < 0 || end < 0 || !body.includes(declaration) || body.match(element)?.length !== reads)
    throw new Error(`Unexpected Three r187 ${method} matrix read`);
  const parameters = body.slice(body.indexOf('(') + 1, body.indexOf(')')).trim();
  const args = parameters ? ', ' + parameters : '';
  const kernel = `readOwned_${method}`;
  const source = body.slice(body.indexOf(declaration) + declaration.length)
    .replace(element, (_, lane: string) => `(row === undefined ? Reflect.get(storage, '${lane}', ${array}) : row.readLane(${lane}, ${array}))`);
  const guarded = body.replace(declaration, declaration +
    `\n\t\tconst storage = sourceCollectionStorage(${array});` +
    `\n\t\tif (storage !== ${array}) return ${kernel}.call(this, ${array}, storage${args});`);
  return contents.slice(0, start) + guarded + contents.slice(end) +
    `\nfunction ${kernel}(${array}, storage${args}) { const row = worldMatrixRow(storage);${source}\n}\n`;
}

function integrateMatrixStorage(contents: string): string {
  for (const name of matrixWriteMethods) {
    const start = contents.indexOf(`\n\t${name}(`);
    const end = contents.indexOf('\n\t}', start);
    const body = contents.slice(start, end);
    if (start < 0 || end < 0 || !body.includes('const te = this.elements') ||
        !body.endsWith('return this;\n')) {
      throw new Error(`Unexpected Three r187 Matrix4.${name} kernel`);
    }
    let write = body
      .replace('const te = this.elements', 'const elements = this.elements;\n\t\tconst te = sourceCollectionStorage(elements)')
      .replace('return this;\n', 'publishMatrixWrite(elements, te);\n\t\treturn this;\n');
    if (name === 'multiplyMatrices') {
      write = write.replace('const ae = a.elements;', 'const leftElements = a.elements;')
        .replace('const be = b.elements;', 'const rightElements = b.elements;')
        .replace('const a11 =', `const row = worldMatrixRow(te);
          if (row !== undefined) {
            multiplyWorldElements(leftElements, rightElements, row);
            publishMatrixWrite(elements, te);
            return this;
          }
          const ae = worldMatrixInput(leftElements);
          const a11 =`)
        .replace('const b11 =', 'const be = worldMatrixInput(rightElements);\n\t\tconst b11 =');
    }
    if (name === 'copy')
      write = write.replace('const me = m.elements;', `const input = m.elements;
        const me = matrixReadStorage(input);
        if (copyWorldMatrixElements(te, me, input)) {
          publishMatrixWrite(elements, te);
          return this;
        }`);
    contents = contents.slice(0, start) + write + contents.slice(end);
  }
  return contents.replace(/const ([abm]e) = ([abm]|matrix)\.elements;/g, 'const $1 = sourceCollectionStorage($2.elements);')
    .replace('me = m.elements;', 'me = sourceCollectionStorage(m.elements);');
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
        const matrixRows = fileURLToPath(new URL('./src/world-matrix-storage.ts', import.meta.url));
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
              replace('boneInverses.push( mat );', 'mat.elements = ownedMatrixElements(mat.elements); boneInverses.push( mat );', 1);
            } else if (path.endsWith('Matrix4.js')) {
              contents = integrateMatrixStorage(extractPoseKernels(contents));
              replace('determinantAffine() {\n\n\t\tconst te = this.elements;',
                'determinantAffine() {\n\n\t\tconst te = matrixReadStorage(this.elements);', 1);
              contents = integratePoseRead(contents, 'decompose', 'te', 'this', 12);
              contents = `import { installPoseKernels } from ${JSON.stringify(worldPose)};\n${contents}`;
            } else if (path.endsWith('Object3D.js')) {
              const declaration = 'class Object3D extends EventDispatcher {';
              replace(declaration, declaration + `
                #sourcePose;
                static {
                  installSourcePoseStorage(previous => ({
                    get(node) { return #sourcePose in node ? node.#sourcePose : previous.get(node); },
                    set(node, binding) {
                      if (#sourcePose in node) node.#sourcePose = binding;
                      else previous.set(node, binding);
                    }
                  }));
                }`, 1);
              replace('this.children = [];', 'this.children = ownedChildren(this, []); initializeSourceHierarchy(this);', 1);
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
              // Preserve Three's visit order, captured length and virtual child calls.
              for (const prefix of [
                '// make sure descendants are updated if required\n\n\t\t',
                'if ( updateChildren === true ) {\n\n\t\t\t',
              ]) {
                replace(prefix + 'const children = this.children;', prefix + 'const children = sourceCollectionStorage(this.children);', 1);
              }
              replace('const position = new Vector3();', 'const position = new Vector3(0, 0, 0, poseConstruction);', 1);
              replace('const quaternion = new Quaternion();', 'const quaternion = new Quaternion(0, 0, 0, 1, poseConstruction);', 1);
              replace('const scale = new Vector3( 1, 1, 1 );', 'const scale = new Vector3(1, 1, 1, poseConstruction);', 1);
              for (const field of ['matrix', 'matrixWorld']) {
                const assignment = `this.${field} = new Matrix4();`;
                replace(assignment, `${assignment} this.${field}.elements = ${field === 'matrixWorld' ? 'ownedWorldMatrixElements' : 'ownedMatrixElements'}(this.${field}.elements);`, 1);
              }
            } else if (path.endsWith('LightShadow.js')) {
              replace('this.camera = camera;', 'this.camera = camera; camera.projectionMatrix.elements = ownedMatrixElements(camera.projectionMatrix.elements);', 1);
              replace('this.matrix = new Matrix4();', 'this.matrix = new Matrix4(); this.matrix.elements = ownedMatrixElements(this.matrix.elements);', 1);
            } else if (path.endsWith('Vector3.js') || path.endsWith('Quaternion.js')) {
              const quaternion = path.endsWith('Quaternion.js');
              if (!quaternion) contents = integratePoseRead(contents, 'setFromMatrixPosition', 'e', 'm', 3);
              const anchor = quaternion ? 'this.isQuaternion = true;' : 'constructor( x = 0, y = 0, z = 0 ) {';
              replace(anchor, `${anchor} if (creatingTrackedPose(arguments[${quaternion ? 4 : 3}])) initializePoseLayout(this, ${quaternion});`, 1);
            } else if (path.endsWith('Skeleton.js')) {
              replace('this.bones = bones.slice( 0 );', 'this.bones = ownedCollection(bones.slice(0));', 1);
              replace('constructor( bones = [], boneInverses = [] )', 'constructor( bones = [], boneInverses = ownedCollection([]) )', 1);
              replace('this.boneInverses = [];','this.boneInverses = ownedCollection([]);',1);
              replace('const inverse = new Matrix4();','const inverse = new Matrix4(); inverse.elements = ownedMatrixElements(inverse.elements);',1);
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
              contents: `import { ownedCollection, ownedMatrixElements, ownedWorldMatrixElements, ownedChildren, initializeSourceHierarchy, poseConstruction, creatingTrackedPose, sourceCollectionStorage, matrixReadStorage, worldMatrixInput, publishMatrixWrite } from ${JSON.stringify(helper)};\nimport { copyWorldMatrixElements, worldMatrixRow } from ${JSON.stringify(matrixRows)};\n${path.endsWith('Object3D.js') ? `import { installSourcePoseStorage, resolveSourceWorldPose } from ${JSON.stringify(worldPose)};\n` : ''}import { initializePoseLayout } from ${JSON.stringify(fields)};\n${contents}`,
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
