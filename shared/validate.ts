import { T } from "./i18n.ts"

/**
 * The message a numeric field shows for what was typed, or "" when it is
 * acceptable. The same rule and wording as the approved prototype's numeric
 * fields, so a refusal reads the same in the panel as it was reviewed, and
 * arrives before a round trip rather than as the hub's English error.
 *
 * `raw` is the text in the box, not a number: an emptied box is "", which must
 * read as missing rather than as 0.
 */
export function numericError(
  raw: string,
  { min = 0, max = Infinity, step = 1, required = false }: { min?: number; max?: number; step?: number | "any"; required?: boolean } = {},
): string {
  if (raw === "") return required ? T("请填写此项") : ""
  const integer = step === 1
  if (!(integer ? /^\d+$/ : /^(?:\d+(?:\.\d*)?|\.\d+)$/).test(raw)) return integer ? T("请输入非负整数") : T("请输入非负数")
  const n = Number(raw)
  if (!Number.isFinite(n)) return T("数值过大")
  if (n < min) return T("不能小于 {min}", { min })
  if (n > max) return T("不能大于 {max}", { max })
  if (step !== "any" && Math.abs((n - min) / step - Math.round((n - min) / step)) > 1e-7) return T("请按 {step} 的步长填写", { step })
  return ""
}
