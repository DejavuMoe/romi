// Differential checks for the current formatter against an explicit local baseline.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as current from '../web/src/lib/format.ts'

if (!process.argv[2]) throw new Error('usage: node scripts/frontend_ablation.mjs <baseline-format.ts> [output.json]')
const baseline = await import(pathToFileURL(resolve(process.argv[2])).href)
const actualNow = Date.now
Date.now = () => Date.UTC(2026, 8, 22, 12)
let comparisons = 0
function compare(name, args) {
  assert.deepEqual(current[name](...args), baseline[name](...args), `${name}: ${JSON.stringify(args)}`)
  comparisons++
}
try {
  for (let i = 0; i < 10000; i++) {
    const n = i * 7919 / 10
    for (const name of ['bytes','axisBytes','rate','uptime']) compare(name,[n])
    compare('pair',[n,n*17]);compare('percent',[n,n*17])
    const from = Date.UTC(2026,0,1) + i*60000
    compare('timeTicks',[from,from+86400000+(i%7)*3600000])
    for (const hours of [1,24,25,168]) {
      assert.equal(current.clockFor(hours)(from),baseline.clockFor(hours)(from));comparisons++
    }
  }
  for (const value of [NaN,0,-1,0.5,Infinity,Number.MAX_SAFE_INTEGER]) {
    for (const name of ['bytes','axisBytes','rate']) compare(name,[value])
  }
  for (const value of [null,'','invalid','2026-09-21','2026-09-22','2026-09-23','2028-02-29']) compare('daysUntil',[value])
  for (const value of ['Debian GNU/Linux 12 (bookworm)','Alpine Linux','Test (x)','']) compare('osName',[value])
  for (const points of [[],[{ts:0}],[{ts:0},{ts:180}],[{ts:0,step:120},{ts:120,step:120}]]) compare('withHistoryGaps',[points])
} finally { Date.now = actualNow }
const report={comparisons,result:'equal',scope:'active formatting outputs; no runtime performance claim'}
if(process.argv[3])await writeFile(process.argv[3],JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify(report))
