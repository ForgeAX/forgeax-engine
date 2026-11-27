//! Build-time resource reads of each entry, following helper arguments and returns.
//! Aggregate copies keep their origin until a member is selected. Unknown aggregate
//! consumption conservatively reads its complete originating structure.
use naga::valid::{FunctionInfo, GlobalUse, ModuleInfo};
use naga::{AddressSpace, Expression, Function, Handle, Module, Statement, Type, TypeInner};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Serialize)]
pub struct EntryReads {
    pub name: String,
    pub stage: &'static str,
    pub bindings: Vec<BindingReads>,
    pub effects: EntryEffects,
    #[serde(rename = "valueReads", skip_serializing_if = "Option::is_none")]
    pub value_reads: Option<ValueReads>,
}
#[derive(Serialize)]
pub struct ValueReads {
    #[serde(rename = "schemaVersion")]
    pub schema_version: &'static str,
    pub structs: Vec<StructReads>,
}
#[derive(Serialize)]
pub struct StructReads {
    #[serde(rename = "typeDescriptor")]
    pub type_descriptor: super::ReflectionTypeDescriptor,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<String>>,
    #[serde(rename = "consumerGlobals", skip_serializing_if = "Option::is_none")]
    pub consumer_globals: Option<Vec<ConsumerGlobal>>,
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ConsumerGlobal {
    Bound {
        group: u32,
        binding: u32,
    },
    Unbound {
        name: String,
        #[serde(rename = "addressSpace")]
        address_space: String,
    },
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryEffects {
    pub may_discard: bool,
    pub writes_depth: bool,
    pub writes_sample_mask: bool,
    pub writes_storage: bool,
}

fn block_may_discard(block: &naga::Block, functions: &[bool]) -> bool {
    block.iter().any(|statement| match statement {
        Statement::Kill => true,
        Statement::Call { function, .. } => {
            functions.get(function.index()).copied().unwrap_or(true)
        }
        Statement::Block(body) => block_may_discard(body, functions),
        Statement::If { accept, reject, .. } => {
            block_may_discard(accept, functions) || block_may_discard(reject, functions)
        }
        Statement::Switch { cases, .. } => cases
            .iter()
            .any(|case| block_may_discard(&case.body, functions)),
        Statement::Loop {
            body, continuing, ..
        } => block_may_discard(body, functions) || block_may_discard(continuing, functions),
        _ => false,
    })
}

fn output_builtin(module: &Module, function: &Function, builtin: naga::BuiltIn) -> bool {
    let Some(result) = &function.result else {
        return false;
    };
    let matches = |binding: &Option<naga::Binding>| matches!(binding, Some(naga::Binding::BuiltIn(found)) if found == &builtin);
    if matches(&result.binding) {
        return true;
    }
    match &module.types[result.ty].inner {
        TypeInner::Struct { members, .. } => members.iter().any(|member| matches(&member.binding)),
        _ => false,
    }
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
type ConsumerGlobals = BTreeMap<usize, BTreeSet<usize>>;

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
    info: &'a ModuleInfo,
    function: &'a Function,
    function_info: &'a FunctionInfo,
    arguments: Vec<Vec<Origin>>,
    statements: Vec<&'a Statement>,
    memo: Vec<Option<Vec<Origin>>>,
    active: Vec<bool>,
    reads: &'r mut Reads,
    value_reads: &'r mut Reads,
    collect_values: bool,
    consumers: &'r mut ConsumerGlobals,
    lexical_globals: BTreeSet<usize>,
}
impl<'a, 'r> FunctionReads<'a, 'r> {
    fn new(
        module: &'a Module,
        info: &'a ModuleInfo,
        function: &'a Function,
        function_info: &'a FunctionInfo,
        arguments: Vec<Vec<Origin>>,
        reads: &'r mut Reads,
        value_reads: &'r mut Reads,
        collect_values: bool,
        consumers: &'r mut ConsumerGlobals,
    ) -> Self {
        let mut body = Vec::new();
        statements(&function.body, &mut body);
        Self {
            module,
            info,
            function,
            function_info,
            arguments,
            statements: body,
            memo: vec![None; function.expressions.len()],
            active: vec![false; function.expressions.len()],
            reads,
            value_reads,
            collect_values,
            consumers,
            lexical_globals: BTreeSet::new(),
        }
    }
    fn struct_type(&self, mut ty: Handle<Type>) -> Option<Handle<Type>> {
        loop {
            match self.module.types[ty].inner {
                TypeInner::Struct { .. } => return Some(ty),
                TypeInner::Pointer { base, .. } => ty = base,
                _ => return None,
            }
        }
    }
    fn expression_struct(&self, expression: Handle<Expression>) -> Option<Handle<Type>> {
        let ty = &self.function_info[expression].ty;
        match ty.inner_with(&self.module.types) {
            TypeInner::Struct { .. } => ty.handle(),
            TypeInner::Pointer { base, .. } => self.struct_type(*base),
            _ => None,
        }
    }
    fn observe_struct(&mut self, ty: Handle<Type>) {
        if self.collect_values {
            if let Some(ty) = self.struct_type(ty) {
                self.value_reads
                    .entry(ty.index())
                    .or_insert_with(|| Some(BTreeSet::new()));
            }
        }
    }
    fn consume_value(&mut self, ty: Handle<Type>) {
        if !self.collect_values {
            return;
        }
        match &self.module.types[ty].inner {
            TypeInner::Struct { members, .. } => {
                self.value_reads.insert(ty.index(), None);
                for member in members {
                    self.consume_value(member.ty);
                }
            }
            TypeInner::Array { base, .. } | TypeInner::Pointer { base, .. } => {
                self.consume_value(*base);
            }
            _ => {}
        }
    }
    fn consume_expression(&mut self, value: Handle<Expression>) {
        if let Some(ty) = self.function_info[value].ty.handle() {
            self.consume_value(ty);
        } else if let Some(ty) = self.expression_struct(value) {
            self.consume_value(ty);
        }
    }
    fn scan_value(&mut self, handle: Handle<Expression>, expression: &Expression) {
        if !self.collect_values {
            return;
        }
        if let Expression::GlobalVariable(global) = expression {
            self.lexical_globals.insert(global.index());
        }
        if let Some(ty) = self.expression_struct(handle) {
            self.observe_struct(ty);
        }
        if let Expression::AccessIndex { base, index } = expression {
            if let Some(ty) = self.expression_struct(*base) {
                let fields = self
                    .value_reads
                    .entry(ty.index())
                    .or_insert_with(|| Some(BTreeSet::new()));
                if let Some(fields) = fields {
                    fields.insert(*index);
                }
            }
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
            self.info,
            &self.module.functions[function],
            &self.info[function],
            origins,
            self.reads,
            self.value_reads,
            self.collect_values,
            self.consumers,
        );
        let result = child.scan(false);
        self.lexical_globals.extend(child.lexical_globals);
        result
    }
    fn scan(&mut self, entry: bool) -> Vec<Origin> {
        for argument in &self.function.arguments {
            self.observe_struct(argument.ty);
        }
        if let Some(result) = &self.function.result {
            self.observe_struct(result.ty);
        }
        for (handle, expression) in self.function.expressions.iter() {
            self.scan_value(handle, expression);
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
                        self.consume_expression(*value);
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
                    if self.local_root(*pointer).is_none() {
                        self.consume_expression(*value);
                    }
                }
                _ => {}
            }
        }
        if self.collect_values {
            for argument in &self.function.arguments {
                if let Some(ty) = self.struct_type(argument.ty) {
                    self.consumers
                        .entry(ty.index())
                        .or_default()
                        .extend(&self.lexical_globals);
                }
            }
        }
        returns
    }
}

pub fn derive(
    module: &Module,
    info: &ModuleInfo,
    layouter: &naga::proc::Layouter,
    collect_values: bool,
) -> Result<Vec<EntryReads>, String> {
    // Validated Naga functions precede their callers. Unlike may_kill (a
    // uniformity fact), structural Kill reachability includes uniform and
    // unconditional discard. No source parser or separate shader IR is used.
    let mut function_discards = Vec::with_capacity(module.functions.len());
    for (_, function) in module.functions.iter() {
        function_discards.push(block_may_discard(&function.body, &function_discards));
    }
    module
        .entry_points
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let mut reads = Reads::new();
            let mut value_reads = Reads::new();
            let mut consumers = ConsumerGlobals::new();
            FunctionReads::new(
                module,
                info,
                &entry.function,
                info.get_entry_point(index),
                Vec::new(),
                &mut reads,
                &mut value_reads,
                collect_values,
                &mut consumers,
            )
            .scan(true);
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
            let values = if collect_values {
                let mut structs = Vec::new();
                for (handle, ty) in module.types.iter() {
                    let Some(fields) = value_reads.get(&handle.index()) else {
                        continue;
                    };
                    let TypeInner::Struct { members, .. } = &ty.inner else {
                        continue;
                    };
                    structs.push(StructReads {
                        type_descriptor: super::reflection_type_descriptor(
                            module, layouter, handle,
                        )?,
                        fields: fields.as_ref().map(|indices| {
                            indices
                                .iter()
                                .filter_map(|index| members.get(*index as usize)?.name.clone())
                                .collect()
                        }),
                        consumer_globals: consumers.get(&handle.index()).map(|indices| {
                            module
                                .global_variables
                                .iter()
                                .filter(|(global, _)| indices.contains(&global.index()))
                                .map(|(global, variable)| match variable.binding {
                                    Some(binding) => ConsumerGlobal::Bound {
                                        group: binding.group,
                                        binding: binding.binding,
                                    },
                                    None => ConsumerGlobal::Unbound {
                                        name: variable.name.clone().unwrap_or_else(|| {
                                            format!("global#{}", global.index())
                                        }),
                                        address_space: format!("{:?}", variable.space),
                                    },
                                })
                                .collect()
                        }),
                    });
                }
                Some(ValueReads {
                    schema_version: "shader-value-member-reads/1",
                    structs,
                })
            } else {
                None
            };
            Ok(EntryReads {
                name: entry.name.clone(),
                stage: match entry.stage {
                    naga::ShaderStage::Vertex => "vertex",
                    naga::ShaderStage::Fragment => "fragment",
                    naga::ShaderStage::Compute => "compute",
                    _ => "unknown",
                },
                bindings,
                effects: EntryEffects {
                    // A helper used by another entry does not affect this entry.
                    may_discard: block_may_discard(&entry.function.body, &function_discards),
                    writes_depth: output_builtin(module, &entry.function, naga::BuiltIn::FragDepth),
                    writes_sample_mask: output_builtin(
                        module,
                        &entry.function,
                        naga::BuiltIn::SampleMask,
                    ),
                    writes_storage: module.global_variables.iter().any(|(handle, global)| {
                        global.binding.is_some()
                            && info.get_entry_point(index)[handle]
                                .intersects(GlobalUse::WRITE | GlobalUse::ATOMIC)
                    }),
                },
                value_reads: values,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn reflect_mode(source: &str, values: bool) -> serde_json::Value {
        let module = naga::front::wgsl::parse_str(source).unwrap();
        let info = naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::all(),
        )
        .validate(&module)
        .unwrap();
        let mut layouter = naga::proc::Layouter::default();
        layouter.update(module.to_ctx()).unwrap();
        serde_json::to_value(derive(&module, &info, &layouter, values).unwrap()).unwrap()
    }
    fn reflect(source: &str) -> serde_json::Value {
        reflect_mode(source, false)
    }
    fn value_fields(result: &serde_json::Value, entry: usize, name: &str) -> serde_json::Value {
        result[entry]["valueReads"]["structs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["typeDescriptor"]["name"] == name)
            .unwrap()["fields"]
            .clone()
    }
    #[test]
    fn typed_member_reads_ignore_construction_and_unreachable_helpers() {
        let result = reflect_mode(
            r#"
struct Input { uv: vec2f, view: vec3f, time: f32, }
@group(0) @binding(0) var<uniform> eye: vec4f;
fn make() -> Input { return Input(vec2f(1), eye.xyz, 0.0); }
fn identity(value: Input) -> Input { return value; }
fn unused(value: Input) -> vec3f { return value.view; }
fn surface(value: Input) -> vec4f { var local = identity(value); return vec4f(local.uv, 0, 1); }
@fragment fn fs() -> @location(0) vec4f { return surface(make()); }
@fragment fn other() -> @location(0) vec4f { let value=make(); return vec4f(value.view, value.time); }
"#,
            true,
        );
        assert_eq!(value_fields(&result, 0, "Input"), serde_json::json!(["uv"]));
        assert_eq!(
            value_fields(&result, 1, "Input"),
            serde_json::json!(["view", "time"])
        );
        // Existing resource semantics retain the constructor's real eye read.
        assert_eq!(
            result[0]["bindings"],
            serde_json::json!([{"group":0,"binding":0}])
        );
    }
    #[test]
    fn typed_whole_aggregate_escape_is_not_an_empty_member_read_set() {
        let result = reflect_mode(
            r#"
struct Input { uv: vec2f, view: vec3f, time: f32, }
struct Wrapper { values: array<Input, 1>, }
@group(0) @binding(0) var<storage, read_write> output: Wrapper;
@compute @workgroup_size(1) fn cs() { output = Wrapper(array(Input(vec2f(0), vec3f(0), 0.0))); }
"#,
            true,
        );
        assert!(value_fields(&result, 0, "Input").is_null());
        assert!(value_fields(&result, 0, "Wrapper").is_null());
    }
    #[test]
    fn typed_reads_follow_pointer_aliases_and_arguments() {
        let result = reflect_mode(
            r#"
struct Input { uv: vec2f, view: vec3f, time: f32, }
fn from_pointer(value: ptr<function, Input>) -> vec3f { let forwarded = value; return (*forwarded).view; }
@fragment fn fs() -> @location(0) vec4f { var value=Input(vec2f(0), vec3f(0), 0.0); return vec4f(from_pointer(&value), 1); }
"#,
            true,
        );
        assert_eq!(
            value_fields(&result, 0, "Input"),
            serde_json::json!(["view"])
        );
    }
    #[test]
    fn consumer_globals_exclude_return_only_producers_and_other_entries() {
        let result = reflect_mode(
            r#"
struct Input { uv: vec2f, view: vec3f, time: f32, }
@group(0) @binding(0) var<uniform> eye: vec4f;
@group(1) @binding(0) var<uniform> material: vec4f;
fn make() -> Input { return Input(vec2f(0), eye.xyz, 0.0); }
fn unrelated(value: Input) -> vec4f { return eye + vec4f(value.uv,0,1); }
fn surface(value: Input) -> vec4f { return material * vec4f(value.uv,0,1); }
@fragment fn fs() -> @location(0) vec4f { return surface(make()); }
@fragment fn other() -> @location(0) vec4f { return unrelated(make()); }
"#,
            true,
        );
        let global_reads = |entry: usize| {
            result[entry]["valueReads"]["structs"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["typeDescriptor"]["name"] == "Input")
                .unwrap()["consumerGlobals"]
                .clone()
        };
        assert_eq!(
            global_reads(0),
            serde_json::json!([{"kind":"bound","group":1,"binding":0}])
        );
        assert_eq!(
            global_reads(1),
            serde_json::json!([{"kind":"bound","group":0,"binding":0}])
        );
    }
    #[test]
    fn entry_effects_follow_native_reachability_and_fragment_outputs() {
        let result = reflect(
            r#"
@group(0) @binding(0) var<storage, read_write> colors: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> counter: atomic<u32>;
fn masked(alpha: f32) { if alpha < 0.5 { discard; } }
fn nested(alpha: f32) { masked(alpha); }
fn unused() { colors[0] = vec4<f32>(1.0); discard; }
@fragment fn opaque() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }
@fragment fn clipped(@location(0) alpha: f32) -> @location(0) vec4<f32> {
  nested(alpha); return vec4<f32>(1.0);
}
struct Output {
  @location(0) color: vec4<f32>,
  @builtin(frag_depth) depth: f32,
  @builtin(sample_mask) mask: u32,
}
@fragment fn outputs() -> Output { return Output(vec4<f32>(1.0), 0.5, 1u); }
fn store_color() { colors[0] = vec4<f32>(1.0); }
@fragment fn storage_fs() -> @location(0) vec4<f32> { store_color(); return vec4<f32>(1.0); }
@compute @workgroup_size(1) fn atomic_cs() { atomicAdd(&counter, 1u); }
"#,
        );
        assert_eq!(
            result[0]["effects"],
            serde_json::json!({
                "mayDiscard": false, "writesDepth": false, "writesSampleMask": false, "writesStorage": false,
            })
        );
        assert_eq!(result[1]["effects"]["mayDiscard"], true);
        assert_eq!(result[1]["effects"]["writesStorage"], false);
        assert_eq!(result[2]["effects"]["writesDepth"], true);
        assert_eq!(result[2]["effects"]["writesSampleMask"], true);
        assert_eq!(result[3]["effects"]["writesStorage"], true);
        assert_eq!(result[4]["effects"]["writesStorage"], true);
        assert_eq!(result[4]["effects"]["mayDiscard"], false);
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
        assert_eq!(result[1]["effects"]["mayDiscard"], true);
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
