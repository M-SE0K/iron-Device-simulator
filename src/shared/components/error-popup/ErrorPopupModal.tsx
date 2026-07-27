"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { PopupVariant } from "./ErrorPopupContext";

interface ErrorPopupModalProps {
  message: string;
  variant: PopupVariant;
  /** 이 팝업 뒤에 아직 대기 중인 메시지 개수 — 0이면 배지를 표시하지 않는다. */
  queuedCount: number;
  onClose: () => void;
}

const VARIANT_STYLE = {
  error: {
    label: "Error",
    icon: AlertTriangle,
    iconWrap: "bg-red-50 text-red-500",
  },
  success: {
    label: "Applied",
    icon: CheckCircle2,
    iconWrap: "bg-emerald-50 text-emerald-600",
  },
} as const;

/**
 * 화면 정중앙에 뜨는 단일 피드백 팝업(에러 또는 성공). 배경 클릭/ESC로는 닫히지 않고
 * "닫기" 버튼을 눌러야만 사라진다 — USB 연결 끊김처럼 사용자가 반드시 인지해야 하는
 * 에러를 실수로 흘려보내지 않기 위함. z-index는 드로어/전체화면 오버레이(최대 z-[65])
 * 위에 항상 뜨도록 최상위로 둔다.
 */
export default function ErrorPopupModal({ message, variant, queuedCount, onClose }: ErrorPopupModalProps) {
  const { label, icon: Icon, iconWrap } = VARIANT_STYLE[variant];
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={label}
      className="fixed inset-0 z-[200] flex items-center justify-center bg-iron-900/40 backdrop-blur-[1px] p-4"
    >
      <div className="w-full max-w-sm rounded-2xl bg-white shadow-[0_24px_64px_rgba(15,23,42,0.28)] border border-iron-100 p-6 flex flex-col items-center text-center gap-3">
        <div className={`flex items-center justify-center w-11 h-11 rounded-full shrink-0 ${iconWrap}`}>
          <Icon className="w-5 h-5" />
        </div>
        <h2 className="text-sm font-semibold text-iron-900">{label}</h2>
        <p className="text-sm text-iron-600 leading-relaxed break-words">{message}</p>
        {queuedCount > 0 && (
          <span className="text-[11px] text-iron-400">+{queuedCount} more waiting</span>
        )}
        <button
          type="button"
          onClick={onClose}
          autoFocus
          className="mt-1 w-full h-10 rounded-xl bg-iron-900 text-white text-sm font-semibold hover:bg-iron-800 transition-colors"
        >
          Close
        </button>
      </div>
    </div>
  );
}
