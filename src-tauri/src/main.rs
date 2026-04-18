#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

type AnyError = Box<dyn std::error::Error>;

struct RuntimeProcesses {
  backend: Child,
  worker: Child,
}

struct ManagedProcesses(Mutex<Option<RuntimeProcesses>>);

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

fn start_backend(runtime_root: &Path) -> Result<Child, AnyError> {
  let standalone_dir = runtime_root.join(".next").join("standalone");
  let server_entry = standalone_dir.join("server.js");
  if !server_entry.exists() {
    return Err(format!("Backend entry not found: {}", server_entry.display()).into());
  }

  let mut command = Command::new("node");
  command
    .current_dir(&standalone_dir)
    .arg("server.js")
    .env("HOSTNAME", "127.0.0.1")
    .env("PORT", "3000");
  configure_stdio(&mut command);

  let child = command
    .spawn()
    .map_err(|err| format!("Failed to start backend server process: {err}"))?;
  Ok(child)
}

fn start_worker(runtime_root: &Path) -> Result<Child, AnyError> {
  let standalone_dir = runtime_root.join(".next").join("standalone");
  let worker_entry = standalone_dir
    .join("dist-worker")
    .join("worker")
    .join("worker.js");
  if !worker_entry.exists() {
    return Err(format!("Worker entry not found: {}", worker_entry.display()).into());
  }

  let mut command = Command::new("node");
  command.current_dir(&standalone_dir).arg(worker_entry.as_os_str());
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

  let request = b"GET /api/session/verify HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
  if stream.write_all(request).is_err() {
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

  let _ = processes.worker.kill();
  let _ = processes.backend.kill();
  let _ = processes.worker.wait();
  let _ = processes.backend.wait();
}

fn main() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![open_external_url])
    .manage(ManagedProcesses(Mutex::new(None)))
    .setup(|app| {
      let runtime_root = resolve_runtime_root(app.handle())?;
      println!("Desktop runtime root: {}", runtime_root.display());

      let mut backend = start_backend(&runtime_root)?;
      if let Err(err) = wait_for_backend(Duration::from_secs(30)) {
        let _ = backend.kill();
        let _ = backend.wait();
        return Err(err);
      }

      let worker = match start_worker(&runtime_root) {
        Ok(worker) => worker,
        Err(err) => {
          let _ = backend.kill();
          let _ = backend.wait();
          return Err(err);
        }
      };

      let state = app.state::<ManagedProcesses>();
      let mut guard = state
        .0
        .lock()
        .map_err(|_| "Failed to lock managed process state")?;
      *guard = Some(RuntimeProcesses { backend, worker });

      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("failed to build tauri application")
    .run(|app, event| {
      if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
        stop_managed_processes(app);
      }
    });
}
