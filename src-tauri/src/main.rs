#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

const BACKEND_HOST: &str = "127.0.0.1";
const BACKEND_PORT: u16 = 3000;
const BACKEND_URL: &str = "http://127.0.0.1:3000";
const BACKEND_HEALTH_PATH: &str = "/api/system/check";
const BACKEND_BOOT_TIMEOUT_SECS: u64 = 45;
const WORKER_BOOT_GRACE_MS: u64 = 2000;

#[derive(Clone)]
struct StartupFailure {
  code: &'static str,
  what: String,
  why: String,
  fix: String,
}

impl StartupFailure {
  fn new(code: &'static str, what: impl Into<String>, why: impl Into<String>, fix: impl Into<String>) -> Self {
    Self {
      code,
      what: what.into(),
      why: why.into(),
      fix: fix.into(),
    }
  }
}

struct RuntimeProcesses {
  backend: Option<Child>,
  worker: Child,
}

struct ManagedProcesses(Mutex<Option<RuntimeProcesses>>);
struct ManagedBootStatus(Mutex<DesktopBootStatus>);
struct ManagedBootInFlight(Mutex<bool>);
struct ManagedInstanceLock(Mutex<Option<AppInstanceLock>>);

struct AppInstanceLock {
  path: PathBuf,
  _file: File,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopBootStatus {
  state: String,
  message: String,
  backend_url: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  error_code: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  error_why: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  error_fix: Option<String>,
}

impl DesktopBootStatus {
  fn starting(message: &str) -> Self {
    Self {
      state: "starting".to_string(),
      message: message.to_string(),
      backend_url: BACKEND_URL.to_string(),
      error_code: None,
      error_why: None,
      error_fix: None,
    }
  }

  fn ready(message: &str) -> Self {
    Self {
      state: "ready".to_string(),
      message: message.to_string(),
      backend_url: BACKEND_URL.to_string(),
      error_code: None,
      error_why: None,
      error_fix: None,
    }
  }

  fn error(message: &str) -> Self {
    Self {
      state: "error".to_string(),
      message: message.to_string(),
      backend_url: BACKEND_URL.to_string(),
      error_code: None,
      error_why: None,
      error_fix: None,
    }
  }

  fn error_with(failure: &StartupFailure) -> Self {
    Self {
      state: "error".to_string(),
      message: failure.what.clone(),
      backend_url: BACKEND_URL.to_string(),
      error_code: Some(failure.code.to_string()),
      error_why: Some(failure.why.clone()),
      error_fix: Some(failure.fix.clone()),
    }
  }
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
  let trimmed = url.trim();
  if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
    return Err("Only http(s) URLs are allowed".to_string());
  }

  webbrowser::open(trimmed)
    .map(|_| ())
    .map_err(|err| format!("Failed to open external URL: {err}"))
}

#[tauri::command]
fn desktop_boot_status(app: AppHandle) -> DesktopBootStatus {
  current_boot_status(&app)
}

#[tauri::command]
fn desktop_retry_runtime_boot(app: AppHandle) -> Result<DesktopBootStatus, String> {
  if let Err(failure) = ensure_instance_lock(&app) {
    set_boot_status(&app, DesktopBootStatus::error_with(&failure));
    return Ok(current_boot_status(&app));
  }

  spawn_runtime_bootstrap(&app, true);
  Ok(current_boot_status(&app))
}

fn current_boot_status(app: &AppHandle) -> DesktopBootStatus {
  let state = app.state::<ManagedBootStatus>();
  let guard = match state.0.lock() {
    Ok(guard) => guard,
    Err(_) => return DesktopBootStatus::error("Failed to read runtime status."),
  };

  guard.clone()
}

fn set_boot_status(app: &AppHandle, status: DesktopBootStatus) {
  let state = app.state::<ManagedBootStatus>();
  let lock_result = state.0.lock();
  if let Ok(mut guard) = lock_result {
    *guard = status;
  }
}

fn try_mark_boot_inflight(app: &AppHandle) -> bool {
  let state = app.state::<ManagedBootInFlight>();
  let mut guard = match state.0.lock() {
    Ok(guard) => guard,
    Err(_) => return false,
  };

  if *guard {
    return false;
  }

  *guard = true;
  true
}

fn clear_boot_inflight(app: &AppHandle) {
  let state = app.state::<ManagedBootInFlight>();
  let lock_result = state.0.lock();
  if let Ok(mut guard) = lock_result {
    *guard = false;
  }
}

fn open_log_file(log_dir: &Path, file_name: &str) -> Option<File> {
  if fs::create_dir_all(log_dir).is_err() {
    return None;
  }

  OpenOptions::new()
    .create(true)
    .append(true)
    .open(log_dir.join(file_name))
    .ok()
}

fn configure_stdio(command: &mut Command, log_dir: Option<&Path>, process_name: &str) {
  if cfg!(debug_assertions) {
    command.stdout(Stdio::inherit()).stderr(Stdio::inherit());
    return;
  }

  if let Some(directory) = log_dir {
    let stdout_name = format!("{process_name}.stdout.log");
    let stderr_name = format!("{process_name}.stderr.log");
    let stdout_file = open_log_file(directory, &stdout_name);
    let stderr_file = open_log_file(directory, &stderr_name);

    command.stdout(match stdout_file {
      Some(file) => Stdio::from(file),
      None => Stdio::null(),
    });
    command.stderr(match stderr_file {
      Some(file) => Stdio::from(file),
      None => Stdio::null(),
    });
    return;
  }

  command.stdout(Stdio::null()).stderr(Stdio::null());
}

fn resolve_log_dir(app: &AppHandle) -> PathBuf {
  app
    .path()
    .app_local_data_dir()
    .unwrap_or_else(|_| std::env::temp_dir().join("emailagent-desktop"))
    .join("logs")
}

fn runtime_server_entry(runtime_root: &Path) -> PathBuf {
  runtime_root.join(".next").join("standalone").join("server.js")
}

fn resolve_runtime_root(app: &AppHandle) -> Result<PathBuf, StartupFailure> {
  let resource_dir = app.path().resource_dir().map_err(|err| {
    StartupFailure::new(
      "RESOURCE_DIR_UNAVAILABLE",
      "Unable to resolve packaged desktop resources.",
      format!("Tauri resource directory lookup failed: {err}"),
      "Reinstall EmailAgent Desktop, then launch again.",
    )
  })?;

  let candidates = vec![resource_dir.join("runtime"), resource_dir];

  for candidate in &candidates {
    if runtime_server_entry(candidate).exists() {
      return Ok(candidate.clone());
    }
  }

  for candidate in &candidates {
    if candidate.exists() {
      return Err(StartupFailure::new(
        "BACKEND_ENTRY_MISSING",
        "Packaged backend entry is missing.",
        format!(
          "Expected backend file was not found at {}",
          runtime_server_entry(candidate).display()
        ),
        "Reinstall EmailAgent Desktop. If building locally, run npm run desktop:ship:prep before npx tauri build.",
      ));
    }
  }

  Err(StartupFailure::new(
    "RUNTIME_NOT_PACKAGED",
    "Desktop runtime payload is missing from the installer.",
    "Neither runtime/.next/standalone nor .next/standalone was found in app resources.".to_string(),
    "Reinstall EmailAgent Desktop. If this keeps happening, rebuild the installer after running npm run desktop:ship:prep.",
  ))
}

fn command_available(executable: &Path, args: &[&str]) -> bool {
  let status = Command::new(executable)
    .args(args)
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .status();

  matches!(status, Ok(code) if code.success())
}

fn resolve_node_executable(runtime_root: &Path) -> Result<PathBuf, StartupFailure> {
  let bundled_candidates = if cfg!(target_os = "windows") {
    vec![
      runtime_root.join("node").join("node.exe"),
      runtime_root.join("node.exe"),
    ]
  } else {
    vec![
      runtime_root.join("node").join("bin").join("node"),
      runtime_root.join("node").join("node"),
      runtime_root.join("node"),
    ]
  };

  for candidate in bundled_candidates {
    if candidate.exists() {
      return Ok(candidate);
    }
  }

  let system_node = PathBuf::from("node");
  if command_available(&system_node, &["--version"]) {
    return Ok(system_node);
  }

  Err(StartupFailure::new(
    "NODE_NOT_FOUND",
    "Node.js runtime is required to start desktop services.",
    "No bundled Node binary was found and system node is unavailable.".to_string(),
    "Install Node.js from https://nodejs.org and relaunch EmailAgent Desktop.",
  ))
}

fn load_bootstrap_env(runtime_root: &Path) -> Vec<(String, String)> {
  let bootstrap_path = runtime_root.join("bootstrap").join("runtime-env.json");
  if !bootstrap_path.exists() {
    return Vec::new();
  }

  let raw = match fs::read_to_string(&bootstrap_path) {
    Ok(raw) => raw,
    Err(_) => return Vec::new(),
  };

  let parsed = match serde_json::from_str::<HashMap<String, String>>(&raw) {
    Ok(parsed) => parsed,
    Err(_) => return Vec::new(),
  };

  parsed
    .into_iter()
    .filter_map(|(key, value)| {
      let normalized_key = key.trim().to_string();
      let normalized_value = value.trim().to_string();
      if normalized_key.is_empty() || normalized_value.is_empty() {
        None
      } else {
        Some((normalized_key, normalized_value))
      }
    })
    .collect()
}

fn start_backend(
  runtime_root: &Path,
  node_executable: &Path,
  bootstrap_env: &[(String, String)],
  log_dir: &Path,
) -> Result<Child, StartupFailure> {
  let standalone_dir = runtime_root.join(".next").join("standalone");
  let server_entry = standalone_dir.join("server.js");
  if !server_entry.exists() {
    return Err(StartupFailure::new(
      "BACKEND_ENTRY_MISSING",
      "Backend entry file is missing.",
      format!("Expected backend entry at {}", server_entry.display()),
      "Reinstall EmailAgent Desktop or rebuild installer assets with npm run desktop:ship:prep.",
    ));
  }

  let static_dir = standalone_dir.join(".next").join("static");
  if !static_dir.exists() {
    return Err(StartupFailure::new(
      "BACKEND_STATIC_MISSING",
      "Backend static assets are missing.",
      format!("Expected static directory at {}", static_dir.display()),
      "Rebuild desktop runtime bundle so .next/static is packaged with standalone output.",
    ));
  }

  let mut command = Command::new(node_executable);
  command
    .current_dir(&standalone_dir)
    .arg("server.js")
    .env("HOSTNAME", "127.0.0.1")
    .env("PORT", "3000")
    .env("NODE_ENV", "production")
    .env("EMAILAGENT_DESKTOP", "1");
  for (key, value) in bootstrap_env {
    command.env(key, value);
  }
  configure_stdio(&mut command, Some(log_dir), "backend");

  let child = command
    .spawn()
    .map_err(|err| {
      StartupFailure::new(
        "BACKEND_SPAWN_FAILED",
        "Failed to spawn backend process.",
        err.to_string(),
        "Verify antivirus policy allows app execution, then retry startup.",
      )
    })?;
  Ok(child)
}

fn start_worker(
  runtime_root: &Path,
  node_executable: &Path,
  bootstrap_env: &[(String, String)],
  log_dir: &Path,
) -> Result<Child, StartupFailure> {
  let standalone_dir = runtime_root.join(".next").join("standalone");
  let worker_entry = standalone_dir.join("dist").join("worker.js");
  if !worker_entry.exists() {
    return Err(StartupFailure::new(
      "WORKER_ENTRY_MISSING",
      "Worker entry file is missing.",
      format!("Expected worker entry at {}", worker_entry.display()),
      "Rebuild worker bundle and desktop runtime assets, then reinstall the app.",
    ));
  }

  let mut command = Command::new(node_executable);
  command
    .current_dir(&standalone_dir)
    .arg(worker_entry.as_os_str())
    .env("NODE_ENV", "production")
    .env("EMAILAGENT_DESKTOP", "1");
  for (key, value) in bootstrap_env {
    command.env(key, value);
  }
  configure_stdio(&mut command, Some(log_dir), "worker");

  let child = command
    .spawn()
    .map_err(|err| {
      StartupFailure::new(
        "WORKER_SPAWN_FAILED",
        "Failed to spawn worker process.",
        err.to_string(),
        "Verify runtime files and permissions, then retry startup.",
      )
    })?;
  Ok(child)
}

fn is_port_available(port: u16) -> bool {
  match TcpListener::bind((BACKEND_HOST, port)) {
    Ok(listener) => {
      drop(listener);
      true
    }
    Err(_) => false,
  }
}

#[derive(Clone)]
struct BackendProbe {
  status_code: u16,
  is_emailagent: bool,
}

fn parse_status_code(response: &str) -> Option<u16> {
  let line = response.lines().next()?;
  let mut parts = line.split_whitespace();
  let _http = parts.next()?;
  let status = parts.next()?;
  status.parse::<u16>().ok()
}

fn response_body(response: &str) -> &str {
  if let Some(idx) = response.find("\r\n\r\n") {
    &response[idx + 4..]
  } else {
    ""
  }
}

fn probe_backend() -> Option<BackendProbe> {
  let mut stream = TcpStream::connect((BACKEND_HOST, BACKEND_PORT)).ok()?;

  let _ = stream.set_read_timeout(Some(Duration::from_millis(700)));
  let _ = stream.set_write_timeout(Some(Duration::from_millis(700)));

  let request = format!(
    "GET {BACKEND_HEALTH_PATH} HTTP/1.1\r\nHost: {BACKEND_HOST}:{BACKEND_PORT}\r\nConnection: close\r\n\r\n"
  );
  if stream.write_all(request.as_bytes()).is_err() {
    return None;
  }

  let mut response = String::new();
  if stream.read_to_string(&mut response).is_err() {
    return None;
  }

  let status_code = parse_status_code(&response)?;
  let body = response_body(&response);
  let is_emailagent =
    body.contains("\"pipeline_ok\"") || body.contains("\"service\":\"emailagent-backend\"");

  Some(BackendProbe {
    status_code,
    is_emailagent,
  })
}

fn port_conflict_failure() -> StartupFailure {
  StartupFailure::new(
    "BACKEND_PORT_CONFLICT",
    "Backend port is already occupied.",
    format!(
      "Port {BACKEND_PORT} is in use by a process that is not EmailAgent backend."
    ),
    format!(
      "Close the process using port {BACKEND_PORT}, then relaunch EmailAgent Desktop."
    ),
  )
}

fn exit_status_text(status: ExitStatus) -> String {
  match status.code() {
    Some(code) => code.to_string(),
    None => "terminated by signal".to_string(),
  }
}

fn wait_for_backend(backend: &mut Child, timeout: Duration) -> Result<BackendProbe, StartupFailure> {
  let deadline = Instant::now() + timeout;
  while Instant::now() < deadline {
    match backend.try_wait() {
      Ok(Some(status)) => {
        return Err(StartupFailure::new(
          "BACKEND_EXITED",
          "Backend process exited during startup.",
          format!(
            "Backend exited before startup completed (exit code {}).",
            exit_status_text(status)
          ),
          "Verify DATABASE_URL and AUTH_SECRET configuration, then retry startup.",
        ))
      }
      Ok(None) => {}
      Err(err) => {
        return Err(StartupFailure::new(
          "BACKEND_PROCESS_CHECK_FAILED",
          "Failed to check backend process state.",
          err.to_string(),
          "Retry startup. If this repeats, reinstall EmailAgent Desktop.",
        ))
      }
    }

    if let Some(probe) = probe_backend() {
      if probe.is_emailagent {
        return Ok(probe);
      }

      if !is_port_available(BACKEND_PORT) {
        return Err(port_conflict_failure());
      }
    }

    thread::sleep(Duration::from_millis(300));
  }

  Err(StartupFailure::new(
    "BACKEND_BOOT_TIMEOUT",
    "Backend did not become reachable in time.",
    format!(
      "No valid response from {BACKEND_URL}{BACKEND_HEALTH_PATH} within {BACKEND_BOOT_TIMEOUT_SECS}s."
    ),
    "Retry startup. If it fails again, verify DB connectivity and runtime configuration.",
  ))
}

fn wait_for_worker_boot(worker: &mut Child) -> Result<(), StartupFailure> {
  let deadline = Instant::now() + Duration::from_millis(WORKER_BOOT_GRACE_MS);
  while Instant::now() < deadline {
    match worker.try_wait() {
      Ok(Some(status)) => {
        return Err(StartupFailure::new(
          "WORKER_EXITED",
          "Worker process exited right after launch.",
          format!(
            "Worker exited during startup validation (exit code {}).",
            exit_status_text(status)
          ),
          "Verify worker runtime configuration (especially DATABASE_URL) and retry startup.",
        ))
      }
      Ok(None) => {
        thread::sleep(Duration::from_millis(250));
      }
      Err(err) => {
        return Err(StartupFailure::new(
          "WORKER_PROCESS_CHECK_FAILED",
          "Failed to check worker process state.",
          err.to_string(),
          "Retry startup. If this repeats, reinstall EmailAgent Desktop.",
        ))
      }
    }
  }

  Ok(())
}

fn kill_child(child: &mut Child) {
  let _ = child.kill();
  let _ = child.wait();
}

fn bootstrap_runtime(app: &AppHandle) -> Result<String, StartupFailure> {
  {
    let state = app.state::<ManagedProcesses>();
    let guard = state
      .0
      .lock()
      .map_err(|_| {
        StartupFailure::new(
          "PROCESS_STATE_LOCK_FAILED",
          "Failed to lock process state.",
          "Runtime process state mutex is poisoned.".to_string(),
          "Close and reopen EmailAgent Desktop.",
        )
      })?;
    if guard.is_some() {
      return Ok("Runtime already running.".to_string());
    }
  }

  let runtime_root = resolve_runtime_root(app)?;
  let node_executable = resolve_node_executable(&runtime_root)?;
  let bootstrap_env = load_bootstrap_env(&runtime_root);
  let log_dir = resolve_log_dir(app);

  let mut backend_child: Option<Child> = None;
  let mut attached_existing_backend = false;
  let backend_probe = if let Some(probe) = probe_backend() {
    if !probe.is_emailagent {
      return Err(port_conflict_failure());
    }

    attached_existing_backend = true;
    probe
  } else {
    if !is_port_available(BACKEND_PORT) {
      return Err(port_conflict_failure());
    }

    let mut backend = start_backend(&runtime_root, &node_executable, &bootstrap_env, &log_dir)?;
    let probe = wait_for_backend(&mut backend, Duration::from_secs(BACKEND_BOOT_TIMEOUT_SECS))?;
    backend_child = Some(backend);
    probe
  };

  let mut worker = match start_worker(&runtime_root, &node_executable, &bootstrap_env, &log_dir) {
    Ok(worker) => worker,
    Err(err) => {
      if let Some(mut backend) = backend_child {
        kill_child(&mut backend);
      }
      return Err(err);
    }
  };

  if let Err(err) = wait_for_worker_boot(&mut worker) {
    kill_child(&mut worker);
    if let Some(mut backend) = backend_child {
      kill_child(&mut backend);
    }
    return Err(err);
  }

  let state = app.state::<ManagedProcesses>();
  let mut guard = state
    .0
    .lock()
    .map_err(|_| {
      StartupFailure::new(
        "PROCESS_STATE_UPDATE_FAILED",
        "Failed to update process state.",
        "Runtime process state mutex is poisoned during state update.".to_string(),
        "Close and reopen EmailAgent Desktop.",
      )
    })?;
  *guard = Some(RuntimeProcesses {
    backend: backend_child,
    worker,
  });

  let health_note = if backend_probe.status_code == 200 {
    "Backend health check passed."
  } else {
    "Backend is reachable in degraded mode; open onboarding/settings to complete setup."
  };

  if attached_existing_backend {
    Ok(format!(
      "Connected to existing backend at {BACKEND_URL} and started worker. {health_note}"
    ))
  } else {
    Ok(format!("Backend and worker started at {BACKEND_URL}. {health_note}"))
  }
}

fn spawn_runtime_bootstrap(app: &AppHandle, force_retry: bool) {
  if !force_retry {
    let status = current_boot_status(app);
    if status.state == "ready" {
      return;
    }
  }

  if !try_mark_boot_inflight(app) {
    return;
  }

  set_boot_status(
    app,
    DesktopBootStatus::starting("Starting local backend and worker..."),
  );

  let app_handle = app.clone();
  thread::spawn(move || {
    let next_status = match bootstrap_runtime(&app_handle) {
      Ok(message) => DesktopBootStatus::ready(&message),
      Err(failure) => DesktopBootStatus::error_with(&failure),
    };

    set_boot_status(&app_handle, next_status);
    clear_boot_inflight(&app_handle);
  });
}

fn read_lock_pid(lock_path: &Path) -> Option<u32> {
  let raw = fs::read_to_string(lock_path).ok()?;
  for line in raw.lines() {
    let trimmed = line.trim();
    if let Some(pid_text) = trimmed.strip_prefix("pid=") {
      if let Ok(pid) = pid_text.trim().parse::<u32>() {
        return Some(pid);
      }
    }
  }
  None
}

fn is_pid_running(pid: u32) -> bool {
  if pid == std::process::id() {
    return true;
  }

  #[cfg(target_os = "windows")]
  {
    let query = format!("tasklist /FI \"PID eq {pid}\" /FO LIST /NH");
    let output = Command::new("cmd").args(["/C", query.as_str()]).output();

    let output = match output {
      Ok(output) => output,
      Err(_) => return false,
    };

    if !output.status.success() {
      return false;
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
    if stdout.contains("no tasks are running") {
      return false;
    }

    stdout.contains(&format!("pid: {pid}"))
      || stdout.contains(&format!("pid:\t{pid}"))
      || stdout.contains(&format!("pid:{pid}"))
  }

  #[cfg(not(target_os = "windows"))]
  {
    Command::new("kill")
      .args(["-0", &pid.to_string()])
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .status()
      .map(|status| status.success())
      .unwrap_or(false)
  }
}

fn acquire_instance_lock(app: &AppHandle) -> Result<AppInstanceLock, String> {
  let lock_dir = app
    .path()
    .app_local_data_dir()
    .unwrap_or_else(|_| std::env::temp_dir().join("emailagent-desktop"));

  fs::create_dir_all(&lock_dir)
    .map_err(|err| format!("Unable to create app data directory for lock file: {err}"))?;

  let lock_path = lock_dir.join("instance.lock");
  let open_new_lock = || -> Result<File, String> {
    OpenOptions::new()
      .write(true)
      .create_new(true)
      .open(&lock_path)
      .map_err(|err| {
        if err.kind() == ErrorKind::AlreadyExists {
          "LOCK_ALREADY_EXISTS".to_string()
        } else {
          format!("Unable to create instance lock file: {err}")
        }
      })
  };

  let mut file = match open_new_lock() {
    Ok(file) => file,
    Err(err) if err == "LOCK_ALREADY_EXISTS" => {
      if let Some(existing_pid) = read_lock_pid(&lock_path) {
        if is_pid_running(existing_pid) {
          return Err(format!(
            "Another EmailAgent Desktop instance is already running (pid={existing_pid})."
          ));
        }
      }

      fs::remove_file(&lock_path)
        .map_err(|remove_err| format!("Unable to clear stale instance lock file: {remove_err}"))?;

      match open_new_lock() {
        Ok(file) => file,
        Err(retry_err) if retry_err == "LOCK_ALREADY_EXISTS" => {
          return Err("Another EmailAgent Desktop instance is already running.".to_string())
        }
        Err(retry_err) => return Err(retry_err),
      }
    }
    Err(err) => return Err(err),
  };

  let _ = writeln!(file, "pid={}", std::process::id());

  Ok(AppInstanceLock {
    path: lock_path,
    _file: file,
  })
}

fn ensure_instance_lock(app: &AppHandle) -> Result<(), StartupFailure> {
  let state = app.state::<ManagedInstanceLock>();
  let mut guard = state.0.lock().map_err(|_| {
    StartupFailure::new(
      "INSTANCE_LOCK_STATE_FAILED",
      "Unable to access instance lock state.",
      "Instance lock mutex is unavailable.".to_string(),
      "Close and relaunch EmailAgent Desktop.",
    )
  })?;

  if guard.is_some() {
    return Ok(());
  }

  let lock = acquire_instance_lock(app).map_err(|err| {
    StartupFailure::new(
      "INSTANCE_LOCK_FAILED",
      "EmailAgent could not acquire the app instance lock.",
      err,
      "Close other EmailAgent windows and relaunch. If the issue persists, restart Windows.",
    )
  })?;

  *guard = Some(lock);
  Ok(())
}

fn release_instance_lock(app: &AppHandle) {
  let state = app.state::<ManagedInstanceLock>();
  let mut guard = match state.0.lock() {
    Ok(guard) => guard,
    Err(_) => return,
  };

  let lock = match guard.take() {
    Some(lock) => lock,
    None => return,
  };

  let _ = fs::remove_file(lock.path);
}

fn stop_managed_processes(app: &AppHandle) {
  let state = app.state::<ManagedProcesses>();
  let mut guard = match state.0.lock() {
    Ok(guard) => guard,
    Err(_) => return,
  };

  let mut processes = match guard.take() {
    Some(processes) => processes,
    None => return,
  };

  kill_child(&mut processes.worker);
  if let Some(mut backend) = processes.backend {
    kill_child(&mut backend);
  }
}

fn main() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      open_external_url,
      desktop_boot_status,
      desktop_retry_runtime_boot,
    ])
    .manage(ManagedProcesses(Mutex::new(None)))
    .manage(ManagedBootStatus(Mutex::new(DesktopBootStatus::starting(
      "Initializing desktop runtime...",
    ))))
    .manage(ManagedBootInFlight(Mutex::new(false)))
    .manage(ManagedInstanceLock(Mutex::new(None)))
    .setup(|app| {
      match ensure_instance_lock(app.handle()) {
        Ok(()) => {
          spawn_runtime_bootstrap(app.handle(), false);
        }
        Err(failure) => {
          set_boot_status(app.handle(), DesktopBootStatus::error_with(&failure));
        }
      }

      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("failed to build tauri application")
    .run(|app, event| {
      if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
        stop_managed_processes(app);
        release_instance_lock(app);
      }
    });
}
