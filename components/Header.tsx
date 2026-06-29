"use client";

import { Activity } from "lucide-react";

export default function Header() {
  return (
    <header id="app-header" className="bg-white border-b border-iron-100 px-4 sm:px-6 py-0 flex items-center justify-between gap-2 h-14 shrink-0">
      {/* Logo area */}
      <div id="header-logo" className="flex items-center gap-3 min-w-0">
        <div className="header-logo-icon w-8 h-8 rounded-md flex items-center justify-center shrink-0">
          <Activity size={16} className="text-black" strokeWidth={2.5} />
        </div>
        <div className="header-brand truncate">
          <span id="brand-name" className="text-sm font-bold text-iron-900 tracking-tight">IRON DEVICE</span>
        </div>
      </div>
    </header>
  );
}
