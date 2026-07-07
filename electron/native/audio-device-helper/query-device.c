// query-device.c — CoreAudio HAL 장치 조회 진단 도구 (macOS 전용)
//
// 연결된 오디오 입력 장치를 훑어, 이름으로 필터한 장치의
//   - 현재 NominalSampleRate + 지원되는 SampleRate 목록
//   - 현재 BufferFrameSize + 허용 범위(min/max)
//   - 입력 채널 수
// 를 출력한다. audio-device-helper(get/set/capture)와 달리 "기본 입력 장치"에
// 묶이지 않고 장치를 이름으로 직접 찾는다 — MCHStreamer가 기본 장치가 아니어도 조회 가능.
//
// ⚠️ BufferFrameSize/Range는 per-client 프로퍼티(TN2321)라, 여기서 보이는 값은
//    "이 조회 프로세스가 보는 장치 기본값/범위"다. capture 헬퍼가 IOProc으로
//    실제 적용한 값은 그 프로세스 안에서만 1024로 보이고 여기선 기본값(예: 512)이 나온다.
//
// 빌드:  cc -O2 -o dist/query-device query-device.c -framework CoreAudio -framework CoreFoundation
// 사용:  ./dist/query-device            # 이름에 "MCHStreamer" 포함된 입력 장치
//        ./dist/query-device Scarlett   # 다른 이름으로 필터
//        ./dist/query-device --all      # 모든 입력 장치

#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

// kAudioObjectPropertyElementMain은 SDK enum(macOS 12+). 구형 SDK만 Master로 폴백.
#if !defined(__MAC_12_0) || (defined(MAC_OS_X_VERSION_MIN_REQUIRED) && MAC_OS_X_VERSION_MIN_REQUIRED < 120000)
#define kAudioObjectPropertyElementMain kAudioObjectPropertyElementMaster
#endif

static char *cfStringToC(CFStringRef s) {
    if (!s) return strdup("");
    CFIndex len = CFStringGetLength(s);
    CFIndex maxBytes = CFStringGetMaximumSizeForEncoding(len, kCFStringEncodingUTF8) + 1;
    char *buf = malloc(maxBytes);
    if (!CFStringGetCString(s, buf, maxBytes, kCFStringEncodingUTF8)) buf[0] = '\0';
    return buf;
}

static char *deviceName(AudioDeviceID dev) {
    CFStringRef name = NULL;
    UInt32 size = sizeof(CFStringRef);
    AudioObjectPropertyAddress addr = {
        kAudioObjectPropertyName,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain,
    };
    if (AudioObjectGetPropertyData(dev, &addr, 0, NULL, &size, &name) != noErr) return strdup("");
    char *c = cfStringToC(name);
    if (name) CFRelease(name);
    return c;
}

// 입력 채널 수(스코프 Input의 StreamConfiguration 합) — 0이면 출력 전용 장치.
static UInt32 inputChannelCount(AudioDeviceID dev) {
    AudioObjectPropertyAddress addr = {
        kAudioDevicePropertyStreamConfiguration,
        kAudioObjectPropertyScopeInput,
        kAudioObjectPropertyElementMain,
    };
    UInt32 size = 0;
    if (AudioObjectGetPropertyDataSize(dev, &addr, 0, NULL, &size) != noErr || size == 0) return 0;
    AudioBufferList *bl = malloc(size);
    UInt32 channels = 0;
    if (AudioObjectGetPropertyData(dev, &addr, 0, NULL, &size, bl) == noErr) {
        for (UInt32 i = 0; i < bl->mNumberBuffers; i++) channels += bl->mBuffers[i].mNumberChannels;
    }
    free(bl);
    return channels;
}

static void printDeviceDetails(AudioDeviceID dev) {
    char *name = deviceName(dev);
    printf("● %s  (AudioDeviceID=%u)\n", name, dev);
    free(name);

    // ── 현재 SampleRate ──
    {
        Float64 rate = 0;
        UInt32 size = sizeof(rate);
        AudioObjectPropertyAddress addr = {
            kAudioDevicePropertyNominalSampleRate,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain,
        };
        if (AudioObjectGetPropertyData(dev, &addr, 0, NULL, &size, &rate) == noErr)
            printf("    현재 SampleRate     : %.0f Hz\n", rate);
        else
            printf("    현재 SampleRate     : (조회 실패)\n");
    }

    // ── 지원 SampleRate 목록 ──
    {
        AudioObjectPropertyAddress addr = {
            kAudioDevicePropertyAvailableNominalSampleRates,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain,
        };
        UInt32 size = 0;
        if (AudioObjectGetPropertyDataSize(dev, &addr, 0, NULL, &size) == noErr && size > 0) {
            int n = size / sizeof(AudioValueRange);
            AudioValueRange *ranges = malloc(size);
            if (AudioObjectGetPropertyData(dev, &addr, 0, NULL, &size, ranges) == noErr) {
                printf("    지원 SampleRate     : ");
                for (int i = 0; i < n; i++) {
                    if (ranges[i].mMinimum == ranges[i].mMaximum)
                        printf("%.0f", ranges[i].mMinimum);
                    else
                        printf("%.0f-%.0f", ranges[i].mMinimum, ranges[i].mMaximum);
                    printf(i < n - 1 ? ", " : "\n");
                }
            }
            free(ranges);
        }
    }

    // ── 현재 BufferFrameSize ──
    {
        UInt32 frames = 0;
        UInt32 size = sizeof(frames);
        AudioObjectPropertyAddress addr = {
            kAudioDevicePropertyBufferFrameSize,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain,
        };
        if (AudioObjectGetPropertyData(dev, &addr, 0, NULL, &size, &frames) == noErr)
            printf("    현재 BufferFrameSize: %u frames\n", frames);
        else
            printf("    현재 BufferFrameSize: (조회 실패)\n");
    }

    // ── BufferFrameSize 허용 범위 ──
    {
        AudioValueRange range = {0, 0};
        UInt32 size = sizeof(range);
        AudioObjectPropertyAddress addr = {
            kAudioDevicePropertyBufferFrameSizeRange,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain,
        };
        if (AudioObjectGetPropertyData(dev, &addr, 0, NULL, &size, &range) == noErr)
            printf("    Buffer 허용 범위    : %.0f ~ %.0f frames\n", range.mMinimum, range.mMaximum);
    }

    printf("    입력 채널 수        : %u\n", inputChannelCount(dev));
    printf("\n");
}

int main(int argc, char **argv) {
    const char *filter = "MCHStreamer"; // 기본 필터
    int showAll = 0;
    if (argc >= 2) {
        if (strcmp(argv[1], "--all") == 0) showAll = 1;
        else filter = argv[1];
    }

    // 시스템의 모든 오디오 장치 열거
    AudioObjectPropertyAddress addr = {
        kAudioHardwarePropertyDevices,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain,
    };
    UInt32 size = 0;
    if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &addr, 0, NULL, &size) != noErr) {
        fprintf(stderr, "장치 목록 크기 조회 실패\n");
        return 1;
    }
    int count = size / sizeof(AudioDeviceID);
    AudioDeviceID *devices = malloc(size);
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, NULL, &size, devices) != noErr) {
        fprintf(stderr, "장치 목록 조회 실패\n");
        free(devices);
        return 1;
    }

    if (showAll) printf("=== 입력 장치 전체 ===\n\n");
    else printf("=== 입력 장치 중 이름에 \"%s\" 포함 ===\n\n", filter);

    int matched = 0;
    for (int i = 0; i < count; i++) {
        if (inputChannelCount(devices[i]) == 0) continue; // 입력 장치만
        if (!showAll) {
            char *name = deviceName(devices[i]);
            int hit = (strcasestr(name, filter) != NULL);
            free(name);
            if (!hit) continue;
        }
        printDeviceDetails(devices[i]);
        matched++;
    }

    if (matched == 0) {
        printf("(일치하는 입력 장치 없음 — `--all`로 전체 목록을 보거나 이름 일부를 인자로 넘기세요)\n");
    }

    free(devices);
    return 0;
}
