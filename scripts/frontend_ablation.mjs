// Windows owns Git reads; this experiment writes only temporary comparison files.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as shared from '../shared/format.ts'

const scratch = await mkdtemp(join(tmpdir(), 'romi-format-'))
try {
  const modules = {}
  for (const app of ['admin', 'web']) {
    const path = join(scratch, `${app}.mts`)
    await writeFile(path, execFileSync('git', ['show', `v0.0.1:${app}/src/lib/format.ts`]))
    modules[app] = await import(pathToFileURL(path).href)
  }
  let comparisons = 0
  for (let i = 0; i < 10_000; i++) {
    const n = i * 7919 / 10
    for (const name of ['bytes', 'uptime']) {
      for (const original of Object.values(modules)) {
        assert.equal(shared[name](n), original[name](n))
        comparisons++
      }
    }
    for (const mode of ['up', 'down', 'max', 'sum']) {
      const node = { month_rx: i * 11, month_tx: i * 29, traffic_mode: mode }
      assert.equal(shared.monthUsage(node), modules.admin.monthUsage(node))
      comparisons++
    }
  }
  const paths = ['admin/src/lib/api.ts', 'admin/src/lib/format.ts', 'web/src/lib/api.ts',
    'web/src/lib/format.ts', 'web/src/components/NodeCard.tsx']
  const lines = text => text.trimEnd().split(/\r?\n/).length
  const before = paths.reduce((n, p) => n + lines(execFileSync('git', ['show', `v0.0.1:${p}`], { encoding: 'utf8' })), 0)
  let after = 0
  for (const p of [...paths, 'shared/nodes.ts', 'shared/http.ts', 'shared/format.ts']) after += lines(await readFile(p, 'utf8'))
  // Negative control: removing billing-mode selection is smaller but incorrect.
  const node = { month_rx: 4, month_tx: 9 }
  const rejected = ['up', 'down', 'max', 'sum'].filter(traffic_mode =>
    node.month_rx + node.month_tx !== shared.monthUsage({ ...node, traffic_mode }))
  assert.equal(rejected.length, 3)
  const result = { baseline: 'v0.0.1', comparisons, before_lines: before, after_lines: after,
    decision: 'keep shared implementation; reject sum-only billing', rejected_billing_modes: rejected,
    measurement: 'source duplication ablation and differential output checks; no runtime speedup claim' }
  if (process.argv[2]) await writeFile(resolve(process.argv[2]), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
} finally {
  assert.ok(resolve(scratch).startsWith(resolve(tmpdir()) + sep + 'romi-format-'))
  await rm(scratch, { recursive: true })
}
