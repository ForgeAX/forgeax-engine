//! W3C error-scope semantics over wgpu's uncaptured-error callback.
//!
//! The device installs one handler and never pushes wgpu error scopes. wgpu reports every
//! device-level error synchronously during the call that caused it, so the handler can route
//! it to the innermost scope whose filter matches (the first error per scope wins) or, when no
//! scope matches, to the uncaptured queue the TypeScript device drains into
//! `uncapturederror` events.

use serde::Serialize;
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorKind {
    Validation,
    OutOfMemory,
    Internal,
}

impl ErrorKind {
    pub fn parse(filter: &str) -> Option<Self> {
        match filter {
            "validation" => Some(Self::Validation),
            "out-of-memory" => Some(Self::OutOfMemory),
            "internal" => Some(Self::Internal),
            _ => None,
        }
    }
}

#[derive(Clone, Serialize)]
pub struct ErrorRecord {
    pub kind: ErrorKind,
    pub message: String,
}

struct Scope {
    filter: ErrorKind,
    error: Option<ErrorRecord>,
}

#[derive(Default)]
struct SinkState {
    scopes: Vec<Scope>,
    uncaptured: Vec<ErrorRecord>,
    capture: Option<Vec<String>>,
}

#[derive(Clone, Default)]
pub struct ErrorSink(Arc<Mutex<SinkState>>);

impl ErrorSink {
    fn state(&self) -> std::sync::MutexGuard<'_, SinkState> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn install(&self, device: &wgpu::Device) {
        let sink = self.clone();
        device.on_uncaptured_error(Arc::new(move |error: wgpu::Error| {
            let (kind, message) = match &error {
                wgpu::Error::Validation { description, .. } => {
                    (ErrorKind::Validation, description.clone())
                }
                wgpu::Error::OutOfMemory { .. } => (ErrorKind::OutOfMemory, error.to_string()),
                wgpu::Error::Internal { description, .. } => {
                    (ErrorKind::Internal, description.clone())
                }
            };
            sink.report(kind, message);
        }));
    }

    pub fn report(&self, kind: ErrorKind, message: String) {
        let mut state = self.state();
        if let Some(capture) = state.capture.as_mut() {
            capture.push(message.clone());
        }
        let record = ErrorRecord { kind, message };
        if let Some(scope) = state.scopes.iter_mut().rev().find(|s| s.filter == kind) {
            scope.error.get_or_insert(record);
        } else {
            state.uncaptured.push(record);
        }
    }

    pub fn push(&self, filter: ErrorKind) {
        self.state().scopes.push(Scope {
            filter,
            error: None,
        });
    }

    /// `None` when the stack is empty (the W3C `OperationError`).
    pub fn pop(&self) -> Option<Option<ErrorRecord>> {
        self.state().scopes.pop().map(|scope| scope.error)
    }

    pub fn drain(&self) -> Vec<ErrorRecord> {
        std::mem::take(&mut self.state().uncaptured)
    }

    /// Run `f` and also collect the messages of every error it reports (shader compilation
    /// info). The errors still route through scopes as usual.
    pub fn capturing<T>(&self, f: impl FnOnce() -> T) -> (T, Vec<String>) {
        self.state().capture = Some(Vec::new());
        let value = f();
        let messages = self.state().capture.take().unwrap_or_default();
        (value, messages)
    }
}
