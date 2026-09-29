// The page's scrollbar gutter, measured while nothing holds the page. A dialog
// turns it into padding of the same width (styles/theme.css), so the scrim
// covers the whole window and nothing behind it moves. Measured from the root's
// box rather than clientWidth: a gutter reserved by `scrollbar-gutter: stable`
// with no scrollbar drawn in it still narrows the page, and clientWidth then
// reports the full window.
function measureGutter() {
  const root = document.documentElement
  if (document.body?.hasAttribute("data-scroll-locked")) return
  root.style.setProperty("--gutter-w", `${Math.max(0, innerWidth - root.getBoundingClientRect().width)}px`)
}

export function watchGutter() {
  addEventListener("resize", measureGutter)
  // Again once the stylesheet has surely applied.
  addEventListener("load", measureGutter, { once: true })
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", measureGutter, { once: true })
  else measureGutter()
}
