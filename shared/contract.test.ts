import assert from "node:assert/strict"
import { api, ApiError } from "./http.ts"
import { bytes, monthUsage, continuousUptime } from "./format.ts"
import { usageTone } from "./usage.ts"

assert.deepEqual([null, undefined, NaN, 0, 59.9, 60, 84.9, 85, 100].map(usageTone),
  ["unknown", "unknown", "unknown", "normal", "normal", "warning", "warning", "critical", "critical"])

assert.deepEqual(["up", "down", "max", "sum"].map(traffic_mode =>
  monthUsage({ month_rx: 4, month_tx: 9, traffic_mode })), [9, 4, 9, 13])
assert.equal(bytes(0.5), "0 B")
assert.equal(bytes(1024), "1.00 KiB")
const originalFetch = globalThis.fetch
try {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "/api/nodes")
    assert.equal(new Headers(init?.headers).get("content-type"), "application/json")
    return new Response('{"id":1}', { status: 201 })
  }
  assert.deepEqual(await api("/nodes", { method: "POST", body: "{}" }), { id: 1 })
  globalThis.fetch = async () => new Response(null, { status: 204 })
  assert.equal(await api("/nodes/1", { method: "DELETE" }), undefined)
  globalThis.fetch = async () => new Response("登录已失效", { status: 401 })
  await assert.rejects(api("/nodes"), e => e instanceof ApiError && e.status === 401 && e.message === "登录已失效")
} finally {
  globalThis.fetch = originalFetch
}
console.log("shared HTTP and formatting contracts passed")

const {connectionLabel}=await import("./nodes.ts")
assert.equal(connectionLabel({online:false,last_seen:1000},1300),"重连中")
assert.equal(connectionLabel({online:false,last_seen:1000},1301),"离线")
assert.equal(connectionLabel({online:false,last_seen:0},1301),"未连接")

assert.equal(continuousUptime({online:false,last_seen:1000,online_since:900},1300),"等待恢复")
assert.equal(continuousUptime({online:false,last_seen:1000,online_since:900},1301),"已中断")
assert.equal(continuousUptime({online:true,last_seen:1000,online_since:1100},1000),"—")
