use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter};

const READ_BUF_SIZE: usize = 65536;

pub struct StreamController {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    generation: AtomicU64,
}

impl Default for StreamController {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamController {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            stdin: Mutex::new(None),
            generation: AtomicU64::new(0),
        }
    }

    pub fn is_running(&self) -> bool {
        self.child.lock().unwrap().is_some()
    }

    pub fn write_stdin_line(&self, line: &str) -> Result<(), String> {
        self.write_stdin_bytes(line.as_bytes())
    }

    pub fn write_stdin_bytes(&self, bytes: &[u8]) -> Result<(), String> {
        let mut guard = self.stdin.lock().unwrap();
        let stdin = guard.as_mut().ok_or_else(|| "not-running".to_string())?;
        stdin.write_all(bytes).map_err(|e| e.to_string())
    }

    fn begin(&self, mut child: Child) -> u64 {
        let stdin = child.stdin.take();
        let mut guard = self.child.lock().unwrap();
        let gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        *self.stdin.lock().unwrap() = stdin;
        *guard = Some(child);
        gen
    }

    fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    pub fn stop(&self) -> Value {
        let child = {
            let mut guard = self.child.lock().unwrap();
            self.generation.fetch_add(1, Ordering::SeqCst);
            guard.take()
        };
        drop(self.stdin.lock().unwrap().take());
        if let Some(mut child) = child {
            stop_streaming_child(&mut child);
            let _ = child.wait();
        }
        serde_json::json!({ "success": true })
    }
}

fn stop_streaming_child(child: &mut Child) {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    let deadline = Instant::now() + Duration::from_millis(200);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    return;
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(_) => return,
        }
    }
}

fn reap_after_eof(controller: &StreamController, my_generation: u64) -> Option<i32> {
    loop {
        let mut guard = controller.child.lock().unwrap();
        if controller.generation() != my_generation {
            return None;
        }
        let child = guard.as_mut()?;
        match child.try_wait() {
            Ok(Some(status)) => {
                guard.take();
                return status.code();
            }
            Ok(None) => {
                drop(guard);
                thread::sleep(Duration::from_millis(10));
            }
            Err(_) => {
                guard.take();
                return None;
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn run_streaming_helper(
    app: AppHandle,
    controller: Arc<StreamController>,
    helper_path: std::path::PathBuf,
    args: Vec<String>,
    data_channel: Channel<InvokeResponseBody>,
    ended_event: String,
    on_exit_cleanup: Option<Box<dyn FnOnce() + Send + 'static>>,
) -> Value {
    let mut command = crate::helper::helper_command(&helper_path);
    command
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            if let Some(cleanup) = on_exit_cleanup {
                cleanup();
            }
            return serde_json::json!({ "success": false, "error": err.to_string() });
        }
    };

    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            if let Some(cleanup) = on_exit_cleanup {
                cleanup();
            }
            return serde_json::json!({ "success": false, "error": "invalid-helper-output" });
        }
    };

    let my_generation = controller.begin(child);
    let (settle_tx, settle_rx) = mpsc::channel::<Value>();

    thread::spawn(move || {
        reader_loop(
            app,
            controller,
            my_generation,
            stdout,
            data_channel,
            ended_event,
            on_exit_cleanup,
            settle_tx,
        );
    });

    settle_rx.recv().unwrap_or_else(
        |_| serde_json::json!({ "success": false, "error": "invalid-helper-output" }),
    )
}

#[allow(clippy::too_many_arguments)]
fn reader_loop(
    app: AppHandle,
    controller: Arc<StreamController>,
    my_generation: u64,
    mut stdout: impl Read,
    data_channel: Channel<InvokeResponseBody>,
    ended_event: String,
    on_exit_cleanup: Option<Box<dyn FnOnce() + Send + 'static>>,
    settle_tx: mpsc::Sender<Value>,
) {
    let mut header_buf: Vec<u8> = Vec::new();
    let mut header_done = false;
    let mut settled = false;
    let mut buf = [0u8; READ_BUF_SIZE];

    loop {
        let n = match stdout.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };

        if header_done {
            let _ = data_channel.send(InvokeResponseBody::Raw(buf[..n].to_vec()));
            continue;
        }

        header_buf.extend_from_slice(&buf[..n]);
        let Some(nl) = header_buf.iter().position(|&b| b == b'\n') else {
            continue;
        };
        header_done = true;

        let header: Value = serde_json::from_slice(&header_buf[..nl]).unwrap_or_else(
            |_| serde_json::json!({ "success": false, "error": "invalid-helper-output" }),
        );
        let success = header
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        if !success {
            controller.stop();
        } else {
            let rest = header_buf[nl + 1..].to_vec();
            if !rest.is_empty() {
                let _ = data_channel.send(InvokeResponseBody::Raw(rest));
            }
        }

        if !settled {
            settled = true;
            let _ = settle_tx.send(header);
        }
    }

    let code = reap_after_eof(&controller, my_generation);
    let still_current = controller.generation() == my_generation;
    if still_current {
        let _ = app.emit(&ended_event, serde_json::json!({ "code": code }));
    }
    if let Some(cleanup) = on_exit_cleanup {
        cleanup();
    }
    if !settled {
        let code_str = code.map_or_else(|| "-1".to_string(), |c| c.to_string());
        let _ = settle_tx.send(serde_json::json!({
            "success": false,
            "error": format!("helper-exited({code_str})"),
        }));
    }
}
