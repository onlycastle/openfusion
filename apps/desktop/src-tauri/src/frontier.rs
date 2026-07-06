//! Frontier engine (Claude Code / Codex) auth via delegation to the official
//! CLI. This module NEVER handles a subscription token — it invokes the
//! operator's own installed CLI and observes its exit/status only, keeping
//! the engine's auth-agnostic invariant intact (spec §3, §6). The CLI holds
//! the login; the engine already runs on it by spawning the CLI.

use serde::Serialize;

/// The outcome of running a CLI once. `code` is the process exit code.
pub struct CliOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// The CLI could not be spawned at all (binary not found / not executable).
pub struct CliSpawnError;

/// Seam over "run a CLI once", so `compute_status` is unit-testable without
/// the real binaries. Real impl: [`SystemCli`].
pub trait CliRunner: Send + Sync {
    fn run(&self, program: &str, args: &[&str]) -> Result<CliOutput, CliSpawnError>;
}

/// Real runner over `std::process::Command`.
pub struct SystemCli;

impl CliRunner for SystemCli {
    fn run(&self, program: &str, args: &[&str]) -> Result<CliOutput, CliSpawnError> {
        match std::process::Command::new(program).args(args).output() {
            Ok(out) => Ok(CliOutput {
                code: out.status.code().unwrap_or(-1),
                stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            }),
            Err(_) => Err(CliSpawnError),
        }
    }
}

/// Connection status for one frontier engine.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontierAuthStatus {
    /// "connected" | "disconnected" | "not-installed"
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

// IMPLEMENTATION-VERIFICATION (spec §9): confirm these argv against the real
// CLIs before shipping. The mapping below (spawn-fail => not-installed,
// exit 0 => connected, else => disconnected) is the tested contract.
const CLAUDE_PROGRAM: &str = "claude";
const CODEX_PROGRAM: &str = "codex";
const STATUS_ARGS_CLAUDE: &[&str] = &["auth", "status"];
const STATUS_ARGS_CODEX: &[&str] = &["login", "status"];
const LOGIN_ARGS_CLAUDE: &[&str] = &["auth", "login"];
const LOGIN_ARGS_CODEX: &[&str] = &["login"];
const LOGOUT_ARGS_CLAUDE: &[&str] = &["auth", "logout"];
const LOGOUT_ARGS_CODEX: &[&str] = &["logout"];

fn program_and_status_args(engine: &str) -> Option<(&'static str, &'static [&'static str])> {
    match engine {
        "claude-code" => Some((CLAUDE_PROGRAM, STATUS_ARGS_CLAUDE)),
        "codex" => Some((CODEX_PROGRAM, STATUS_ARGS_CODEX)),
        _ => None,
    }
}

fn program_and_login_args(engine: &str) -> Option<(&'static str, &'static [&'static str])> {
    match engine {
        "claude-code" => Some((CLAUDE_PROGRAM, LOGIN_ARGS_CLAUDE)),
        "codex" => Some((CODEX_PROGRAM, LOGIN_ARGS_CODEX)),
        _ => None,
    }
}

fn program_and_logout_args(engine: &str) -> Option<(&'static str, &'static [&'static str])> {
    match engine {
        "claude-code" => Some((CLAUDE_PROGRAM, LOGOUT_ARGS_CLAUDE)),
        "codex" => Some((CODEX_PROGRAM, LOGOUT_ARGS_CODEX)),
        _ => None,
    }
}

/// Pure status mapping (testable): unknown engine or un-spawnable binary =>
/// not-installed; exit 0 => connected; any other exit => disconnected.
pub fn compute_status(runner: &dyn CliRunner, engine: &str) -> FrontierAuthStatus {
    let Some((program, args)) = program_and_status_args(engine) else {
        return FrontierAuthStatus { state: "not-installed".into(), detail: Some(format!("unknown engine {engine}")) };
    };
    match runner.run(program, args) {
        Err(CliSpawnError) => FrontierAuthStatus { state: "not-installed".into(), detail: None },
        Ok(out) if out.code == 0 => FrontierAuthStatus { state: "connected".into(), detail: None },
        Ok(_) => FrontierAuthStatus { state: "disconnected".into(), detail: None },
    }
}

/// `invoke('frontier_login_status', { engine })`.
#[tauri::command]
pub fn frontier_login_status(engine: String) -> FrontierAuthStatus {
    compute_status(&SystemCli, &engine)
}

/// `invoke('frontier_login', { engine })`. Launches the official CLI's own
/// login (its OAuth completes in the user's browser). Returns once the
/// process is initiated; the pane re-probes status afterward. No token
/// crosses this boundary.
#[tauri::command]
pub fn frontier_login(engine: String) -> Result<(), String> {
    let Some((program, args)) = program_and_login_args(&engine) else {
        return Err(format!("unknown frontier engine: {engine}"));
    };
    std::process::Command::new(program)
        .args(args)
        .spawn()
        .map(|_child| ())
        .map_err(|err| format!("could not launch {program} login: {err}"))
}

/// `invoke('frontier_logout', { engine })`.
#[tauri::command]
pub fn frontier_logout(engine: String) -> Result<(), String> {
    let Some((program, args)) = program_and_logout_args(&engine) else {
        return Err(format!("unknown frontier engine: {engine}"));
    };
    std::process::Command::new(program)
        .args(args)
        .output()
        .map(|_| ())
        .map_err(|err| format!("could not run {program} logout: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeCli {
        // None => spawn fails (program not installed)
        result: Option<CliOutput>,
    }
    impl CliRunner for FakeCli {
        fn run(&self, _program: &str, _args: &[&str]) -> Result<CliOutput, CliSpawnError> {
            match &self.result {
                Some(o) => Ok(CliOutput { code: o.code, stdout: o.stdout.clone(), stderr: o.stderr.clone() }),
                None => Err(CliSpawnError),
            }
        }
    }

    #[test]
    fn unknown_engine_reports_not_installed() {
        let runner = FakeCli { result: Some(CliOutput { code: 0, stdout: String::new(), stderr: String::new() }) };
        let status = compute_status(&runner, "nonesuch");
        assert_eq!(status.state, "not-installed");
    }

    #[test]
    fn spawn_failure_maps_to_not_installed() {
        let runner = FakeCli { result: None };
        let status = compute_status(&runner, "claude-code");
        assert_eq!(status.state, "not-installed");
    }

    #[test]
    fn exit_zero_maps_to_connected() {
        let runner = FakeCli { result: Some(CliOutput { code: 0, stdout: "logged in".into(), stderr: String::new() }) };
        let status = compute_status(&runner, "claude-code");
        assert_eq!(status.state, "connected");
    }

    #[test]
    fn nonzero_exit_maps_to_disconnected() {
        let runner = FakeCli { result: Some(CliOutput { code: 1, stdout: String::new(), stderr: "not authenticated".into() }) };
        let status = compute_status(&runner, "codex");
        assert_eq!(status.state, "disconnected");
    }

    #[test]
    fn status_serializes_state_camelcase_without_detail_when_none() {
        let status = FrontierAuthStatus { state: "connected".into(), detail: None };
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, r#"{"state":"connected"}"#);
    }
}
