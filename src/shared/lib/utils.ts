import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { saveFileViaTauri } from "./tauri-bridge/file-export";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function round3(v: number): number {
  return parseFloat(v.toFixed(3));
}

export function formatFileSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function splitFileName(fileName: string | null | undefined): { stem: string; ext: string } {
  if (!fileName) return { stem: "", ext: "" };
  const dot = fileName.lastIndexOf(".");
  if (dot > 0 && dot < fileName.length - 1) {
    return { stem: fileName.slice(0, dot), ext: fileName.slice(dot + 1) };
  }
  return { stem: fileName, ext: "" };
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "_").trim() || "untitled";
}

export function splitPath(path: string): { name: string; parent: string } {
  const clean = path.replace(/[/\\]+$/, "");
  const idx = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  const name = idx < 0 ? clean : clean.slice(idx + 1);
  let parent = idx < 0 ? "" : clean.slice(0, idx) || "/";
  parent = parent.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
  return { name, parent };
}

export async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    await saveFileViaTauri(blob, filename);
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
