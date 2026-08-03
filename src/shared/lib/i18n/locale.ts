export type Locale = "ko" | "en";

export const DEFAULT_LOCALE: Locale = "ko";
export const LOCALE_STORAGE_KEY = "iron-device-locale";

export function isLocale(value: string | null | undefined): value is Locale {
  return value === "ko" || value === "en";
}

export function detectSystemLocale(): Locale {
  if (typeof navigator === "undefined") return DEFAULT_LOCALE;
  const candidates = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const lang of candidates) {
    if (lang?.toLowerCase().startsWith("ko")) return "ko";
    if (lang?.toLowerCase().startsWith("en")) return "en";
  }
  return DEFAULT_LOCALE;
}
