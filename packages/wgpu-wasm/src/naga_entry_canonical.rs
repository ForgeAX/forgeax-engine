//! Canonical form of one compacted compute-entry closure.
//!
//! A closure is cut from a whole program whose identifiers were already chosen
//! by a previous writer pass. Those names carry collision suffixes from every
//! other entry in that program, and Naga compaction keeps every named constant.
//! Two programs whose selected entries are identical therefore produced
//! different text. This pass makes the written text a function of the closure:
//!
//! - named constants that nothing in the closure references are removed;
//! - function arguments, local variables and named expressions lose their
//!   inherited names, so the WGSL writer's Namer assigns fresh unique names in
//!   closure order.
//!
//! Entry points, functions, global variables, used constants, types and struct
//! members keep their names: those are part of the shader's authored interface
//! and reflection.
use naga::{Expression, Handle, Module};

/// Rewrite `module` (already reduced to one entry and compacted) in place.
pub(crate) fn canonicalize_closure(module: &mut Module) {
    if let Some(used) = referenced_constants(module) {
        let mut dropped = false;
        for (handle, constant) in module.constants.iter_mut() {
            if !used[handle.index()] && constant.name.take().is_some() {
                dropped = true;
            }
        }
        if dropped {
            naga::compact::compact(module, naga::compact::KeepUnused::No);
        }
    }
    // Retained names keep their authored spelling: the new bases neither equal
    // one nor prefix one, so the Namer's numeric suffixes cannot shadow them.
    let taken = retained_names(module);
    let argument_base = fresh_base("param", &taken);
    let local_base = fresh_base("local", &taken);
    let value_base = fresh_base("value", &taken);
    let functions = module
        .functions
        .iter_mut()
        .map(|(_, function)| function)
        .chain(
            module
                .entry_points
                .iter_mut()
                .map(|entry| &mut entry.function),
        );
    for function in functions {
        for argument in function.arguments.iter_mut() {
            argument.name = Some(argument_base.clone());
        }
        for (_, local) in function.local_variables.iter_mut() {
            local.name = Some(local_base.clone());
        }
        for name in function.named_expressions.values_mut() {
            name.clone_from(&value_base);
        }
    }
}

/// Module-level names the writer reserves, compared as the Namer sanitizes
/// them (a trailing separator is not significant).
fn retained_names(module: &Module) -> std::collections::BTreeSet<String> {
    let functions = module.functions.iter().map(|(_, f)| f.name.as_deref());
    let globals = module
        .global_variables
        .iter()
        .map(|(_, g)| g.name.as_deref());
    let constants = module.constants.iter().map(|(_, c)| c.name.as_deref());
    let overrides = module.overrides.iter().map(|(_, o)| o.name.as_deref());
    let types = module.types.iter().map(|(_, t)| t.name.as_deref());
    let entries = module.entry_points.iter().map(|e| Some(e.name.as_str()));
    functions
        .chain(globals)
        .chain(constants)
        .chain(overrides)
        .chain(types)
        .chain(entries)
        .flatten()
        .map(|name| name.trim_end_matches('_').to_string())
        .collect()
}

/// A base that neither equals a retained name nor prefixes one with `_`, so
/// no suffix the Namer derives from it (`base_1`, ...) can shadow one either.
fn fresh_base(stem: &str, taken: &std::collections::BTreeSet<String>) -> String {
    let mut base = stem.to_string();
    while taken
        .iter()
        .any(|name| name == &base || name.starts_with(&format!("{base}_")))
    {
        base.push('x');
    }
    base
}

/// Constants reachable from the closure, or `None` when a global expression
/// form is not understood (then every constant is conservatively kept).
fn referenced_constants(module: &Module) -> Option<Vec<bool>> {
    let mut constants = vec![false; module.constants.len()];
    let mut globals = vec![false; module.global_expressions.len()];
    let mut pending: Vec<Handle<Expression>> = Vec::new();
    let functions = module
        .functions
        .iter()
        .map(|(_, function)| function)
        .chain(module.entry_points.iter().map(|entry| &entry.function));
    for function in functions {
        for (_, expression) in function.expressions.iter() {
            if let Expression::Constant(constant) = *expression {
                mark_constant(module, constant, &mut constants, &mut pending);
            }
        }
    }
    for (_, variable) in module.global_variables.iter() {
        pending.extend(variable.init);
    }
    for (_, r#override) in module.overrides.iter() {
        pending.extend(r#override.init);
    }
    for entry in module.entry_points.iter() {
        pending.extend(entry.workgroup_size_overrides.iter().flatten().flatten());
    }
    while let Some(handle) = pending.pop() {
        if std::mem::replace(&mut globals[handle.index()], true) {
            continue;
        }
        let expression = &module.global_expressions[handle];
        if let Expression::Constant(constant) = *expression {
            mark_constant(module, constant, &mut constants, &mut pending);
        }
        if !const_operands(expression, &mut pending) {
            return None;
        }
    }
    Some(constants)
}

fn mark_constant(
    module: &Module,
    constant: Handle<naga::Constant>,
    used: &mut [bool],
    pending: &mut Vec<Handle<Expression>>,
) {
    if !std::mem::replace(&mut used[constant.index()], true) {
        pending.push(module.constants[constant].init);
    }
}

/// Push the operands of a constant expression; `false` for unknown forms.
fn const_operands(expression: &Expression, pending: &mut Vec<Handle<Expression>>) -> bool {
    match *expression {
        Expression::Literal(_)
        | Expression::ZeroValue(_)
        | Expression::Override(_)
        | Expression::Constant(_) => {}
        Expression::Compose { ref components, .. } => pending.extend(components.iter().copied()),
        Expression::Splat { value, .. } => pending.push(value),
        Expression::Access { base, index } => pending.extend([base, index]),
        Expression::AccessIndex { base, .. } => pending.push(base),
        Expression::Swizzle { vector, .. } => pending.push(vector),
        Expression::Unary { expr, .. } | Expression::As { expr, .. } => pending.push(expr),
        Expression::Binary { left, right, .. } => pending.extend([left, right]),
        Expression::Select {
            condition,
            accept,
            reject,
        } => pending.extend([condition, accept, reject]),
        Expression::Relational { argument, .. } => pending.push(argument),
        Expression::Math {
            arg,
            arg1,
            arg2,
            arg3,
            ..
        } => {
            pending.push(arg);
            pending.extend([arg1, arg2, arg3].into_iter().flatten());
        }
        _ => return false,
    }
    true
}
