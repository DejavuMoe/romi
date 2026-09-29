// Interface language. The Chinese text is the source and the key; the English
// catalog (locale-en.js) maps it. Plain script, loaded before everything else.
(function () {
  const STORE = "romi-v15-lang"
  const pick = (v) => (!v ? null : /^en/i.test(v) ? "en" : /^zh/i.test(v) ? "zh-CN" : null)
  const params = new URLSearchParams(location.search)
  let locale = pick(params.get("lang")) || pick(localStorage.getItem(STORE)) || pick(navigator.language) || "zh-CN"
  const catalogs = { en: {} }
  const listeners = new Set()
  const plural = { en: new Intl.PluralRules("en") }

  // T("{n} 个节点", { n: 3 }): the entry for the current language, then the
  // source; a {one, other} entry is chosen by the count in `n`. A "#word"
  // suffix tells apart one Chinese text with two meanings ("关闭#off") and is
  // not shown.
  function T(source, vars) {
    const bare = source.replace(/#[a-z-]+$/, "")
    let text = locale === "zh-CN" ? bare : catalogs[locale][source] ?? bare
    if (text && typeof text === "object") text = text[plural[locale].select(Number(vars && vars.n) || 0)] ?? text.other
    if (vars) text = text.replace(/\{(\w+)\}/g, (all, key) => (key in vars ? String(vars[key]) : all))
    return locale === "zh-CN" ? text : text.replace(/ {2,}/g, " ")
  }

  function apply() {
    document.documentElement.lang = locale
  }
  function setLocale(next) {
    next = pick(next) || "zh-CN"
    if (next === locale) return
    locale = next
    localStorage.setItem(STORE, locale)
    const url = new URL(location.href)
    if (url.searchParams.has("lang")) {
      url.searchParams.set("lang", locale)
      history.replaceState(history.state, "", url)
    }
    apply()
    listeners.forEach((fn) => fn(locale))
  }
  apply()

  window.romiI18n = {
    get locale() {
      return locale
    },
    // BCP 47 tag for Intl formatters.
    get intl() {
      return locale === "en" ? "en-US" : "zh-CN"
    },
    setLocale,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    define(lang, entries) {
      Object.assign(catalogs[lang], entries)
    },
    has: (lang, source) => Object.prototype.hasOwnProperty.call(catalogs[lang] || {}, source),
    catalog: (lang) => catalogs[lang],
  }
  window.T = T
})()
