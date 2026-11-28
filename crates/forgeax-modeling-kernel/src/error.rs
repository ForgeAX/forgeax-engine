//! Closed structured error vocabulary for the modeling kernel.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u16)]
pub enum KernelErrorCode {
    InvalidArgument = 1,
    InvalidHandle = 2,
    InvalidValue = 3,
    Precondition = 4,
    Degenerate = 5,
    SelectionEmpty = 6,
    SelectionCardinality = 7,
    WorkBudget = 8,
    Cancelled = 9,
    CapabilityUnavailable = 10,
    Internal = 11,
    OpNoEffect = 12,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KernelError {
    pub code: KernelErrorCode,
    pub field: String,
    pub reason: String,
}

impl KernelError {
    pub fn new(code: KernelErrorCode, field: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            code,
            field: field.into(),
            reason: reason.into(),
        }
    }

    pub fn invalid_value(field: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::new(KernelErrorCode::InvalidValue, field, reason)
    }

    pub fn invalid_handle() -> Self {
        Self::new(
            KernelErrorCode::InvalidHandle,
            "handle",
            "handle is invalid or has been disposed",
        )
    }

    pub fn degenerate(field: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::new(KernelErrorCode::Degenerate, field, reason)
    }

    pub fn precondition(field: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::new(KernelErrorCode::Precondition, field, reason)
    }

    pub fn out_of_memory(field: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::new(KernelErrorCode::WorkBudget, field, reason)
    }

    pub fn unsupported(field: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::new(KernelErrorCode::CapabilityUnavailable, field, reason)
    }

    pub fn selection_empty(field: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::new(KernelErrorCode::SelectionEmpty, field, reason)
    }

    pub fn selection_count(field: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::new(KernelErrorCode::SelectionCardinality, field, reason)
    }

    pub fn work_budget(field: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::new(KernelErrorCode::WorkBudget, field, reason)
    }

    pub fn no_effect(field: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::new(KernelErrorCode::OpNoEffect, field, reason)
    }
}
