use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};

const MAX_REQUEST_BYTES: u64 = 1024 * 1024;
const MAX_ARGUMENTS: usize = 1024;
const MAX_PATHS: usize = 256;
const MAX_ENVIRONMENT_VARIABLES: usize = 128;
const SANDBOX_EXECUTABLE: &str = "/usr/bin/sandbox-exec";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum Profile {
    Author,
    Verify,
    Review,
    Scout,
    Eval,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    schema_version: u8,
    profile: Profile,
    executable: String,
    #[serde(default)]
    args: Vec<String>,
    cwd: String,
    private_temp_dir: String,
    #[serde(default)]
    readable_paths: Vec<String>,
    #[serde(default)]
    executable_paths: Vec<String>,
    #[serde(default)]
    network_granted: bool,
    #[serde(default)]
    environment: BTreeMap<String, String>,
}

fn canonical_existing(value: &str, label: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if !path.is_absolute() {
        return Err(format!("{label} must be absolute"));
    }
    fs::canonicalize(path).map_err(|error| format!("cannot canonicalize {label}: {error}"))
}

fn scheme_string(path: &Path) -> String {
    let value = path.to_string_lossy();
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn path_rule(operation: &str, filter: &str, path: &Path) -> String {
    format!("(allow {operation} ({filter} {}))", scheme_string(path))
}

fn deny_path_rule(operation: &str, filter: &str, path: &Path) -> String {
    format!("(deny {operation} ({filter} {}))", scheme_string(path))
}

fn validate_environment(environment: &BTreeMap<String, String>) -> Result<(), String> {
    if environment.len() > MAX_ENVIRONMENT_VARIABLES {
        return Err("too many environment variables".to_string());
    }
    for (name, value) in environment {
        let mut chars = name.chars();
        let first = chars.next().ok_or_else(|| "environment variable name is empty".to_string())?;
        if !(first == '_' || first.is_ascii_alphabetic())
            || !chars.all(|character| character == '_' || character.is_ascii_alphanumeric())
        {
            return Err(format!("invalid environment variable name: {name}"));
        }
        if value.as_bytes().contains(&0) {
            return Err(format!("environment variable {name} contains a NUL byte"));
        }
    }
    Ok(())
}

fn canonical_set(values: &[String], label: &str) -> Result<BTreeSet<PathBuf>, String> {
    if values.len() > MAX_PATHS {
        return Err(format!("too many {label}"));
    }
    values
        .iter()
        .map(|value| canonical_existing(value, label))
        .collect()
}

fn build_profile(request: &Request) -> Result<(String, PathBuf, PathBuf, PathBuf), String> {
    if request.schema_version != 1 {
        return Err("unsupported sandbox request schema".to_string());
    }
    if request.args.len() > MAX_ARGUMENTS {
        return Err("too many process arguments".to_string());
    }
    if request.args.iter().any(|argument| argument.as_bytes().contains(&0)) {
        return Err("process argument contains a NUL byte".to_string());
    }
    validate_environment(&request.environment)?;

    let cwd = canonical_existing(&request.cwd, "cwd")?;
    let private_temp = canonical_existing(&request.private_temp_dir, "private temp directory")?;
    let executable = canonical_existing(&request.executable, "executable")?;
    if !executable.is_file() {
        return Err("sandbox executable target is not a regular file".to_string());
    }

    let mut readable = canonical_set(&request.readable_paths, "readable paths")?;
    readable.insert(cwd.clone());
    readable.insert(private_temp.clone());
    let system_read_paths = [
        "/bin",
        "/usr/bin",
        "/usr/lib",
        "/usr/share",
        "/System/Library",
        "/Library/Apple",
        "/private/etc",
        "/private/var/db/dyld",
        // Read-only package-manager roots needed by explicitly allowlisted
        // Homebrew/MacPorts executables for their dylibs and script bundles.
        // These are machine toolchains, never a user's home directory.
        "/opt/homebrew/Cellar",
        "/opt/homebrew/lib",
        "/opt/homebrew/opt",
        "/usr/local/Cellar",
        "/usr/local/lib",
        "/usr/local/opt",
        "/opt/local/lib",
    ];
    for value in system_read_paths {
        if let Ok(canonical) = fs::canonicalize(value) {
            readable.insert(canonical);
        }
    }

    let mut executable_paths = canonical_set(&request.executable_paths, "executable paths")?;
    executable_paths.insert(executable.clone());
    for value in ["/bin", "/usr/bin", "/usr/sbin", "/sbin"] {
        if let Ok(canonical) = fs::canonicalize(value) {
            executable_paths.insert(canonical);
        }
    }

    let mut writable = BTreeSet::from([private_temp.clone()]);
    if matches!(request.profile, Profile::Author | Profile::Verify | Profile::Eval) {
        writable.insert(cwd.clone());
    }

    let mut lines = vec![
        "(version 1)".to_string(),
        "(deny default)".to_string(),
        "(allow process-fork)".to_string(),
        "(allow process-info* (target same-sandbox))".to_string(),
        "(allow signal (target same-sandbox))".to_string(),
        "(allow sysctl-read)".to_string(),
        "(allow mach-lookup (global-name \"com.apple.system.logger\"))".to_string(),
        "(allow mach-lookup (global-name \"com.apple.system.opendirectoryd.libinfo\"))".to_string(),
        "(allow mach-lookup (global-name \"com.apple.system.opendirectoryd.membership\"))".to_string(),
        "(allow file-read-metadata)".to_string(),
        // Some macOS runtime reads have no stable pathname filter. Start
        // with the operation enabled, deny the entire filesystem, then
        // re-open only the literal root and declared canonical roots below.
        "(allow file-read*)".to_string(),
        "(deny file-read* (subpath \"/\"))".to_string(),
        "(allow file-read* (literal \"/\"))".to_string(),
        "(allow file-read* (literal \"/dev/null\"))".to_string(),
        "(allow file-read* (literal \"/dev/urandom\"))".to_string(),
        "(allow file-write* (literal \"/dev/null\"))".to_string(),
    ];
    lines.extend(readable.iter().map(|entry| path_rule("file-read*", "subpath", entry)));
    lines.extend(executable_paths.iter().map(|entry| path_rule("process-exec", "subpath", entry)));
    lines.extend(writable.iter().map(|entry| path_rule("file-write*", "subpath", entry)));
    let git_control = cwd.join(".git");
    let openfusion_control = cwd.join(".openfusion");
    if !matches!(request.profile, Profile::Verify | Profile::Eval) {
        lines.push(deny_path_rule("file-read*", "subpath", &git_control));
        lines.push(deny_path_rule("file-read*", "literal", &git_control));
    }
    for control_path in [&git_control, &openfusion_control] {
        lines.push(deny_path_rule("file-write*", "subpath", control_path));
        lines.push(deny_path_rule("file-write*", "literal", control_path));
    }
    lines.push(deny_path_rule("file-read*", "subpath", &openfusion_control));
    lines.push(deny_path_rule("file-read*", "literal", &openfusion_control));
    lines.push(if request.network_granted {
        "(allow network-outbound)".to_string()
    } else {
        "(deny network*)".to_string()
    });
    Ok((lines.join("\n"), cwd, private_temp, executable))
}

fn load_request(path: &Path) -> Result<Request, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("cannot inspect sandbox request: {error}"))?;
    if !metadata.file_type().is_file() {
        return Err("sandbox request must be a regular file".to_string());
    }
    if metadata.nlink() != 1 {
        return Err("sandbox request must not have hard links".to_string());
    }
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err("sandbox request permissions are too broad".to_string());
    }
    if metadata.len() > MAX_REQUEST_BYTES {
        return Err("sandbox request is too large".to_string());
    }
    let bytes = fs::read(path).map_err(|error| format!("cannot read sandbox request: {error}"))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("invalid sandbox request: {error}"))
}

fn probe() -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("native containment is only certified on macOS".to_string());
    }
    if !Path::new(SANDBOX_EXECUTABLE).is_file() {
        return Err("sandbox-exec is unavailable".to_string());
    }
    let request = Request {
        schema_version: 1,
        profile: Profile::Review,
        executable: "/usr/bin/true".to_string(),
        args: vec![],
        cwd: "/usr".to_string(),
        private_temp_dir: "/private/tmp".to_string(),
        readable_paths: vec![],
        executable_paths: vec!["/usr/bin/true".to_string()],
        network_granted: false,
        environment: BTreeMap::from([
            ("PATH".to_string(), "/bin:/usr/bin:/usr/sbin:/sbin".to_string()),
            ("HOME".to_string(), "/private/tmp".to_string()),
            ("TMPDIR".to_string(), "/private/tmp".to_string()),
            ("LANG".to_string(), "C".to_string()),
            ("LC_ALL".to_string(), "C".to_string()),
        ]),
    };
    let (profile, cwd, _, executable) = build_profile(&request)?;
    let status = Command::new(SANDBOX_EXECUTABLE)
        .arg("-p")
        .arg(profile)
        .arg(executable)
        .current_dir(cwd)
        .env_clear()
        .envs(request.environment)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| format!("sandbox probe failed to start: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("sandbox probe exited with {status}"))
    }
}

fn run(request_path: &Path) -> Result<i32, String> {
    if !cfg!(target_os = "macos") {
        return Err("native containment is only certified on macOS".to_string());
    }
    let request = load_request(request_path)?;
    let (profile, cwd, _private_temp, executable) = build_profile(&request)?;
    let mut command = Command::new(SANDBOX_EXECUTABLE);
    command
        .arg("-p")
        .arg(profile)
        .arg(executable)
        .args(&request.args)
        .current_dir(cwd)
        .env_clear()
        .envs(&request.environment)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    let status = command
        .status()
        .map_err(|error| format!("failed to start contained process: {error}"))?;
    Ok(status.code().unwrap_or_else(|| 128 + status.signal().unwrap_or(1)))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let result = match args.as_slice() {
        [_, flag] if flag == "--probe" => probe().map(|_| 0),
        [_, flag, request] if flag == "--request-file" => run(Path::new(request)),
        _ => Err("usage: openfusion-sandbox --probe | --request-file <path>".to_string()),
    };
    match result {
        Ok(code) if (0..=255).contains(&code) => ExitCode::from(code as u8),
        Ok(_) => ExitCode::FAILURE,
        Err(error) => {
            eprintln!("openfusion-sandbox: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "macos")]
    use std::net::TcpListener;
    #[cfg(target_os = "macos")]
    use std::os::unix::fs::symlink;
    #[cfg(target_os = "macos")]
    use std::sync::atomic::{AtomicU64, Ordering};
    #[cfg(target_os = "macos")]
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture(profile: Profile) -> Request {
        Request {
            schema_version: 1,
            profile,
            executable: "/usr/bin/true".to_string(),
            args: vec![],
            cwd: "/usr".to_string(),
            private_temp_dir: "/tmp".to_string(),
            readable_paths: vec![],
            executable_paths: vec![],
            network_granted: false,
            environment: BTreeMap::new(),
        }
    }

    #[test]
    fn author_can_write_cwd_but_network_is_denied() {
        let (profile, cwd, _, _) = build_profile(&fixture(Profile::Author)).unwrap();
        assert!(profile.contains(&path_rule("file-write*", "subpath", &cwd)));
        assert!(profile.contains("(deny network*)"));
    }

    #[test]
    fn reviewer_cannot_write_candidate_tree() {
        let (profile, cwd, _, _) = build_profile(&fixture(Profile::Review)).unwrap();
        assert!(!profile.contains(&path_rule("file-write*", "subpath", &cwd)));
    }

    #[test]
    fn eval_profile_is_writable_but_network_is_fail_closed() {
        let (profile, cwd, _, _) = build_profile(&fixture(Profile::Eval)).unwrap();
        assert!(profile.contains(&path_rule("file-write*", "subpath", &cwd)));
        assert!(!profile.contains(&deny_path_rule("file-read*", "subpath", &cwd.join(".git"))));
        assert!(profile.contains("(deny network*)"));
    }

    #[test]
    fn environment_names_are_validated() {
        let mut request = fixture(Profile::Verify);
        request.environment.insert("BAD-NAME".to_string(), "value".to_string());
        assert!(build_profile(&request).unwrap_err().contains("invalid environment"));
    }

    #[cfg(target_os = "macos")]
    fn isolated_root() -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!(
            "openfusion-sandbox-test-{}-{nonce}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir_all(root.join("worktree")).unwrap();
        fs::create_dir_all(root.join("private-temp")).unwrap();
        fs::create_dir_all(root.join("outside")).unwrap();
        root
    }

    #[cfg(target_os = "macos")]
    fn contained_output(request: &Request) -> std::process::Output {
        let (profile, cwd, _, executable) = build_profile(request).unwrap();
        Command::new(SANDBOX_EXECUTABLE)
            .arg("-p")
            .arg(profile)
            .arg(executable)
            .args(&request.args)
            .current_dir(cwd)
            .env_clear()
            .envs(&request.environment)
            .output()
            .unwrap()
    }

    #[cfg(target_os = "macos")]
    fn request_for(root: &Path, profile: Profile, executable: &str, args: Vec<String>) -> Request {
        Request {
            schema_version: 1,
            profile,
            executable: executable.to_string(),
            args,
            cwd: root.join("worktree").to_string_lossy().into_owned(),
            private_temp_dir: root.join("private-temp").to_string_lossy().into_owned(),
            readable_paths: vec![],
            executable_paths: vec![executable.to_string()],
            network_granted: false,
            environment: BTreeMap::from([
                ("PATH".to_string(), "/bin:/usr/bin:/usr/sbin:/sbin".to_string()),
                ("HOME".to_string(), root.join("private-temp").to_string_lossy().into_owned()),
                ("TMPDIR".to_string(), root.join("private-temp").to_string_lossy().into_owned()),
                ("PWD".to_string(), root.join("worktree").to_string_lossy().into_owned()),
                ("LANG".to_string(), "C".to_string()),
                ("LC_ALL".to_string(), "C".to_string()),
            ]),
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn denies_absolute_and_symlink_reads_outside_the_candidate() {
        let root = isolated_root();
        let secret = root.join("outside/secret.txt");
        fs::write(&secret, "NATIVE_SECRET_SENTINEL").unwrap();
        symlink(&secret, root.join("worktree/link")).unwrap();

        let absolute = request_for(
            &root,
            Profile::Author,
            "/bin/cat",
            vec![secret.to_string_lossy().into_owned()],
        );
        let absolute_output = contained_output(&absolute);
        assert!(!absolute_output.status.success());
        assert!(!String::from_utf8_lossy(&absolute_output.stdout).contains("NATIVE_SECRET_SENTINEL"));

        let through_link = request_for(
            &root,
            Profile::Author,
            "/bin/cat",
            vec![root.join("worktree/link").to_string_lossy().into_owned()],
        );
        let link_output = contained_output(&through_link);
        assert!(!link_output.status.success());
        assert!(!String::from_utf8_lossy(&link_output.stdout).contains("NATIVE_SECRET_SENTINEL"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn policy_is_inherited_by_descendants_and_blocks_outside_writes() {
        let root = isolated_root();
        let secret = root.join("outside/secret.txt");
        let escaped_write = root.join("outside/written.txt");
        fs::write(&secret, "DESCENDANT_SECRET_SENTINEL").unwrap();
        let command = format!(
            "/bin/sh -c 'cat {}'; printf escaped > {}",
            secret.to_string_lossy(),
            escaped_write.to_string_lossy(),
        );
        let request = request_for(
            &root,
            Profile::Author,
            "/bin/sh",
            vec!["-c".to_string(), command],
        );
        let output = contained_output(&request);
        assert!(!output.status.success());
        assert!(!String::from_utf8_lossy(&output.stdout).contains("DESCENDANT_SECRET_SENTINEL"));
        assert!(!escaped_write.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn author_writes_are_scoped_and_reviewer_is_read_only() {
        let root = isolated_root();
        let sanity = request_for(&root, Profile::Author, "/usr/bin/true", vec![]);
        let sanity_output = contained_output(&sanity);
        assert!(
            sanity_output.status.success(),
            "true failed ({:?}): {}",
            sanity_output.status,
            String::from_utf8_lossy(&sanity_output.stderr),
        );
        let inside = root.join("worktree/inside.txt");
        let author = request_for(
            &root,
            Profile::Author,
            "/bin/sh",
            vec!["-c".to_string(), "printf allowed > inside.txt".to_string()],
        );
        let author_output = contained_output(&author);
        assert!(
            author_output.status.success(),
            "author command failed ({:?}): {}",
            author_output.status,
            String::from_utf8_lossy(&author_output.stderr),
        );
        assert_eq!(fs::read_to_string(&inside).unwrap(), "allowed");

        fs::remove_file(&inside).unwrap();
        let review = request_for(
            &root,
            Profile::Review,
            "/bin/sh",
            vec!["-c".to_string(), "printf denied > inside.txt".to_string()],
        );
        assert!(!contained_output(&review).status.success());
        assert!(!inside.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn denies_network_and_does_not_inherit_host_environment() {
        let root = isolated_root();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let network = request_for(
            &root,
            Profile::Author,
            "/usr/bin/nc",
            vec!["-z".to_string(), "-w".to_string(), "1".to_string(), "127.0.0.1".to_string(), port.to_string()],
        );
        assert!(!contained_output(&network).status.success());

        std::env::set_var("OPENFUSION_NATIVE_SECRET_SENTINEL", "must-not-leak");
        let environment = request_for(&root, Profile::Author, "/usr/bin/env", vec![]);
        let output = contained_output(&environment);
        std::env::remove_var("OPENFUSION_NATIVE_SECRET_SENTINEL");
        assert!(
            output.status.success(),
            "environment command failed ({:?}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr),
        );
        assert!(!String::from_utf8_lossy(&output.stdout).contains("OPENFUSION_NATIVE_SECRET_SENTINEL"));
        drop(listener);
        fs::remove_dir_all(root).unwrap();
    }
}
