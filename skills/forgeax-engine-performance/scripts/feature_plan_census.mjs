import { createHash } from 'node:crypto';

/** Source overlay for an existing private App carrier's esbuild onLoad hook.
 * Pass the carrier's TypeScript module; no Engine package or live browser is loaded.
 * Disabled mode returns the exact original bytes, with no import/wrapper/clock.
 *
 * In the existing carrier build, call this for its source onLoad result:
 *   instrumentFeaturePlanCensus(ts, path, text, {
 *     enabled: explicitObservationArm,
 *     runtimeModule: absolutePathToFeaturePlanCensusRuntime,
 *     selection: { windowId, featureIdentity, frameNumber, owner?, generation? },
 *   });
 * Preserve each result's originalSha256/observedSha256/hooks in the arm receipt.
 * The carrier imports featurePlanCensus from the SAME runtimeModule and reads
 * featurePlanCensus().snapshot() after the chosen synchronous transaction.
 * Use the existing complete App workload/output oracle; this is not a timer arm
 * or an ordinary FPS capture. No normal Engine source edit or SDK build is needed.
 */
export function instrumentFeaturePlanCensus(ts, file, source, options = {}) {
  if (options.enabled !== true) return { source, hooks: [], disabled: true };
  const selectedFiles = [
    '/features/host.ts',
    '/features/prepared-gpu-work.ts',
    '/features/prepared-graphics-store.ts',
    '/features/native-resource-admission.ts',
    '/prepare/prepared-graphics-resolver.ts',
  ];
  if (!selectedFiles.some((suffix) => file.endsWith(suffix))) return { source, hooks: [] };
  if (!options.runtimeModule || !options.selection)
    throw new Error('Require runtimeModule and selection');
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits = [],
    hooks = [];
  const at = (pos, text) => edits.push({ pos, text });
  const host = file.endsWith('/features/host.ts');
  const functions = file.endsWith('/features/prepared-gpu-work.ts')
    ? new Set([
        'prepareProgram',
        'prepareBuffer',
        'prepareBufferResource',
        'prepareTextureView',
        'prepareSampler',
        'prepareBindings',
        'resolveBuffer',
        'resolveComputePass',
      ])
    : file.endsWith('/prepare/prepared-graphics-resolver.ts')
      ? new Set(['resolve', 'resolvePipeline', 'resolveBindings', 'resolveBuffer', 'uploadBuffer'])
      : host
        ? new Set(['preparePlanResources', 'projectPlanPasses', 'resolveGraphicsSnapshot'])
        : new Set();
  const labelPrefix = host
    ? 'host'
    : file.endsWith('/features/prepared-gpu-work.ts')
      ? 'gpu-session'
      : 'graphics-resolver';
  const functionName = (n) =>
    n.name?.getText(sf) ??
    (ts.isVariableDeclaration(n.parent) || ts.isPropertyAssignment(n.parent)
      ? n.parent.name.getText(sf)
      : undefined);
  const wrap = (node, label) => {
    if (!node.body || !ts.isBlock(node.body)) return;
    const args = node.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : 'undefined'));
    const token = `__census_${node.pos}`.replaceAll('-', '_');
    at(
      node.body.getStart(sf) + 1,
      `const ${token}=__featureCensus()?.start(${JSON.stringify(label)},[${args.join(',')}]);try{`,
    );
    at(
      node.body.end - 1,
      `}catch(__censusError){__featureCensus().thrown(${token});throw __censusError;}finally{__featureCensus()?.end(${token});}`,
    );
    const returns = (n) => {
      if (n !== node.body && ts.isFunctionLike(n)) return;
      if (ts.isReturnStatement(n)) {
        if (n.expression) {
          const expression = n.expression;
          const knownResult =
            ts.isCallExpression(expression) &&
            ts.isIdentifier(expression.expression) &&
            ['ok', 'err'].includes(expression.expression.text);
          const returnKind = knownResult
            ? label === 'graphics-resolver.uploadBuffer' && expression.expression.text === 'ok'
              ? 'result-physical'
              : label.startsWith('graphics-resolver.resolve')
                ? 'result-resource'
                : 'result-reference'
            : label === 'gpu-session.resolveBuffer'
              ? 'resource'
              : 'opaque';
          at(n.getStart(sf) + 6, ` __featureCensus()?.returned(${token},`);
          at(n.expression.end, `,${JSON.stringify(returnKind)})`);
        } else at(n.getStart(sf) + 6, ` __featureCensus()?.returned(${token},undefined)`);
      }
      ts.forEachChild(n, returns);
    };
    returns(node.body);
    hooks.push(label);
  };
  const visit = (n) => {
    if (ts.isFunctionLike(n) && n.body) {
      const name = functionName(n);
      if (functions.has(name)) wrap(n, `${labelPrefix}.${name}`);
      if (
        file.endsWith('/features/prepared-graphics-store.ts') &&
        ts.isMethodDeclaration(n) &&
        n.parent.name?.text === 'PreparedGraphicsTransactionImpl' &&
        ['prepare', 'lookup', 'validateGraphicsPass'].includes(name)
      )
        wrap(n, `graphics-store.${name}`);
      if (host && name === 'runRenderFeatureFrame') {
        const text = '    const identity = feature.identity;';
        const begin = source.indexOf(text, n.body.pos),
          end = source.indexOf('\n  }\n  ', begin);
        if (begin < 0 || begin > n.end || end < 0 || end > n.end)
          throw new Error('Missing feature iteration seam');
        at(
          begin + text.length,
          '\nconst __censusTransaction=__featureCensus()?.begin(input,identity,errors.length);let __censusEscaped=false;try{',
        );
        const transactionReady = '    if (transaction === undefined) continue;';
        const ready = source.indexOf(transactionReady, begin);
        if (ready < 0 || ready > n.end) throw new Error('Missing prepared transaction seam');
        at(ready + transactionReady.length, '__featureCensus()?.transaction(transaction);');
        at(
          end,
          '}catch(__censusCause){__censusEscaped=true;throw __censusCause;}finally{__featureCensus()?.finish(__censusTransaction,errors.length,__censusEscaped);}',
        );
        hooks.push('host/one-feature-transaction');
      }
    }
    if (
      host &&
      ts.isVariableDeclaration(n) &&
      n.name.getText(sf) === 'scope' &&
      n.initializer?.getText(sf) === 'row.work.scope'
    ) {
      const statement = n.parent.parent;
      at(statement.end, '__featureCensus()?.scope(scope);');
      hooks.push('host/work-scope');
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ((n.expression.name.text === 'writeBuffer' &&
        n.expression.expression.getText(sf) === 'input.device.queue') ||
        (file.endsWith('/prepare/prepared-graphics-resolver.ts') &&
          n.expression.expression.getText(sf) === 'input' &&
          ['resolvePipeline', 'resolveBindings', 'resolveGpuBuffer'].includes(
            n.expression.name.text,
          )))
    ) {
      const receiver = n.expression.expression.getText(sf),
        method = n.expression.name.text;
      const category = method === 'writeBuffer' ? 'upload' : 'provider';
      // Replace only this call's receiver/method text, preserving all argument expressions.
      edits.push({
        pos: n.expression.getStart(sf),
        end: n.expression.end,
        text: `(__featureCensus()?.isActive()?__featureCensus().method(${receiver},${JSON.stringify(method)},${JSON.stringify(category)})`,
      });
      // The unobserved branch invokes the original expression, without wrapping.
      at(n.end, `:${n.getText(sf)})`);
      hooks.push(category === 'upload' ? 'physical/upload' : `provider/${method}`);
    }
    if (
      file.endsWith('/features/native-resource-admission.ts') &&
      ts.isMethodDeclaration(n) &&
      n.parent.name?.text === 'PreparedResourceLookup' &&
      n.name.getText(sf) === 'get'
    ) {
      const original =
        'return super.get(name) ?? this.parent?.get(name) ?? this.fallback?.get(name);';
      const pos = source.indexOf(original, n.body.pos);
      if (pos < 0 || pos > n.end) throw new Error('Missing inherited lookup seam');
      edits.push({
        pos,
        end: pos + original.length,
        text: 'return __featureCensus()?.isActive()?(__featureCensus().lookup("local",name,super.get(name))??__featureCensus().lookup("inherited",name,this.parent?.get(name))??__featureCensus().lookup("fallback",name,this.fallback?.get(name))):(super.get(name)??this.parent?.get(name)??this.fallback?.get(name));',
      });
      hooks.push('resource-map/local-inherited-fallback');
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!hooks.length) return { source, hooks };
  at(
    0,
    `import {featurePlanCensus as __featureCensus${host ? ',configureFeaturePlanCensus as __configureFeatureCensus' : ''}} from ${JSON.stringify(options.runtimeModule)};\n${host ? `__configureFeatureCensus(${JSON.stringify(options.selection)});\n` : ''}`,
  );
  let result = source;
  for (const edit of edits.sort((a, b) => b.pos - a.pos))
    result = result.slice(0, edit.pos) + edit.text + result.slice(edit.end ?? edit.pos);
  const parsed = ts.createSourceFile(file, result, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (parsed.parseDiagnostics.length) {
    const error = parsed.parseDiagnostics[0];
    throw new Error(
      `Census overlay syntax failure in ${file}: ${error.messageText}: ${result.slice(error.start - 90, error.start + 90)}`,
    );
  }
  return {
    source: result,
    hooks,
    originalSha256: createHash('sha256').update(source).digest('hex'),
    observedSha256: createHash('sha256').update(result).digest('hex'),
  };
}
