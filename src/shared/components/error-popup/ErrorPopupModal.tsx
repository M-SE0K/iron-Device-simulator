"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { ErrorPopupModalProps } from "./popup-types";

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
          <span className="text-[11px] text-iron-400">{`+${queuedCount} more waiting`}</span>
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
