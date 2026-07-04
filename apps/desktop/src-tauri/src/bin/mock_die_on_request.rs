//! Thin entry point: see `support/mock_common.rs` for the actual scripted
//! behavior of this test-only sidecar (scenario "die_on_request").
#[path = "support/mock_common.rs"]
mod mock_common;

fn main() {
    mock_common::run("die_on_request");
}
