// Holds the v15 stylesheets to one scale. Every font size, weight, line height,
// radius, duration and easing must come from the tokens in styles.css, spacing
// must sit on the 2 px grid below 16 px and the 4 px grid above, and colours
// must be tokens outside the blocks that define them.
//
//   node designs/romi-next/revision-v15/tools/css-scale.cjs
//
// Exits 1 and lists each offending declaration when anything is off the scale.
const fs = require("node:fs")
const path = require("node:path")

const DIR = path.resolve(__dirname, "..")
const FILES = ["styles.css", "pages.css", "admin.css", "system.css"]
const JSX = fs.readdirSync(DIR).filter((f) => f.endsWith(".jsx"))

const WEIGHTS = new Set(["400", "500", "600", "700", "inherit"])
const EM_SIZES = new Set(["0.75em", "0.92em", "1em", "inherit"])
const LINE = new Set(["1", "var(--lh-tight)", "var(--lh-snug)", "var(--lh-base)", "var(--lh-loose)", "inherit", "normal"])
const ICONS = new Set([12, 14, 16, 20, 24])
const onGrid = (n) => n === 0 || (Math.abs(n) < 16 ? n % 2 === 0 : n % 4 === 0)

// Declarations inside rules, with the selector they belong to and the line.
function declarations(css) {
  const out = []
  const stack = []
  let buf = ""
  let line = 1
  let startLine = 1
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2)
      line += (css.slice(i, end).match(/\n/g) || []).length
      i = end + 1
      continue
    }
    if (ch === "\n") line++
    if (ch === "{") {
      stack.push(buf.trim())
      buf = ""
      startLine = line
    } else if (ch === "}") {
      if (buf.trim()) out.push({ selector: stack[stack.length - 1], decl: buf.trim(), line: startLine, stack: [...stack] })
      stack.pop()
      buf = ""
    } else if (ch === ";") {
      if (buf.trim()) out.push({ selector: stack[stack.length - 1], decl: buf.trim(), line, stack: [...stack] })
      buf = ""
      startLine = line
    } else buf += ch
  }
  return out
}

const problems = []
const flag = (file, line, decl, why) => problems.push(`${file}:${line}  ${decl}  — ${why}`)

for (const file of FILES) {
  const css = fs.readFileSync(path.join(DIR, file), "utf8")
  for (const { selector, decl, line, stack } of declarations(css)) {
    const colon = decl.indexOf(":")
    if (colon < 0) continue
    const prop = decl.slice(0, colon).trim()
    const value = decl.slice(colon + 1).trim().replace(/\s*!important$/, "")
    const inTokens = stack.some((s) => /^(:root|\[data-theme="(light|dark)"\]|:root,\s*\[data-theme="light"\])/.test(s))
    if (prop.startsWith("--")) continue
    if (prop === "font-size" && !/^var\(--fs-[a-z0-9]+\)$/.test(value) && !EM_SIZES.has(value)) flag(file, line, decl, "font size off the type scale")
    if (prop === "font-weight" && !WEIGHTS.has(value)) flag(file, line, decl, "weight must be 400, 500, 600 or 700")
    if (prop === "line-height" && !LINE.has(value)) flag(file, line, decl, "line height must be a --lh token")
    if (/^(margin|padding|gap|row-gap|column-gap|inset)(-|$)/.test(prop)) {
      for (const m of value.matchAll(/(-?\d*\.?\d+)px/g)) if (!onGrid(Number(m[1]))) flag(file, line, decl, `${m[0]} is off the spacing grid`)
    }
    if (/^border(-[a-z]+)*-radius$/.test(prop)) {
      const parts = value.replace(/var\(--r-[a-z]+\)/g, "R").replace(/calc\(R( [-+] R)*\)/g, "R").split(/\s+/)
      if (parts.some((p) => !/^(R|0|50%|inherit)$/.test(p))) flag(file, line, decl, "radius must be an --r token")
    }
    if (/^(transition|animation)(-duration)?$/.test(prop) && /(^|[\s,])\d*\.?\d+m?s\b/.test(value.replace(/var\([^)]*\)/g, ""))) flag(file, line, decl, "duration must be a --t token")
    if (prop === "animation-delay" && !/^(var\(--t[a-z-]*\)|calc\(.*var\(--t[a-z-]*\).*\)|0)$/.test(value)) flag(file, line, decl, "delay must be built from --t tokens")
    if (/^(transition|animation)(-timing-function)?$/.test(prop) && /cubic-bezier|steps\(/.test(value)) flag(file, line, decl, "easing must be an --ease token")
    if (!inTokens && /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(\s*\d/i.test(value)) flag(file, line, decl, "colour must be a token")
  }
}

// Icons come in five sizes.
for (const file of JSX) {
  const src = fs.readFileSync(path.join(DIR, file), "utf8")
  src.split("\n").forEach((text, i) => {
    for (const m of text.matchAll(/<Icon\b[^>]*\bsize=\{(\d+)\}/g)) if (!ICONS.has(Number(m[1]))) flag(file, i + 1, m[0], "icon size must be 12, 14, 16, 20 or 24")
  })
}

if (problems.length) {
  console.log(problems.join("\n"))
  console.log(`\n${problems.length} declarations off the scale.`)
  process.exit(1)
}
console.log(`scale passed: ${FILES.join(", ")} and ${JSX.length} JSX files.`)
