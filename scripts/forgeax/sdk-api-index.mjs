// Generates the game-facing SDK API index from Engine sources.
//
//   node scripts/forgeax/sdk-api-index.mjs          rewrite the index
//   node scripts/forgeax/sdk-api-index.mjs --check  fail when the committed index drifts
//
// SECTIONS is the curated allowlist: each entry is an export of a public
// `@forgeax/engine/<facade>` and optionally the members to show. Signatures and
// component fields are read from source declarations, so a rename, removal or
// signature change fails `pnpm skills:check` until the index is regenerated.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const API_INDEX_PATH = 'skills/forgeax-engine-sdk/references/api-index.md';
// 14 KiB: the rendering entries (spot aim, additive blend, shadow opt-out, custom
// surface + per-frame uniform) replaced about six `.d.ts` lookups per lit scene.
export const API_INDEX_MAX_BYTES = 14 * 1024;

const SECTIONS = [
  [
    'types',
    ['ok', 'err', 'Result', 'RenderQueue', 'MaterialRenderState: cullMode depthWriteEnabled blend'],
  ],
  [
    'ecs',
    [
      'World: spawn get set addComponent despawn insertResource getResource addSystem removeSystem',
      'SystemDescriptor: name queries fn after before',
      'QueryDescriptor: read write with without',
      'QueryRow: entity get mut',
      'defineComponent',
      'TimeResource: delta elapsed',
      '+Time FixedTime Update FixedUpdate EntityHandle',
    ],
  ],
  ['plugin', ['Plugin', 'Context: world assets physics gameHost effect']],
  ['app', ['GameHost: canvas uiRoot assets setPointerLockAllowed']],
  [
    'scene',
    [
      'Transform',
      'worldResolveSceneEntity',
      'sceneEntity',
      'readPresentationWorldMatrix',
      '+Name worldDespawnScene GlobalTransform ChildOf Children PROPAGATE_TRANSFORMS_SYSTEM',
    ],
  ],
  [
    'math',
    [
      'vec3: create add sub scale normalize length distance lerp',
      'quat: create fromEuler fromAxisAngle fromLookAt multiply slerp',
      'ray: getOrigin getDirection',
      'EulerOrder',
      '+vec2 vec4 mat3 mat4 euler color box3 easing noise',
    ],
  ],
  ['picking', ['viewportToWorld', 'pick', 'PickHit: *', '+pickTriangle pickVertex pickTile']],
  ['input', ['INPUT_SNAPSHOT_RESOURCE_KEY', 'InputSnapshot: keyboard mouse', '+getAxis getVector']],
  [
    'render',
    [
      'perspective(opts): fov aspect near far autoAspect',
      'orthographic(opts): left right bottom top near far',
      'Camera: clearColor tonemap exposure antialias bloom bloomThreshold bloomIntensity',
      'DirectionalLight: direction color intensity castShadow',
      'PointLight: color intensity range',
      'SpotLight: direction color intensity range innerConeDeg outerConeDeg castShadow',
      'Skylight: color intensity',
      'Fog: color density heightFalloff',
      'VolumetricFog: light spotLight density boundsMin boundsMax',
      'ShadowParticipation: cast receive',
      'MeshFilter',
      'MeshRenderer: materials',
      'Materials.standard(options): baseColor metallic roughness emissive emissiveIntensity baseColorTexture alphaCutoff renderState queue surfaceModule parameters values',
      'Materials: unlit',
      '+setActiveCamera SkyboxBackground Atmosphere TONEMAP_ACES_FILMIC ANTIALIAS_FXAA BLOOM_ENABLED',
    ],
  ],
  [
    'geometry',
    [
      'createBoxGeometry',
      '+createSphereGeometry createPlaneGeometry createCylinderGeometry createCapsuleGeometry createConeGeometry createTorusGeometry createMeshBuilder',
    ],
  ],
  [
    'physics',
    [
      'physicsPlugin',
      'RigidBody: type mass linearDamping gravityScale lockRotation',
      'RigidBodyTypeValue',
      'Collider: shape halfExtents radius halfHeight friction isSensor',
      'ColliderShapeValue',
      'CharacterController: snapToGroundDist grounded',
      'PhysicsWorld: raycast moveAndSlide teleport applyBodyImpulse setBodyMotion',
    ],
  ],
  ['pack/source', ['definePack', 'definePackageId']],
  ['assets-runtime', ['AssetRegistry: load create update release instantiate parseGuid']],
  [
    'animation',
    [
      'AnimationPlayer: clips times speeds looping',
      'bindAnimationTargets',
      'deriveAnimationTargetId',
    ],
  ],
  [
    'audio',
    ['AudioSource: clip playing loop volume spatialBlend bus', '+AudioListener audioPlugin'],
  ],
  ['vfx', ['ParticleEffectPlayer: effect playing seed timeScale']],
  ['ui', ['mountUi', 'mountUi(options): root layer onAction', 'UiInstance: host dispose']],
  ['state', ['defineState', 'setNextState', '+getState addOnEnter addOnExit inState']],
  [
    'navigation',
    [
      'createNavigationGrid',
      'NavigationGraph: findPath',
      '+setNavigationTarget setNavigationPath createNavigationMesh',
    ],
  ],
];

// `{{facade name}}` / `{{facade name.member}}` expands to the generated code span.
const REFERENCE = /\{\{(\S+) (\S+)\}\}/g;
const GOTCHAS = [
  'Import from `@forgeax/engine/<facade>` only, never physical `@forgeax/engine-*` packages.',
  'Expected failures return `Result` (`r.ok ? r.value : r.error`, `.unwrap()` throws): World methods, asset loads, geometry, pack builds.',
  'Math values are branded `Float32Array`s from `vec3.create(x, y, z)` / `quat.create()`; functions write into `out` and return it. Component data takes plain arrays (`{ pos: [0, 1, 0] }`).',
  'Euler order is a required argument: {{math quat.fromEuler}}.',
  'Pack output keys (sourceKeys) must match {{pack/guid PACK_SOURCE_KEY_RE}} (lower case).',
  'Screen to ground: `viewportToWorld` (canvas pixels, top-left origin, after transform propagation) returns a world ray; solve `origin.y + t * dir.y = 0` for a ground plane. `pick` returns the nearest entity AABB hit.',
  'Input: in a system read `world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY)`; `mouse.position` (canvas pixels, hover) may be `undefined`.',
  "Declare every service a plugin reads in `inject` (`inject: ['world', 'assets', 'gameHost']`); add systems inside `ctx.effect` and `yield` their removal.",
  'Camera: `{ component: Camera, data: { ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }), clearColor: [0, 0, 0, 1] } }`; `fov` is radians. `DirectionalLight.direction` points from the light toward the scene (opposite of Three.js).',
  "Material transparency has no `opacity` field: use `baseColor` alpha plus `renderState: { blend, depthWriteEnabled: false }` and `queue: RenderQueue.Transparent`. Additive glow: `blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } }`.",
  '`SpotLight` takes its position from `Transform` but aims by its world `direction` field (not the Transform rotation); cone angles are half-angles in degrees. Give a light-volume mesh `ShadowParticipation { cast: false, receive: false }` so it never shadows its own light.',
  'Custom lit shader: `Materials.standard({ surfaceModule, parameters, values })` names a `.wgsl` module under `assets/` (`#define_import_path`) that exports `evaluate_surface(input: SurfaceInput) -> SurfaceData` from `forgeax_material::surface_v1`; read parameters as `material.<name>` and seconds as `input.frameTime`. Feed a uniform per frame with `assets.update(handle, { values: { name } })`.',
];

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(resolve(root, 'package.json'));
const ts = require('typescript');

function facadeSource(directory, subpath) {
  const manifestPath = resolve(root, 'packages', directory, 'package.json');
  if (!existsSync(manifestPath)) return undefined;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const entry = manifest.exports?.[subpath === undefined ? '.' : `./${subpath}`];
  const types = typeof entry === 'string' ? entry : entry?.types;
  if (typeof types !== 'string') return undefined;
  const file = resolve(
    root,
    'packages',
    directory,
    types.replace(/^\.\/dist\//, 'src/').replace(/\.d\.ts$/, '.ts'),
  );
  return existsSync(file) ? file : undefined;
}

function facadeEntry(facade) {
  const [directory, subpath] = facade.split('/');
  const file = facadeSource(directory, subpath);
  if (file === undefined)
    throw new Error(`api-index: no source entry for @forgeax/engine/${facade}`);
  return file;
}

function createProgram(entries) {
  const options = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    noEmit: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  // Engine packages resolve to their sources (the same files their dist mirrors).
  host.resolveModuleNameLiterals = (literals, containing) =>
    literals.map(({ text }) => {
      const engine = /^@forgeax\/engine[-/]([a-z0-9-]+)(?:\/(.+))?$/.exec(text);
      if (engine === null) return ts.resolveModuleName(text, containing, options, host);
      const file = facadeSource(engine[1], engine[2]);
      return { resolvedModule: file && { resolvedFileName: file, extension: ts.Extension.Ts } };
    });
  return ts.createProgram({ rootNames: entries, options, host });
}

const normalize = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\breadonly /g, '')
    .replace(/import\('[^']+'\)\./g, '')
    .replace(/([([{<]) /g, '$1')
    .replace(/,? ([)\]}>])/g, (_match, close) => (close === '}' ? ' }' : close))
    .replace(/;? }/g, ' }')
    .trim();

const textOf = (node) => (node === undefined ? undefined : normalize(node.getText()));

function renderParameter(parameter) {
  const optional = parameter.questionToken !== undefined || parameter.initializer !== undefined;
  const name = `${parameter.dotDotDotToken ? '...' : ''}${parameter.name.getText()}${optional ? '?' : ''}`;
  return parameter.type === undefined ? name : `${name}: ${textOf(parameter.type)}`;
}

function renderSignature(node) {
  const typeParameters = node.typeParameters
    ? `<${node.typeParameters.map((parameter) => parameter.name.text).join(', ')}>`
    : '';
  const result = node.type === undefined ? '' : `: ${textOf(node.type)}`;
  return `${typeParameters}(${node.parameters.map(renderParameter).join(', ')})${result}`;
}

const isSignature = (node) =>
  ts.isFunctionDeclaration(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isMethodSignature(node) ||
  ts.isArrowFunction(node) ||
  ts.isFunctionExpression(node) ||
  ts.isFunctionTypeNode(node);

// Overloaded functions show their first overload signature, not the implementation.
function signatureNodes(declarations) {
  const signatures = declarations.filter(isSignature);
  const overloads = signatures.filter((node) => node.body === undefined || !isImplementation(node));
  return overloads.length > 0 ? overloads : signatures;
}

function isImplementation(node) {
  return (
    (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.body !== undefined
  );
}

function functionLike(declaration) {
  if (isSignature(declaration)) return declaration;
  const value = declaration.initializer ?? declaration.type;
  if (value === undefined) return undefined;
  const inner =
    ts.isAsExpression(value) || ts.isSatisfiesExpression(value) ? value.expression : value;
  return isSignature(inner) ? inner : undefined;
}

function renderFunction(name, declarations) {
  const nodes = signatureNodes(declarations.map((node) => functionLike(node) ?? node));
  if (nodes.length === 0 || !nodes.every(isSignature)) return undefined;
  const more = nodes.length - 1;
  const note = more === 0 ? '' : ` /* +${more} overload${more === 1 ? '' : 's'} */`;
  return `${name}${renderSignature(nodes[0])}${note}`;
}

function defineComponentFields(declaration) {
  const call = declaration.initializer;
  if (call === undefined || !ts.isCallExpression(call)) return undefined;
  if (!/(^|\.)defineComponent$/.test(call.expression.getText())) return undefined;
  const schema = call.arguments[1];
  if (schema === undefined || !ts.isObjectLiteralExpression(schema)) return undefined;
  const fields = new Map();
  for (const property of schema.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(property.initializer)) {
      continue;
    }
    const attributes = new Map(
      property.initializer.properties
        .filter(ts.isPropertyAssignment)
        .map((attribute) => [attribute.name.getText(), attribute.initializer]),
    );
    const type = attributes.get('type');
    const fallback = attributes
      .get('default')
      ?.getText()
      .replace(/^new Float32Array\((.*)\)$/s, '$1');
    const literal =
      fallback !== undefined && /^[-\w.'"]{1,12}$|^\[[-\d., ]{1,24}\]$/.test(fallback);
    fields.set(
      property.name.getText(),
      `${type ? type.getText().replace(/^'|'$/g, '') : 'unknown'}${literal ? ` = ${fallback}` : ''}`,
    );
  }
  return fields;
}

class ApiIndexBuilder {
  constructor(facades) {
    this.program = createProgram(facades.map(facadeEntry));
    this.checker = this.program.getTypeChecker();
    this.exports = new Map();
    for (const facade of facades) {
      const module = this.checker.getSymbolAtLocation(
        this.program.getSourceFile(facadeEntry(facade)),
      );
      this.exports.set(
        facade,
        new Map(this.checker.getExportsOfModule(module).map((symbol) => [symbol.name, symbol])),
      );
    }
  }

  resolve(facade, name) {
    const symbol = this.exports.get(facade)?.get(name);
    if (symbol === undefined)
      throw new Error(`api-index: @forgeax/engine/${facade} has no export ${name}`);
    return symbol.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol;
  }

  members(symbol) {
    const declaration = symbol.declarations?.[0];
    if (symbol.flags & ts.SymbolFlags.ValueModule && declaration && ts.isSourceFile(declaration)) {
      return new Map(
        this.checker.getExportsOfModule(symbol).map((member) => [member.name, member]),
      );
    }
    if (declaration && ts.isVariableDeclaration(declaration)) {
      const value = declaration.initializer;
      const object = value && (ts.isAsExpression(value) ? value.expression : value);
      if (object && ts.isObjectLiteralExpression(object)) {
        return new Map(object.properties.map((property) => [property.name.getText(), property]));
      }
    }
    const type =
      symbol.flags & ts.SymbolFlags.Type
        ? this.checker.getDeclaredTypeOfSymbol(symbol)
        : this.checker.getTypeOfSymbol(symbol);
    return new Map(type.getProperties().map((member) => [member.name, member]));
  }

  memberDeclarations(member) {
    if ('escapedName' in member) return member.declarations ?? [];
    if (ts.isShorthandPropertyAssignment(member)) {
      return this.checker.getShorthandAssignmentValueSymbol(member)?.declarations ?? [];
    }
    if (ts.isPropertyAssignment(member)) {
      const target = ts.isIdentifier(member.initializer)
        ? this.checker.getSymbolAtLocation(member.initializer)
        : undefined;
      return target?.declarations ?? [member];
    }
    return [member];
  }

  renderMember(name, member) {
    const declarations = this.memberDeclarations(member);
    const label = `${name}${declarations[0]?.questionToken ? '?' : ''}`;
    const signature = renderFunction(label, declarations);
    if (signature !== undefined) return signature;
    const declaration = declarations[0];
    if (declaration?.type !== undefined) return `${label}: ${textOf(declaration.type)}`;
    const value = declaration?.initializer;
    return value === undefined ? name : `${name}: ${textOf(value)}`;
  }

  // `fn(param)` / `fn.member(param)` lists properties of a parameter whose type is not exported.
  parameterMembers(facade, path) {
    const [, name, member, parameterName] = /^(\w+)(?:\.(\w+))?\((\w+)\)$/.exec(path) ?? [];
    if (name === undefined) return undefined;
    const symbol = this.resolve(facade, name);
    const owner = member === undefined ? symbol : this.members(symbol).get(member);
    if (owner === undefined)
      throw new Error(`api-index: ${facade} ${name} has no member ${member}`);
    const parameter = signatureNodes(
      this.memberDeclarations(owner).map((node) => functionLike(node) ?? node),
    )
      .flatMap((node) => node.parameters ?? [])
      .find((node) => node.name.getText() === parameterName);
    if (parameter === undefined) throw new Error(`api-index: ${facade} ${path} has no parameter`);
    const type = this.checker.getTypeAtLocation(parameter);
    const properties = new Map();
    for (const part of type.isUnion() ? type.types : [type]) {
      for (const property of part.getProperties()) {
        if (property.declarations?.[0]?.type?.kind === ts.SyntaxKind.NeverKeyword) continue;
        if (!properties.has(property.name)) properties.set(property.name, property);
      }
    }
    return { members: properties };
  }

  // Selected members render as one TypeScript-like body; `...` marks an abridged list.
  renderMembers(facade, name, memberList) {
    const parameter = this.parameterMembers(facade, name);
    const declarations = parameter ? [] : (this.resolve(facade, name).declarations ?? []);
    const members = parameter?.members ?? this.members(this.resolve(facade, name));
    const fields = declarations.map(defineComponentFields).find((value) => value !== undefined);
    const available = fields ?? members;
    const wanted = memberList === '*' ? [...available.keys()] : memberList.split(' ');
    const rendered = wanted.map((memberName) => {
      if (fields?.has(memberName)) return `${memberName}: ${fields.get(memberName)}`;
      const member = members.get(memberName);
      if (member === undefined)
        throw new Error(`api-index: ${facade} ${name} has no member ${memberName}`);
      return this.renderMember(memberName, member);
    });
    const abridged =
      wanted.length < [...available.keys()].filter((key) => !key.startsWith('#')).length;
    return { fields, rendered, abridged };
  }

  renderItem(facade, spec) {
    if (spec.startsWith('+')) {
      const names = spec.slice(1).trim().split(' ');
      for (const name of names) this.resolve(facade, name);
      return `Also: ${names.map((name) => `\`${name}\``).join(', ')}`;
    }
    const [name, memberList] = spec.split(/:\s*/, 2);
    if (memberList === undefined) return this.renderWhole(name, this.resolve(facade, name));
    const { fields, rendered, abridged } = this.renderMembers(facade, name, memberList);
    const body = `${rendered.join('; ')}${abridged ? '; ...' : ''}`;
    return `\`${name} { ${body} }\`${fields ? ' component' : ''}`;
  }

  renderWhole(name, symbol) {
    const declarations = symbol.declarations ?? [];
    const signatures = renderFunction(name, declarations);
    if (signatures !== undefined) return `\`${signatures}\``;
    const fields = declarations.map(defineComponentFields).find((value) => value !== undefined);
    if (fields !== undefined) {
      const body = [...fields].map(([field, type]) => `${field}: ${type}`).join('; ');
      return `\`${name} {${body === '' ? '' : ` ${body} `}}\` component`;
    }
    const declaration = declarations.find((node) => !ts.isSourceFile(node)) ?? declarations[0];
    if (declaration === undefined) throw new Error(`api-index: ${name} has no declaration`);
    return `\`${this.renderDeclaration(name, declaration)}\``;
  }

  renderDeclaration(name, declaration) {
    if (ts.isTypeAliasDeclaration(declaration)) {
      const parameters = declaration.typeParameters
        ? `<${declaration.typeParameters.map((node) => textOf(node)).join(', ')}>`
        : '';
      return `type ${name}${parameters} = ${textOf(declaration.type)}`;
    }
    if (ts.isVariableDeclaration(declaration)) {
      if (declaration.type !== undefined) return `${name}: ${textOf(declaration.type)}`;
      if (declaration.initializer !== undefined) {
        return `${name} = ${textOf(declaration.initializer).replace(/ as const$/, '')}`;
      }
    }
    if (ts.isInterfaceDeclaration(declaration) || ts.isClassDeclaration(declaration)) {
      throw new Error(`api-index: ${name} needs an explicit member list`);
    }
    return name;
  }

  renderReference(facade, path) {
    const [name, member] = path.split('.');
    if (member === undefined) return this.renderWhole(name, this.resolve(facade, name));
    const target = this.members(this.resolve(facade, name)).get(member);
    if (target === undefined)
      throw new Error(`api-index: ${facade} ${name} has no member ${member}`);
    return `\`${name}.${this.renderMember(member, target)}\``;
  }
}

export function renderApiIndex({ sections = SECTIONS, gotchas: notes = GOTCHAS } = {}) {
  const referenced = notes.flatMap((text) =>
    [...text.matchAll(REFERENCE)].map((match) => match[1]),
  );
  const builder = new ApiIndexBuilder([
    ...new Set([...sections.map(([facade]) => facade), ...referenced]),
  ]);
  const gotchas = notes.map(
    (text) =>
      `- ${text.replace(REFERENCE, (_, facade, path) => builder.renderReference(facade, path))}`,
  );
  const body = sections.map(([facade, items]) =>
    [
      `## \`@forgeax/engine/${facade}\``,
      ...items.map((item) => `- ${builder.renderItem(facade, item)}`),
    ].join('\n'),
  );
  return `${[
    '# ForgeaX SDK API index',
    '',
    '> Generated from Engine sources by `node scripts/forgeax/sdk-api-index.mjs`; do not edit.',
    '> Look signatures up here before searching `node_modules`; `...` marks an abridged member list.',
    '',
    '## Gotchas',
    '',
    ...gotchas,
    '',
    body.join('\n\n'),
  ].join('\n')}\n`;
}

export function checkApiIndex() {
  const file = resolve(root, API_INDEX_PATH);
  let expected;
  try {
    expected = renderApiIndex();
  } catch (error) {
    return [`${API_INDEX_PATH}: ${error.message}`];
  }
  const failures = [];
  const bytes = Buffer.byteLength(expected);
  if (bytes > API_INDEX_MAX_BYTES) {
    failures.push(
      `${API_INDEX_PATH}: ${bytes} bytes exceeds ${API_INDEX_MAX_BYTES}; trim SECTIONS`,
    );
  }
  const actual = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  if (actual !== expected) {
    failures.push(`${API_INDEX_PATH}: stale; run node scripts/forgeax/sdk-api-index.mjs`);
  }
  return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    const failures = checkApiIndex();
    if (failures.length > 0) {
      console.error(failures.join('\n'));
      process.exitCode = 1;
    } else {
      console.log(`api-index-ok: ${API_INDEX_PATH}`);
    }
  } else {
    const output = renderApiIndex();
    writeFileSync(resolve(root, API_INDEX_PATH), output);
    console.log(`api-index-written: ${API_INDEX_PATH} (${Buffer.byteLength(output)} bytes)`);
  }
}
