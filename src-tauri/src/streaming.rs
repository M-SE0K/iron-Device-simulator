//!
//! audio_capture.rs/audio_playcapture.rs가 이 모듈의 `StreamController`/`run_streaming_helper`를
//! 공유 재사용한다 — 두 헬퍼(capture/play-capture) 모두 "첫 줄 JSON 헤더 → 이후 raw PCM 청크"
//! 프로토콜과 stdin-EOF 종료 규약이 동일하기 때문이다(원본 JS와 동일 구조).
//!
//! Node의 단일 스레드 이벤트 루프가 암묵적으로 보장하던 순서(사용자 stop이 먼저 `child = null`을
//! 해서 뒤이은 exit 핸들러의 `isCurrentChild` 체크를 실패시키는 것)를, Rust에서는 스레드가
//! 여럿이라 명시적 동기화가 필요하다. 그래서 원본에는 없는 **세대(generation) 카운터**를
//! 도입했다: 매 시작마다 세대를 올려 자신의 세대 번호를 기억해두고, 프로세스 종료를 감지했을 때
//! "그 사이 세대가 바뀌지 않았는지"(=사용자가 stop을 부르지 않았는지)를 판정 근거로 쓴다.
//! `stop()`은 (원본의 `child = null` 선행과 동일한 의미로) 프로세스를 실제로 죽이기 **전에**
//! 세대를 먼저 올리고 자신의 자식 참조를 비운다 — 뒤늦게 도착하는 종료 감지가 ended 이벤트를
//! 내보내지 않도록 억제하기 위해서다.

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

/// stdout을 한 번에 읽는 버퍼 크기. 헬퍼가 int16 인터리브 PCM을 얼마나 자주/크게 flush하는지는
/// OS 파이프 버퍼링에 달려 있으므로, 이 크기는 상한일 뿐 실제 청크 경계와는 무관하다(원본 JS도
/// Node stream의 임의 청크 경계를 그대로 중계했다 — 동일 계약).
const READ_BUF_SIZE: usize = 65536;

/// capture/play-capture 상주 헬퍼 자식 프로세스 하나를 관리하는 상태.
/// `audio_capture.rs`/`audio_playcapture.rs`가 각자 별도 인스턴스를 `tauri::State`로 관리한다.
pub struct StreamController {
    child: Mutex<Option<Child>>,
    /// 자식의 stdin을 `Child`에서 떼어내 따로 보관한다 — play-capture 스트리밍 모드는 재생
    /// 프레임마다(~100 Hz) 여기에 PCM을 쓰는데, 그 경로가 `is_running()`/reap 폴링 같은 다른
    /// 경로와 child 뮤텍스를 다투지 않게 하려는 것. 이 핸들을 drop하는 것이 곧 헬퍼에 보내는
    /// EOF 신호다(양쪽 헬퍼 모두 stdin EOF를 정상 종료 경로로 처리한다).
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

    /// 이미 상주 헬퍼가 떠 있는지 — `capture-already-running` / `play-capture-already-running`
    /// 판정에 쓴다.
    pub fn is_running(&self) -> bool {
        self.child.lock().unwrap().is_some()
    }

    /// pause/resume/end 등 stdin 한 줄 명령 중계 — `audio-playcapture:control`용.
    /// 자식이 없으면 `not-running`.
    pub fn write_stdin_line(&self, line: &str) -> Result<(), String> {
        self.write_stdin_bytes(line.as_bytes())
    }

    /// stdin에 바이트를 그대로 쓴다 — play-capture 스트리밍 모드의 `"pcm <n>\n" + 페이로드`용.
    /// 한 호출이 곧 한 번의 `write_all`이고 stdin 뮤텍스로 직렬화되므로, 헤더와 페이로드 사이에
    /// 다른 제어 라인이 끼어들 수 없다.
    pub fn write_stdin_bytes(&self, bytes: &[u8]) -> Result<(), String> {
        let mut guard = self.stdin.lock().unwrap();
        let stdin = guard.as_mut().ok_or_else(|| "not-running".to_string())?;
        stdin.write_all(bytes).map_err(|e| e.to_string())
    }

    /// 새 자식을 등록하고 새 세대 번호를 반환한다. 호출 전 `is_running()`으로 중복 실행을
    /// 확인해야 한다(레이스는 단일 렌더러 호출 패턴에서 실질적 위험이 없다 — 원본과 동일 가정).
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

    /// 사용자 주도 종료. **세대를 먼저 올리고 자식 참조를 비운 뒤** 실제 종료 절차(stdin EOF →
    /// 유예 → kill)를 밟는다 — 원본 `createStreamingChildController.stop`의 `child = null` 선행과
    /// 동일한 순서·의도(뒤이어 도착할 exit 감지가 ended 이벤트를 내보내지 않게 억제).
    pub fn stop(&self) -> Value {
        let child = {
            let mut guard = self.child.lock().unwrap();
            self.generation.fetch_add(1, Ordering::SeqCst);
            guard.take()
        };
        // 세대를 올린 **뒤에** stdin을 떨어뜨린다 — 순서가 반대면 EOF를 받은 헬퍼가 먼저 죽어
        // 리더 스레드가 아직 현재 세대라고 판단하고 ended 이벤트를 내보낼 수 있다.
        drop(self.stdin.lock().unwrap().take());
        if let Some(mut child) = child {
            stop_streaming_child(&mut child);
            // 종료된 자식을 reap해 좀비 프로세스가 남지 않게 한다. exit code는 여기서는
            // 쓰이지 않는다(사용자 stop의 반환값은 항상 success:true — 원본과 동일).
            let _ = child.wait();
        }
        serde_json::json!({ "success": true })
    }
}

/// 상주 헬퍼 종료 대기 — SIGTERM으로 바로 죽이면 Windows에서 곧장 TerminateProcess로 강제 종료돼
/// ASIOStop/DisposeBuffers/ASIOExit 같은 정리 경로를 건너뛴다(원본 JS 주석과 동일 근거).
/// 두 플랫폼 헬퍼 모두 stdin EOF를 정상 종료 신호로 이미 처리하므로, 호출자(`stop()`)가 먼저
/// stdin 핸들을 drop해 그 경로를 타게 하고, 여기서는 `grace` 안에 종료하는지만 지켜보다
/// 넘기면 `kill()`로 강제 정리한다(드라이버 행 등 안전망).
fn stop_streaming_child(child: &mut Child) {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return; // 이미 종료됨
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

/// stdout EOF 이후 종료 코드를 회수(reap)한다. 폴링 도중 세대가 바뀌면(=그 사이 `stop()`이
/// 먼저 자식을 가져가 정리 중) 더 기다리지 않고 포기한다 — 이중 kill/wait를 피하기 위함.
fn reap_after_eof(controller: &StreamController, my_generation: u64) -> Option<i32> {
    loop {
        let mut guard = controller.child.lock().unwrap();
        if controller.generation() != my_generation {
            return None; // stop()이 이미 가져가 처리 중 — 그쪽이 reap을 책임진다.
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

/// `run-streaming-helper.js`의 `runStreamingHelper` 포팅.
///
/// 반환값은 헬퍼의 첫 줄 JSON 헤더(성공 시) 또는 헤더가 끝내 오지 않고 프로세스가 죽었을 때의
/// `{"success": false, "error": "helper-exited(<code>)"}`(ipc-error.ts 정규식과 정확히 일치해야
/// 하는 포맷 — 시그널로 죽어 코드가 없으면 "-1"로 대체한다).
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
            // Node child_process의 'error' 이벤트(대개 ENOENT 등 spawn 자체 실패) 대응.
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
            Ok(0) => break, // EOF — 헬퍼가 stdout을 닫음(대개 프로세스 종료와 함께).
            Ok(n) => n,
            Err(_) => break,
        };

        if header_done {
            let _ = data_channel.send(InvokeResponseBody::Raw(buf[..n].to_vec()));
            continue;
        }

        header_buf.extend_from_slice(&buf[..n]);
        let Some(nl) = header_buf.iter().position(|&b| b == b'\n') else {
            continue; // 헤더 줄이 아직 다 안 옴 — 다음 read를 계속 기다린다.
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
            // 원본 JS: stopActiveChild() — 세대를 올려 자신을 비우 뒤 stdin EOF→유예→kill.
            controller.stop();
        } else {
            // 헤더 개행 뒤에 이미 읽힌 나머지 바이트는 첫 데이터 청크로 그대로 전달한다
            // (원본 run-streaming-helper.js:56-:61과 동일 동작).
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
