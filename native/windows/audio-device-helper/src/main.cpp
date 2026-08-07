// main.cpp — audio-device-helper (Windows/ASIO).
//
// macOS의 mac.swift(CoreAudio)와 **소스가 아니라 CLI 계약을 공유하는** 형제 바이너리다.
// 같은 argv, 같은 한 줄 JSON stdout을 내보내므로 src-tauri/src/audio_device.rs는
// 타깃 OS로 경로만 갈라 그대로 재사용한다.
//
// 이 파일은 계약(파싱·직렬화·종료 코드)만 담당하고 장치 접근은 audio_backend.h 뒤에 있다.
//
// 현재 구현 범위: list / get / query / set (일회성) + capture / play-capture (상주).
// play-capture는 --ref(파일 선업로드)와 --stream(stdin으로 보호 PCM 스트리밍) 두 모드를 갖는다.
//
// 일회성 명령과 상주 모드는 stdout 성격이 다르다. 앞은 JSON 한 줄로 끝나지만 상주 모드는
// 헤더 한 줄 뒤로 raw PCM이 계속 흐르고, 종료 코드도 부모가 읽는다
// (0 = 정상/재생 완료, 3 = 장치 연결 해제).
#include <windows.h>

#include <fcntl.h>
#include <io.h>

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

#include "audio_backend.h"
#include "json_out.h"

namespace {

// ⚠️ 일회성 명령은 실패해도 **exit 0**이어야 한다.
// 부모(runAudioHelper)는 execFile을 쓰는데, 종료 코드가 0이 아니면 err 분기로 빠져
// stdout의 {"success":false,"error":"..."}를 버리고 "Command failed"로 덮어쓴다.
// 즉 non-zero exit은 구조화된 에러 사유를 통째로 삼킨다. 사유는 항상 JSON으로 전달한다.
// (상주 모드의 exit 3 = 장치 연결 해제 규약은 이와 별개다 — 그쪽은 부모가 code를 읽는다.)
int emit(const std::string& line) 
{
  fputs(line.c_str(), stdout);
  fputc('\n', stdout);
  fflush(stdout);
  return 0;
}

int fail(const std::string& message) 
{ 
  return emit(json::error(message)); 
}

// --device <UID> 를 뽑아내고 나머지는 positional로 남긴다.
struct Args 
{
  std::string deviceUid;
  bool probe = true;  // list 전용. --no-probe로 끌 수 있다
  std::string refPath;        // play-capture 전용
  long outputChannel = 0;     // play-capture 전용
  long refChannels = 1;       // play-capture 전용 — --ref 파일 채널 수(2=인터리브 스테레오)
  long outputChannelR = -1;   // play-capture 전용 — R 출력 채널(생략 시 -1=모노만)
  bool stream = false;        // play-capture 전용 — --ref 대신 stdin으로 재생 PCM을 받는다
  double prefillMs = 40.0;    // --stream 전용 — 재생 시작 전에 링에 채워둘 분량
  double prefillTimeoutS = 15.0;  // --stream 전용 — 이 시간 안에 프리필이 안 차면 exit 4
  std::vector<std::string> positional;
};

bool parseArgs(int argc, char** argv, Args& out, std::string& error) 
{
  for (int i = 2; i < argc; ++i) {  // argv[1]은 명령어
    const std::string a = argv[i];
    if (a == "--device") {
      if (i + 1 >= argc) {
        error = "usage: --device requires a UID";
        return false;
      }
      out.deviceUid = argv[++i];
    } else if (a == "--ref") {
      if (i + 1 >= argc) {
        error = "usage: --ref requires a path";
        return false;
      }
      out.refPath = argv[++i];
    } else if (a == "--out-ch") {
      if (i + 1 >= argc) {
        error = "usage: --out-ch requires a channel index";
        return false;
      }
      out.outputChannel = atol(argv[++i]);
    } else if (a == "--ref-channels") {
      if (i + 1 >= argc) {
        error = "usage: --ref-channels requires 1 or 2";
        return false;
      }
      out.refChannels = atol(argv[++i]);
    } else if (a == "--out-ch-r") {
      if (i + 1 >= argc) {
        error = "usage: --out-ch-r requires a channel index";
        return false;
      }
      out.outputChannelR = atol(argv[++i]);
    } else if (a == "--stream") {
      out.stream = true;
    } else if (a == "--prefill-ms") {
      if (i + 1 >= argc) {
        error = "usage: --prefill-ms requires a duration in ms";
        return false;
      }
      out.prefillMs = atof(argv[++i]);
    } else if (a == "--prefill-timeout-s") {
      if (i + 1 >= argc) {
        error = "usage: --prefill-timeout-s requires a duration in seconds";
        return false;
      }
      out.prefillTimeoutS = atof(argv[++i]);
    } else if (a == "--probe") {
      out.probe = true;
    } else if (a == "--no-probe") {
      out.probe = false;
    } else {
      out.positional.push_back(a);
    }
  }
  return true;
}

int cmdList(const Args& args) 
{
  std::vector<audio::DeviceInfo> devices;
  std::string error;
  if (!audio::listDevices(devices, args.probe, error)) return fail(error);

  json::Writer w;
  w.beginObj().kv("success", true).key("devices").beginArr();
  for (const auto& d : devices) {
    w.beginObj()
        .kv("uid", d.uid)
        .kv("name", d.name)
        .kv("inputChannels", d.inputChannels)
        .kvOrNull("sampleRate", d.sampleRate)
        .kv("isDefault", d.isDefault)
        // probed=false면 inputChannels/sampleRate는 미상(0/null)이다. 드라이버가 다른
        // 프로세스에 점유돼 열리지 않은 것이지 장치가 없는 게 아니다 — UI가 구분할 수 있게 싣는다.
        .kv("probed", d.probed)
        .endObj();
  }
  w.endArr().endObj();
  return emit(w.str());
}

int cmdGet(const Args& args) 
{
  audio::DeviceState state;
  std::string error;
  if (!audio::getDevice(args.deviceUid, state, error)) return fail(error);

  json::Writer w;
  w.beginObj()
      .kv("success", true)
      .kv("device", state.name)
      .kv("deviceUID", state.uid)
      .key("actual")
      .beginObj()
      .kvOrNull("sampleRate", state.sampleRate)
      .kv("bufferSize", state.bufferSize)
      .endObj()
      .endObj();
  return emit(w.str());
}

int cmdQuery(const Args& args) 
{
  audio::DeviceCaps caps;
  std::string error;
  if (!audio::queryDevice(args.deviceUid, caps, error)) return fail(error);

  json::Writer w;
  w.beginObj()
      .kv("success", true)
      .kv("device", caps.name)
      .kv("deviceUID", caps.uid)
      .key("current")
      .beginObj()
      .kvOrNull("sampleRate", caps.sampleRate)
      .kv("bufferSize", caps.bufferSize)
      .endObj()
      .key("supportedSampleRates")
      .beginArr();
  for (double r : caps.supportedSampleRates) w.val(r);
  w.endArr()
      .key("bufferRange")
      .beginObj()
      .kv("min", caps.bufferMin)
      .kv("max", caps.bufferMax)
      .endObj()
      .kv("inputChannels", caps.inputChannels)
      .kv("outputChannels", caps.outputChannels)
      .kv("bufferPreferred", caps.bufferPreferred)
      .kv("bufferGranularity", caps.bufferGranularity)
      .key("latency")
      .beginObj()
      .kv("input", caps.inputLatency)
      .kv("output", caps.outputLatency)
      .endObj()
      .endObj();
  return emit(w.str());
}

int cmdSet(const Args& args)
{
  if (args.positional.size() < 2) {
    return fail("usage: set [--device <UID>] <sampleRate> <bufferSize>");
  }
  const double sampleRate = atof(args.positional[0].c_str());
  const long bufferSize = atol(args.positional[1].c_str());

  audio::DeviceState state;
  std::string error;
  if (!audio::setDevice(args.deviceUid, sampleRate, bufferSize, state, error)) return fail(error);

  json::Writer w;
  w.beginObj()
      .kv("success", true)
      .kv("device", state.name)
      .kv("deviceUID", state.uid)
      .key("requested")
      .beginObj()
      .kv("sampleRate", sampleRate)
      .kv("bufferSize", bufferSize)
      .endObj()
      .key("actual")
      .beginObj()
      .kvOrNull("sampleRate", state.sampleRate)
      .kv("bufferSize", state.bufferSize)
      .endObj()
      // 두 값의 성격이 다르므로 뭉뚱그리지 않고 각각 보고한다.
      //
      //  sampleRate — ASIOSetSampleRate로 드라이버에 **실제 적용**된다. miniDSP ASIO
      //    드라이버에서 프로세스 종료 후에도 유지됨을 실측 확인했다(macOS와 동일한 거동).
      //    다만 지속성은 ASIO 스펙이 보장하지 않는 드라이버 재량이다.
      //  bufferSize — **적용되지 않는다.** ASIO는 ASIOCreateBuffers 시점에만 크기가
      //    정해지므로 set이 건드릴 대상 자체가 없다. actual.bufferSize는 "capture가
      //    이 값을 요청하면 실제로 무엇이 될지"를 미리 계산해 보여주는 값일 뿐이다.
      .key("applied")
      .beginObj()
      .kv("sampleRate", true)
      .kv("bufferSize", false)
      .endObj()
      .endObj();
  return emit(w.str());
}

// ── capture (상주 모드) ──────────────────────────────────────────────────────

std::atomic<bool> g_stopWriter{false};
std::atomic<bool> g_stdinClosed{false};

// stdout 소비자. RT 콜백은 링에 밀어넣기만 하고 여기서만 fwrite한다 — 파이프가 차면
// 이 스레드가 블로킹되지만 오디오 콜백은 계속 돈다.
void writerLoop() {
  std::vector<uint8_t> buf(64 * 1024);
  for (;;) {
    const size_t n = audio::readCaptured(buf.data(), buf.size());
    if (n > 0) {
      fwrite(buf.data(), 1, n, stdout);
      fflush(stdout);
      continue;
    }
    // 링이 비었다. 종료 신호가 이미 왔다면 여기가 마지막 드레인 지점이다.
    if (g_stopWriter.load(std::memory_order_acquire)) break;
    Sleep(2);
  }
}

std::atomic<bool> g_stopRequested{false};

// ── stdin 리더와 stopCapture()의 경합 차단 ───────────────────────────────────
//
// stdin 리더는 _read()에 블로킹된 채 끝나므로 join할 수 없다(detach). 그런데 --stream에서는
// 이 스레드가 백프레셔로 **수 ms~수백 ms 동안 재생 링 안에 머문다**. 그 사이 main이
// stopCapture()로 링을 delete하면 그대로 use-after-free다(capture 링은 writer를 join해서
// 이 문제를 피하지만, 여기서는 join이라는 수단이 없다).
//
// 그래서 Dekker 방식으로 막는다 — 리더는 "들어간다"를 먼저 표시하고 종료 플래그를 읽고,
// main은 종료 플래그를 먼저 쓰고 리더의 깊이를 읽는다. 둘 다 seq_cst여야 성립한다.
// 어느 한쪽은 반드시 상대의 표시를 보므로, 링 안에 스레드가 있는 채로 delete되지 않는다.
std::atomic<bool> g_shuttingDown{false};
std::atomic<int> g_backendDepth{0};

// 백엔드(=링을 만지는 audio::* 호출) 진입 가드. 종료가 시작됐으면 아예 들어가지 않는다.
struct BackendGuard {
  bool entered;
  BackendGuard() {
    g_backendDepth.fetch_add(1);
    entered = !g_shuttingDown.load();
    if (!entered) g_backendDepth.fetch_sub(1);
  }
  ~BackendGuard() {
    if (entered) g_backendDepth.fetch_sub(1);
  }
};

// stopCapture() 직전에 부른다. 리더가 백엔드 밖으로 나올 때까지 잠깐 기다린다.
// 리더의 대기 루프도 g_shuttingDown을 매 반복 확인하므로 실제로는 1~2 ms면 빠져나온다.
void quiesceBackendCallers() {
  g_shuttingDown.store(true);
  for (int i = 0; i < 200 && g_backendDepth.load() != 0; ++i) Sleep(1);
}

// stdin EOF = 부모 Tauri 코어 사망. 감지하지 못하면 헬퍼가 고아로 남아 장치를 계속 물고 있다.
// 별도 스레드인 이유: main은 reset/재생완료 플래그도 함께 폴링해야 하는데 stdin 읽기는 블로킹이다.
//
// play-capture의 라인 명령(pause/resume/stop)도 여기서 받는다. capture 모드에서도 같은
// 루프를 쓰지만 재생이 없어 pause/resume은 무해한 no-op이 된다.
//
// ⚠️ fgets가 아니라 바이트 단위로 읽는다. --stream에서 stdin은 라인 명령과 **바이너리 PCM
// 페이로드가 섞인** 채널이기 때문이다(macOS 헬퍼와 동일한 프레이밍):
//
//   "pcm <nBytes>\n" + <nBytes 그대로>   # int16 인터리브 스테레오 LE
//   "end\n"                              # 더 보낼 프레임 없음
//   "pause\n" / "resume\n" / "stop\n"    # 기존 라인 명령 그대로
//
// _read()를 쓰는 이유: fread는 요청한 크기가 다 찰 때까지 블로킹하므로 스트림에 맞지 않는다.
// 파이프에서 _read는 온 만큼만 돌려준다.
void stdinWatchLoop(bool streamMode) {
  std::vector<uint8_t> pending;
  std::vector<uint8_t> chunk(64 * 1024);
  // 0보다 크면 "지금 pending 앞쪽 이만큼은 라인이 아니라 PCM 페이로드"라는 뜻이다.
  size_t awaitingPcmBytes = 0;

  const int fd = _fileno(stdin);
  for (;;) {
    const int got = _read(fd, chunk.data(), static_cast<unsigned>(chunk.size()));
    if (got <= 0) break;  // EOF(부모 사망) 또는 에러
    pending.insert(pending.end(), chunk.begin(), chunk.begin() + got);

    // read 한 번에 여러 라인/페이로드가 함께 올 수 있으니 더 못 자를 때까지 훑는다.
    bool stop = false;
    for (;;) {
      if (awaitingPcmBytes > 0) {
        if (pending.size() < awaitingPcmBytes) break;
        // 프레임(L,R) 단위로만 적재한다 — 짝이 안 맞는 꼬리는 버려야 L/R이 밀리지 않는다.
        const size_t totalFrames = awaitingPcmBytes / (2 * sizeof(int16_t));
        const int16_t* samples = reinterpret_cast<const int16_t*>(pending.data());
        BackendGuard guard;
        for (size_t done = 0; guard.entered && done < totalFrames;) {
          const size_t n = audio::writePlaybackPcm(samples, done, totalFrames - done);
          done += n;
          // 링이 가득 찼다 — 콜백이 비울 때까지 잠깐 잔다. 여기서 막히는 것이 그대로
          // 파이프를 거슬러 Rust write_all과 렌더러까지 닿는 백프레셔다. 렌더러가 리드
          // 이상 앞서 보내지 않으므로 정상 동작에서는 걸리지 않는다.
          if (n == 0) {
            if (g_shuttingDown.load()) break;
            Sleep(1);
          }
        }
        pending.erase(pending.begin(), pending.begin() + awaitingPcmBytes);
        awaitingPcmBytes = 0;
        continue;
      }

      const auto nl = std::find(pending.begin(), pending.end(), static_cast<uint8_t>('\n'));
      if (nl == pending.end()) break;
      std::string cmd(pending.begin(), nl);
      pending.erase(pending.begin(), nl + 1);
      while (!cmd.empty() && cmd.back() == '\r') cmd.pop_back();
      if (cmd.empty()) continue;

      // 페이로드 헤더는 여기서 바로 해석한다 — 앱 로직이 아니라 프레이밍의 일부다.
      if (streamMode && cmd.rfind("pcm ", 0) == 0) {
        const long n = atol(cmd.c_str() + 4);
        // 말이 안 되는 길이는 무시한다 — 한 덩이가 1 MB를 넘을 일이 없다.
        awaitingPcmBytes = (n > 0 && n <= (1 << 20)) ? static_cast<size_t>(n) : 0;
        continue;
      }

      if (cmd == "pause") {
        BackendGuard guard;
        if (guard.entered) audio::setPlaybackPaused(true);
      } else if (cmd == "resume") {
        BackendGuard guard;
        if (guard.entered) audio::setPlaybackPaused(false);
      } else if (streamMode && cmd == "end") {
        BackendGuard guard;
        if (guard.entered) audio::markPlaybackEndOfStream();
      } else if (cmd == "stop") {
        g_stopRequested.store(true, std::memory_order_release);
        stop = true;
        break;
      }
      // 알 수 없는 명령은 무시한다 (macOS 헬퍼와 동일 — 프로토콜 전방 호환)
    }
    if (stop) break;
  }
  g_stdinClosed.store(true, std::memory_order_release);
}

// capture와 play-capture는 스트리밍 계약이 같다 — 헤더 한 줄 뒤로 int16 인터리브 PCM.
// 다른 건 출력(재생) 유무뿐이라 한 함수로 처리하고 refPath 유무로 갈린다.
int cmdCapture(const Args& args, bool playCapture) {
  if (args.positional.size() < 2) {
    return fail(playCapture
        ? "usage: play-capture [--device <UID>] (--ref <path> [--ref-channels <1|2>] | --stream [--prefill-ms <n>] [--prefill-timeout-s <n>]) [--out-ch <n>] [--out-ch-r <n>] <sampleRate> <bufferSize> [channels=2]"
        : "usage: capture [--device <UID>] <sampleRate> <bufferSize> [channels=2]");
  }
  if (playCapture && args.refPath.empty() && !args.stream) {
    return fail("usage: play-capture requires --ref <path> or --stream");
  }
  if (playCapture && !args.refPath.empty() && args.stream) {
    // 둘 다 오면 재생 소스가 둘이 된다 — 조용히 하나를 고르면 디버깅이 지옥이 되므로 거절한다.
    return fail("usage: --ref and --stream are mutually exclusive");
  }

  audio::CaptureConfig cfg;
  cfg.deviceUid = args.deviceUid;
  cfg.sampleRate = atof(args.positional[0].c_str());
  cfg.bufferSize = atol(args.positional[1].c_str());
  cfg.channels = args.positional.size() >= 3 ? atol(args.positional[2].c_str()) : 2;
  if (playCapture) {
    cfg.refPath = args.refPath;
    cfg.outputChannel = args.outputChannel;
    cfg.refChannels = args.refChannels;
    cfg.outputChannelR = args.outputChannelR;
    cfg.streamPlayback = args.stream;
    cfg.prefillMs = args.prefillMs;
  }

  // ⚠️ 반드시 첫 출력 전에. 기본 텍스트 모드에서는 CRT가 PCM 안의 0x0A를 0x0D 0x0A로
  // 부풀려 스트림이 통째로 깨진다 — 파형이 미묘하게 지직거리는 형태로만 드러나 추적이 어렵다.
  _setmode(_fileno(stdout), _O_BINARY);
  // stdin도 마찬가지다 — --stream의 PCM 페이로드에 0x1A(Ctrl-Z)가 들어 있으면 텍스트
  // 모드에서는 그 자리가 EOF로 잘리고, CRLF 변환은 바이트 수를 어긋나게 만든다.
  _setmode(_fileno(stdin), _O_BINARY);

  audio::CaptureInfo info;
  std::string error;
  if (!audio::startCapture(cfg, info, error)) return fail(error);

  // 이 헤더가 success:true로 나가야 부모가 이후 청크를 렌더러로 중계하기 시작한다
  // (run-streaming-helper.js). 스트림보다 반드시 먼저 나가야 하므로 writer 시작 전에 쓴다.
  json::Writer w;
  w.beginObj()
      .kv("success", true)
      .kv("device", info.name)
      .kv("deviceUID", info.uid)
      .kv("channels", info.channels)
      .key("requested")
      .beginObj()
      .kv("sampleRate", cfg.sampleRate)
      .kv("bufferSize", cfg.bufferSize)
      .endObj()
      // ASIO는 버퍼를 드라이버 격자로 스냅하므로 requested와 다른 게 정상이다
      // (예: 480 요청 → 512). macOS는 480을 그대로 쓰던 자리다.
      .key("actual")
      .beginObj()
      .kvOrNull("sampleRate", info.sampleRate)
      .kv("bufferSize", info.bufferSize)
      .endObj();
  if (info.playCapture) {
    // capture 헤더에 얹는 가산 키 — playbackChannel/playbackChannelR로 실제 사용된 출력
    // 채널을 안다. 재생 길이는 모드에 따라 다르다: --ref는 refLen(총 프레임 수)을 알지만
    // --stream은 아직 아무것도 안 받았으므로 알 수 없고, 대신 prefillFrames를 싣는다.
    if (info.streamPlayback) {
      w.kv("mode", "play-capture-stream").kv("prefillFrames", info.prefillFrames);
    } else {
      w.kv("mode", "play-capture").kv("refLen", info.refFrames);
    }
    w.kv("playbackChannel", info.playbackChannel);
    w.key("playbackChannelR");
    if (info.playbackChannelR >= 0) w.val(info.playbackChannelR);
    else w.null();
  }
  w.endObj();
  emit(w.str());

  std::thread writer(writerLoop);
  std::thread stdinWatch(stdinWatchLoop, cfg.streamPlayback);
  stdinWatch.detach();  // _read에 블로킹된 채로 끝난다 — join할 수 없다

  int code = 0;

  // ── --stream: 프리필 게이트 ────────────────────────────────────────────────
  //
  // startCapture는 --stream에서 ASIOStart를 미뤄뒀다. 링이 빈 채로 시작하면 앞머리가
  // 무음이 되는데 캡처는 그 구간까지 세므로 "수신 캡처 프레임 수 = 재생 프레임 수"
  // 등식이 깨진다. 위 헤더가 렌더러에게 보내는 출발 신호이고, 렌더러가 프리필을 밀어
  // 넣으면 여기서 시작한다 (docs/protected-playback-plan.md D3).
  bool prefillFailed = false;
  if (cfg.streamPlayback) {
    // 첫 실행은 WASM 엔진 로드까지 이 시간 안에 끝나야 한다 — macOS 헬퍼와 같은 기본 15초.
    const double timeoutS = args.prefillTimeoutS > 0 ? args.prefillTimeoutS : 15.0;
    const ULONGLONG deadline = GetTickCount64() + static_cast<ULONGLONG>(timeoutS * 1000.0);
    for (;;) {
      if (audio::playbackPrefillReady()) break;
      // 프리필을 기다리는 중에도 중단은 받아들인다(사용자 stop / 부모 사망).
      if (g_stopRequested.load(std::memory_order_acquire) ||
          g_stdinClosed.load(std::memory_order_acquire)) {
        prefillFailed = true;
        break;
      }
      if (GetTickCount64() > deadline) {
        // 렌더러가 보호 PCM을 밀어 넣지 못했다(엔진 로드 실패 등). 재생을 시작하지 않고 끝낸다.
        code = 4;
        prefillFailed = true;
        break;
      }
      Sleep(5);
    }
    if (!prefillFailed && !audio::startDeferredPlayback()) {
      // 헤더는 이미 success:true로 나갔으므로 종료 코드로만 실패를 알린다(capture와 동일).
      code = 2;
      prefillFailed = true;
    }
  }

  // 드라이버는 main 스레드가 소유한다(COM 아파트먼트). 종료 사유 둘을 여기서 폴링한다.
  for (; !prefillFailed;) {
    if (audio::captureResetRequested()) {
      code = 3;  // 장치 연결 해제 — 렌더러가 이 코드를 일반 크래시와 구분해 안내한다
      break;
    }
    // 재생 완료(+감쇠 테일) → exit 0으로 자기 종료. 부모는 이 code 0을 "재생 완료"로 읽는다.
    if (audio::playbackFinished()) break;
    if (g_stopRequested.load(std::memory_order_acquire)) break;  // stdin "stop"
    if (g_stdinClosed.load(std::memory_order_acquire)) break;    // 부모 사망
    Sleep(50);
  }

  // writer를 먼저 정리한다. 반대로 하면 stopCapture가 링을 delete하는 동안
  // writer가 그 링을 읽고 있을 수 있다.
  g_stopWriter.store(true, std::memory_order_release);
  writer.join();

  // stdin 리더는 join할 수 없으므로(detach) 링 밖으로 나오기를 기다린다 —
  // --stream에서는 이 스레드가 백프레셔로 링 안에 오래 머물 수 있다.
  quiesceBackendCallers();

  // 집계는 드레인이 끝난 뒤, 링이 아직 살아있는 이 틈에서만 읽을 수 있다.
  const uint64_t dropped = audio::captureDroppedBytes();
  const uint64_t underrun = cfg.streamPlayback ? audio::playbackUnderrunFrames() : 0;
  audio::stopCapture();

  if (dropped > 0) {
    // stdout은 PCM 전용이라 진단은 stderr로만 나간다.
    fprintf(stderr, "capture: dropped %llu bytes (ring overrun)\n",
            static_cast<unsigned long long>(dropped));
  }
  if (underrun > 0) {
    // 이쪽은 "유실"이 아니다 — 링이 비어 무음이 나갔을 뿐 재생 위치는 소비되지 않았으므로
    // 샘플은 그대로 뒤로 밀렸다. 진행바가 실제 재생보다 앞선 만큼을 뜻한다(D5).
    fprintf(stderr, "play-capture: %llu frames of playback underrun (ring starved)\n",
            static_cast<unsigned long long>(underrun));
  }
  return code;
}

}  // namespace

int main(int argc, char** argv) {
  // AsioDriverList 생성자도 CoInitialize를 부르지만 드라이버가 0개면 부르지 않는다.
  // 여기서 먼저 잡아두면 그 경로에서도 COM 상태가 일관된다(중첩 호출은 참조 카운트).
  // STA를 쓰는 이유: asiolist.cpp가 CoInitialize(0)으로 STA를 전제하고,
  // 다수 ASIO 드라이버가 컨트롤 패널 창을 띄우려면 STA여야 한다.
  const HRESULT hr = CoInitialize(nullptr);
  if (FAILED(hr)) return fail("com-init-failed");

  int rc;
  if (argc < 2) {
    rc = fail("usage: audio-device-helper <list|get|query|set> [--device <UID>] [...]");
  } else {
    const std::string command = argv[1];
    Args args;
    std::string parseError;
    if (!parseArgs(argc, argv, args, parseError)) {
      rc = fail(parseError);
    } else if (command == "list") {
      rc = cmdList(args);
    } else if (command == "get") {
      rc = cmdGet(args);
    } else if (command == "query") {
      rc = cmdQuery(args);
    } else if (command == "set") {
      rc = cmdSet(args);
    } else if (command == "capture") {
      rc = cmdCapture(args, /*playCapture=*/false);
    } else if (command == "play-capture") {
      rc = cmdCapture(args, /*playCapture=*/true);
    } else {
      rc = fail("unknown-command(" + command + ")");
    }
  }

  CoUninitialize();
  return rc;
}
