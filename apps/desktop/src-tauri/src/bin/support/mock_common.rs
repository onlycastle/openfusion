//! Shared scenario logic for the test-only mock sidecars under
//! `src/bin/mock_*.rs`.
//!
//! This file is NOT itself a Cargo bin target — it lives in `bin/support/`
//! (a subdirectory without a `main.rs`), which Cargo's auto-discovery does
//! not pick up. Each `src/bin/mock_<scenario>.rs` pulls it in via
//! `#[path = "support/mock_common.rs"] mod mock_common;` and calls
//! `mock_common::run("<scenario>")`.
//!
//! Why one binary per scenario instead of one binary + argv: the real
//! `EngineBridge::spawn(binary_path)` takes no argv (mirrors the real
//! engine sidecar, whose Tauri capability denies args — see
//! `capabilities/default.json`, `"args": false`). Keeping the mock's
//! call surface identical (a bare path, no args/env) means the tests
//! exercise the exact same `spawn()` shape production code uses.
//!
//! None of this is shipped: these binaries are cargo test fixtures, never
//! staged into `binaries/` or bundled by `tauri build`.
use std::io::{self, BufRead, Write};
use std::time::Duration;

fn read_line(stdin: &io::Stdin) -> Option<String> {
    let mut line = String::new();
    match stdin.lock().read_line(&mut line) {
        Ok(0) => None,
        Ok(_) => Some(line),
        Err(_) => None,
    }
}

fn parse_request(line: &str) -> Option<(u64, serde_json::Value)> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    let id = value.get("id")?.as_u64()?;
    let params = value.get("params").cloned().unwrap_or(serde_json::Value::Null);
    Some((id, params))
}

fn write_line(stdout: &mut io::Stdout, s: &str) {
    let _ = stdout.write_all(s.as_bytes());
    let _ = stdout.write_all(b"\n");
    let _ = stdout.flush();
}

fn write_result(stdout: &mut io::Stdout, id: u64, result: &serde_json::Value) {
    let envelope = serde_json::json!({"jsonrpc": "2.0", "id": id, "result": result});
    write_line(stdout, &envelope.to_string());
}

pub fn run(scenario: &str) {
    let stdin = io::stdin();
    let mut stdout = io::stdout();

    match scenario {
        // One request in, one matching response out. Proves basic
        // call()<->response id correlation.
        "echo" => {
            if let Some(line) = read_line(&stdin) {
                if let Some((id, params)) = parse_request(&line) {
                    write_result(&mut stdout, id, &params);
                }
            }
        }

        // Reads exactly 3 requests (fired concurrently by the test), then
        // answers them in REVERSE arrival order. Each response's `result`
        // echoes back that request's own params, so the test can prove no
        // cross-talk: if the bridge ever mis-routed a response to the
        // wrong pending caller, the resolved value would not match what
        // that caller sent.
        "reverse3" => {
            let mut captured = Vec::new();
            for _ in 0..3 {
                if let Some(line) = read_line(&stdin) {
                    if let Some(pair) = parse_request(&line) {
                        captured.push(pair);
                    }
                }
            }
            for (id, params) in captured.into_iter().rev() {
                write_result(&mut stdout, id, &params);
            }
        }

        // One request in, a JSON-RPC error envelope out.
        "error" => {
            if let Some(line) = read_line(&stdin) {
                if let Some((id, _params)) = parse_request(&line) {
                    let envelope = serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": {"code": 123, "message": "boom", "data": {"detail": "nope"}}
                    });
                    write_line(&mut stdout, &envelope.to_string());
                }
            }
        }

        // Answers the request normally, then emits an unsolicited
        // notification (no `id`) — proves notification routing to
        // subscribe() separate from the call()/response path.
        "notify" => {
            if let Some(line) = read_line(&stdin) {
                if let Some((id, params)) = parse_request(&line) {
                    write_result(&mut stdout, id, &params);
                }
            }
            write_line(
                &mut stdout,
                r#"{"jsonrpc":"2.0","method":"orchestrate.progress","params":{"pct":50}}"#,
            );
        }

        // response, GARBAGE line, response — proves a malformed ndjson
        // line between two good ones doesn't kill the reader task; the
        // second response still delivers.
        "malformed_between" => {
            if let Some(line) = read_line(&stdin) {
                if let Some((id, _params)) = parse_request(&line) {
                    write_result(&mut stdout, id, &serde_json::json!({"slot": "first"}));
                }
            }
            write_line(&mut stdout, "this line is not json at all {{{");
            if let Some(line) = read_line(&stdin) {
                if let Some((id, _params)) = parse_request(&line) {
                    write_result(&mut stdout, id, &serde_json::json!({"slot": "second"}));
                }
            }
        }

        // Reads one request, then exits WITHOUT responding — simulates the
        // engine process dying mid-call. The bridge's pending call must
        // resolve to an error (not hang) once stdout closes.
        "die_on_request" => {
            let _ = read_line(&stdin);
            std::process::exit(1);
        }

        // Exits promptly once stdin hits EOF (mirrors well-behaved engine
        // shutdown semantics) — used to test the "clean" shutdown() path.
        "clean_exit_on_eof" => {
            while let Some(line) = read_line(&stdin) {
                if let Some((id, params)) = parse_request(&line) {
                    write_result(&mut stdout, id, &params);
                }
            }
        }

        // Deliberately ignores stdin EOF and never exits on its own — used
        // to test shutdown()'s bounded-wait-then-kill path.
        "ignore_eof" => {
            loop {
                if read_line(&stdin).is_none() {
                    break;
                }
            }
            loop {
                std::thread::sleep(Duration::from_secs(3600));
            }
        }

        other => {
            eprintln!("mock sidecar: unknown scenario '{other}'");
            std::process::exit(2);
        }
    }
}
