// fake_backend.cpp — audio_backend.h의 호스트용 가짜 구현 (tests/host/README.md 참고).
//
// ASIO 드라이버 대신 스레드 하나가 bufferSwitch를 흉내 낸다: 실시간 속도로 buffer 크기만큼
// "콜백"을 돌면서 캡처 PCM을 만들어 링에 넣고, play-capture면 재생 링을 그만큼 소비한다.
//
// ⚠️ 이 파일의 재생 로직은 asio_backend.cpp의 bufferSwitch를 **베껴 쓴 모델**이다. 한쪽
// 의미론을 바꾸면 다른 쪽도 같이 봐야 한다. 이 테스트가 검증하는 것은 main.cpp(프레이밍·
// 게이트·종료 시퀀스)이지 ASIO 콜백 자체가 아니다.
#include "audio_backend.h"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <memory>
#include <thread>
#include <vector>

#include "playback_ring.h"
#include "ring_buffer.h"

namespace audio {
namespace {

struct FakeStream {
  double rate = 48000;
  long bufferSize = 480;
  long channels = 2;

  bool playCapture = false;
  bool streamPlayback = false;
  long prefillFrames = 0;
  long playbackChannel = 0;
  long playbackChannelR = -1;

  std::vector<float> ref;          // --ref 모드 재생 소스
  size_t refPos = 0;
  size_t tailFrames = 0;
  size_t tailTarget = 0;

  std::unique_ptr<RingBuffer> ring;
  std::unique_ptr<PlaybackRing> playRing;
  std::vector<float> playL, playR;

  std::atomic<bool> paused{false};
  std::atomic<bool> playbackDone{false};
  std::atomic<bool> running{false};
  std::thread callbackThread;

  // 캡처 누적 프레임 — 단일 클록 등식("수신 캡처 프레임 = 재생 프레임")을 테스트가 볼 수 있게.
  std::atomic<uint64_t> capturedFrames{0};
};

std::atomic<FakeStream*> g_fake{nullptr};

// 진짜 bufferSwitch 한 번에 해당한다.
void fakeCallback(FakeStream* s) {
  const size_t frames = static_cast<size_t>(s->bufferSize);
  const size_t stride = static_cast<size_t>(s->channels);

  // ── 입력(캡처): 일정한 톱니 신호. 내용보다 "몇 프레임 왔는가"가 테스트의 관심사다.
  static thread_local std::vector<int16_t> scratch;
  scratch.assign(frames * stride, 0);
  const uint64_t base = s->capturedFrames.load();
  for (size_t f = 0; f < frames; ++f) {
    for (size_t c = 0; c < stride; ++c) {
      scratch[f * stride + c] = static_cast<int16_t>((base + f) % 1000);
    }
  }
  s->ring->write(scratch.data(), frames * stride * sizeof(int16_t));
  s->capturedFrames.fetch_add(frames);

  if (!s->playCapture) return;

  const bool paused = s->paused.load();
  if (paused) return;  // 출력 무음 + 위치 동결

  if (s->streamPlayback) {
    const size_t got = s->playRing->read(s->playL.data(), s->playR.data(), frames);
    if (got < frames && !s->playRing->endOfStream()) {
      s->playRing->countUnderrun(frames - got);
    }
    if (s->playRing->isDrained()) {
      s->tailFrames += frames;
      if (s->tailFrames >= s->tailTarget) s->playbackDone.store(true);
    }
    return;
  }

  if (s->refPos < s->ref.size()) {
    const size_t avail = s->ref.size() - s->refPos;
    s->refPos += avail < frames ? avail : frames;
  } else {
    s->tailFrames += frames;
    if (s->tailFrames >= s->tailTarget) s->playbackDone.store(true);
  }
}

void callbackLoop(FakeStream* s) {
  using clock = std::chrono::steady_clock;
  const auto period = std::chrono::duration_cast<clock::duration>(
      std::chrono::duration<double>(s->bufferSize / s->rate));
  auto next = clock::now();
  while (s->running.load()) {
    fakeCallback(s);
    next += period;
    std::this_thread::sleep_until(next);
  }
}

}  // namespace

// ── 일회성 명령: 테스트에 필요 없지만 링크를 위해 최소 구현 ────────────────────
bool listDevices(std::vector<DeviceInfo>& out, bool, std::string&) {
  DeviceInfo d;
  d.uid = "{fake}";
  d.name = "Fake Device";
  d.inputChannels = 8;
  d.sampleRate = 48000;
  d.isDefault = true;
  d.probed = true;
  out.push_back(d);
  return true;
}
bool queryDevice(const std::string&, DeviceCaps& out, std::string&) {
  out.name = "Fake Device";
  out.uid = "{fake}";
  out.sampleRate = 48000;
  out.bufferSize = 480;
  out.supportedSampleRates = {44100, 48000};
  out.inputChannels = 8;
  out.outputChannels = 8;
  return true;
}
bool getDevice(const std::string&, DeviceState& out, std::string&) {
  out.name = "Fake Device";
  out.uid = "{fake}";
  out.sampleRate = 48000;
  out.bufferSize = 480;
  return true;
}
bool setDevice(const std::string&, double rate, long buffer, DeviceState& out, std::string&) {
  out.name = "Fake Device";
  out.uid = "{fake}";
  out.sampleRate = rate;
  out.bufferSize = buffer;
  return true;
}

// ── 상주 모드 ────────────────────────────────────────────────────────────────
bool startCapture(const CaptureConfig& cfg, CaptureInfo& out, std::string& error) {
  if (g_fake.load()) {
    error = "capture-already-running";
    return false;
  }
  std::unique_ptr<FakeStream> s(new FakeStream());
  s->rate = cfg.sampleRate > 0 ? cfg.sampleRate : 48000;
  s->bufferSize = cfg.bufferSize > 0 ? cfg.bufferSize : 480;
  s->channels = cfg.channels > 0 ? cfg.channels : 2;
  s->streamPlayback = cfg.streamPlayback;
  s->playCapture = !cfg.refPath.empty() || cfg.streamPlayback;
  s->playbackChannel = cfg.outputChannel;
  if (cfg.outputChannelR >= 0 && cfg.outputChannelR != cfg.outputChannel) {
    s->playbackChannelR = cfg.outputChannelR;
  }
  s->tailTarget = static_cast<size_t>(s->rate * 0.25);

  s->ring.reset(new RingBuffer(static_cast<size_t>(s->rate) *
                               static_cast<size_t>(s->channels) * sizeof(int16_t)));

  if (s->streamPlayback) {
    const double ms = cfg.prefillMs > 0 ? cfg.prefillMs : 40.0;
    s->prefillFrames = static_cast<long>(ms / 1000.0 * s->rate);
    if (s->prefillFrames < 1) s->prefillFrames = 1;
    const size_t wanted = static_cast<size_t>(s->prefillFrames) * 8;
    const size_t oneSecond = static_cast<size_t>(s->rate);
    s->playRing.reset(new PlaybackRing(wanted > oneSecond ? wanted : oneSecond));
    s->playL.assign(static_cast<size_t>(s->bufferSize), 0.0f);
    s->playR.assign(static_cast<size_t>(s->bufferSize), 0.0f);
  } else if (s->playCapture) {
    // --ref 모드: 파일 크기만 반영하면 충분하다(내용은 이 테스트의 관심사가 아니다).
    FILE* f = fopen(cfg.refPath.c_str(), "rb");
    if (!f) {
      error = "ref-open-failed(" + cfg.refPath + ")";
      return false;
    }
    fseek(f, 0, SEEK_END);
    const long bytes = ftell(f);
    fclose(f);
    const size_t floats = static_cast<size_t>(bytes) / sizeof(float);
    s->ref.assign(cfg.refChannels == 2 ? floats / 2 : floats, 0.0f);
  }

  out.name = "Fake Device";
  out.uid = "{fake}";
  out.sampleRate = s->rate;
  out.bufferSize = s->bufferSize;
  out.channels = s->channels;
  out.playCapture = s->playCapture;
  out.refFrames = static_cast<long>(s->ref.size());
  out.playbackChannel = s->playbackChannel;
  out.playbackChannelR = s->playbackChannelR;
  out.streamPlayback = s->streamPlayback;
  out.prefillFrames = s->prefillFrames;

  FakeStream* raw = s.release();
  g_fake.store(raw);
  // --stream은 진짜 백엔드와 마찬가지로 여기서 시작하지 않는다 — 프리필이 찬 뒤
  // main이 startDeferredPlayback()을 부른다.
  if (!raw->streamPlayback) {
    raw->running.store(true);
    raw->callbackThread = std::thread(callbackLoop, raw);
  }
  return true;
}

size_t readCaptured(void* dst, size_t maxBytes) {
  FakeStream* s = g_fake.load();
  return s ? s->ring->read(dst, maxBytes) : 0;
}

bool captureResetRequested() { return false; }

void setPlaybackPaused(bool paused) {
  FakeStream* s = g_fake.load();
  if (s) s->paused.store(paused);
}

bool playbackFinished() {
  FakeStream* s = g_fake.load();
  return s && s->playbackDone.load();
}

uint64_t captureDroppedBytes() {
  FakeStream* s = g_fake.load();
  return s ? s->ring->dropped() : 0;
}

size_t writePlaybackPcm(const int16_t* src, size_t fromFrame, size_t maxFrames) {
  FakeStream* s = g_fake.load();
  if (!s || !s->playRing) return 0;
  return s->playRing->write(src, fromFrame, maxFrames);
}

void markPlaybackEndOfStream() {
  FakeStream* s = g_fake.load();
  if (s && s->playRing) s->playRing->markEndOfStream();
}

bool playbackPrefillReady() {
  FakeStream* s = g_fake.load();
  if (!s || !s->playRing) return false;
  return s->playRing->available() >= static_cast<size_t>(s->prefillFrames) ||
         s->playRing->endOfStream();
}

bool startDeferredPlayback() {
  FakeStream* s = g_fake.load();
  if (!s || s->running.load()) return false;
  s->running.store(true);
  s->callbackThread = std::thread(callbackLoop, s);
  return true;
}

uint64_t playbackUnderrunFrames() {
  FakeStream* s = g_fake.load();
  return (s && s->playRing) ? s->playRing->underrunFrames() : 0;
}

void stopCapture() {
  FakeStream* s = g_fake.load();
  if (!s) return;
  s->running.store(false);
  if (s->callbackThread.joinable()) s->callbackThread.join();
  g_fake.store(nullptr);
  // 테스트가 단일 클록 등식을 확인할 수 있게 stderr로 남긴다.
  fprintf(stderr, "fake: capturedFrames=%llu\n",
          static_cast<unsigned long long>(s->capturedFrames.load()));
  delete s;
}

}  // namespace audio
