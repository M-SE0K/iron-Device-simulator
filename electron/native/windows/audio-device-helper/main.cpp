// main.cpp — audio-device-helper (Windows/ASIO).
//
// macOS의 mac.swift(CoreAudio)와 **소스가 아니라 CLI 계약을 공유하는** 형제 바이너리다.
// 같은 argv, 같은 한 줄 JSON stdout을 내보내므로 electron/ipc/audio-device.js는
// process.platform으로 경로만 갈라 그대로 재사용한다.
//
// 이 파일은 계약(파싱·직렬화·종료 코드)만 담당하고 장치 접근은 audio_backend.h 뒤에 있다.
//
// 현재 구현 범위: list / get / query / set (일회성) + capture / play-capture (상주).
//
// 일회성 명령과 상주 모드는 stdout 성격이 다르다. 앞은 JSON 한 줄로 끝나지만 상주 모드는
// 헤더 한 줄 뒤로 raw PCM이 계속 흐르고, 종료 코드도 부모가 읽는다
// (0 = 정상/재생 완료, 3 = 장치 연결 해제).
#include <windows.h>

#include <fcntl.h>
#include <io.h>

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

int cmdSet(const Args& args) {
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
// 이 스레드가 블로킹되지만 오디오 콜백은 계속 돈다. (CAPTURE-PLAN.md §2)
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

// stdin EOF = 부모 Electron 사망. 감지하지 못하면 헬퍼가 고아로 남아 장치를 계속 물고 있다.
// 별도 스레드인 이유: main은 reset/재생완료 플래그도 함께 폴링해야 하는데 stdin 읽기는 블로킹이다.
//
// play-capture의 라인 명령(pause/resume/stop)도 여기서 받는다. capture 모드에서도 같은
// 루프를 쓰지만 재생이 없어 pause/resume은 무해한 no-op이 된다.
void stdinWatchLoop() {
  char line[256];
  while (fgets(line, sizeof(line), stdin)) {
    std::string cmd(line);
    while (!cmd.empty() && (cmd.back() == '\n' || cmd.back() == '\r')) cmd.pop_back();

    if (cmd == "pause") {
      audio::setPlaybackPaused(true);
    } else if (cmd == "resume") {
      audio::setPlaybackPaused(false);
    } else if (cmd == "stop") {
      g_stopRequested.store(true, std::memory_order_release);
      break;
    }
    // 알 수 없는 명령은 무시한다 (macOS 헬퍼와 동일)
  }
  g_stdinClosed.store(true, std::memory_order_release);
}

// capture와 play-capture는 스트리밍 계약이 같다 — 헤더 한 줄 뒤로 int16 인터리브 PCM.
// 다른 건 출력(재생) 유무뿐이라 한 함수로 처리하고 refPath 유무로 갈린다.
int cmdCapture(const Args& args, bool playCapture) {
  if (args.positional.size() < 2) {
    return fail(playCapture
        ? "usage: play-capture [--device <UID>] --ref <path> [--out-ch <n>] <sampleRate> <bufferSize> [channels=2]"
        : "usage: capture [--device <UID>] <sampleRate> <bufferSize> [channels=2]");
  }
  if (playCapture && args.refPath.empty()) {
    return fail("usage: play-capture requires --ref <path>");
  }

  audio::CaptureConfig cfg;
  cfg.deviceUid = args.deviceUid;
  cfg.sampleRate = atof(args.positional[0].c_str());
  cfg.bufferSize = atol(args.positional[1].c_str());
  cfg.channels = args.positional.size() >= 3 ? atol(args.positional[2].c_str()) : 2;
  if (playCapture) {
    cfg.refPath = args.refPath;
    cfg.outputChannel = args.outputChannel;
  }

  // ⚠️ 반드시 첫 출력 전에. 기본 텍스트 모드에서는 CRT가 PCM 안의 0x0A를 0x0D 0x0A로
  // 부풀려 스트림이 통째로 깨진다 — 파형이 미묘하게 지직거리는 형태로만 드러나 추적이 어렵다.
  _setmode(_fileno(stdout), _O_BINARY);

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
    // capture 헤더에 얹는 가산 키 — 렌더러가 refLen으로 재생 길이를,
    // playbackChannel로 실제 사용된 출력 채널을 안다.
    w.kv("mode", "play-capture")
        .kv("refLen", info.refFrames)
        .kv("playbackChannel", info.playbackChannel);
  }
  w.endObj();
  emit(w.str());

  std::thread writer(writerLoop);
  std::thread stdinWatch(stdinWatchLoop);
  stdinWatch.detach();  // fgetc에 블로킹된 채로 끝난다 — join할 수 없다

  // 드라이버는 main 스레드가 소유한다(COM 아파트먼트). 종료 사유 둘을 여기서 폴링한다.
  int code = 0;
  for (;;) {
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

  // 드롭 집계는 드레인이 끝난 뒤, 링이 아직 살아있는 이 틈에서만 읽을 수 있다.
  const uint64_t dropped = audio::captureDroppedBytes();
  audio::stopCapture();

  if (dropped > 0) {
    // stdout은 PCM 전용이라 진단은 stderr로만 나간다.
    fprintf(stderr, "capture: dropped %llu bytes (ring overrun)\n",
            static_cast<unsigned long long>(dropped));
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
