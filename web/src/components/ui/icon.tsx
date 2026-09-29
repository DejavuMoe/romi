import type { CSSProperties } from "react"
import {
  Activity, ArrowDown, ArrowDownUp, ArrowLeft, ArrowUp, ArrowUpRight, Bell, Calendar, Check, ChevronDown, ChevronLeft,
  ChevronRight, ChevronUp, CircleAlert, CircleCheck, CircleX, Clock, Command, Copy, CopyCheck, Cpu, Database, Download,
  Ellipsis, ExternalLink, Eye, EyeOff, FileArchive, Gauge, Globe, HardDrive, History, Info, KeyRound, Keyboard, Languages,
  Laptop, LayoutGrid, Link2, List, LoaderCircle, Lock, LogOut, MapPin, MemoryStick, Menu, Monitor, Moon, Network, Pause,
  Pencil, Play, Plus, Power, Radar, RefreshCw, RotateCcw, Search, Send, Server, Settings, Shield, SlidersHorizontal,
  Smartphone, SquareTerminal, Sun, Sunrise, Sunset, Tag, Ticket, Timer, Trash2, TriangleAlert, Upload, User, Wallet,
  Webhook, WifiOff, Wrench, X, Zap, type LucideIcon,
} from "lucide-react"

import { cx } from "../../lib/hooks"

// The interface's whole icon set, by the Lucide names the design uses.
const ICONS = {
  activity: Activity, "arrow-down": ArrowDown, "arrow-down-up": ArrowDownUp, "arrow-left": ArrowLeft, "arrow-up": ArrowUp,
  "arrow-up-right": ArrowUpRight, bell: Bell, calendar: Calendar, check: Check, "chevron-down": ChevronDown,
  "chevron-left": ChevronLeft, "chevron-right": ChevronRight, "chevron-up": ChevronUp, "circle-alert": CircleAlert,
  "circle-check": CircleCheck, "circle-x": CircleX, clock: Clock, command: Command, copy: Copy, "copy-check": CopyCheck,
  cpu: Cpu, database: Database, download: Download, ellipsis: Ellipsis, "external-link": ExternalLink, eye: Eye,
  "eye-off": EyeOff, "file-archive": FileArchive, gauge: Gauge, globe: Globe, "hard-drive": HardDrive, history: History,
  info: Info, "key-round": KeyRound, keyboard: Keyboard, languages: Languages, laptop: Laptop, "layout-grid": LayoutGrid,
  "link-2": Link2, list: List, "loader-circle": LoaderCircle, lock: Lock, "log-out": LogOut, "map-pin": MapPin,
  "memory-stick": MemoryStick, menu: Menu, monitor: Monitor, moon: Moon, network: Network, pause: Pause, pencil: Pencil,
  play: Play, plus: Plus, power: Power, radar: Radar, "refresh-cw": RefreshCw, "rotate-ccw": RotateCcw, search: Search,
  send: Send, server: Server, settings: Settings, shield: Shield, "sliders-horizontal": SlidersHorizontal,
  smartphone: Smartphone, "square-terminal": SquareTerminal, sun: Sun, sunrise: Sunrise, sunset: Sunset, tag: Tag,
  ticket: Ticket, timer: Timer, "trash-2": Trash2, "triangle-alert": TriangleAlert, upload: Upload, user: User,
  wallet: Wallet, webhook: Webhook, "wifi-off": WifiOff, wrench: Wrench, x: X, zap: Zap,
} satisfies Record<string, LucideIcon>

export type IconName = keyof typeof ICONS

export function Icon({ name, size = 16, className, style }: { name: IconName; size?: number; className?: string; style?: CSSProperties }) {
  const Glyph = ICONS[name]
  return <Glyph className={cx("icon", className)} size={size} strokeWidth={2} aria-hidden="true" focusable="false" style={style} />
}
