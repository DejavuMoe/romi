import { type Node } from "@/lib/api"

import { Nodes } from "./sections/nodes"
import { Ping } from "./sections/probes"
import { SettingsTab } from "./sections/settings"
import { Notify } from "./sections/notify"
import { Security } from "./sections/security"
import { Data } from "./sections/data"

// Each area is its own route rather than a tab, so a page can be linked to and a
// reload returns to the same section.
export function Admin({
  path,
  nodes,
  refresh,
  site,
  canProvision,
  distributionAvailable,
  onOpen,
}: {
  path: string
  nodes: Node[]
  refresh: () => void
  site: string
  canProvision: boolean
  distributionAvailable: boolean
  onOpen:(id:number)=>void
}) {
  return (
    <div className={`flex flex-col gap-5 ${["/admin/settings","/admin/data","/admin/security","/admin/notify"].includes(path) ? "settings-page" : ""}`}>
      <div className="min-w-0 flex-1">
        {path === "/admin/ping" ? (
          <Ping nodes={nodes} />
        ) : path === "/admin/notify" ? (
          <Notify nodes={nodes} refresh={refresh} />
        ) : path === "/admin/data" ? (
          <Data />

        ) : path === "/admin/security" ? (
          <Security />
        ) : path === "/admin/settings" ? (
          <SettingsTab />
        ) : (
          <Nodes onOpen={onOpen} nodes={nodes} refresh={refresh} site={site} canProvision={canProvision} distributionAvailable={distributionAvailable} />
        )}
      </div>
    </div>
  )
}
