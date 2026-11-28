//! Sparse linear solvers and discrete differential operators.

pub mod sparse;

pub use sparse::{build_cotangent_laplacian, solve_pcg, CsrMatrix, TripletList};
