"use client";

import { X } from "lucide-react";
import type { ReactNode } from "react";

interface SideDrawerProps {
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  layer?: "content" | "overlay";
  side?: "left" | "right";
  widthClassName?: string;
  safeAreaTop?: boolean;
  header?: ReactNode;
  title?: string;
  count?: number;
  bodyClassName?: string;
  footer?: ReactNode;
  children: ReactNode;
}

export default function SideDrawer({
  open,
  onClose,
  ariaLabel,
  layer = "content",
  side = "right",
  widthClassName = "w-[320px] max-w-[82vw]",
  safeAreaTop = false,
  header,
  title,
  count,
  bodyClassName = "p-4",
  footer,
  children,
}: SideDrawerProps) {
  const backdropPos = layer === "overlay" ? "fixed z-[61]" : "absolute z-40";
  const panelPos = layer === "overlay" ? "fixed z-[62]" : "absolute z-50";
  const sidePos = side === "left" ? "left-0" : "right-0";
  const sideBorder = side === "left" ? "border-r" : "border-l";
  const sideShadow = side === "left"
    ? "shadow-[12px_0_40px_rgba(15,23,42,0.16)]"
    : "shadow-[-12px_0_40px_rgba(15,23,42,0.16)]";
  const closedTranslate = side === "left" ? "-translate-x-full" : "translate-x-full";

  return (
    <>
      <div
        onClick={onClose}
        aria-hidden
        className={`${backdropPos} inset-0 bg-iron-900/30 backdrop-blur-[1px] transition-opacity duration-300 ${
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      />

      <aside
        className={`${panelPos} top-0 ${sidePos} h-full ${widthClassName} bg-white ${sideBorder} border-iron-100 ${sideShadow} flex flex-col transition-transform duration-[240ms] ease-out ${
          open ? "translate-x-0" : closedTranslate
        }`}
        style={safeAreaTop ? { paddingTop: "env(safe-area-inset-top)" } : undefined}
        role="dialog"
        aria-label={ariaLabel}
        aria-hidden={!open}
      >
        {header ?? (
          <div className="px-5 pt-5 pb-4 shrink-0 flex items-center justify-between border-b border-iron-100">
            <div className="flex items-center gap-2 min-w-0">
              <h2 className="m-0 text-lg font-bold text-iron-900">{title}</h2>
              {count !== undefined && count > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-iron-100 text-xs text-iron-500 font-semibold tabular-nums">
                  {count}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex items-center justify-center w-8 h-8 rounded-lg text-iron-400 hover:bg-iron-100 hover:text-iron-700 transition shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <div className={`flex-1 min-h-0 overflow-auto ${bodyClassName}`}>{children}</div>

        {footer}
      </aside>
    </>
  );
}
