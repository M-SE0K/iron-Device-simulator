"use client";

// 좌측 슬라이딩 내비게이션 드로어 (대시보드 ↔ 워크스페이스 전환)
// 트리거(햄버거)와 패널을 한 컴포넌트로 캡슐화 — Header / workspace 페이지 어디에든 <SideNav /> 드롭.
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { FolderTree, LayoutDashboard, LogOut, Menu, X } from "lucide-react";

const NAV = [
  { href: "/", label: "대시보드", icon: LayoutDashboard },
  { href: "/workspace", label: "워크스페이스", icon: FolderTree },
] as const;

export default function SideNav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();

  // Esc 로 닫기 + 열렸을 때 배경 스크롤 잠금
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <>
      {/* 트리거 (좌측 탭) */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="메뉴 열기"
        aria-expanded={open}
        className="flex items-center justify-center w-9 h-9 rounded-lg text-iron-500 hover:bg-iron-100 hover:text-iron-900 transition"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* 배경 오버레이 */}
      <div
        onClick={() => setOpen(false)}
        aria-hidden
        className={`fixed inset-0 z-40 bg-iron-900/30 backdrop-blur-[1px] transition-opacity duration-300 ${
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      />

      {/* 슬라이딩 패널 */}
      <aside
        className={`fixed top-0 left-0 z-50 h-full w-64 bg-white border-r border-iron-100 shadow-xl flex flex-col transition-transform duration-300 ease-out ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
        role="dialog"
        aria-label="내비게이션"
        aria-hidden={!open}
      >
        <div className="h-14 px-4 shrink-0 flex items-center justify-between border-b border-iron-100">
          <span className="text-sm font-bold text-iron-900 tracking-tight">IRON DEVICE</span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="메뉴 닫기"
            className="flex items-center justify-center w-8 h-8 rounded-lg text-iron-400 hover:bg-iron-100 hover:text-iron-700 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <nav className="flex-1 p-2 overflow-auto">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                onClick={() => setOpen(false)}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-3 px-3 py-2.5 mb-1 rounded-lg text-sm transition ${
                  active
                    ? "bg-brand-blue/10 text-brand-blue font-medium"
                    : "text-iron-600 hover:bg-iron-100"
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="p-2 border-t border-iron-100 shrink-0">
          <button
            type="button"
            onClick={logout}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-iron-500 hover:bg-iron-100 transition"
          >
            <LogOut className="w-4 h-4 shrink-0" />
            로그아웃
          </button>
        </div>
      </aside>
    </>
  );
}
