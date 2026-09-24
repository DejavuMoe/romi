import { useEffect, useState } from "react"

import type { Node } from "../../../shared/nodes.ts"
import { api, ApiError } from "../../../shared/http.ts"
export type { Node, Metrics } from "../../../shared/nodes.ts"
export { api, ApiError } from "../../../shared/http.ts"

export type PingTask = { id: number; name: string; target: string; interval: number; nodes: number[] }

/** Form snapshots must never overwrite fields the user did not edit. */
export function changes<T extends object>(initial: T, values: Partial<T>): Partial<T> {
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== initial[key as keyof T])) as Partial<T>
}

export const GIB = 1024 ** 3

/**
 * The traffic fields as a `TrafficPatch`: GB entered by hand, bytes on the wire,
 * and only the counters actually given a value.
 *
 * An emptied field means the counter is left unchanged rather than set to zero.
 * The patch is entirely `Option` and `set_traffic` COALESCEs, so omitting the key
 * expresses that; sending 0 would clear a lifetime total, the one figure that may
 * never decrease and that nothing can recompute. Zeroing deliberately remains one
 * keystroke away.
 */
export function trafficCorrection(
  pristine: Record<string, string>,
  typed: Record<string, string>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(changes(pristine, typed))
      .filter(([, value]) => String(value).trim() !== "")
      .map(([key, value]) => [key, Math.round(Number(value) * GIB)]),
  )
}

/** Private, carrier-grade NAT, loopback or link-local: unreachable from outside the machine's own network. */
function isLocalV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number)
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254)
}

/**
 * The addresses shown for a node. The agent reports its interfaces; `ip` is
 * where its connection arrived from, which the hub canonicalizes to dotted form
 * for IPv4. Behind NAT the interface holds only a private IPv4 while the
 * connection arrives from the public one, so that address leads. `ip` alone is
 * also the fallback for an agent too old to report its interfaces.
 */
export function addresses(node: Pick<Node, "ip" | "ipv4" | "ipv6">): string[] {
  const reported = [node.ipv4, node.ipv6].filter(Boolean) as string[]
  const { ip } = node
  if (!ip) return reported
  if (node.ipv4 && isLocalV4(node.ipv4) && ip.includes(".") && !isLocalV4(ip)) return [ip, ...reported]
  return reported.length ? reported : [ip]
}

/** Installation commands require a TLS origin with a domain, never an IP. */
export function provisioningSite(site: string): string {
  try {
    const u = new URL(site)
    return u.protocol === "https:" && !u.hostname.startsWith("[") && !/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)
      && u.hostname !== "localhost" && !u.hostname.endsWith(".localhost") && !u.username && !u.password
      && u.pathname === "/" && !u.search && !u.hash ? u.origin : ""
  } catch {
    return ""
  }
}

/**
 * 4 MiB: the only size a reverse proxy must pass, whatever the file behind it
 * weighs. The hub accepts up to 8 MiB per request, so this can change without
 * touching the server or negotiating first.
 */
const CHUNK = 4 * 1024 * 1024

/**
 * Uploads a file one chunk at a time. There is no upload id: the hub tracks an
 * upload by the length of what it has already written, so a chunk states only
 * where it begins. The last one carries the result.
 */
export async function upload<T>(
  path: string,
  file: File,
  onProgress?: (sent: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  if (file.size === 0) throw new ApiError(400, "文件是空的")
  let last: Response | null = null
  for (let offset = 0; offset < file.size; offset += CHUNK) {
    // A chunk boundary is a genuine stopping point: the hub applies nothing until
    // the last piece lands, and `offset = 0` truncates whatever an abandoned
    // attempt left behind, so aborting here leaves the state unchanged.
    if (signal?.aborted) throw new DOMException("aborted", "AbortError")
    const res = await fetch(`/api${path}?offset=${offset}&total=${file.size}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: file.slice(offset, offset + CHUNK),
      signal,
    })
    if (!res.ok) {
      // A 413 never reached the hub: the proxy in front answered, and only its
      // own logs record it. The message names the setting responsible.
      throw new ApiError(
        res.status,
        res.status === 413
          ? "反向代理拒收了 4 MiB 的分片，把 nginx 的 client_max_body_size 调到 8m"
          : (await res.text()) || res.statusText,
      )
    }
    last = res
    onProgress?.(Math.min(offset + CHUNK, file.size))
  }
  return last!.json()
}

/**
 * Live node list. Uses the WebSocket the hub pushes every two seconds, falling
 * back to polling if it cannot be established.
 */
export function useNodes() {
  const [nodes, setNodes] = useState<Node[] | null>(null)
  // null until a frame reports it. The panel treats an explicit false as the
  // session no longer being an admin one, so an unanswered first fetch must not
  // read as that; see App.tsx.
  const [admin, setAdmin] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let socket: WebSocket | null = null
    let poll: ReturnType<typeof setInterval> | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let closed = false

    // A 401 is an answer, not an outage. Signed out with the public page off --
    // which is the default, and therefore the state the login screen is normally
    // in -- retrying would ask the same refused question every five seconds and
    // reopen the stream forever behind an unattended login form. Retrying is
    // what covers an unreachable hub; it cannot make a refusal succeed.
    const stop = () => {
      closed = true
      socket?.close()
      socket = null
      if (poll) {
        clearInterval(poll)
        poll = null
      }
      if (retry) {
        clearTimeout(retry)
        retry = null
      }
    }

    const fetchOnce = () =>
      api<{ nodes: Node[]; admin: boolean }>("/nodes")
        .then((d) => {
          setNodes(d.nodes)
          setAdmin(d.admin)
          setError(null)
        })
        .catch((e: Error) => {
          setError(e.message)
          // With the public page switched off, a revoked session receives a 401
          // here and on the stream, so the frame that would report admin=false
          // never arrives and the panel would retain the list it already had.
          if (e instanceof ApiError && e.status === 401) {
            setAdmin(false)
            stop()
          }
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
        const frame = JSON.parse(event.data)
        setNodes(frame.nodes)
        setAdmin(frame.admin)
        setError(null)
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

    return stop
  }, [reload])

  // `refresh` is also how the panel resumes after signing in: the effect reruns,
  // which is what restarts a stream stopped by the 401 above.
  return { nodes, admin, error, refresh: () => setReload((n) => n + 1) }
}


/** POSIX shell quoting for user-configured URLs and one-time credentials. */
export const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

export function agentCommand(site: string, seconds: number) {
  site = provisioningSite(site)
  if (!site) return ""
  if (!Number.isInteger(seconds) || seconds<3 || seconds>60) return ""
  const interval = seconds
  // The permanent token is deliberately absent here. The downloaded installer
  // prompts for it on the node, so it stays out of shell history and argv.
  // mktemp avoids a predictable file name in a shared working directory.
  return `tmp=$(mktemp) && trap 'rm -f "$tmp"' EXIT && curl -fsSL ${shellQuote(site + "/install.sh")} -o "$tmp" && sudo sh "$tmp" --server ${shellQuote(site)} --interval ${interval}`
}

export function registrationCommand(site: string, key: string) {
  site = provisioningSite(site)
  if (!site) return ""
  // The registration key is short-lived and exchanged once; batch automation
  // may place it in the command, unlike the permanent node token.
  return `tmp=$(mktemp) && trap 'rm -f "$tmp"' EXIT && curl -fsSL ${shellQuote(site + "/install.sh")} -o "$tmp" && sudo sh "$tmp" --server ${shellQuote(site)} --register-key ${shellQuote(key)}`
}
