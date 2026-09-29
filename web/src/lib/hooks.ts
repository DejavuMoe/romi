import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"
import { flushSync } from "react-dom"

import { getLocale, subscribe } from "../../../shared/i18n.ts"

export const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches

export const cx = (...parts: unknown[]) => parts.filter(Boolean).join(" ")

/** The page language, re-rendering its caller when it changes. */
export function useLocale() {
  const [locale, setLocale] = useState(getLocale)
  useEffect(() => subscribe(setLocale), [])
  return locale
}

export type Theme = "light" | "dark"

/**
 * The theme, stored per browser. Written on the toggle rather than on every
 * render: storing the resolved value at mount pins whatever the system preferred
 * at the first visit, and a visitor who never touched the switch would stop
 * following their own system. Where the browser can, the new theme is drawn
 * outward from the button that asked for it.
 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem("theme")
    return saved ? (saved === "dark" ? "dark" : "light") : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  })
  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark")
  }, [theme])
  const toggle = (event?: { currentTarget: EventTarget | null }) => {
    const next: Theme = theme === "dark" ? "light" : "dark"
    localStorage.setItem("theme", next)
    if (!document.startViewTransition || reduceMotion()) return setTheme(next)
    const r = event?.currentTarget instanceof Element ? event.currentTarget.getBoundingClientRect() : null
    const x = r ? r.left + r.width / 2 : innerWidth - 40
    const y = r ? r.top + r.height / 2 : 28
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))
    const root = document.documentElement
    root.classList.add("theme-transition")
    const vt = document.startViewTransition(() => flushSync(() => setTheme(next)))
    vt.ready.then(() => {
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 620, easing: "cubic-bezier(.2,.7,.2,1)", pseudoElement: "::view-transition-new(root)" },
      )
    }, () => {})
    vt.finished.finally(() => root.classList.remove("theme-transition"))
  }
  return [theme, toggle] as const
}

export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

/** An element's content width, following it as it resizes. */
export function useWidth(ref: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)))
    ro.observe(el)
    setWidth(Math.round(el.getBoundingClientRect().width))
    return () => ro.disconnect()
  }, [ref])
  return width
}

/** A page-wide shortcut; `typing` says whether a field holds the focus. */
export function useHotkey(match: (e: KeyboardEvent, typing: boolean) => boolean, handler: (e: KeyboardEvent) => void) {
  const latest = useRef({ match, handler })
  useLayoutEffect(() => {
    latest.current = { match, handler }
  })
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable
      if (latest.current.match(e, typing)) {
        e.preventDefault()
        latest.current.handler(e)
      }
    }
    addEventListener("keydown", on)
    return () => removeEventListener("keydown", on)
  }, [])
}

/** Page transitions share elements by name where the browser can. */
export function transition(update: () => void) {
  if (!document.startViewTransition || reduceMotion()) return update()
  document.startViewTransition(() => flushSync(update))
}
