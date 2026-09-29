import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

import { en } from "./locale-en.ts"
import { T, setLocale } from "./i18n.ts"

// Every text the interface passes to T() as a literal has an English entry, and
// every entry keeps the placeholders of its source, so switching the language
// never leaves Chinese on the page or drops a figure from a sentence.
const root = join(import.meta.dirname, "..")
const files: string[] = []
const walk = (dir: string) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts") && entry.name !== "locale-en.ts") files.push(path)
  }
}
for (const dir of ["shared", "web/src", "admin/src"]) walk(join(root, dir))

const missing: string[] = []
const used = new Set<string>()
for (const file of files) {
  const source = readFileSync(file, "utf8")
  for (const match of source.matchAll(/\bT\(\s*"((?:[^"\\]|\\.)*)"/g)) {
    const key = JSON.parse(`"${match[1]}"`) as string
    used.add(key)
    if (/[一-鿿]/.test(key) && !Object.hasOwn(en, key)) missing.push(`${relative(root, file)}: ${key}`)
  }
}
assert.deepEqual(missing, [], "texts without an English entry")

const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
const mismatched = Object.entries(en).flatMap(([source, entry]) => {
  const want = holes(source.replace(/#[a-z-]+$/, "")).filter((name, i, all) => all.indexOf(name) === i)
  const forms = typeof entry === "string" ? [entry] : [entry.one, entry.other].filter((v): v is string => !!v)
  return forms
    .filter((form) => {
      const got = holes(form).filter((name, i, all) => all.indexOf(name) === i)
      // A singular may spell the count out ("Every day" for "每 {n} 天").
      return got.some((name) => !want.includes(name)) || (form === forms[forms.length - 1] && want.some((name) => !got.includes(name)))
    })
    .map(() => source)
})
assert.deepEqual(mismatched, [], "entries whose placeholders differ from their source")

// Plural forms follow the count; a missing entry falls back to the source.
setLocale("en")
assert.equal(T("{n} 个节点", { n: 1 }), "1 node")
assert.equal(T("{n} 个节点", { n: 3 }), "3 nodes")
assert.equal(T("没有这条"), "没有这条")
setLocale("zh-CN")
assert.equal(T("{n} 个节点", { n: 3 }), "3 个节点")
console.log(`i18n: ${used.size} texts in ${files.length} files have English entries`)
