/**
 * Input(원본)은 **무채색**, Protected(보호 후)는 유채색이다. 이 패널의 관심사는 "원본 대비
 * 무엇이 얼마나 깎였나"라, 두 쌍을 같은 채도로 그리면 겹친 구간에서 어느 쪽이 결과인지
 * 한눈에 안 들어온다. 원본은 배경 기준선으로 물러나고 보호 결과만 색으로 떠오르게 한다.
 *
 * L/R 구분은 채도가 아니라 **명도 두 단계**로 준다(iron-600 / iron-400 = 프로젝트 회색 팔레트).
 */
export const COLOR_INPUT_L     = "#475569";
export const COLOR_PROTECTED_L = "#2563eb";
export const COLOR_INPUT_R     = "#94A3B8";
export const COLOR_PROTECTED_R = "#d97706";
