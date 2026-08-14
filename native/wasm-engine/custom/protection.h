/*
* ff_prot.h — 스피커 피드-포워드 보호(feed-forward protection) 추정기 (검증용 참조 구현)
*
* ⚠️ 이 파일은 Iron Device 정품 libirontune.so 의 원본이 아니다.
*    아직 정품 C 소스를 받지 못한 상태에서 "빠른 파이프라인 검증"을 위해
*    브라우저 WASM 호출자(src/features/audio/lib/engine/adapters/wasm-client.ts)의
*    함수 시그니처에 맞춰 임의로 구성한 물리 근사 모델이다. 정품 라이브러리가 제공되면 폐기한다.
*
* 함수 시그니처는 wasm-client.ts 의 mod._ff_prot_*(...) 호출과 1:1로 일치한다.
*
*
* 입출력 버퍼 규약 (engine/utils.ts 의 deinterleave() 결과):
*   - planar 배치: [ch0 전체 샘플][ch1 전체 샘플] ...  (인터리브 아님)
*   - 16-bit PCM(int16), 리틀엔디언
*   - ⚠️ buf 는 **In/Out** 이다 — start_exec 이 보호 감쇠 결과를 같은 버퍼에 in-place 로 되쓴다. 호출자가 원본을 계속 써야 한다면 넘기기 전에 복사해 둬야 한다.
*   - samples_per_ch는 호출자(Calibration UI)가 세션마다 지정하는 런타임 값이다 —
*     480 samples는 기본값일 뿐 고정 아님.
*   ⚠️ 실제 벤더 시그니처엔 sample_rate_hz 인자가 없다(검증됨) — 실제 라이브러리의 시간 정보 출처는 아직 미확인이며 벤더 확인이 필요하다. 이 참조 스텁은 잠정적으로 DEFAULT_SAMPLE_RATE_HZ(고정값)로
*      근사한다 — Calibration UI에서 실제 세션 샘플레이트를 바꿔도 이 스텁의 dt 계산에는
*      더 이상 반영되지 않는다(알려진 한계, 정품 스펙 확인 시 정정).
*
* 출력 단위:
*   - spk_temp[ch] : 보이스코일 추정 온도 [°C]        (int32, amb_temp 기준 상승)
*   - spk_exc[ch]  : 콘 피크 변위 추정 [µm, 마이크로미터] (int32, 0 ~ 8000 ≈ 0~8 mm)
*
*   ⚠️ 단위 주의: wasm-client.ts는 raw µm 값을 그대로 반환하고, 표시 시 src/features/audio/lib/units.ts의 toMm()이 1/1000을 곱해 mm로 변환한다.
*/
#ifndef FF_PROT_H
#define FF_PROT_H
 
 
#include <stdint.h>
 
#ifdef __cplusplus
extern "C" {
#endif
 
/* 성공 0, 실패 시 음수 반환 (아래 에러 코드) */
enum {
    FF_PROT_OK                  =  0,
    FF_PROT_ERR_NOT_INIT        = -1,  /* start_exec 를 init 전에 호출 */
    FF_PROT_ERR_NULL_ARG        = -2,  /* buf / spk_temp / spk_exc == NULL */
    FF_PROT_ERR_BAD_FORMAT      = -3,  /* bytes_per_sample != 2 */
    FF_PROT_ERR_TOO_MANY_CH     = -4,  /* channels > FF_PROT_MAX_CH */
};
 
/* 참조 구현이 지원하는 최대 채널 수 */
#define FF_PROT_MAX_CH 8
 
/** 라이브러리 초기화: 열/변위 추정기 상태를 리셋한다. 매 세션 시작 시 1회. */
int ff_prot_init(void);
 
/**
* 보호 파라미터 설정.
* 정품 라이브러리처럼 현재는 인자를 받지 않으며(바인딩이 무인자), 내부 기본 튜닝값을 다시 적용하는 것 외에는 사실상 NOP이다. 실제 파라미터 주입 지점(예: Re, Mms, tau, 정격 전력)은 여기에 확장한다. -> 정품 제공 시 수정 필요.
*/
int ff_prot_set_param(void);
 
/**
* 한 프레임(블록) 처리: planar PCM 을 받아 (1) 보호 감쇠를 buf 에 in-place 로 적용하고
* (2) 감쇠 후 상태 기준의 채널별 온도/변위를 추정한다.
* 실제 벤더 시그니처와 동일하게 sample_rate_hz 인자는 없다 — dt/LPF 계수는 이 참조 스텁
* 내부에서 DEFAULT_SAMPLE_RATE_HZ로 근사 계산한다.
*
* ⚠️ 감쇠 커브(EXC_LIMIT_UM / TEMP_LIMIT_C 기반)는 이 스텁이 지어낸 임의값이다 —
*    파이프라인 검증용이며 보호 성능의 근거가 아니다. 정품 .so 수령 시 폐기.
* @param buf              [in/out] planar int16 PCM (ch0 전체 → ch1 전체 → ...).
*                         반환 시 보호 감쇠가 적용된 PCM 으로 덮어써진다.
* @param samples_per_ch   채널당 샘플 수 (호출자가 세션마다 지정, 예: 480)
* @param bytes_per_sample 샘플당 바이트 (2 고정)
* @param channels         채널 수 (예: 2)
* @param amb_temp         주변 온도 [°C] (예: 25)
* @param spk_temp         [out] int32[channels] 보이스코일 온도 [°C]
* @param spk_exc          [out] int32[channels] 콘 피크 변위 [µm]
* @param v_sensing        [in, optional] 실제 캡쳐된 V(전압) sensing 데이터 — int16[samples_per_ch]
*                         **단일(모노) 스트림**이다. buf 처럼 channels별 배열이 아니다 —
*                         MCHStreamer가 실측 V/I 센스 라인을 캡처 장치의 **ch0(V)/ch1(I)**로
*                         그대로 실어 보내므로, 클라이언트는 그 캡처 wire 프레임을 디인터리브해
*                         v_sensing/i_sensing으로 넘긴다(frame-core.ts의 selectSensing 참고) —
*                         캡처 채널 수(2/4/6/8)와 무관하게 항상 이 두 채널이다. 과거엔 4ch+
*                         캡처에서 ch2/ch3를 별도 센스 라인으로 오인해 추출했었는데
*                         (reframeNativeChunk.ts, 2026-07-23 정정 전), 실제로는 ch2/ch3에 V/I가
*                         실리지 않아 잘못된 값이었다.
*                         ⚠️ 2026-07-24 정정: v_sensing/i_sensing은 **buf와 더 이상 같은 소스가
*                         아니다**. buf는 이제 실제 처리 대상 오디오 신호(Tauri 파일 재생
*                         모드에서는 재생 중인 원본 오디오, 재생 PCM이 없는 캡처 전용 경로에서는 무음)이고,
*                         v_sensing/i_sensing만 캡처된 실측 V/I를 그대로 담는다
*                         (useNativeCapture.ts가 두 프레임을 이어붙여 보내고, frame-core.ts의
*                         processAnalysisFrame이 다시 분리한다). 이전엔 buf 자체가 캡처된
*                         V/I였기 때문에 buf를 그대로 재사용해도 됐지만, 지금은 그렇지 않다.
*                         (⚠️ 정확한 단위/스케일은 여전히 벤더 확인 필요 — 신규 소스의 주석엔
*                         "실제 캡쳐된 V/I Sensing 데이터값"이라고만 돼 있다).
*                         non-NULL이면 pass A(게인 결정)와 pass C(감쇠 후 상태 보고) 의 전력을
*                         모두 v_sensing × i_sensing 실측치로 대체한다(모든 channels에 동일하게
*                         적용 — ff_prot.c 참고). 이 클라이언트 경로에서는 v_sensing/i_sensing이
*                         항상 채워지므로 사실상 NULL(=RMS 근사 폴백)은 발생하지 않는다 — 단,
*                         그 RMS 근사는 이제 buf(재생 음원/무음)의 RMS이지 V/I가 아니다.
*                         excursion(spk_exc) 추정에는 반영되지 않는다 — back-EMF 기반 변위
*                         추정에는 Re/Bl 등 스피커 파라미터가 필요한데 주입 경로가 없어(위
*                         ff_prot_set_param 참고) 현재는 PCM 근사만 쓰는 인터페이스 확인용
*                         목업이다.
* @param i_sensing        [in, optional] 실제 캡쳐된 I(전류) sensing 데이터(캡처 ch1) — v_sensing
*                         과 동일 레이아웃/규약. NULL 허용(위 참고).
* @return FF_PROT_OK 또는 음수 에러 코드
*/
int ff_prot_start_exec(void       *buf,
                       uint32_t    samples_per_ch,
                       uint32_t    bytes_per_sample,
                       uint32_t    channels,
                       int32_t     amb_temp,
                       void       *spk_temp,
                       void       *spk_exc,
                       const void *v_sensing,
                       const void *i_sensing);
 
/** 세션 종료: 상태 정리. (참조 구현에서는 상태 플래그만 내림) */
int ff_prot_stop_exec(void);
 
#ifdef __cplusplus
}
#endif
 
#endif /* FF_PROT_H */
 