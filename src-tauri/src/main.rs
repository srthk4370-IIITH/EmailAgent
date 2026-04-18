#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

type AnyError = Box<dyn std::error::Error + Send + Sync>;

const BACKEND_URL: &str = "http://127.0.0.1:3000";
const BACKEND_HEALTH_PATH: &str = "/api/health";
const BACKEND_BOOT_TIMEOUT_SECS: u64 = 45;

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
}

impl DesktopBootStatus {
  fn starting(message: &str) -> Self {
    Self {
      state: "starting".to_string(),
      message: message.to_string(),
      backend_url: BACKEND_URL.to_string(),
    }
  }

  fn ready(message: &str) -> Self {
    Self {
      state: "ready".to_string(),
      message: message.to_string(),
      backend_url: BACKEND_URL.to_string(),
    }
  }

  fn error(message: &str) -> Self {
    Self {
      state: "error".to_string(),
      message: message.to_string(),
      backend_url: BACKEND_URL.to_string(),
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

fn configure_stdio(command: &mut Command) {
  if cfg!(debug_assertions) {
    command.stdout(Stdio::inherit()).stderr(Stdio::inherit());
  } else {
    command.stdout(Stdio::null()).stderr(Stdio::null());
  }
}

fn resolve_runtime_root(app: &AppHandle) -> Result<PathBuf, AnyError> {
  if let Ok(resource_dir) = app.path().resource_dir() {
    let bundled_runtime = resource_dir.join("runtime");
    if bundled_runtime.exists() {
      return Ok(bundled_runtime);
    }
  }

  let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
  let workspace_root = manifest_dir
    .parent()
    .ok_or("Unable to resolve workspace root from CARGO_MANIFEST_DIR")?;

  let staged_runtime = workspace_root.join("desktop").join("runtime");
  if staged_runtime.exists() {
    return Ok(staged_runtime);
  }

  Ok(workspace_root.to_path_buf())
}

fn command_available(executable: &Path, args: &[&str]) -> bool {
  let status = Command::new(executable)
    .args(args)
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .status();

  matches!(status, Ok(code) if code.success())
}

fn resolve_node_executable(runtime_root: &Path) -> Result<PathBuf, AnyError> {
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

  Err("Node.js runtime not found. Install Node.js 20+ or bundle a node binary under runtime/node/.".into())
}

fn start_backend(runtime_root: &Path, node_executable: &Path) -> Result<Child, AnyError> {
  let standalone_dir = runtime_root.join(".next").join("standalone");
  let server_entry = standalone_dir.join("server.js");
  if !server_entry.exists() {
    return Err(format!("Backend entry not found: {}", server_entry.display()).into());
  }

  let mut command = Command::new(node_executable);
  command
    .current_dir(&standalone_dir)
    .arg("server.js")
    .env("HOSTNAME", "127.0.0.1")
    .env("PORT", "3000")
    .env("NODE_ENV", "production")
    .env("EMAILAGENT_DESKTOP", "1");
  configure_stdio(&mut command);

  let child = command
    .spawn()
    .map_err(|err| format!("Failed to start backend server process: {err}"))?;
  Ok(child)
}

fn start_worker(runtime_root: &Path, node_executable: &Path) -> Result<Child, AnyError> {
  let standalone_dir = runtime_root.join(".next").join("standalone");
  let worker_entry = standalone_dir.join("dist").join("worker.js");
  if !worker_entry.exists() {
    return Err(format!("Worker entry not found: {}", worker_entry.display()).into());
  }

  let mut command = Command::new(node_executable);
  command
    .current_dir(&standalone_dir)
    .arg(worker_entry.as_os_str())
    .env("NODE_ENV", "production")
    .env("EMAILAGENT_DESKTOP", "1");
  configure_stdio(&mut command);

  let child = command
    .spawn()
    .map_err(|err| format!("Failed to start worker process: {err}"))?;
  Ok(child)
}

fn is_backend_healthy() -> bool {
  let mut stream = match TcpStream::connect("127.0.0.1:3000") {
    Ok(stream) => stream,
    Err(_) => return false,
  };

  let _ = stream.set_read_timeout(Some(Duration::from_millis(700)));
  let _ = stream.set_write_timeout(Some(Duration::from_millis(700)));

  let request = format!(
    "GET {} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    BACKEND_HEALTH_PATH,
  );
  if stream.write_all(request.as_bytes()).is_err() {
    return false;
  }

  let mut response = String::new();
  if stream.read_to_string(&mut response).is_err() {
    return false;
  }

  response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")
}

fn wait_for_backend(timeout: Duration) -> Result<(), AnyError> {
  let deadline = Instant::now() + timeout;
  while Instant::now() < deadline {
    if is_backend_healthy() {
      return Ok(());
    }
    thread::sleep(Duration::from_millis(300));
  }

  Err("Backend did not become healthy before timeout".into())
}

fn kill_child(child: &mut Child) {
  let _ = child.kill();
  let _ = child.wait();
}

fn bootstrap_runtime(app: &AppHandle) -> Result<String, String> {
  {
    let state = app.state::<ManagedProcesses>();
    let guard = state
      .0
      .lock()
      .map_err(|_| "Failed to lock process state.".to_string())?;
    if guard.is_some() {
      return Ok("Runtime already running.".to_string());
    }
  }

  let runtime_root = resolve_runtime_root(app)
    .map_err(|err| format!("Failed to resolve packaged runtime: {err}"))?;
  let node_executable = resolve_node_executable(&runtime_root)
    .map_err(|err| format!("Startup blocked: {err}"))?;

  let mut backend_child: Option<Child> = None;
  let mut attached_existing_backend = false;

  if is_backend_healthy() {
    attached_existing_backend = true;
  } else {
    let mut backend = start_backend(&runtime_root, &node_executable)
      .map_err(|err| format!("Failed to start backend: {err}"))?;

    if let Err(err) = wait_for_backend(Duration::from_secs(BACKEND_BOOT_TIMEOUT_SECS)) {
      kill_child(&mut backend);
      return Err(format!(
        "Backend did not become healthy at {BACKEND_URL} within {BACKEND_BOOT_TIMEOUT_SECS}s: {err}"
      ));
    }

    backend_child = Some(backend);
  }

  let worker = match start_worker(&runtime_root, &node_executable) {
    Ok(worker) => worker,
    Err(err) => {
      if let Some(mut backend) = backend_child {
        kill_child(&mut backend);
      }
      return Err(format!("Failed to start worker: {err}"));
    }
  };

  let state = app.state::<ManagedProcesses>();
  let mut guard = state
    .0
    .lock()
    .map_err(|_| "Failed to lock process state for update.".to_string())?;
  *guard = Some(RuntimeProcesses {
    backend: backend_child,
    worker,
  });

  if attached_existing_backend {
    Ok(format!(
      "Connected to existing backend at {BACKEND_URL} and started worker."
    ))
  } else {
    Ok(format!("Backend and worker started at {BACKEND_URL}."))
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
      Err(message) => DesktopBootStatus::error(&message),
    };

    set_boot_status(&app_handle, next_status);
    clear_boot_inflight(&app_handle);
  });
}

fn acquire_instance_lock(app: &AppHandle) -> Result<AppInstanceLock, String> {
  let lock_dir = app
    .path()
    .app_local_data_dir()
    .unwrap_or_else(|_| std::env::temp_dir().join("emailagent-desktop"));

  fs::create_dir_all(&lock_dir)
    .map_err(|err| format!("Unable to create app data directory for lock file: {err}"))?;

  let lock_path = lock_dir.join("instance.lock");
  let mut file = match OpenOptions::new()
    .write(true)
    .create_new(true)
    .open(&lock_path)
  {
    Ok(file) => file,
    Err(err) if err.kind() == ErrorKind::AlreadyExists => {
      return Err("Another EmailAgent Desktop instance is already running.".to_string())
    }
    Err(err) => {
      return Err(format!("Unable to create instance lock file: {err}"));
    }
  };

  let _ = writeln!(file, "pid={}", std::process::id());

  Ok(AppInstanceLock {
    path: lock_path,
    _file: file,
  })
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
      let lock = acquire_instance_lock(app.handle())
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::Other, err))?;
      let lock_state = app.state::<ManagedInstanceLock>();
      let mut lock_guard = lock_state
        .0
        .lock()
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "Failed to lock instance state"))?;
      *lock_guard = Some(lock);

      spawn_runtime_bootstrap(app.handle(), false);

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
