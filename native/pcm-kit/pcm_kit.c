/* pcm_kit.c — 렌더 계층 벌크 PCM 커널 (파형 엔벌로프 min/max 버킷 집계).
 *
 * ChannelWaveStore(src/features/audio/lib/render/wave-store.ts)의 addBlock 내부 루프
 * (샘플당 나눗셈+분기 JS)를 대체한다. 채널 추출(인터리브 → 단일 채널)과 버킷별
 * min/max + peak/sumsq 집계를 한 번의 호출로 수행하고, 버킷 상태(seen/compact 등)는
 * 호출자(JS)가 계속 소유한다 — 이 커널은 호출당 무상태(stateless)다.
 *
 * ff_prot.wasm(보호 엔진)과 별개 모듈로 두는 이유: 엔진은 암호화·하드닝·벤더 드롭인
 * 대상이지만 이 커널은 표시용 유틸이라 평문 배포로 충분하고, 엔진 교체와 수명이 다르다.
 *
 * 빌드: ./build-pcm-kit.sh → public/wasm/pcm_kit.wasm (emcc --no-entry 독립 WASM,
 * -msimd128 자동 벡터화). 로더/JS 폴백은 src/features/audio/lib/pcm-kit.ts.
 *
 * 계약 (pcm-kit.ts 와 반드시 동기 유지):
 *   1) 호출자가 pcmkit_in() 스크래치에 인터리브 원시 샘플을 복사한다
 *      (format 0 = int16, 1 = float32; 리틀엔디언 네이티브).
 *   2) pcmkit_envelope(...) 호출 — 반환값 = 기록된 버킷 수 n (음수 = 오류).
 *   3) pcmkit_min()/pcmkit_max()[0..n) 이 버킷 (first + j) 의 정규화(-1..1) min/max.
 *      빈 버킷은 min=+inf > max=-inf 센티널. first 는 pcmkit_stats()[2] (버킷 없음 = -1).
 *   4) pcmkit_stats()[0] = 블록 전체 peak(|max abs|), [1] = 정규화 제곱합(sumsq).
 *      버킷 범위 밖(>= max_buckets)으로 잘린 샘플도 stats 에는 포함된다 — 기존
 *      wave-store 의 "peak/rms 는 전 샘플" 의미를 보존.
 *
 * 버킷 경계: 샘플 i 의 시각 t = start_sec + i/rate, 소속 버킷 = floor(t/bucket_sec).
 * 샘플당 floor 대신 버킷당 경계 인덱스(ceil((경계-start)*rate)) 1회 계산으로 재구성했다
 * — 경계 부동소수점 반올림에서 옛 JS 산식과 ±1 샘플 차이가 날 수 있으나 표시 전용
 * 엔벌로프라 무해하고, JS 폴백(pcm-kit.ts)도 동일 산식을 쓴다.
 */
#include <stdint.h>

#define PCMKIT_IN_CAP_BYTES (1u << 20)              /* 원시 입력 스크래치 1 MiB          */
#define PCMKIT_BUF_CAP      (PCMKIT_IN_CAP_BYTES/2) /* 추출 f32 최대 프레임 수 (i16 모노) */
#define PCMKIT_OUT_CAP      8192u                    /* 호출당 최대 버킷 수                */

#define INT16_NORM (1.0f / 32768.0f)

static uint8_t g_in[PCMKIT_IN_CAP_BYTES] __attribute__((aligned(16)));
static float   g_buf[PCMKIT_BUF_CAP]     __attribute__((aligned(16)));
static float   g_min[PCMKIT_OUT_CAP];
static float   g_max[PCMKIT_OUT_CAP];
static double  g_stats[4]; /* [0]=peak, [1]=sumsq, [2]=firstBucket(-1=없음), [3]=예약 */

uint8_t *pcmkit_in(void)      { return g_in; }
float   *pcmkit_min(void)     { return g_min; }
float   *pcmkit_max(void)     { return g_max; }
double  *pcmkit_stats(void)   { return g_stats; }
uint32_t pcmkit_in_cap(void)  { return PCMKIT_IN_CAP_BYTES; }
uint32_t pcmkit_out_cap(void) { return PCMKIT_OUT_CAP; }

int32_t pcmkit_envelope(uint32_t format,
                        uint32_t frames,
                        uint32_t channels,
                        uint32_t channel,
                        double   start_sec,
                        double   sample_rate,
                        double   bucket_sec,
                        uint32_t max_buckets)
{
    g_stats[0] = 0.0;
    g_stats[1] = 0.0;
    g_stats[2] = -1.0;

    if (format > 1u || channels == 0u || channel >= channels) return -1;
    if (!(sample_rate > 0.0) || !(bucket_sec > 0.0))          return -1;
    if (!(start_sec >= 0.0))                                  return -1;
    /* 버킷이 샘플 간격의 절반보다 작아지면(실사용 범위 밖) 버킷 순회가 폭주할 수
     * 있어 거부한다 — 호출자는 JS 폴백의 per-sample 경로로 처리한다. */
    if (bucket_sec * sample_rate < 0.5)                       return -1;
    const uint32_t bps = (format == 0u) ? 2u : 4u;
    if ((uint64_t)frames * channels * bps > PCMKIT_IN_CAP_BYTES) return -2;
    if (frames > PCMKIT_BUF_CAP)                                 return -2;
    if (frames == 0u) return 0;

    /* ── phase 1: 채널 추출 → 연속 f32 (정규화) ─────────────────────────── */
    if (format == 0u) {
        const int16_t *src = (const int16_t *)g_in + channel;
        for (uint32_t f = 0; f < frames; ++f)
            g_buf[f] = (float)src[(uint32_t)(f * channels)] * INT16_NORM;
    } else {
        const float *src = (const float *)g_in + channel;
        for (uint32_t f = 0; f < frames; ++f)
            g_buf[f] = src[(uint32_t)(f * channels)];
    }

    /* ── phase 2: 버킷별 min/max + peak/sumsq ───────────────────────────── */
    double  peak  = 0.0;
    double  sumsq = 0.0;
    int64_t b     = (int64_t)__builtin_floor(start_sec / bucket_sec);
    if (b < 0) b = 0;

    uint32_t i         = 0;
    int32_t  out_n     = 0;
    int64_t  out_first = -1;

    while (i < frames) {
        const double t_next = (double)(b + 1) * bucket_sec;
        const double f_end  = (t_next - start_sec) * sample_rate;
        uint32_t iEnd;
        if (f_end >= (double)frames)      iEnd = frames;
        else if (f_end <= (double)i)      iEnd = i;      /* 빈 버킷 (진행은 b++ 로) */
        else                              iEnd = (uint32_t)__builtin_ceil(f_end);
        if (iEnd > frames) iEnd = frames;

        const int in_range = ((uint64_t)b < (uint64_t)max_buckets)
                          && (out_n < (int32_t)PCMKIT_OUT_CAP);

        if (iEnd > i) {
            float mn = g_buf[i];
            float mx = mn;
            /* sumsq 는 f32 부분합을 4096샘플마다 f64 로 배출 — 큰 버킷(압축 후 수백만
             * 샘플)에서도 정밀도를 유지하면서 내부 루프는 벡터화 가능하게 남긴다. */
            uint32_t k = i;
            while (k < iEnd) {
                uint32_t seg_end = k + 4096u;
                if (seg_end > iEnd) seg_end = iEnd;
                float ss = 0.0f;
                for (uint32_t s = k; s < seg_end; ++s) {
                    const float v = g_buf[s];
                    mn = (v < mn) ? v : mn;
                    mx = (v > mx) ? v : mx;
                    ss += v * v;
                }
                sumsq += (double)ss;
                k = seg_end;
            }
            const float am = (-mn > mx) ? -mn : mx;
            if ((double)am > peak) peak = (double)am;
            if (in_range) {
                if (out_first < 0) out_first = b;
                g_min[out_n] = mn;
                g_max[out_n] = mx;
                out_n++;
            }
        } else if (in_range && out_first >= 0) {
            /* 시작 이후의 빈 버킷 — 출력 인덱스 연속성을 위해 센티널로 채운다.
             * (첫 기록 전의 빈 버킷은 건너뛰어 out_first 가 실제 첫 데이터 버킷이 된다.) */
            g_min[out_n] =  __builtin_inff();
            g_max[out_n] = -__builtin_inff();
            out_n++;
        }

        i = iEnd;
        b++;
    }

    g_stats[0] = peak;
    g_stats[1] = sumsq;
    g_stats[2] = (double)out_first;
    return out_n;
}
