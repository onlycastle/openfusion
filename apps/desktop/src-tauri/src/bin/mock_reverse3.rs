//! Thin entry point: see `support/mock_common.rs` for the actual scripted
//! behavior of this test-only sidecar (scenario "reverse3").
#[path = "../mock_common_support.rs"]
mod mock_common;

fn main() {
    mock_common::run("reverse3");
}
