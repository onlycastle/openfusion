//! Shared scenario logic for the test-only mock sidecars under
//! `src/bin/mock_*.rs`.
//!
//! This file is NOT itself a Cargo bin target — it's a plain top-level
//! `src/` file (not `src/main.rs`/`src/lib.rs`), so Cargo's auto-discovery
//! ignores it entirely. Each `src/bin/mock_<scenario>.rs` pulls it in via
//! `#[path = "../mock_common_support.rs"] mod mock_common;` and calls
//! `mock_common::run("<scenario>")`.
//!
//! DELIBERATELY NOT placed at `src/bin/support/mock_common.rs` (a
//! subdirectory of `src/bin/` without a `main.rs`): `tauri build`'s bundler
//! independently sweeps `src/bin/` looking for extra binaries to copy into
//! `Contents/MacOS`, and empirically (see
//! docs/research/2026-07-04-m8-signing-verification.md) that sweep gets
//! confused once every `.rs` file directly in `src/bin/` has an explicit
//! `[[bin]]` override — it treats the one remaining unmatched directory
//! entry (`support/`) as a phantom binary and fails the whole bundle with
//! "Failed to copy binary from `.../target/.../support`: does not exist".
//! Keeping shared, non-target code out of `src/bin/` entirely sidesteps
//! that bundler behavior instead of relying on undocumented internals.
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

        // Never reads a single byte from stdin (not even to drain it) and
        // never exits on its own — used to test shutdown()'s stdin-close
        // step against a concurrent call() whose write_all() is blocked
        // because the OS pipe buffer filled up and nothing is reading it.
        // (`ignore_eof` above still drains stdin in a loop, which would
        // keep the pipe buffer empty and never reproduce that block.)
        "stdin_black_hole" => {
            let _ = &stdin; // never read from; keeps the pipe buffer full
            loop {
                std::thread::sleep(Duration::from_secs(3600));
            }
        }

        // Deliberately does NOT read from stdin for a while (long enough
        // that a multi-MiB write blocks on a full OS pipe buffer), then
        // drains + echoes every complete line forever until EOF. Used by
        // the mid-write-cancellation framing-integrity test: the delay
        // gives a cancelled write a real window to leave a partial line on
        // the wire *before* anything starts reading, so the test can prove
        // whether a subsequent request's framing survives intact. A
        // malformed/garbled line (e.g. two requests concatenated because a
        // partial write ran into a full one) fails to parse and gets no
        // response at all — that silence is the observable signature of
        // framing corruption; a well-framed line always gets an echoed
        // response.
        "delayed_drain_echo" => {
            std::thread::sleep(Duration::from_millis(300));
            while let Some(line) = read_line(&stdin) {
                if let Some((id, params)) = parse_request(&line) {
                    write_result(&mut stdout, id, &params);
                }
                // Malformed lines are silently skipped -- no response is
                // exactly the point (see doc comment above).
            }
        }

        // Reads + echoes each request like `clean_exit_on_eof`, but sleeps
        // briefly before responding to *each* one. Used to test per-call
        // timeouts: a short enough caller-side timeout fires while waiting
        // on the response (not mid-write -- these payloads are tiny), and a
        // later call on the same bridge must still complete normally,
        // proving the stream stayed intact across the timed-out call.
        "slow_response_echo" => {
            while let Some(line) = read_line(&stdin) {
                if let Some((id, params)) = parse_request(&line) {
                    std::thread::sleep(Duration::from_millis(250));
                    write_result(&mut stdout, id, &params);
                }
            }
        }

        other => {
            eprintln!("mock sidecar: unknown scenario '{other}'");
            std::process::exit(2);
        }
    }
}
