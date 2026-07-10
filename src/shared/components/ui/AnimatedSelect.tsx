"use client";

// 애니메이션 드롭다운 — 네이티브 <select>를 대체하는 커스텀 셀렉트.
// 네이티브 <select>는 펼침 목록(option list)을 브라우저가 그려 트랜지션을 넣을 수 없으므로,
// 드로어(Calibration/Workspace)의 드롭다운 UX를 통일된 인터랙티브 애니메이션으로 대체한다:
//   · 트리거: 열림 시 chevron 180° 회전, 포커스 링, 눌림(active) 스케일
//   · 메뉴: opacity + scale + translateY 로 펼침/접힘 양방향 재생, 뷰포트 하단이면 위로 flip
//   · 옵션: 진입 시 index 기반 stagger, hover 하이라이트, 선택 항목 체크 + 자동 스크롤
//   · 키보드: ↑/↓ 이동, Enter 선택, Esc/외부클릭 닫기 (role=listbox/option, aria-activedescendant)
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

export interface SelectOption {
  value: string;
  /** 표시 라벨 (미지정 시 value 사용) */
  label?: string;
  /** 우측 보조 텍스트(예: "(연결 안 됨)") */
  hint?: string;
}

interface Props {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** 선택값이 옵션에 없을 때 보여줄 placeholder */
  placeholder?: string;
  /** 트리거/옵션 라벨 뒤에 붙는 단위(예: "Hz") */
  unit?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

const optLabel = (o: SelectOption) => o.label ?? o.value;

export default function AnimatedSelect({
  value,
  options,
  onChange,
  placeholder = "선택",
  unit,
  disabled,
  className = "",
  "aria-label": ariaLabel,
}: Props) {
  const [open, setOpen] = useState(false);
  const [flipUp, setFlipUp] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listboxId = useId();

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;
  const withUnit = (s: string) => (unit ? `${s} ${unit}` : s);

  // 열 때: 하이라이트를 선택 항목으로, 뷰포트 하단 공간이 부족하면 위로 flip
  const openMenu = useCallback(() => {
    if (disabled) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) {
      const spaceBelow = window.innerHeight - rect.bottom;
      // 옵션당 ~36px, 최대 240px 기준으로 아래 공간이 모자라고 위가 더 넓으면 flip
      const needed = Math.min(options.length * 36 + 8, 240);
      setFlipUp(spaceBelow < needed && rect.top > spaceBelow);
    }
    setHighlight(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  }, [disabled, options.length, selectedIndex]);

  const close = useCallback(() => setOpen(false), []);

  const commit = useCallback(
    (i: number) => {
      const o = options[i];
      if (o) onChange(o.value);
      close();
    },
    [options, onChange, close],
  );

  // 외부 클릭으로 닫기
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, close]);

  // 열리면 하이라이트(또는 선택) 항목이 보이도록 스크롤
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: "nearest" });
  }, [open, highlight]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlight((h) => (h + 1) % options.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlight((h) => (h - 1 + options.length) % options.length);
        break;
      case "Home":
        e.preventDefault();
        setHighlight(0);
        break;
      case "End":
        e.preventDefault();
        setHighlight(options.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        commit(highlight);
        break;
      case "Escape":
        e.preventDefault();
        close();
        break;
      case "Tab":
        close();
        break;
    }
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={`group w-full flex items-center gap-2 px-3 py-2 rounded-lg border bg-white font-mono text-sm text-left transition-all duration-150
          focus:outline-none focus:ring-1 focus:ring-brand-blue focus:border-brand-blue active:scale-[0.99]
          ${open ? "border-brand-blue ring-1 ring-brand-blue" : "border-iron-200 hover:border-iron-300"}
          ${disabled ? "bg-iron-50 text-iron-300 cursor-not-allowed" : "text-iron-800 cursor-pointer"}`}
      >
        <span className={`flex-1 min-w-0 truncate ${selected ? "" : "text-iron-300"}`}>
          {selected ? withUnit(optLabel(selected)) : placeholder}
        </span>
        <ChevronDown
          className={`w-4 h-4 shrink-0 text-iron-400 transition-transform duration-200 ease-out ${
            open ? "rotate-180 text-brand-blue" : "group-hover:translate-y-0.5"
          }`}
        />
      </button>

      {/* 펼침 목록 — 항상 마운트, 클래스 토글로 양방향 애니메이션 */}
      <ul
        ref={listRef}
        role="listbox"
        id={listboxId}
        aria-activedescendant={highlight >= 0 ? `${listboxId}-${highlight}` : undefined}
        className={`absolute left-0 right-0 z-20 max-h-60 overflow-auto rounded-lg border border-iron-200 bg-white p-1 shadow-lg shadow-iron-900/5 origin-top
          transition-[opacity,transform] duration-200 ease-out
          ${flipUp ? "bottom-full mb-1 origin-bottom" : "top-full mt-1"}
          ${open ? "opacity-100 scale-100 translate-y-0 pointer-events-auto" : "opacity-0 scale-95 -translate-y-1 pointer-events-none"}`}
      >
        {options.map((o, i) => {
          const isSelected = o.value === value;
          const isActive = i === highlight;
          return (
            <li 
              key={o.value || i}
              id={`${listboxId}-${i}`}
              role="option"
              aria-selected={isSelected}
              data-active={isActive}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => commit(i)}
              style={{ transitionDelay: open ? `${Math.min(i, 8) * 22}ms` : "0ms" }}
              className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md text-sm font-mono cursor-pointer select-none
                transition-[background-color,color,opacity,transform] duration-200 ease-out
                ${open ? "opacity-100 translate-x-0" : "opacity-0 -translate-x-1"}
                ${isActive ? "bg-brand-blue/10 text-brand-blue" : "text-iron-700"}`}
            >
              <Check
                className={`w-3.5 h-3.5 shrink-0 transition-all duration-150 ${
                  isSelected ? "opacity-100 scale-100 text-brand-blue" : "opacity-0 scale-50"
                }`}
              />
              <span className="flex-1 min-w-0 truncate">{withUnit(optLabel(o))}</span>
              {o.hint && <span className="shrink-0 text-[10px] text-iron-400">{o.hint}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
