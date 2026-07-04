//! Thin entry point: see `support/mock_common.rs` for the actual scripted
//! behavior of this test-only sidecar (scenario "clean_exit_on_eof").
#[path = "support/mock_common.rs"]
mod mock_common;

fn main() {
    mock_common::run("clean_exit_on_eof");
}
