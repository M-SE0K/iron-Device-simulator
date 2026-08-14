/* debug/passthrough.c — 원음을 아무 가공 없이 그대로 흘려보내는 디버그 알고리즘.
 * buf 는 전혀 수정하지 않는다(무튜닝 패스스루). exc/temp는 감쇠가 없으므로 원음 신호
 * 세기를 그대로 반영한다(../protection.c 와 동일한 근사 모델, 감쇠 로직만 제거).
 * 빌드: FF_PROT_SRCS=custom/debug/passthrough.c */
#include "./protection.h"
#include <stdio.h>
#include <math.h>
#include <string.h>

#define DEFAULT_SAMPLE_RATE_HZ 48000.0
#define NOMINAL_POWER_W  30.0
#define THERMAL_RES_C_W  2.5
#define THERMAL_TAU_S    20.0
#define EXC_LPF_FC_HZ    120.0
#define EXC_FULLSCALE_UM 8000.0
#define INT16_FULLSCALE  32768.0
#define FF_PI 3.14159265358979323846
#define FF_PROT_MAX_CH 8

static int    g_initialized = 0;
static int    g_ch_primed[FF_PROT_MAX_CH];
static double g_vc_temp[FF_PROT_MAX_CH];
static double g_lpf_state[FF_PROT_MAX_CH];

static void reset_state(void)
{
    memset(g_ch_primed, 0, sizeof(g_ch_primed));
    memset(g_vc_temp, 0, sizeof(g_vc_temp));
    memset(g_lpf_state, 0, sizeof(g_lpf_state));
}

static void scan_block(const int16_t *x, uint32_t n, double a_lpf,
                       double *lpf_state, double *out_rms, double *out_peaklpf)
{
    double sumsq = 0.0;
    double lpf   = *lpf_state;
    double peaklpf = 0.0;

    for (uint32_t i = 0; i < n; ++i) {
        double s = (double)x[i] / INT16_FULLSCALE;
        sumsq += s * s;
        lpf = a_lpf * lpf + (1.0 - a_lpf) * s;
        double m = fabs(lpf);
        if (m > peaklpf) peaklpf = m;
    }

    *lpf_state   = lpf;
    *out_rms     = sqrt(sumsq / (double)n);
    *out_peaklpf = peaklpf;
}

static double compute_real_power(const int16_t *v, const int16_t *i, uint32_t n)
{
    double sum = 0.0;
    for (uint32_t k = 0; k < n; ++k) {
        double vv = (double)v[k] / INT16_FULLSCALE;
        double ii = (double)i[k] / INT16_FULLSCALE;
        sum += vv * ii;
    }
    double p = NOMINAL_POWER_W * (sum / (double)n);
    return (p < 0.0) ? 0.0 : p;
}

int ff_prot_init(void)
{
    reset_state();
    g_initialized = 1;
    return FF_PROT_OK;
}

int ff_prot_set_param(void)
{
    return FF_PROT_OK;
}

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
    if (!g_initialized)                 return FF_PROT_ERR_NOT_INIT;
    if (!buf || !spk_temp || !spk_exc)  return FF_PROT_ERR_NULL_ARG;
    if (bytes_per_sample != 2)          return FF_PROT_ERR_BAD_FORMAT;
    if (channels > FF_PROT_MAX_CH)      return FF_PROT_ERR_TOO_MANY_CH;
    if (samples_per_ch == 0)            return FF_PROT_ERR_BAD_FORMAT;

    int16_t *pcm  = (int16_t *)buf;
    int32_t *outT = (int32_t *)spk_temp;
    int32_t *outE = (int32_t *)spk_exc;

    const int16_t *vSense = (const int16_t *)v_sensing;
    const int16_t *iSense = (const int16_t *)i_sensing;
    const int    have_real_power = (vSense != NULL && iSense != NULL);
    const double real_power      = have_real_power
                                  ? compute_real_power(vSense, iSense, samples_per_ch)
                                  : 0.0;

    const double dt    = (double)samples_per_ch / DEFAULT_SAMPLE_RATE_HZ;
    const double alpha = dt / THERMAL_TAU_S;
    const double a_lpf = exp(-2.0 * FF_PI * EXC_LPF_FC_HZ / DEFAULT_SAMPLE_RATE_HZ);

    for (uint32_t ch = 0; ch < channels; ++ch) {
        int16_t *x = pcm + (size_t)ch * samples_per_ch;

        if (!g_ch_primed[ch]) {
            g_vc_temp[ch]   = (double)amb_temp;
            g_ch_primed[ch] = 1;
        }

        double rms, peaklpf;
        scan_block(x, samples_per_ch, a_lpf, &g_lpf_state[ch], &rms, &peaklpf);

        double power = have_real_power ? real_power : NOMINAL_POWER_W * rms * rms;
        double t_equil = (double)amb_temp + THERMAL_RES_C_W * power;
        g_vc_temp[ch] += alpha * (t_equil - g_vc_temp[ch]);

        double exc_um = peaklpf * EXC_FULLSCALE_UM;

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
