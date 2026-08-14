//! `perf` 피처 전용 — 파이프라인 각 노드(ASIO/CoreAudio 캡처, IPC 스트리밍)의 지연을 재서
//! `iron-perf` 앱 이벤트로 프론트엔드에 흘려보낸다. 프론트엔드는
//! `src/shared/lib/iron-perf`에서 이 이벤트를 구독해 `window.__ironPerf`로 노출한다.
//! 이 모듈은 배포 빌드(`perf` 피처 꺼짐)에서는 아예 컴파일되지 않는다
//! (`main.rs`의 `#[cfg(feature = "perf")] mod perf;`).
//!
//! WASM 엔진(③)·렌더(④) 노드는 전부 프론트엔드(JS/TS) 안에서 벌어지는 일이라 이 모듈과
//! 무관하게 `src/shared/lib/iron-perf/collector.ts`가 직접 잰다 — 여기서 다루는 건 네이티브
//! 프로세스 경계를 건너는 ①/② 뿐이다.

use std::io::{BufRead, BufReader};
use std::process::ChildStderr;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

/// 프론트엔드가 `listen()`으로 구독하는 앱 이벤트 이름 — `iron-perf/index.ts`와 반드시 일치.
pub const PERF_EVENT: &str = "iron-perf";

/// `streaming.rs` 리더 루프가 이 주기마다 누적된 통계를 스냅샷·리셋해서 emit한다.
pub const EMIT_INTERVAL: Duration = Duration::from_millis(500);

/// 재설정 가능한 마이크로초 단위 min/max/avg/count 롤링 통계.
///
/// `streaming.rs`의 리더 루프 스레드 하나만 소유해서 쓴다 — 여러 스레드가 공유하지 않으므로
/// 원자 연산/락이 필요 없다(실시간 오디오 콜백에서 쓰는 네이티브 쪽 통계와는 다른 용도).
#[derive(Default)]
pub struct RollingStats {
    count: u64,
    sum_us: f64,
    max_us: f64,
    min_us: f64,
}

impl RollingStats {
    pub fn record(&mut self, d: Duration) {
        let us = d.as_secs_f64() * 1_000_000.0;
        self.count += 1;
        self.sum_us += us;
        if self.count == 1 || us > self.max_us {
            self.max_us = us;
        }
        if self.count == 1 || us < self.min_us {
            self.min_us = us;
        }
    }

    /// 누적된 표본이 있으면 JSON으로 스냅샷하고 내부 상태를 리셋한다. 없으면 `None`
    /// (해당 구간에 활동이 없었던 emit 주기 — 굳이 빈 이벤트를 보내지 않는다).
    pub fn take_snapshot(&mut self) -> Option<serde_json::Value> {
        if self.count == 0 {
            return None;
        }
        let value = serde_json::json!({
            "count": self.count,
            "avgUs": self.sum_us / self.count as f64,
            "maxUs": self.max_us,
            "minUs": self.min_us,
        });
        *self = Self::default();
        Some(value)
    }
}

/// 네이티브 헬퍼(ASIO/CoreAudio)가 `#ifdef IRON_PERF`로 stderr에 흘려보내는 perf JSON 라인을
/// 읽어 그대로 `iron-perf` 앱 이벤트로 포워드한다. 오디오 데이터 채널
/// (`Channel<InvokeResponseBody>`, stdout 경유)과 완전히 분리된 사이드채널이라 PCM 스트림
/// 파싱에는 전혀 영향이 없다 — 헬퍼가 perf 빌드가 아니면 stderr에 아무것도 안 쓰므로 이 스레드는
/// 그냥 EOF까지 조용히 대기하다 끝난다.
pub fn spawn_stderr_forwarder(app: AppHandle, stderr: ChildStderr) {
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue; // perf 라인이 아니거나 깨진 줄 — 무시하고 다음 줄 계속.
            };
            if value.get("type").and_then(|v| v.as_str()) != Some("perf") {
                continue;
            }
            let _ = app.emit(PERF_EVENT, value);
        }
    });
}
