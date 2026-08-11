// asio.h — Steinberg ASIO SDK 2.3의 **타입체크 전용** 스텁 (tests/host/README.md).
//
// ⚠️ 이 파일은 진짜 SDK가 아니다. 선언만 SDK 2.3과 같게 맞춰 asio_backend.cpp가
// 호스트에서 컴파일되는지 보기 위한 것이고, 링크하면 아무 일도 하지 않는다.
// 실제 동작은 여전히 실기(mingw 크로스 빌드 + ASIO 드라이버)에서만 검증된다.
// SDK 선언과 어긋나면 이 스텁이 조용히 잘못된 통과를 만든다 — SDK를 기준으로 맞출 것.
#pragma once

typedef long ASIOBool;
enum { ASIOFalse = 0, ASIOTrue = 1 };

typedef double ASIOSampleRate;
typedef long ASIOSampleType;
typedef long ASIOError;

// ASIOSampleType 값. asio_backend.cpp의 static_assert가 sample_convert.h의 복제본과
// 대조하므로, 이 숫자가 SDK와 어긋나면 컴파일이 실패한다 — 스텁이 조용히 틀릴 수 없는 지점.
enum {
  ASIOSTInt16MSB = 0,
  ASIOSTInt24MSB = 1,
  ASIOSTInt32MSB = 2,
  ASIOSTFloat32MSB = 3,
  ASIOSTFloat64MSB = 4,
  ASIOSTInt32MSB16 = 8,
  ASIOSTInt32MSB18 = 9,
  ASIOSTInt32MSB20 = 10,
  ASIOSTInt32MSB24 = 11,
  ASIOSTInt16LSB = 16,
  ASIOSTInt24LSB = 17,
  ASIOSTInt32LSB = 18,
  ASIOSTFloat32LSB = 19,
  ASIOSTFloat64LSB = 20,
  ASIOSTInt32LSB16 = 24,
  ASIOSTInt32LSB18 = 25,
  ASIOSTInt32LSB20 = 26,
  ASIOSTInt32LSB24 = 27,
  ASIOSTDSDInt8LSB1 = 32,
  ASIOSTDSDInt8MSB1 = 33,
  ASIOSTDSDInt8NER8 = 40,
  ASIOSTLastEntry
};

enum {
  ASE_OK = 0,
  ASE_SUCCESS = 0x3f4847a0,
  ASE_NotPresent = -1000,
  ASE_HWMalfunction,
  ASE_InvalidParameter,
  ASE_InvalidMode,
  ASE_SPNotAdvancing,
  ASE_NoClock,
  ASE_NoMemory
};

enum {
  kAsioSelectorSupported = 1,
  kAsioEngineVersion,
  kAsioResetRequest,
  kAsioBufferSizeChange,
  kAsioResyncRequest,
  kAsioLatenciesChanged,
  kAsioSupportsTimeInfo,
  kAsioSupportsTimeCode,
  kAsioMMCCommand,
  kAsioSupportsInputMonitor
};

struct ASIOTimeInfo {
  double speed;
  long reserved[10];
};
struct ASIOTime {
  long reserved[4];
  ASIOTimeInfo timeInfo;
};

struct ASIODriverInfo {
  long asioVersion;
  long driverVersion;
  char name[32];
  char errorMessage[124];
  void* sysRef;
};

struct ASIOBufferInfo {
  ASIOBool isInput;
  long channelNum;
  void* buffers[2];
};

struct ASIOChannelInfo {
  long channel;
  ASIOBool isInput;
  ASIOBool isActive;
  long channelGroup;
  ASIOSampleType type;
  char name[32];
};

struct ASIOCallbacks {
  void (*bufferSwitch)(long doubleBufferIndex, ASIOBool directProcess);
  void (*sampleRateDidChange)(ASIOSampleRate sRate);
  long (*asioMessage)(long selector, long value, void* message, double* opt);
  ASIOTime* (*bufferSwitchTimeInfo)(ASIOTime* params, long doubleBufferIndex,
                                    ASIOBool directProcess);
};

ASIOError ASIOInit(ASIODriverInfo* info);
ASIOError ASIOExit(void);
ASIOError ASIOStart(void);
ASIOError ASIOStop(void);
ASIOError ASIOGetChannels(long* numInputChannels, long* numOutputChannels);
ASIOError ASIOGetLatencies(long* inputLatency, long* outputLatency);
ASIOError ASIOGetBufferSize(long* minSize, long* maxSize, long* preferredSize,
                            long* granularity);
ASIOError ASIOCanSampleRate(ASIOSampleRate sampleRate);
ASIOError ASIOGetSampleRate(ASIOSampleRate* currentRate);
ASIOError ASIOSetSampleRate(ASIOSampleRate sampleRate);
ASIOError ASIOGetChannelInfo(ASIOChannelInfo* info);
ASIOError ASIOCreateBuffers(ASIOBufferInfo* bufferInfos, long numChannels,
                            long bufferSize, ASIOCallbacks* callbacks);
ASIOError ASIODisposeBuffers(void);
ASIOError ASIOOutputReady(void);
