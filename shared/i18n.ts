// Interface language. The Chinese text is the source and the key; the English
// catalog maps it. Both applications and the shared formatters read it at call
// time, so a change of language re-renders into the new one.
import { en } from "./locale-en.ts"

export type Locale = "zh-CN" | "en"
export type Entry = string | { one?: string; other: string }

const STORE = "lang"
const pick = (value: string | null | undefined): Locale | null =>
  !value ? null : /^en/i.test(value) ? "en" : /^zh/i.test(value) ? "zh-CN" : null

// Outside a browser (the unit tests) there is no visitor to follow.
const browser = typeof document !== "undefined"
const stored = () => {
  try {
    return localStorage.getItem(STORE)
  } catch {
    return null
  }
}

let locale: Locale = (browser && (pick(stored()) || pick(navigator.language))) || "zh-CN"
const catalogs: Record<Exclude<Locale, "zh-CN">, Record<string, Entry>> = { en }
const plural = { en: new Intl.PluralRules("en") }
const listeners = new Set<(next: Locale) => void>()

if (browser) document.documentElement.lang = locale

/**
 * `T("{n} 个节点", { n: 3 })`: the entry for the current language, else the
 * source. A `{one, other}` entry is chosen by the count in `n`. A `#word` suffix
 * tells apart one Chinese text with two meanings ("关闭#off") and is not shown.
 */
export function T(source: string, vars?: Record<string, string | number>): string {
  const bare = source.replace(/#[a-z-]+$/, "")
  let entry: Entry = locale === "zh-CN" ? bare : (catalogs[locale][source] ?? bare)
  if (typeof entry === "object") entry = entry[plural[locale as "en"].select(Number(vars?.n) || 0) as "one" | "other"] ?? entry.other
  let text = entry
  if (vars) text = text.replace(/\{(\w+)\}/g, (all, key: string) => (key in vars ? String(vars[key]) : all))
  return locale === "zh-CN" ? text : text.replace(/ {2,}/g, " ")
}

export const getLocale = () => locale
/** The BCP 47 tag for Intl formatters. */
export const intl = () => (locale === "en" ? "en-US" : "zh-CN")

export function setLocale(next: string) {
  const value = pick(next) || "zh-CN"
  if (value === locale) return
  locale = value
  try {
    localStorage.setItem(STORE, locale)
  } catch {
    // A browser that refuses storage keeps the choice for this page only.
  }
  if (browser) document.documentElement.lang = locale
  listeners.forEach((fn) => fn(locale))
}

export function subscribe(fn: (next: Locale) => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Whether a catalog holds a source text, for the completeness check. */
export const has = (lang: Exclude<Locale, "zh-CN">, source: string) => Object.hasOwn(catalogs[lang], source)
