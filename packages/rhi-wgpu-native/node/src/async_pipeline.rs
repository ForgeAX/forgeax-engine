use napi::bindgen_prelude::*;
use napi::{Env, Task};
use napi_derive::napi;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub(crate) type PipelineOwner = Arc<AtomicBool>;

pub(crate) struct ComputeSnapshot {
    pub label: Option<String>,
    pub layout: Option<wgpu::PipelineLayout>,
    pub module: wgpu::ShaderModule,
    pub entry: Option<String>,
    pub constants: Vec<(String, f64)>,
}

impl ComputeSnapshot {
    pub fn create(&self, device: &wgpu::Device) -> wgpu::ComputePipeline {
        let constants: Vec<(&str, f64)> = self
            .constants
            .iter()
            .map(|(k, v)| (k.as_str(), *v))
            .collect();
        device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: self.label.as_deref(),
            layout: self.layout.as_ref(),
            module: &self.module,
            entry_point: self.entry.as_deref(),
            compilation_options: wgpu::PipelineCompilationOptions {
                constants: &constants,
                zero_initialize_workgroup_memory: true,
            },
            cache: None,
        })
    }
}

#[napi(object)]
pub struct PipelineFailure {
    pub kind: String,
    pub message: String,
}

impl PipelineFailure {
    fn internal(message: impl Into<String>) -> Self {
        Self {
            kind: "internal".into(),
            message: message.into(),
        }
    }
    fn validation(message: impl Into<String>) -> Self {
        Self {
            kind: "validation".into(),
            message: message.into(),
        }
    }
    fn from_wgpu(error: wgpu::Error) -> Self {
        match error {
            wgpu::Error::Validation { description, .. } => Self::validation(description),
            other => Self::internal(other.to_string()),
        }
    }
}

/// Only the receiving device's JS thread may take a completion, exactly once.
struct CompletionSlot<T> {
    owner: PipelineOwner,
    value: Mutex<Option<T>>,
}

impl<T> CompletionSlot<T> {
    fn take(&self, owner: &PipelineOwner) -> std::result::Result<T, PipelineFailure> {
        if !Arc::ptr_eq(owner, &self.owner) {
            return Err(PipelineFailure::internal(
                "Foreign async pipeline completion",
            ));
        }
        if !owner.load(Ordering::Acquire) {
            return Err(PipelineFailure::internal(
                "Async pipeline device is lost or destroyed",
            ));
        }
        self.value
            .lock()
            .map_err(|_| PipelineFailure::internal("Poisoned pipeline completion"))?
            .take()
            .ok_or_else(|| PipelineFailure::internal("Async pipeline completion already adopted"))
    }
}

type WorkerResult = std::result::Result<wgpu::ComputePipeline, PipelineFailure>;

pub struct ComputePipelineCompletion {
    slot: CompletionSlot<WorkerResult>,
}

impl ComputePipelineCompletion {
    pub(crate) fn take(&self, owner: &PipelineOwner) -> WorkerResult {
        self.slot.take(owner)?
    }
}

#[napi(object)]
pub struct ComputePipelineAdoption {
    pub id: u32,
    pub error: Option<PipelineFailure>,
}

pub struct ComputePipelineTask {
    device: wgpu::Device,
    owner: PipelineOwner,
    snapshot: Option<std::result::Result<ComputeSnapshot, String>>,
}

impl ComputePipelineTask {
    pub(crate) fn new(
        device: wgpu::Device,
        owner: PipelineOwner,
        snapshot: std::result::Result<ComputeSnapshot, String>,
    ) -> Self {
        Self {
            device,
            owner,
            snapshot: Some(snapshot),
        }
    }

    fn create(&mut self) -> WorkerResult {
        if !self.owner.load(Ordering::Acquire) {
            return Err(PipelineFailure::internal(
                "Async pipeline device is lost or destroyed",
            ));
        }
        let snapshot = self
            .snapshot
            .take()
            .ok_or_else(|| PipelineFailure::internal("Async pipeline task executed twice"))?
            .map_err(PipelineFailure::validation)?;
        // std-enabled wgpu scopes are thread-local. Never leave the JS ErrorSink
        // stack pushed while another thread compiles or the UI processes work.
        let validation = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let internal = self.device.push_error_scope(wgpu::ErrorFilter::Internal);
        let memory = self.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let pipeline = snapshot.create(&self.device);
        let memory_error = pollster::block_on(memory.pop());
        let internal_error = pollster::block_on(internal.pop());
        let validation_error = pollster::block_on(validation.pop());
        if let Some(error) = validation_error.or(internal_error).or(memory_error) {
            return Err(PipelineFailure::from_wgpu(error));
        }
        if !self.owner.load(Ordering::Acquire) {
            return Err(PipelineFailure::internal(
                "Async pipeline device is lost or destroyed",
            ));
        }
        Ok(pipeline)
    }
}

impl Task for ComputePipelineTask {
    type Output = WorkerResult;
    type JsValue = ExternalRef<ComputePipelineCompletion>;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(
            catch_unwind(AssertUnwindSafe(|| self.create())).unwrap_or_else(|_| {
                Err(PipelineFailure::internal(
                    "Native async pipeline worker panicked",
                ))
            }),
        )
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        ExternalRef::new(
            &env,
            ComputePipelineCompletion {
                slot: CompletionSlot {
                    owner: self.owner.clone(),
                    value: Mutex::new(Some(output)),
                },
            },
        )
    }
}

#[cfg(test)]
#[path = "__tests__/async_pipeline.rs"]
mod tests;
