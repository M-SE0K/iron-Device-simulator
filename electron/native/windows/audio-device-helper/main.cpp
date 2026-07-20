// main.cpp — audio-device-helper (Windows/ASIO).
//
// macOS의 mac.swift(CoreAudio)와 **소스가 아니라 CLI 계약을 공유하는** 형제 바이너리다.
// 같은 argv, 같은 한 줄 JSON stdout을 내보내므로 electron/ipc/audio-device.js는
// process.platform으로 경로만 갈라 그대로 재사용한다.
//
// 이 파일은 계약(파싱·직렬화·종료 코드)만 담당하고 장치 접근은 audio_backend.h 뒤에 있다.
//
// 현재 구현 범위: list / get / query / set (일회성 명령).
// capture / play-capture(상주 모드)는 아직 없다 — 링버퍼·포맷 변환·RT 스레드가 얽혀
// 별도 단계로 뺐다. 미구현 명령은 not-implemented 에러를 정직하게 돌려준다.
#include <windows.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "audio_backend.h"
#include "json_out.h"

namespace {

// ⚠️ 일회성 명령은 실패해도 **exit 0**이어야 한다.
// 부모(runAudioHelper)는 execFile을 쓰는데, 종료 코드가 0이 아니면 err 분기로 빠져
// stdout의 {"success":false,"error":"..."}를 버리고 "Command failed"로 덮어쓴다.
// 즉 non-zero exit은 구조화된 에러 사유를 통째로 삼킨다. 사유는 항상 JSON으로 전달한다.
// (상주 모드의 exit 3 = 장치 연결 해제 규약은 이와 별개다 — 그쪽은 부모가 code를 읽는다.)
int emit(const std::string& line) {
  fputs(line.c_str(), stdout);
  fputc('\n', stdout);
  fflush(stdout);
  return 0;
}

int fail(const std::string& message) { return emit(json::error(message)); }

// --device <UID> 를 뽑아내고 나머지는 positional로 남긴다.
struct Args {
  std::string deviceUid;
  bool probe = true;  // list 전용. --no-probe로 끌 수 있다
  std::vector<std::string> positional;
};

bool parseArgs(int argc, char** argv, Args& out, std::string& error) {
  for (int i = 2; i < argc; ++i) {  // argv[1]은 명령어
    const std::string a = argv[i];
    if (a == "--device") {
      if (i + 1 >= argc) {
        error = "usage: --device requires a UID";
        return false;
      }
      out.deviceUid = argv[++i];
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

int cmdList(const Args& args) {
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

int cmdGet(const Args& args) {
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

int cmdQuery(const Args& args) {
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
      // 이하는 macOS엔 없는 가산 키 — 계약을 깨지 않으면서 ASIO 고유 정보를 노출한다.
      // bufferGranularity가 -1이면 2의 거듭제곱만, 양수면 그 배수만 허용된다는 뜻이라
      // UI가 임의의 버퍼 크기를 입력받으면 안 된다는 신호로 쓸 수 있다.
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
    } else if (command == "capture" || command == "play-capture") {
      // 계약에는 있으나 아직 미구현. 부모가 무한 대기하지 않도록 즉시 헤더만 내고 끝낸다.
      rc = fail("not-implemented(" + command + ")");
    } else {
      rc = fail("unknown-command(" + command + ")");
    }
  }

  CoUninitialize();
  return rc;
}
