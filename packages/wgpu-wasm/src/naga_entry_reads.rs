//! Build-time resource reads of each entry, following helper arguments and returns.
//! Aggregate copies keep their origin until a member is selected. Unknown aggregate
//! consumption conservatively reads its complete originating structure.
use naga::valid::ModuleInfo;
use naga::{AddressSpace, Expression, Function, Handle, Module, Statement, Type, TypeInner};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Serialize)]
pub struct EntryReads {
    pub name: String,
    pub stage: &'static str,
    pub bindings: Vec<BindingReads>,
}
#[derive(Serialize)]
pub struct BindingReads {
    pub group: u32,
    pub binding: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<String>>,
}
#[derive(Clone, PartialEq, Eq)]
struct Origin {
    global: Handle<naga::GlobalVariable>,
    ty: Handle<Type>,
    field: Option<u32>,
}
type Reads = BTreeMap<usize, Option<BTreeSet<u32>>>;

fn statements<'a>(block: &'a naga::Block, out: &mut Vec<&'a Statement>) {
    for statement in block.iter() {
        out.push(statement);
        match statement {
            Statement::Block(body) => statements(body, out),
            Statement::If { accept, reject, .. } => {
                statements(accept, out);
                statements(reject, out);
            }
            Statement::Switch { cases, .. } => {
                for case in cases {
                    statements(&case.body, out);
                }
            }
            Statement::Loop {
                body, continuing, ..
            } => {
                statements(body, out);
                statements(continuing, out);
            }
            _ => {}
        }
    }
}
fn extend(to: &mut Vec<Origin>, from: Vec<Origin>) {
    for origin in from {
        if !to.contains(&origin) {
            to.push(origin);
        }
    }
}
struct FunctionReads<'a, 'r> {
    module: &'a Module,
    function: &'a Function,
    arguments: Vec<Vec<Origin>>,
    statements: Vec<&'a Statement>,
    memo: Vec<Option<Vec<Origin>>>,
    active: Vec<bool>,
    reads: &'r mut Reads,
}
impl<'a, 'r> FunctionReads<'a, 'r> {
    fn new(
        module: &'a Module,
        function: &'a Function,
        arguments: Vec<Vec<Origin>>,
        reads: &'r mut Reads,
    ) -> Self {
        let mut body = Vec::new();
        statements(&function.body, &mut body);
        Self {
            module,
            function,
            arguments,
            statements: body,
            memo: vec![None; function.expressions.len()],
            active: vec![false; function.expressions.len()],
            reads,
        }
    }
    fn record(&mut self, origins: Vec<Origin>) {
        for origin in origins {
            let entry = self
                .reads
                .entry(origin.global.index())
                .or_insert_with(|| Some(BTreeSet::new()));
            if let Some(field) = origin.field {
                if let Some(fields) = entry {
                    fields.insert(field);
                }
            } else {
                *entry = None;
            }
        }
    }
    fn member(&self, mut origin: Origin, index: Option<u32>) -> Origin {
        match &self.module.types[origin.ty].inner {
            TypeInner::Struct { members, .. } => {
                if let Some(index) = index {
                    if let Some(member) = members.get(index as usize) {
                        if origin.field.is_none() {
                            origin.field = Some(index);
                        }
                        origin.ty = member.ty;
                    }
                }
            }
            TypeInner::Array { base, .. } | TypeInner::Pointer { base, .. } => {
                origin.ty = *base;
            }
            _ => {}
        }
        origin
    }
    fn origins(&mut self, handle: Handle<Expression>) -> Vec<Origin> {
        if let Some(value) = &self.memo[handle.index()] {
            return value.clone();
        }
        // Local mutation cycles do not introduce a new source; other stores
        // and argument origins are still visited by this invocation.
        if self.active[handle.index()] {
            return Vec::new();
        }
        self.active[handle.index()] = true;
        let result = match self.function.expressions[handle].clone() {
            Expression::GlobalVariable(global)
                if self.module.global_variables[global].binding.is_some() =>
            {
                vec![Origin {
                    global,
                    ty: self.module.global_variables[global].ty,
                    field: None,
                }]
            }
            Expression::FunctionArgument(index) => self
                .arguments
                .get(index as usize)
                .cloned()
                .unwrap_or_default(),
            Expression::AccessIndex { base, index } => self
                .origins(base)
                .into_iter()
                .map(|v| self.member(v, Some(index)))
                .collect(),
            Expression::Access { base, .. } => self
                .origins(base)
                .into_iter()
                .map(|v| self.member(v, None))
                .collect(),
            Expression::Load { pointer } => self.origins(pointer),
            Expression::Select { accept, reject, .. } => {
                let mut a = self.origins(accept);
                extend(&mut a, self.origins(reject));
                a
            }
            Expression::LocalVariable(local) => {
                let mut values = self.function.local_variables[local]
                    .init
                    .map(|value| self.origins(value))
                    .unwrap_or_default();
                let stores: Vec<_> = self
                    .statements
                    .iter()
                    .filter_map(|statement| match statement {
                        Statement::Store { pointer, value }
                            if self.local_root(*pointer) == Some(local) =>
                        {
                            Some(*value)
                        }
                        _ => None,
                    })
                    .collect();
                for value in stores {
                    extend(&mut values, self.origins(value));
                }
                values
            }
            Expression::GlobalVariable(global) => {
                let stores: Vec<_> = self.statements.iter().filter_map(|statement| match statement {
                    Statement::Store { pointer, value } if matches!(self.function.expressions[*pointer], Expression::GlobalVariable(found) if found == global) => Some(*value), _ => None,
                }).collect();
                let mut values = Vec::new();
                for value in stores {
                    extend(&mut values, self.origins(value));
                }
                values
            }
            Expression::CallResult(_) => {
                let call = self
                    .statements
                    .iter()
                    .find_map(|statement| match statement {
                        Statement::Call {
                            function,
                            arguments,
                            result: Some(result),
                        } if *result == handle => Some((*function, arguments.clone())),
                        _ => None,
                    });
                if let Some((function, arguments)) = call {
                    self.call(function, &arguments)
                } else {
                    Vec::new()
                }
            }
            _ => Vec::new(),
        };
        self.active[handle.index()] = false;
        self.memo[handle.index()] = Some(result.clone());
        result
    }
    fn local_root(&self, expression: Handle<Expression>) -> Option<Handle<naga::LocalVariable>> {
        match self.function.expressions[expression] {
            Expression::LocalVariable(local) => Some(local),
            Expression::Access { base, .. } | Expression::AccessIndex { base, .. } => {
                self.local_root(base)
            }
            _ => None,
        }
    }
    fn call(
        &mut self,
        function: Handle<Function>,
        arguments: &[Handle<Expression>],
    ) -> Vec<Origin> {
        let origins = arguments.iter().map(|value| self.origins(*value)).collect();
        let mut child = FunctionReads::new(
            self.module,
            &self.module.functions[function],
            origins,
            self.reads,
        );
        child.scan(false)
    }
    fn scan(&mut self, entry: bool) -> Vec<Origin> {
        for (handle, expression) in self.function.expressions.iter() {
            match expression {
                Expression::Load { .. }
                | Expression::AccessIndex { .. }
                | Expression::Access { .. } => {
                    let origins = self
                        .origins(handle)
                        .into_iter()
                        .filter(|origin| {
                            !matches!(
                                self.module.types[origin.ty].inner,
                                TypeInner::Struct { .. }
                                    | TypeInner::Array { .. }
                                    | TypeInner::Pointer { .. }
                            )
                        })
                        .collect();
                    self.record(origins);
                }
                Expression::Compose { components, .. } => {
                    for component in components {
                        let origins = self.origins(*component);
                        self.record(origins);
                    }
                }
                Expression::CallResult(_) => {
                    self.origins(handle);
                }
                _ => {}
            }
        }
        let mut returns = Vec::new();
        for statement in self.statements.clone() {
            match statement {
                Statement::Call {
                    function,
                    arguments,
                    result: None,
                } => {
                    self.call(*function, arguments);
                }
                Statement::Return { value: Some(value) } => {
                    let origins = self.origins(*value);
                    if entry {
                        self.record(origins.clone());
                    }
                    extend(&mut returns, origins);
                }
                Statement::Store { pointer, value }
                    if !matches!(
                        self.function.expressions[*pointer],
                        Expression::LocalVariable(_)
                    ) =>
                {
                    // A partial local, pointer-argument or private-global store
                    // can move an aggregate into a different enclosing shape.
                    // Preserve the source structure conservatively rather than
                    // interpreting the destination member index as its index.
                    let origins = self.origins(*value);
                    self.record(origins);
                }
                _ => {}
            }
        }
        returns
    }
}

pub fn derive(module: &Module, info: &ModuleInfo) -> Vec<EntryReads> {
    module
        .entry_points
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let mut reads = Reads::new();
            FunctionReads::new(module, &entry.function, Vec::new(), &mut reads).scan(true);
            let mut bindings = Vec::new();
            for (handle, global) in module.global_variables.iter() {
                let Some(binding) = global.binding else {
                    continue;
                };
                if info.get_entry_point(index)[handle].is_empty() {
                    continue;
                }
                let mut ty = global.ty;
                while let TypeInner::Array { base, .. } = module.types[ty].inner {
                    ty = base;
                }
                let fields = match (&global.space, &module.types[ty].inner) {
                    (
                        AddressSpace::Uniform | AddressSpace::Storage { .. },
                        TypeInner::Struct { members, .. },
                    ) => Some(match reads.get(&handle.index()) {
                        Some(Some(indices)) => indices
                            .iter()
                            .filter_map(|field| members.get(*field as usize)?.name.clone())
                            .collect(),
                        _ => members
                            .iter()
                            .filter_map(|member| member.name.clone())
                            .collect(),
                    }),
                    _ => None,
                };
                bindings.push(BindingReads {
                    group: binding.group,
                    binding: binding.binding,
                    fields,
                });
            }
            bindings.sort_by_key(|binding| (binding.group, binding.binding));
            EntryReads {
                name: entry.name.clone(),
                stage: match entry.stage {
                    naga::ShaderStage::Vertex => "vertex",
                    naga::ShaderStage::Fragment => "fragment",
                    naga::ShaderStage::Compute => "compute",
                    _ => "unknown",
                },
                bindings,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn reflect(source: &str) -> serde_json::Value {
        let module = naga::front::wgsl::parse_str(source).unwrap();
        let info = naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::all(),
        )
        .validate(&module)
        .unwrap();
        serde_json::to_value(derive(&module, &info)).unwrap()
    }
    #[test]
    fn entry_reads_follow_helper_struct_arguments_and_returns() {
        let result = reflect(
            r#"
struct Params { color: vec4<f32>, roughness: f32, alpha: f32, displacement: f32, }
@group(1) @binding(0) var<uniform> params: Params;
fn identity(p: Params) -> Params { return p; }
fn opacity(p: Params) -> f32 { return identity(p).alpha; }
fn unused() -> f32 { return params.roughness; }
@vertex fn vs() -> @builtin(position) vec4<f32> { return vec4<f32>(params.displacement, 0.0, 0.0, 1.0); }
@fragment fn fs() { if opacity(params) < 0.5 { discard; } }
"#,
        );
        assert_eq!(
            result[0]["bindings"][0]["fields"],
            serde_json::json!(["displacement"])
        );
        assert_eq!(
            result[1]["bindings"][0]["fields"],
            serde_json::json!(["alpha"])
        );
    }
    #[test]
    fn entry_reads_cover_dynamic_arrays_and_complete_aggregate_outputs() {
        let result = reflect(
            r#"
struct Entry { color: vec4<f32>, factor: vec4<f32>, }
struct Params { entries: array<Entry, 4>, roughness: vec4<f32>, }
@group(1) @binding(0) var<uniform> params: Params;
@fragment fn dynamic(@location(0) index: f32) -> @location(0) vec4<f32> { return params.entries[u32(index)].factor; }
@fragment fn aggregate() -> @location(0) vec4<f32> { var local = params; return local.roughness; }
"#,
        );
        assert_eq!(
            result[0]["bindings"][0]["fields"],
            serde_json::json!(["entries"])
        );
        assert_eq!(
            result[1]["bindings"][0]["fields"],
            serde_json::json!(["roughness"])
        );
    }
    #[test]
    fn aggregate_stored_inside_another_structure_keeps_complete_source() {
        let result = reflect(
            r#"
struct Params { color: vec4<f32>, roughness: vec4<f32>, alpha: vec4<f32>, }
struct Wrapper { value: Params, }
@group(1) @binding(0) var<uniform> params: Params;
@fragment fn fs() -> @location(0) vec4<f32> {
  var local: Wrapper;
  local.value = params;
  return local.value.alpha + params.color;
}
"#,
        );
        assert_eq!(
            result[0]["bindings"][0]["fields"],
            serde_json::json!(["color", "roughness", "alpha"])
        );
    }
    #[test]
    fn entry_resources_exclude_other_entry_and_unreachable_helpers() {
        let result = reflect(
            r#"
@group(1) @binding(2) var color: texture_2d<f32>;
@group(1) @binding(3) var shadow: texture_2d<f32>;
fn unreachable() -> vec4<f32> { return textureLoad(shadow, vec2<i32>(0), 0); }
@fragment fn fs() -> @location(0) vec4<f32> { return textureLoad(color, vec2<i32>(0), 0); }
"#,
        );
        assert_eq!(
            result[0]["bindings"],
            serde_json::json!([{"group":1,"binding":2}])
        );
    }
}
