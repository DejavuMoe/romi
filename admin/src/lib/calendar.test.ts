import assert from "node:assert/strict"
import { dateKey, parseDate } from "./calendar.ts"

assert.equal(parseDate("2025-02-29"), null)
assert.equal(parseDate("2026-04-31"), null)
assert.equal(parseDate("2026-13-01"), null)
assert.equal(parseDate("2026-2-3"), null)
assert.equal(parseDate("0000-01-01"), null)
assert.equal(dateKey(parseDate("2024-02-29")!), "2024-02-29")
assert.equal(dateKey(parseDate("0099-12-31")!), "0099-12-31")
console.log("calendar date validation and month boundaries passed")
