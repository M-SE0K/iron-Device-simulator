#include "ff_prot.h"
#include <math.h>
#include <string.h>
#include <stdio.h>
 
/* ── 고정 튜닝 상수 (검증용 임의값) ─────────────────────────────────────── */
/* 실제 벤더 libirontune.so의 ff_prot_start_exec엔 sample_rate_hz 인자가 없음이 검증됐다
* 근사한다 — Calibration UI에서 세션 sampleRate를 바꿔도 여기엔 반영되지 않는다(알려진 한계). */
#define DEFAULT_SAMPLE_RATE_HZ 48000.0
 
/* 열 모델 */
#define NOMINAL_POWER_W  30.0   /* 풀스케일 신호 기준 최대 전기 소산 전력 [W] */
#define THERMAL_RES_C_W  2.5    /* 열저항 [°C/W] → 평형 온도상승 = Rth·P      */
#define THERMAL_TAU_S    20.0   /* 열 시정수 [s] (τ 클수록 천천히 데워짐)      */
 
/* 변위 모델 */
#define EXC_LPF_FC_HZ    120.0  /* LF 강조 저역통과 컷오프 [Hz]                */
#define EXC_FULLSCALE_UM 8000.0 /* LF 풀스케일 입력 시 피크 변위 [µm] (=8 mm)  */
 
#define INT16_FULLSCALE  32768.0
#define INT16_CLAMP_MAX  32767.0
#define INT16_CLAMP_MIN  (-32768.0)
 
/* 보호 한계 (검증용 임의값) — 정품은 스피커별 파라미터로 결정하겠지만, 벤더 ABI 의
* set_param() 이 무인자 NOP 이라 주입 경로 자체가 없다. 그래서 여기 고정한다.
* 튜닝하려면 이 값을 고치고 build-wasm.sh 로 재빌드해야 한다. */
#define EXC_LIMIT_UM     2000.0 /* 콘 피크 변위 한계 [µm] (=2 mm) — 검증 시 감쇠가 그래프에
                                 * 뚜렷이 보이도록 낮춘 값(피크 25%↑부터 개입, 풀스케일 −12dB).
                                 * 정품 파라미터 수령 시 스피커별 실제 한계로 교체. */
#define TEMP_LIMIT_C     85.0   /* 보이스코일 온도 한계 [°C]                   */
#define GAIN_MIN         0.01  /* 감쇠 하한 — 완전 묵음(0)까지는 내리지 않는다 */
/* 게인 스무딩 계수(프레임당). 줄일 땐 빠르게(attack), 되돌릴 땐 천천히(release) —
* 비대칭이라야 과도 신호에서 펌핑이 덜하다. */
#define GAIN_ATTACK      0.50
#define GAIN_RELEASE     0.05
 
/* 부스트(묵음에 가까운 입력의 게인 상향) 파라미터 — 검증용 임의값.
* RMS가 BOOST_RMS_THRESHOLD 미만이면 "거의 묵음"으로 보고, RMS를 BOOST_TARGET_RMS까지
* 끌어올리는 게인을 노린다(BOOST_MAX_GAIN으로 상한). 아래 EXC/온도 체크가 이 값 위에
* 그대로 이어지므로 부스트는 항상 보호 로직보다 낮은 우선순위다 — 부스트된 신호가
* 한계를 넘으면 다시 감쇠 쪽으로 클램프된다. */
#define BOOST_RMS_THRESHOLD 0.05    /* 이 RMS 미만 입력만 부스트 후보로 삼는다   */
#define BOOST_TARGET_RMS    0.05    /* 부스트가 노리는 목표 RMS                  */
#define BOOST_MAX_GAIN      4.0     /* 부스트 게인 상한 (=+12dB)                 */
#define BOOST_RMS_EPS       1e-6    /* 0-division 방지                           */
 
#define FF_PI 3.14159265358979323846
 
/* ── 검증용 테스트 신호 주입 (FF_PROT_TEST_INJECT) ───────────────────────────
* 무음(0) 소스만 재생해도 보호 로직이 실제로 개입하는지 눈으로 확인하기 위한 훅.
* 켜면 buf 전체를 "프레임마다 STEP 만큼 커지는 DC 레벨"로 덮어쓴다 —
*   frame 0 → 0, frame 1 → STEP, frame 2 → 2·STEP … (MAX 에서 유지)
* 기본값(STEP=10, 480샘플/48kHz = 100프레임/s)이면 초당 +1000, 약 8.2초에 진폭
* 8192(=EXC_LIMIT_UM 에 해당하는 지점)를 지나고 약 33초에 풀스케일에 닿는다.
*
* 명시적으로 켤 때만 컴파일된다(기본 빌드에는 흔적이 없다):
*   FF_PROT_TEST_INJECT=1 npm run build:wasm
*   FF_PROT_TEST_INJECT=1 FF_PROT_TEST_INJECT_STEP=50 FF_PROT_TEST_INJECT_MAX=12000 npm run build:wasm
* 확인이 끝나면 플래그 없이 다시 빌드해 public/wasm/ 을 되돌릴 것. */
#ifdef FF_PROT_TEST_INJECT
#ifndef FF_PROT_TEST_INJECT_STEP
#define FF_PROT_TEST_INJECT_STEP 10      /* 프레임당 증가폭 [int16 LSB]        */
#endif
#ifndef FF_PROT_TEST_INJECT_MAX
#define FF_PROT_TEST_INJECT_MAX  32767   /* 램프 상한 — 여기 닿으면 유지       */
#endif
static int32_t g_inject_level = 0;
#endif
 
 
/* ── 채널별 누적 상태 ───────────────────────────────────────────────────── */
static int    g_initialized = 0;
static int    g_ch_primed[FF_PROT_MAX_CH];  /* 첫 블록에서 온도를 amb 로 시드했는지 */
static double g_vc_temp[FF_PROT_MAX_CH];    /* 보이스코일 추정 온도 [°C]           */
static double g_lpf_state[FF_PROT_MAX_CH];  /* LF 저역통과 1-pole 상태             */
static double g_gain[FF_PROT_MAX_CH];       /* 직전 프레임 끝에서 적용된 감쇠 게인  */
 
/* set_param 으로 (재)적용되는 튜닝값 — 정품에선 여기로 파라미터 주입 */
static double g_nominal_power = NOMINAL_POWER_W;
static double g_thermal_res   = THERMAL_RES_C_W;
static double g_thermal_tau   = THERMAL_TAU_S;
static double g_lpf_fc        = EXC_LPF_FC_HZ;
 
static void reset_state(void)
{
    memset(g_ch_primed, 0, sizeof(g_ch_primed));
    for (int i = 0; i < FF_PROT_MAX_CH; ++i) {
        g_vc_temp[i]   = 0.0;
        g_lpf_state[i] = 0.0;
        g_gain[i]      = 1;   /* 무감쇠에서 출발 */
    }
#ifdef FF_PROT_TEST_INJECT
    g_inject_level = 0;       /* 세션(재생)마다 램프를 0부터 다시 */
#endif
}
 
/*
* 한 채널 블록을 훑어 RMS 와 LF 저역통과 피크를 구한다.
* lpf_state 는 in/out — 호출자가 pass A 에서는 사본을 넘겨 상태를 버리고,
* pass C 에서는 실제 상태를 넘겨 커밋한다.
*/
static void scan_block(const int16_t *x, uint32_t n, double a_lpf,
                       double *lpf_state, double *out_rms, double *out_peaklpf)
{
    double sumsq   = 0.0;
    double lpf     = *lpf_state;
    double peaklpf = 0.0;
 
    for (uint32_t i = 0; i < n; ++i) {
        double s = (double)x[i] / INT16_FULLSCALE;   /* -1 .. 1 */
        sumsq += s * s;
        lpf = a_lpf * lpf + (1.0 - a_lpf) * s;       /* LF 강조 */
        double m = fabs(lpf);
        if (m > peaklpf) peaklpf = m;
    }
 
    *lpf_state   = lpf;
    *out_rms     = sqrt(sumsq / (double)n);
    *out_peaklpf = peaklpf;
}
 
/*
* v_sensing/i_sensing 블록의 평균 순시전력(P = mean(v·i))을 [W] 근사로 환산한다.
* v/i 는 buf 와 동일하게 int16 풀스케일(±32768 ↔ ±1)로 정규화한 뒤 NOMINAL_POWER_W를
* 풀스케일 기준 전력으로 써서 스케일한다 — 정확한 벤더 단위/스케일은 미확인이라 buf 기반
* RMS 근사(g_nominal_power·rms²)와 같은 스케일 축을 재사용한 잠정치다(ff_prot.h 참고).
*/
static double compute_real_power(const int16_t *v, const int16_t *i, uint32_t n)
{
    double sum = 0.0;
    for (uint32_t k = 0; k < n; ++k) {
        double vv = (double)v[k] / INT16_FULLSCALE;
        double ii = (double)i[k] / INT16_FULLSCALE;
        sum += vv * ii;
    }
    double p = g_nominal_power * (sum / (double)n);
    return (p < 0.0) ? 0.0 : p;   /* 순간 위상차로 음수가 나올 수 있어 하한만 clamp */
}
 
int ff_prot_init(void)
{
    reset_state();
    g_initialized = 1;
    return FF_PROT_OK;
}
 
int ff_prot_set_param(void)
{
    /* 정품 라이브러리와 동일하게 사실상 NOP: 기본 튜닝값 재적용.
     * 실제 파라미터(스피커별 Re/Mms/정격전력 등) 주입은 여기 확장. -> 정품 제공 시 수정. */
    g_nominal_power = NOMINAL_POWER_W;
    g_thermal_res   = THERMAL_RES_C_W;
    g_thermal_tau   = THERMAL_TAU_S;
    g_lpf_fc        = EXC_LPF_FC_HZ;
    return FF_PROT_OK;
}
 
/*
buf: 언터리브된 데이터
samples_per_ch: 채널 당 샘플 개수(16bit 2channel. 1024바티으면 1024/(2*2) = 256)
byte_per_sample: 샘플 하나당 바이트 크기(16bit PCM = 2, 23/32bit PCM = 4)
channels: 분석 ABI 채널 수(현재 클라이언트는 CHANNELS=2 고정)
amb_temp: clibration UI에서 선택된 주변 온도
spk_exc: 보호 알고리즘을 통해 계산된 exc 값 받아올 버퍼
spk_temp: 보호 알고리즘을 통해 계산된 temp 값을 받아올 버퍼
*/
 
int ff_prot_start_exec(void       *buf,
                       uint32_t    samples_per_ch,
                       uint32_t    bytes_per_sample,
                       uint32_t    channels,
                       int32_t     amb_temp,
                       void       *spk_temp,
                       void       *spk_exc,
                       const void *v_sensing,
                       const void *i_sensing)
{
#ifdef FF_PROT_DEBUG_VI
    /* Calibration 적용값 + V/I 실측값을 한 번에 찍는 디버깅 출력문 — samples_per_ch 전체를
     * 찍으므로 프레임당(~10ms) 로그량이 많다. 렌더러가 이 콘솔 출력을 처리하느라 메인 스레드가
     * 밀리면 N1(네이티브 IPC 릴레이) 같은 지연 측정이 오염되므로, 이 매크로가 켜진 "실험(debug)"
     * WASM 빌드(npm run wasm:build:debug)는 값 확인 전용이다 — E2E 지연 측정/프로덕션에는 항상
     * 이 매크로 없이 빌드된 클린 WASM(npm run wasm:build)을 쓴다. */
    printf("[ff_prot_start_exec 함수 ] samples_per_ch=%u bytes_per_sample=%u channels=%u amb_temp=%d\n",
           samples_per_ch, bytes_per_sample, channels, amb_temp);
    const int16_t *dbgV = (const int16_t *)v_sensing;
    const int16_t *dbgI = (const int16_t *)i_sensing;
    if (dbgV && dbgI) {
        printf("[ff_prot_start_exec V/I] v_sensing[0..%u]=", samples_per_ch - 1);
        for (uint32_t k = 0; k < samples_per_ch; ++k) printf("%d ", dbgV[k]);
        printf("\n[ff_prot_start_exec V/I] i_sensing[0..%u]=", samples_per_ch - 1);
        for (uint32_t k = 0; k < samples_per_ch; ++k) printf("%d ", dbgI[k]);
        printf("\n");
    } else {
        printf("[ff_prot_start_exec V/I] v_sensing/i_sensing = NULL (미실측)\n");
    }
    fflush(stdout);
#endif
 
    if (!g_initialized)                 return FF_PROT_ERR_NOT_INIT;
    if (!buf || !spk_temp || !spk_exc)  return FF_PROT_ERR_NULL_ARG;
    if (bytes_per_sample != 2)          return FF_PROT_ERR_BAD_FORMAT;
    if (channels > FF_PROT_MAX_CH)      return FF_PROT_ERR_TOO_MANY_CH;
    if (samples_per_ch == 0)            return FF_PROT_ERR_BAD_FORMAT;
 
    /* buf 는 In/Out — pass B 에서 감쇠된 샘플을 여기에 되쓴다(벤더 래퍼와 동일 규약). */
    int16_t *pcm  = (int16_t *)buf;
    int32_t *outT = (int32_t *)spk_temp;
    int32_t *outE = (int32_t *)spk_exc;
 
#ifdef FF_PROT_TEST_INJECT
    /* 테스트 램프 주입 — 반드시 pass A 스캔과 real_power 계산 "이전"이어야 이번 프레임의
     * 게인 결정에 곧바로 반영된다. buf 를 통째로 현재 레벨의 DC 로 덮어쓴다.
     *
     * 주입은 WASM 힙 안에서만 일어난다 — 렌더러가 들고 있는 입력 사본(frame-core.ts 의
     * `input`)은 buf 를 힙으로 복사하기 전에 떠 둔 것이라 그대로 0 이다. 그래서
     * ProtectedComparePanel 에서는 Input 트레이스가 0 직선, Protected 트레이스만 램프로
     * 올라가다가 진폭 8192(= EXC_LIMIT_UM 2000µm) 부근에서 꺾여 눌리는 그림이 나온다.
     *
     * ⚠️ Protected 재생 모드에서는 이 DC 램프가 그대로 스피커로 나간다(감쇠 후지만 DC 는
     *    보이스코일에 계속 흐른다). 하드웨어를 물린 채로는 앰프를 내리거나
     *    FF_PROT_TEST_INJECT_MAX 를 낮춰서 쓸 것. */
    {
        int32_t lvl = g_inject_level;
        if (lvl > FF_PROT_TEST_INJECT_MAX) lvl = FF_PROT_TEST_INJECT_MAX;
        const int16_t dc    = (int16_t)lvl;
        const size_t  total = (size_t)channels * (size_t)samples_per_ch;
        for (size_t k = 0; k < total; ++k) pcm[k] = dc;
 
        /* v/i 센싱도 같이 주입해야 온도 트레이스가 산다 — 주입이 buf 만 바꾸므로 실제
         * 캡처된 v/i(무음이라 ≈0)를 그대로 두면 real_power 가 0 이라 온도가 amb_temp 에
         * 고정된다. 실제 하드웨어 루프처럼 "직전 프레임에 적용된 게인이 실려 나간 신호를
         * 되받은 것"으로 쳐서 g_gain[0] 을 곱해 넣는다.
         * 대상 버퍼는 호출자(wasm-client.ts)가 프레임마다 새로 채워 넣는 전용 힙 버퍼라
         * const 를 떼고 덮어써도 다음 프레임에 영향이 남지 않는다. */
        if (v_sensing && i_sensing) {
            double  sensed = (double)lvl * g_gain[0];
            int16_t sv     = (int16_t)(sensed + 0.5);
            int16_t *vw = (int16_t *)(uintptr_t)v_sensing;
            int16_t *iw = (int16_t *)(uintptr_t)i_sensing;
            for (uint32_t k = 0; k < samples_per_ch; ++k) { vw[k] = sv; iw[k] = sv; }
        }
 
        g_inject_level = lvl + FF_PROT_TEST_INJECT_STEP;
        if (g_inject_level > FF_PROT_TEST_INJECT_MAX) g_inject_level = FF_PROT_TEST_INJECT_MAX;
    }
#endif
 
    /* v_sensing/i_sensing 은 2026-07-21 새로 확인된 인자 — 현재 Tauri 캡처 경로는
     * MCHStreamer의 ch0/ch1 센싱을 항상 넘기지만 ABI는 NULL도 허용한다. 둘 다 있을 때만 실측
     * 전력으로 근사를 대체하며, pass A(게인 결정)와 pass C(상태 보고) 양쪽에 쓴다(ff_prot.h 참고).
     * 채널별 배열이 아니라 단일 스트림이라 루프 밖에서 한 번만 계산해 모든 channels에
     * 동일하게 적용한다(채널별 분리는 현재 범위 밖 — 단일 센스 라인 가정 유지). */
    const int16_t *vSense = (const int16_t *)v_sensing;
    const int16_t *iSense = (const int16_t *)i_sensing;
    const int    have_real_power = (vSense != NULL && iSense != NULL);
    const double real_power      = have_real_power
                                  ? compute_real_power(vSense, iSense, samples_per_ch)
                                  : 0.0;
 
    const double dt    = (double)samples_per_ch / DEFAULT_SAMPLE_RATE_HZ; /* 블록 길이 [s] 근사 */
    const double alpha = dt / g_thermal_tau;                             /* RC 적분 계수  */
    /* 1-pole LPF 계수: a = exp(-2π·fc/fs), y ← a·y + (1−a)·x */
    const double a_lpf = exp(-2.0 * FF_PI * g_lpf_fc / DEFAULT_SAMPLE_RATE_HZ);
 
    for (uint32_t ch = 0; ch < channels; ++ch) {
        int16_t *x = pcm + (size_t)ch * samples_per_ch;
 
        if (!g_ch_primed[ch]) {
            g_vc_temp[ch]   = (double)amb_temp;
            g_ch_primed[ch] = 1;
        }
 
        /* ── pass A: 입력 스캔 — "감쇠 안 하면 어떻게 되는가" 예측 ─────────── */
        /* LPF 상태는 사본으로 훑는다 — 실제 상태는 pass C(감쇠된 신호)가 커밋한다. */
        double lpf_probe = g_lpf_state[ch];
        double rms_in, peak_in;
        scan_block(x, samples_per_ch, a_lpf, &lpf_probe, &rms_in, &peak_in);
 
        /* ── 목표 게인 산출 ──────────────────────────────────────────────── */
        double target = 1.0;
 
#ifndef FF_PROT_DUMMY_ATTENUATION
        /* 부스트: 입력이 묵음에 가까우면(RMS가 매우 작으면) 목표 게인을 1.0 위로
         * 끌어올린다. 아래 EXC/온도 체크가 그대로 이어지므로, 부스트된 신호가 보호
         * 한계를 넘으면 다시 target이 낮은 쪽으로 클램프된다 — 부스트는 항상 보호
         * 로직보다 낮은 우선순위. */
        if (rms_in > BOOST_RMS_EPS && rms_in < BOOST_RMS_THRESHOLD) {
            double g_boost = BOOST_TARGET_RMS / rms_in;
            if (g_boost > BOOST_MAX_GAIN) g_boost = BOOST_MAX_GAIN;
            if (g_boost > target) target = g_boost;
        }
 
        /* 변위: 진폭에 선형이므로 한계/현재 비율이 그대로 게인이 된다. */
        double exc_in = peak_in * EXC_FULLSCALE_UM;
        if (exc_in > EXC_LIMIT_UM) {
            double g_exc = EXC_LIMIT_UM / exc_in;
            if (g_exc < target) target = g_exc;
        }
 
        /* 온도: 적분기라 즉시 못 내린다 — 대신 "평형 온도가 한계에 걸리는" 전력으로
         * 제한한다. v_sensing/i_sensing이 있으면 게인 결정에도 실측 전력(real_power)을
         * 쓴다 — 직전 블록 실측치라 "이번 블록 무감쇠 시" 예측과 타이밍이 완전히 맞지는
         * 않지만, 실측 피드백을 게인 결정에 반영하기로 한 결정에 따라 PCM 근사보다
         * 우선한다(NULL이면 기존처럼 rms_in² 근사). P ∝ g²·rms² 관계이므로 게인은
         * 전력비의 제곱근으로 낮춘다. */
        double power_in = have_real_power ? real_power : g_nominal_power * rms_in * rms_in;
        if (power_in > 0.0) {
            double power_allowed = (TEMP_LIMIT_C - (double)amb_temp) / g_thermal_res;
            if (power_allowed < 0.0) power_allowed = 0.0;   /* 주변온도가 이미 한계 이상 */
            if (power_in > power_allowed) {
                double g_temp = sqrt(power_allowed / power_in);
                if (g_temp < target) target = g_temp;
            }
        }
        if (target < GAIN_MIN) target = GAIN_MIN;
#else
        /* 더미 감쇠 모드(FF_PROT_DUMMY_ATTENUATION) — pass A의 게인 결정 자체를 건너뛰어
         * target을 항상 1.0으로 둔다. 아래 pass B의 in-place 쓰기는 prev==gain==1.0일 때
         * 조건이 거짓이 되어 자연히 스킵되므로 buf가 전혀 수정되지 않는다(패스스루) —
         * "Protection Algorithm" 차트의 Protected 트레이스가 Input과 완전히 겹쳐야 한다.
         * pass C는 그대로 이 원신호를 재스캔하므로 temp/exc는 "보호가 전혀 개입하지 않았을
         * 때" 값을 계속 보여준다. */
        (void)peak_in;
        (void)rms_in;
#endif
 
        /* 비대칭 스무딩: 줄일 땐 빠르게, 되돌릴 땐 천천히 */
        double prev  = g_gain[ch];
        double coeff = (target < prev) ? GAIN_ATTACK : GAIN_RELEASE;
        double gain  = prev + coeff * (target - prev);
 
        /* ── pass B: 감쇠를 in-place 로 적용 ─────────────────────────────── */
        /* 프레임 경계에서 게인이 계단처럼 튀면 지직거린다(zipper noise) —
         * prev → gain 을 샘플 단위로 선형 보간해 넘어간다. */
        if (prev != 1.0 || gain != 1.0) {
            double step = (samples_per_ch > 1)
                        ? (gain - prev) / (double)(samples_per_ch - 1)
                        : 0.0;
            double g = prev;
            for (uint32_t i = 0; i < samples_per_ch; ++i) {
                double v = (double)x[i] * g;
                if (v > INT16_CLAMP_MAX) v = INT16_CLAMP_MAX;
                if (v < INT16_CLAMP_MIN) v = INT16_CLAMP_MIN;
                x[i] = (int16_t)(v >= 0.0 ? v + 0.5 : v - 0.5);
                g += step;
            }
        }
        g_gain[ch] = gain;
 
        /* ── pass C: 감쇠된 신호로 재추정 → 이 값이 차트에 나간다 ────────── */
        /* 보호가 걸린 뒤의 상태를 보고해야 차트에서 "한계에 물린" 모습이 보인다. */
        double rms, peaklpf;
        scan_block(x, samples_per_ch, a_lpf, &g_lpf_state[ch], &rms, &peaklpf);
 
        /* 온도: 전력 → 평형온도 → RC 적분.
         * v_sensing/i_sensing 이 있으면 buf RMS 근사 대신 실측 전력(real_power, 루프 밖에서
         * 1회 계산)을 쓴다 — pass A 게인 결정에도 이제 같은 real_power 를 쓰므로(위 참고),
         * 감쇠 전/후 두 pass 모두 실측치 기준으로 일관된다. */
        double power = have_real_power ? real_power : g_nominal_power * rms * rms; /* ∝ V²/R */
        double t_equil = (double)amb_temp + g_thermal_res * power;  /* 평형 목표 온도 */
        g_vc_temp[ch] += alpha * (t_equil - g_vc_temp[ch]);
 
        /* 변위: LF 피크 → µm (풀스케일 LF = EXC_FULLSCALE_UM) */
        double exc_um = peaklpf * EXC_FULLSCALE_UM;
 
        /* 출력 (정수 반올림, 음수 방지) */
        double t_out = g_vc_temp[ch];
        if (t_out < 0.0) t_out = 0.0;
        outT[ch] = (int32_t)(t_out + 0.5);
        outE[ch] = (int32_t)(exc_um + 0.5);
    }
 
    return FF_PROT_OK;
}
 
int ff_prot_stop_exec(void)
{
    g_initialized = 0;
    return FF_PROT_OK;
}