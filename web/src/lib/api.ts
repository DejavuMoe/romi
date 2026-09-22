import { useEffect, useState } from "react"

import type { Node } from "../../../shared/nodes.ts"
import { api, ApiError } from "../../../shared/http.ts"
export type { Node, Metrics } from "../../../shared/nodes.ts"
export { api, ApiError } from "../../../shared/http.ts"

/**
 * Fleet throughput, one sample per push. Held beside the stream that feeds it
 * rather than in the tile that draws it: the summary unmounts while a node page is
 * open, so a buffer held there would restart empty on every return. Two minutes at
 * the hub's push interval.
 */
const KEEP = 60
export const speedHistory: { rx: number; tx: number }[] = []

function sample(nodes: Node[]) {
  const live = nodes.filter((n) => n.online && n.metrics)
  speedHistory.push({
    rx: live.reduce((s, n) => s + n.metrics!.net_rx, 0),
    tx: live.reduce((s, n) => s + n.metrics!.net_tx, 0),
  })
  if (speedHistory.length > KEEP) speedHistory.shift()
}

/** A malformed report must not remove every other node from the page. */
export function safeNodes(nodes: Node[]): Node[] {
  const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0
  const fields = ["uptime", "cpu", "mem_total", "mem_used", "swap_total", "swap_used", "disk_total", "disk_used",
    "net_rx", "net_tx", "total_rx", "total_tx", "month_rx", "month_tx", "tcp", "udp", "procs"] as const
  return nodes.map((node) => {
    const m = node.metrics
    return !m || (fields.every((key) => number(m[key])) && Array.isArray(m.load) && m.load.length === 3 && m.load.every(number))
      ? node : { ...node, metrics: null }
  })
}

/**
 * Live node list. Uses the WebSocket the hub pushes every two seconds, falling
 * back to polling if it cannot be established.
 */
export function useNodes() {
  const [nodes, setNodes] = useState<Node[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Set when the hub answers 401: the status page has been closed to anonymous
  // callers since this tab loaded. The hub also ends the stream, so this surfaces
  // on the fallback fetch the reconnect starts; a close allows a client to
  // re-query its state but cannot compel it.
  const [closed, setClosed] = useState(false)

  useEffect(() => {
    let socket: WebSocket | null = null
    let poll: ReturnType<typeof setInterval> | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let closed = false

    const receive = (list: Node[]) => {
      const safe = safeNodes(list)
      sample(safe)
      setNodes(safe)
      setError(null)
      setClosed(false)
    }

    const fetchOnce = () =>
      api<{ nodes: Node[] }>("/nodes")
        .then((d) => receive(d.nodes))
        .catch((e: Error) => {
          setError(e.message)
          if (e instanceof ApiError && e.status === 401) setClosed(true)
        })

    fetchOnce()

    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`
    // A hub restart closes every stream. Without reconnecting, a page that
    // outlives a deploy would remain on the fallback poll for the rest of its
    // life, refreshing at a fifth of the live rate with no indication.
    const connect = () => {
      try {
        socket = new WebSocket(url)
      } catch {
        poll ??= setInterval(fetchOnce, 5000)
        return
      }
      socket.onmessage = (event) => {
        receive(JSON.parse(event.data).nodes)
        // The stream has returned; the poll was only covering for it.
        if (poll) {
          clearInterval(poll)
          poll = null
        }
      }
      socket.onerror = () => socket?.close()
      socket.onclose = () => {
        if (closed) return
        poll ??= setInterval(fetchOnce, 5000)
        retry = setTimeout(connect, 5000)
      }
    }
    connect()

    return () => {
      closed = true
      socket?.close()
      if (poll) clearInterval(poll)
      if (retry) clearTimeout(retry)
    }
  }, [])

  return { nodes, error, closed }
}
