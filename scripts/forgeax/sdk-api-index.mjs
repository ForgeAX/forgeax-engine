// Generates the game-facing SDK API reference from Engine sources: a short
// directory (`api-index.md`) and one small file per domain (`api/<domain>.md`),
// so an agent reads only the domain its task needs.
//
//   node scripts/forgeax/sdk-api-index.mjs                    print every file
//   node scripts/forgeax/sdk-api-index.mjs --output <dir>     write <dir>/api-index.md and <dir>/api/*.md
//   node scripts/forgeax/sdk-api-index.mjs --check            validate source signatures and sizes
//   node scripts/forgeax/sdk-api-index.mjs --check --output <dir>  also check those documents
//
// DOMAINS is the curated allowlist: each section is an export of a public
// `@forgeax/engine/<facade>` and optionally the members to show. Signatures and
// component fields are read from source declarations, so a rename, removal or
// signature change fails `pnpm skills:check` until the reference is regenerated.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Whole reference, all files: rendering entries (spot aim, additive blend, shadow opt-out,
// custom surface + per-frame uniform, Camera exposure, Atmosphere fields, light units),
// every procedural geometry factory signature and the runtime mesh write API, the
// playthrough helper (including release play), plus per-file headers. A task reads the
// directory and one file.
export const API_INDEX_MAX_BYTES = 27 * 1024;
// One file is read in a single tool call; keep each well under a context-heavy read.
export const API_FILE_MAX_BYTES = 6 * 1024;
/** The directory file; domain files live beside it under `api/`. */
export const API_INDEX_FILE = 'api-index.md';

const DOMAINS = [
  {
    id: 'core',
    title: 'Core: imports, results, ECS, plugins, scene, math',
    covers:
      'Result, World/systems/queries, Plugin and Context, GameHost, Transform, vec3/quat, packs',
    sections: [
      [
        'types',
        [
          'ok',
          'err',
          'Result',
          'RenderQueue',
          'MaterialRenderState: cullMode depthWriteEnabled blend',
          '+AssetHandle',
        ],
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
      ['app', ['GameHost: canvas uiRoot assets port gameProjection setPointerLockAllowed']],
      [
        'scene',
        [
          'Transform',
          'worldResolveSceneEntity',
          'sceneEntity',
          'readPresentationWorldMatrix',
          'setTransformLookAt',
          '+Name worldDespawnScene GlobalTransform ChildOf Children PROPAGATE_TRANSFORMS_SYSTEM',
        ],
      ],
      [
        'math',
        [
          'vec3: create add sub scale normalize distance lerp',
          'quat: create fromEuler fromAxisAngle fromLookAt multiply slerp',
          'ray: getOrigin getDirection',
          'rng: create',
          'EulerOrder',
          '+vec2 vec4 mat3 mat4 euler color box3 easing noise',
        ],
      ],
      ['pack/source', ['definePack', 'definePackageId']],
    ],
    gotchas: [
      'Import from `@forgeax/engine/<facade>` only, never physical `@forgeax/engine-*` packages.',
      'Expected failures return `Result` (`r.ok ? r.value : r.error`, `.unwrap()` throws): World methods, asset loads, geometry, pack builds.',
      'Math values are branded `Float32Array`s from `vec3.create(x, y, z)` / `quat.create()`; functions write into `out` and return it. Component data takes plain arrays (`{ pos: [0, 1, 0] }`).',
      'Pack output keys (sourceKeys) must match {{pack/guid PACK_SOURCE_KEY_RE}} (lower case).',
      "Declare every service a plugin reads in `inject` (`inject: ['world', 'assets', 'gameHost']`); add systems inside `ctx.effect` and `yield` their removal.",
    ],
  },
  {
    id: 'render',
    title: 'Rendering: camera, lights, sky, fog, materials',
    covers:
      'Camera and exposure, light units, Atmosphere, Fog, MeshRenderer, Materials, transparency',
    sections: [
      [
        'render',
        [
          'perspective(opts): fov aspect near far autoAspect',
          'orthographic(opts): left right bottom top near far',
          'Camera: clearColor tonemap exposure exposureMode compensationEv rangeEv rates antialias bloom bloomThreshold bloomIntensity',
          'DirectionalLight: direction color intensity castShadow',
          'PointLight: color intensity range',
          'SpotLight: direction color intensity range innerConeDeg outerConeDeg castShadow',
          'Skylight: color groundColor intensity',
          'Fog: color mode near far skyOpacity',
          'Atmosphere: *',
          'ShadowParticipation: cast receive',
          'Visibility: state',
          'MeshFilter',
          'MeshRenderer: materials',
          'Materials.standard(options): baseColor metallic roughness emissive emissiveIntensity baseColorTexture alphaCutoff renderState queue surfaceModule parameters values',
          'Materials.unlit(opts): baseColorTexture alphaTexture alphaCutoff alphaMode blendMode renderState queue',
          '+setActiveCamera SkyboxBackground CAMERA_EXPOSURE_MODE_AUTO CAMERA_EXPOSURE_MODE_MANUAL TONEMAP_ACES_FILMIC ANTIALIAS_FXAA BLOOM_ENABLED FogModeValue VisibilityStateValue VolumetricFog Lines Points Instances CanvasTexture PlanarReflection',
        ],
      ],
    ],
    gotchas: [
      'Camera data: `{ ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }), tonemap: TONEMAP_ACES_FILMIC }`; `fov` is radians. Sky: bind a generated HDR equirect asset to `SkyboxBackground` and `Skylight`; an opaque `clearColor` is tone-mapped. `DirectionalLight.direction` points from the light (opposite of Three.js).',
      'Exposure is manual (keep it for a fixed sun). Auto (`CAMERA_EXPOSURE_MODE_AUTO`) meters within `rangeEv` (`[min, max]` EV) at `rates` (`[up, down]` EV/s), offset by `compensationEv`; `exposure` is then the fallback multiplier until the meter commits. It restarts on camera changes; judge a settled frame.',
      'Light units: `PointLight` / `SpotLight` `intensity` is candela, `DirectionalLight` `intensity` is illuminance (lux-like). A point light of I cd lights a surface d m away with I/d^2. Bloom starts at `bloomThreshold` (after exposure); the default -1 blooms the whole frame, 1 keeps only above-white highlights.',
      '`Atmosphere` draws the sky and a sun disc opposite `DirectionalLight.direction` and reddens a low sun itself. The first shadow-casting `DirectionalLight` (else the first) is both sky sun and key light. Under `Atmosphere`, `Fog` already scatters sky and sun light and adds `color` on top: leave its black default (as Unreal), or haze turns the horizon white.',
      'Under `Atmosphere` a `Skylight` without `equirect` is the sky radiance times `intensity`, so the ambient follows the sun.',
      "No `opacity` field: use `baseColor` alpha plus `renderState: { blend, depthWriteEnabled: false }` and `queue: RenderQueue.Transparent`; per entity: bind an `assets.copy`, `assets.update` its `baseColor`. Additive: `color: { srcFactor: 'src-alpha', dstFactor: 'one' }`.",
      '`SpotLight` takes its position from `Transform` but aims by its world `direction` field (not Transform rotation); cone angles are half-angles in degrees. Beam: `createConeGeometry(r, h, 48, 1, true)` (open-ended). Blended-only meshes cast no shadow unless `ShadowParticipation { cast: true }`.',
      'Particles (rain, snow, sparks, fire, dust): `point-list` mesh + `color`/`uv1` streams + `Points { size, sizeUnits: world, shape: soft }` + blended unlit material; `writeRange` per frame (see cookbook index). 10k+: VFX.',
      'Custom lit shader: `Materials.standard({ surfaceModule, parameters, values })` names an `assets/` `.wgsl` module (`#define_import_path`) exporting `evaluate_surface(input: SurfaceInput) -> SurfaceData` from `forgeax_material::surface_v1`; read parameters as `material.<name>` and seconds as `input.frameTime`. Feed a uniform per frame with `assets.update(handle, { values: { name } })`.',
    ],
  },
  {
    id: 'geometry',
    title: 'Geometry and runtime assets',
    covers:
      'procedural mesh factories, MeshBuilder, extrusion and sweeps, AssetRegistry create/update/writeRange',
    sections: [
      [
        'geometry',
        [
          'createBoxGeometry',
          'createSphereGeometry',
          'createPlaneGeometry',
          'createCylinderGeometry',
          'createCapsuleGeometry',
          'createConeGeometry',
          'createTorusGeometry',
          'createIcosahedronGeometry',
          'createDodecahedronGeometry',
          'createOctahedronGeometry',
          'createTetrahedronGeometry',
          'create2dGeometry',
          'create2dRingGeometry',
          'createEdgesGeometry',
          'createRevolutionGeometry',
          'createExtrusionGeometry',
          'ExtrusionOptions: *',
          'createProfileSweepGeometry',
          'ProfileSweepOptions: *',
          'createSweepGeometry',
          'PolygonShape: *',
          'Vec2Point: *',
          'Vec3Point',
          'createMeshBuilder',
          'MeshBuilderOptions: *',
          'MeshBuilder: *',
          'meshFromInterleaved',
          'PROCEDURAL_FLOATS_PER_VERTEX',
        ],
      ],
      [
        'assets-runtime',
        [
          'AssetRegistry: load create release instantiate read update replace writeRange copy',
          'MeshRange',
        ],
      ],
    ],
    gotchas: [
      'Pack or runtime: build-time content (meshes, materials) is a `.pack.ts` output: `parameters` for variants, GUID `AssetGuid.derive(packageId, sourceKey)` from `@forgeax/engine/pack/guid`, `assets.load(guid, kind)`. Play-time content is `assets.create(mesh)`: bind the handle, then `release` it (the binding holds a reference). Change vertices with `writeRange` (same vertex count, per frame) or `replace` (new topology); material `values` never move vertices.',
      'Standard materials read normal, uv and a vec4 `tangent`. Geometry factories, `meshFromInterleaved` and `createMeshBuilder` (triangle lists) derive omitted ones; other topologies author them.',
      'Procedural variation is a pure function of a seed: a Pack `seed` parameter or math `rng.create(seed)`. Never `Math.random()` or `Date.now()` in a Pack `build`: its output is cached.',
    ],
  },
  {
    id: 'gameplay',
    title: 'Gameplay: input, picking, physics, animation, audio, VFX, UI, state, navigation',
    covers:
      'InputSnapshot, viewportToWorld/pick, RigidBody/Collider/PhysicsWorld, AnimationPlayer, AudioSource, mountUi',
    sections: [
      [
        'input',
        ['INPUT_SNAPSHOT_RESOURCE_KEY', 'InputSnapshot: keyboard mouse', '+getAxis getVector'],
      ],
      ['picking', ['viewportToWorld', 'pick', 'PickHit: *', '+pickTriangle pickVertex pickTile']],
      [
        'physics',
        [
          'RigidBody: type mass linearDamping gravityScale lockRotation',
          'RigidBodyTypeValue',
          'Collider: shape halfExtents radius halfHeight friction isSensor',
          'ColliderShapeValue',
          'CharacterController: snapToGroundDist grounded',
          'PhysicsWorld: raycast moveAndSlide teleport applyBodyImpulse setBodyMotion',
        ],
      ],
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
    ],
    gotchas: [
      'Screen to ground: `viewportToWorld` (canvas pixels, top-left origin, after transform propagation) returns a world ray; solve `origin.y + t * dir.y = 0` for the ground. `pick` returns the nearest entity AABB hit.',
      'Input: in a system read `world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY)`; `mouse.position` (canvas pixels, hover) may be `undefined`.',
    ],
  },
  {
    id: 'play',
    title: 'Playthrough scripts: PlayContext',
    covers: '`project play` script helper: keyboard, mouse, state reads, game time, screenshots',
    sections: [
      [
        'devkit',
        [
          'PlayContext: *',
          'PlayPoint',
          'PlayWaitOptions: *',
          'PlayAdvanceOptions: *',
          'PlayStepOptions: *',
          'PlayScreenshot: *',
        ],
      ],
    ],
    gotchas: [
      "A playthrough module default-exports `async (play) => ...`; type it with `/** @param {import('@forgeax/engine/devkit').PlayContext} play */`. Run it with `forgeax project play <script> --json`; `forgeax help project play --json` prints the same helper list. With a `forgeax dev start` owner running, `--session` reloads that owner's page and plays there, skipping the cold browser and dev server start.",
      'Points are canvas-normalized: `[0, 0]` top-left, `[1, 1]` bottom-right. Under pointer lock the cursor does not move: the game must read mouse `movementDelta`, never `position`; `mouse.look(dx, dy)` sends a `movementDelta` in pixels, and a right-button `mouse.drag` produces one too. A cursor-aimed game calls `gameHost.setPointerLockAllowed(false)`.',
      '`state(read)` and `waitFor(predicate, { read, timeoutMs })` read a projection the game registers with `gameHost.gameProjection.registerRead({ id, read })`; `read` defaults to the only one. `advance(seconds)` steps game time without waiting real time (timers, cooldowns). `step(name, run, { setup })` labels work: a failure reports the innermost step and `detail.rerun`, a `--from <step>` command that restarts at the failed top-level step, or the whole run plus `detail.setupHint` when that step has no `setup`. `--from` / `--steps a..b` skip the steps before the range without sending their input; the first step of a range runs its `setup(play)` to reach its starting state. `--time-scale <n>` runs the game in lockstep with the script on fixed 1/60 s frames (physics and input on the same frames), at most n game seconds per wall second: game time stands still between helper calls and advances only inside `wait`, `hold`, `waitFor`, `press` and `click`; `waitFor` and predicate holds check the state every 3 frames, and waits, holds and wait timeouts count game time.',
      '`screenshot(name)` captures canvas and DOM UI; the report `warnings` cover script usage only, never how the frame looks, so open the PNG. `press` and `click` hold until three more Engine frames complete.',
      '`--release` runs the same script against the built static release (`forgeax project build` first, `--dist <dir>` if elsewhere) in real time; that run is the final acceptance, and a script tuned only under `--time-scale` can fail it. `state`, `waitFor` and hold predicates read the registered read projection on both builds (read-only, so what `registerRead` returns is visible in a shipped build); `advance` needs the development host, so guard it with `play.release`. Requests to other hosts are blocked, listed in `externalRequests` and fail the run.',
    ],
  },
];

// `{{facade name}}` / `{{facade name.member}}` expands to the generated code span.
const REFERENCE = /\{\{(\S+) (\S+)\}\}/g;

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
    // An enum field names the object of its codes: `mode: enum FogModeValue = FogModeValue.exp`.
    const labels = attributes.get('labels');
    const codes = labels !== undefined && ts.isIdentifier(labels) ? labels.text : undefined;
    const literal =
      fallback !== undefined &&
      (/^[-\w.'"]{1,12}$|^\[[-\d., ]{1,24}\]$/.test(fallback) ||
        (codes !== undefined && fallback.startsWith(`${codes}.`)));
    const kind = type ? type.getText().replace(/^'|'$/g, '') : 'unknown';
    fields.set(
      property.name.getText(),
      `${kind}${codes === undefined ? '' : ` ${codes}`}${literal ? ` = ${fallback}` : ''}`,
    );
  }
  return fields;
}

/** Longest enum-like object listed with its values. */
const ENUM_TEXT_MAX = 96;

/** `1`, `'name'` or `true` for a literal type, else undefined. */
function literalOf(type) {
  if (type.isNumberLiteral()) return String(type.value);
  if (type.isStringLiteral()) return `'${type.value}'`;
  if (type.flags & ts.TypeFlags.BooleanLiteral) return type.intrinsicName;
  return undefined;
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

  /**
   * The value of an exported constant typed as a literal (`= 1`) or as an object of number
   * literals (`= { exp: 0, exp2: 1 }`), so enum codes appear beside their names.
   */
  constantValue(symbol) {
    if (!(symbol.flags & ts.SymbolFlags.BlockScopedVariable)) return undefined;
    const type = this.checker.getTypeOfSymbol(symbol);
    const literal = literalOf(type);
    if (literal !== undefined) return literal;
    const properties = type.getProperties();
    if (properties.length === 0 || type.getCallSignatures().length > 0) return undefined;
    const entries = properties.map((property) => {
      const value = this.checker.getTypeOfSymbol(property);
      return value.isNumberLiteral() ? `${property.name}: ${value.value}` : undefined;
    });
    if (entries.some((entry) => entry === undefined)) return undefined;
    const text = `{ ${entries.join(', ')} }`;
    return text.length <= ENUM_TEXT_MAX ? text : undefined;
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
      const listed = names.map((name) => {
        const value = this.constantValue(this.resolve(facade, name));
        return `\`${name}${value === undefined ? '' : ` = ${value}`}\``;
      });
      return `Also: ${listed.join(', ')}`;
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

/** Domain file path relative to the directory file. */
export const apiDomainFile = (id) => `api/${id}.md`;

/**
 * Renders the API reference as `{ [relativePath]: markdown }`: the directory
 * `api-index.md` first, then one `api/<domain>.md` per domain.
 */
export function renderApiReference({ domains = DOMAINS } = {}) {
  const referenced = domains.flatMap(({ gotchas }) =>
    gotchas.flatMap((text) => [...text.matchAll(REFERENCE)].map((match) => match[1])),
  );
  const builder = new ApiIndexBuilder([
    ...new Set([
      ...domains.flatMap(({ sections }) => sections.map(([facade]) => facade)),
      ...referenced,
    ]),
  ]);
  // The SDK entry owns guide navigation; generation never fetches external manuals.
  const entry = readFileSync(resolve(root, 'skills/forgeax-engine-sdk/SKILL.md'), 'utf8');
  const threeGuide = entry.match(/\]\(([^)\s]*\/three-equivalents\.md)\)/)?.[1];
  const generated = '> Source-generated by `node scripts/forgeax/sdk-api-index.mjs`.';
  const files = {
    [API_INDEX_FILE]: `${[
      '# ForgeAX SDK API index',
      '',
      generated,
      ...(threeGuide === undefined
        ? []
        : [`> Three.js names map to these APIs in [three-equivalents.md](${threeGuide}).`]),
      '',
      'Open only the domain file you need; each lists gotchas first, then signatures.',
      '',
      '| File | Facades | Covers |',
      '| --- | --- | --- |',
      ...domains.map(
        ({ id, title, covers, sections }) =>
          `| [${title}](${apiDomainFile(id)}) | ${sections.map(([facade]) => `\`${facade}\``).join(', ')} | ${covers} |`,
      ),
    ].join('\n')}\n`,
  };
  for (const { id, title, sections, gotchas } of domains) {
    const notes = gotchas.map(
      (text) =>
        `- ${text.replace(REFERENCE, (_, facade, path) => builder.renderReference(facade, path))}`,
    );
    const body = sections.map(([facade, items]) =>
      [
        `## \`@forgeax/engine/${facade}\``,
        ...items.map((item) => `- ${builder.renderItem(facade, item)}`),
      ].join('\n'),
    );
    files[apiDomainFile(id)] = `${[
      `# ${title}`,
      '',
      `${generated} Directory: [api-index.md](../${API_INDEX_FILE}).`,
      ...(notes.length === 0 ? [] : ['', '## Gotchas', '', ...notes]),
      '',
      body.join('\n\n'),
    ].join('\n')}\n`;
  }
  return files;
}

/** One domain from explicit sections and gotchas (tests and ad-hoc checks). */
export function apiDomain(sections, gotchas = [], id = 'api') {
  return { id, title: 'API', covers: 'selected entries', sections, gotchas };
}

/** The whole reference as one string, directory first (content searches). */
export function renderApiIndex(options) {
  return Object.values(renderApiReference(options)).join('\n');
}

/**
 * Validates generation, the size budgets and that the directory links every
 * domain file; with `directory`, also that each written file is current.
 */
export function checkApiIndex(directory) {
  const label = directory ?? 'api reference';
  let files;
  try {
    files = renderApiReference();
  } catch (error) {
    return [`${label}: ${error.message}`];
  }
  const failures = [];
  let total = 0;
  for (const [path, content] of Object.entries(files)) {
    const bytes = Buffer.byteLength(content);
    total += bytes;
    if (bytes > API_FILE_MAX_BYTES)
      failures.push(
        `${path}: ${bytes} bytes exceeds ${API_FILE_MAX_BYTES}; split or trim the domain`,
      );
    if (path !== API_INDEX_FILE && !files[API_INDEX_FILE].includes(`](${path})`))
      failures.push(`${API_INDEX_FILE}: does not link ${path}`);
  }
  if (total > API_INDEX_MAX_BYTES)
    failures.push(`${label}: ${total} bytes exceeds ${API_INDEX_MAX_BYTES}; trim DOMAINS`);
  if (directory !== undefined) {
    for (const [path, expected] of Object.entries(files)) {
      const file = resolve(directory, path);
      const actual = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
      if (actual !== expected)
        failures.push(`${file}: missing or stale; regenerate with --output ${directory}`);
    }
  }
  return failures;
}

/** Writes every reference file under `directory`; returns `[path, bytes]` pairs. */
export function writeApiReference(directory) {
  return Object.entries(renderApiReference()).map(([path, content]) => {
    const file = resolve(directory, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return [path, Buffer.byteLength(content)];
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outputIndex = process.argv.indexOf('--output');
  const directory = outputIndex < 0 ? undefined : process.argv[outputIndex + 1];
  if (outputIndex >= 0 && (directory === undefined || directory.startsWith('--')))
    throw new Error('--output requires a destination directory');
  if (process.argv.includes('--check')) {
    const failures = checkApiIndex(directory === undefined ? undefined : resolve(directory));
    if (failures.length > 0) {
      console.error(failures.join('\n'));
      process.exitCode = 1;
    } else {
      console.log(`api-index-ok: ${directory ?? 'source signatures'}`);
    }
  } else if (directory === undefined) {
    for (const [path, content] of Object.entries(renderApiReference()))
      process.stdout.write(`<!-- ${path} -->\n${content}\n`);
  } else {
    for (const [path, bytes] of writeApiReference(resolve(directory)))
      console.log(`api-index-written: ${resolve(directory, path)} (${bytes} bytes)`);
  }
}
