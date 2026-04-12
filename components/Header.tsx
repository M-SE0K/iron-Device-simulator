"use client";

import { Activity } from "lucide-react";

export default function Header() {
  return (
    <header id="app-header" className="bg-white border-b border-iron-100 px-6 py-0 flex items-center justify-between h-14 shrink-0">
      {/* Logo area */}
      <div id="header-logo" className="flex items-center gap-3">
        <div className="header-logo-icon w-8 h-8 rounded-md flex items-center justify-center">
          <Activity size={16} className="text-black" strokeWidth={2.5} />
        </div>
        <div className="header-brand">
          <span id="brand-name" className="text-sm font-bold text-iron-900 tracking-tight">IRON DEVICE</span>
          <span className="brand-subtitle ml-2 text-xs text-iron-400 font-medium tracking-wider uppercase">
            Audio Analysis Demo
          </span>
        </div>
      </div>

      {/* Right info */}
      <div id="header-meta" className="flex items-center gap-4 text-xs text-iron-400 font-mono">
        <span className="header-version hidden sm:block">v1.0.1</span>
        <div id="header-system-status" className="flex items-center gap-1.5">
          <span className="status-dot w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block animate-pulse" />
          <span className="status-text">SYSTEM READY</span>
        </div>
      </div>
    </header>
  );
}
