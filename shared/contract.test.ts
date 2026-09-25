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

// The probe interval's wording, as the approved prototype states it.
{
  const { numericError } = await import("./validate.ts")
  const interval = (raw: string) => numericError(raw, { min: 5, max: 3600, required: true })
  assert.deepEqual(["", "0", "4", "5", "3600", "3601", "5.5", "-5", "1e3"].map(interval), [
    "请填写此项", "不能小于 5", "不能小于 5", "", "", "不能大于 3600", "请输入非负整数", "请输入非负整数", "请输入非负整数",
  ])
  assert.equal(numericError("", { required: false }), "")
  assert.equal(numericError("0.25", { step: 0.5 }), "请按 0.5 的步长填写")
}
