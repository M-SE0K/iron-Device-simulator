#!/usr/bin/env python3
"""play-capture --stream 프로토콜 테스트 — 진짜 main.cpp + 가짜 백엔드.

검증 대상은 main.cpp 쪽이다: stdin 프레이밍(pcm/end/pause/resume), 프리필 게이트,
종료 코드, 언더런 보고. ASIO 콜백 자체는 여기서 검증되지 않는다(tests/host/README.md).
"""
import json
import struct
import subprocess
import sys
import threading
import time

HELPER = sys.argv[1]
RATE = 48000
BUFSZ = 480
CH = 2
BYTES_PER_FRAME = 2 * 2  # 인터리브 스테레오 int16

failures = []


def check(name, cond, detail=""):
    mark = "✓" if cond else "✗"
    print(f"  {mark} {name}" + (f" — {detail}" if detail else ""))
    if not cond:
        failures.append(name)


class Helper:
    """헬퍼 프로세스 + stdout 소비 스레드.

    ⚠️ stdout을 계속 읽어주는 쪽이 없으면 헬퍼는 종료하지 못한다. writer 스레드가 꽉 찬
    파이프의 fwrite에 붙잡히고, main이 그 writer를 join하기 때문이다. 실제 앱에서는 Rust
    (streaming.rs)가 쉬지 않고 읽으므로 생기지 않는 상황이지만, 테스트는 직접 흉내 내야 한다.
    """

    def __init__(self, *extra):
        args = [HELPER, "play-capture", "--stream", str(RATE), str(BUFSZ), str(CH),
                "--out-ch", "0", "--out-ch-r", "1", *extra]
        self.p = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE)
        self.header = json.loads(self.p.stdout.readline().decode())
        self._chunks = []
        self._lock = threading.Lock()
        self._reader = threading.Thread(target=self._pump, daemon=True)
        self._reader.start()

    def _pump(self):
        while True:
            b = self.p.stdout.read(8192)
            if not b:
                break
            with self._lock:
                self._chunks.append(b)

    def pcm_bytes(self):
        with self._lock:
            return sum(len(c) for c in self._chunks)

    def send_pcm(self, frames):
        payload = pcm_frames(frames)
        self.p.stdin.write(b"pcm %d\n" % len(payload))
        self.p.stdin.write(payload)
        self.p.stdin.flush()

    def line(self, cmd):
        self.p.stdin.write(cmd.encode() + b"\n")
        self.p.stdin.flush()

    def wait(self, timeout=10):
        rc = self.p.wait(timeout=timeout)
        self._reader.join(timeout=2)
        return rc

    def stderr(self):
        return self.p.stderr.read().decode()


def pcm_frames(n, value=1000):
    """n 프레임짜리 인터리브 스테레오 int16 페이로드."""
    return struct.pack("<" + "h" * (n * 2), *([value, -value] * n))


# ── A. 정상 경로: 프리필 → 재생 → end → 드레인 + 테일 → exit 0 ─────────────────
print("A. 정상 경로 (0.5초 재생 → end → exit 0)")
h = Helper("--prefill-ms", "40")
hdr = h.header
check("헤더 success", hdr.get("success") is True, str(hdr))
check("mode = play-capture-stream", hdr.get("mode") == "play-capture-stream")
check("prefillFrames = 1920 (40ms @48k)", hdr.get("prefillFrames") == 1920,
      str(hdr.get("prefillFrames")))
check("playbackChannel/R echo", hdr.get("playbackChannel") == 0 and hdr.get("playbackChannelR") == 1)
check("refLen 없음 (--stream은 길이를 모른다)", "refLen" not in hdr)

PLAY_FRAMES = RATE // 2  # 0.5초
sent = 0
while sent < PLAY_FRAMES:
    n = min(BUFSZ, PLAY_FRAMES - sent)
    h.send_pcm(n)
    sent += n
h.line("end")
rc = h.wait()
captured = h.pcm_bytes() // (CH * 2)
expected = PLAY_FRAMES + int(RATE * 0.25)  # 재생 + 감쇠 테일
check("exit 0 (재생 완료)", rc == 0, f"rc={rc}")
check("캡처 길이 ≈ 재생 + 테일", abs(captured - expected) < RATE * 0.15,
      f"captured={captured} expected≈{expected}")
check("언더런 없음", "underrun" not in h.stderr())

# ── B. 프리필 미충족 → exit 4 ────────────────────────────────────────────────
print("B. 프리필 타임아웃 (아무것도 안 보냄 → exit 4)")
h = Helper("--prefill-ms", "40", "--prefill-timeout-s", "1")
t0 = time.time()
rc = h.wait()
elapsed = time.time() - t0
check("exit 4 (프리필 타임아웃)", rc == 4, f"rc={rc}")
# 하한만 의미가 있다 — "기다렸다가 끝냈는가". 상한은 느슨하게 둔다(TSan 빌드는
# 계측·종료 처리 때문에 몇 초씩 더 걸린다).
check("바로 죽지 않고 기다렸다", 0.8 < elapsed < 8, f"{elapsed:.2f}s")
check("PCM 한 바이트도 안 나감 (IOProc 미시작)", h.pcm_bytes() == 0, f"{h.pcm_bytes()} bytes")

# ── C. 프리필 게이트가 클록을 붙잡는가 (단일 클록 등식의 전제) ──────────────────
print("C. 프리필 전에는 캡처도 흐르지 않는다")
h = Helper("--prefill-ms", "100", "--prefill-timeout-s", "5")
h.send_pcm(480)   # 10ms — 100ms 프리필에 한참 못 미친다
time.sleep(0.5)
check("프리필 미달 상태에서 캡처 0바이트", h.pcm_bytes() == 0, f"{h.pcm_bytes()} bytes")
h.send_pcm(4800)  # 100ms 채우기
h.line("end")
rc = h.wait()
check("프리필 충족 후 시작 → exit 0", rc == 0, f"rc={rc}")
check("이제는 캡처가 흘렀다", h.pcm_bytes() > 0, f"{h.pcm_bytes()} bytes")

# ── D. --ref 와 --stream 동시 지정 거절 ───────────────────────────────────────
print("D. --ref + --stream 동시 지정")
r = subprocess.run([HELPER, "play-capture", "--stream", "--ref", "/tmp/nope.raw",
                    str(RATE), str(BUFSZ), str(CH)], capture_output=True)
out = json.loads(r.stdout.decode())
check("exit 0 + 구조화된 에러", r.returncode == 0 and out.get("success") is False, str(out))
check("사유가 상호배타임을 밝힌다", "mutually exclusive" in out.get("error", ""), out.get("error"))

# ── E. end가 프리필보다 먼저 와도 시작한다 (짧은 재생) ────────────────────────
print("E. 프리필보다 짧은 재생")
h = Helper("--prefill-ms", "500", "--prefill-timeout-s", "5")
h.send_pcm(480)  # 10ms 뿐 — 500ms 프리필은 영영 못 찬다
h.line("end")
rc = h.wait()
check("end가 게이트를 연다 → exit 0", rc == 0, f"rc={rc}")
check("테일만큼은 캡처됐다", h.pcm_bytes() > 0, f"{h.pcm_bytes()} bytes")

# ── F. pause는 재생 위치를 동결하고 캡처는 계속 흐른다 ────────────────────────
print("F. pause 중에도 캡처는 흐른다")
h = Helper("--prefill-ms", "40")
h.send_pcm(4800)  # 100ms
time.sleep(0.05)
h.line("pause")
time.sleep(0.4)
h.line("resume")
h.send_pcm(4800)
h.line("end")
rc = h.wait()
captured = h.pcm_bytes() // (CH * 2)
check("exit 0", rc == 0, f"rc={rc}")
# 재생 200ms + 테일 250ms = 450ms인데, pause 400ms 동안에도 캡처가 돌았으므로 더 길다.
check("pause 구간만큼 캡처가 더 길다", captured > int(RATE * 0.6),
      f"captured={captured} frames ({captured/RATE:.2f}s)")

# ── G. 언더런: 링이 마르면 무음이 나가고 stderr에 집계된다 ────────────────────
print("G. 언더런 집계")
h = Helper("--prefill-ms", "40")
h.send_pcm(1920)  # 프리필만 채우고
time.sleep(0.4)   # 굶긴다 (end를 안 보냈으므로 언더런으로 센다)
h.send_pcm(1920)
h.line("end")
rc = h.wait()
err = h.stderr()
check("exit 0", rc == 0, f"rc={rc}")
check("stderr에 언더런 보고", "playback underrun" in err, err.strip().replace("\n", " | "))

print()
if failures:
    print(f"실패 {len(failures)}건: {failures}")
    sys.exit(1)
print("모든 시나리오 통과")
