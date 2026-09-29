import type { ReactNode } from "react"
import { Dialog as D } from "radix-ui"

import { T } from "../../../../shared/i18n.ts"
import { cx } from "../../lib/hooks"
import { Button, IconButton } from "./controls"

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

export type DialogProps = {
  title?: ReactNode
  subtitle?: ReactNode
  onClose: () => void
  children?: ReactNode
  footer?: ReactNode
  size?: "sm" | "md" | "lg" | "palette"
  kind?: "center" | "sheet" | "drawer"
  className?: string
  /** Replaces the title block; it must then carry its own Dialog title. */
  head?: ReactNode
  /** A row between the head and the body that does not scroll, such as tabs. */
  bar?: ReactNode
  /** Focus the dialog itself rather than its first control. */
  focusPanel?: boolean
  label?: string
}

/**
 * Head, an optional bar and the foot stay put; only the body scrolls, and every
 * row keeps the same scrollbar gutter, so the surface never changes size or
 * shifts as its content grows or shrinks. Focus stays inside, Escape and the
 * scrim close it, and focus returns to what opened it.
 */
export function Dialog({ title, subtitle, onClose, children, footer, size = "md", kind = "center", className, head, bar, focusPanel, label }: DialogProps) {
  return (
    <D.Root open onOpenChange={(open) => !open && onClose()}>
      <D.Portal>
        <D.Overlay className={cx("overlay", `overlay-${kind}`)}>
          <D.Content
            className={cx("dialog", `dialog-${kind}`, `dialog-${size}`, className)}
            aria-describedby={undefined}
            aria-label={label}
            onOpenAutoFocus={(e) => {
              const panel = e.currentTarget as HTMLElement
              const first = focusPanel ? panel : panel.querySelector<HTMLElement>("[data-autofocus]") || panel.querySelector<HTMLElement>(FOCUSABLE)
              e.preventDefault()
              requestAnimationFrame(() => (first || panel).focus())
            }}
          >
            <div className="dialog-head">
              {head || (
                <div className="dialog-titles">
                  <D.Title>{title}</D.Title>
                  {subtitle && <p className="dialog-subtitle">{subtitle}</p>}
                </div>
              )}
              <D.Close asChild>
                <IconButton label={T("关闭")} icon="x" className="dialog-close" tip="left" />
              </D.Close>
            </div>
            {bar && <div className="dialog-bar">{bar}</div>}
            <div className="dialog-body">{children}</div>
            {footer && <div className="dialog-foot">{footer}</div>}
          </D.Content>
        </D.Overlay>
      </D.Portal>
    </D.Root>
  )
}

/** The title element for a dialog whose head is custom. */
export const DialogTitle = D.Title

export function Confirm({ title, detail, confirmLabel, danger = true, onConfirm, onClose, busy, children }: {
  title: ReactNode
  detail?: ReactNode
  confirmLabel?: ReactNode
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
  busy?: boolean
  children?: ReactNode
}) {
  return (
    <Dialog
      title={title}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} data-autofocus>{T("取消")}</Button>
          <Button kind={danger ? "danger" : "primary"} busy={busy} onClick={onConfirm}>{confirmLabel ?? T("确认")}</Button>
        </>
      }
    >
      {detail && <p className="confirm-detail">{detail}</p>}
      {children}
    </Dialog>
  )
}
