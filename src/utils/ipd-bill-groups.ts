// 住院帳單明細的分類（住院結帳畫面、費用明細表共用）：依 ChargeLine.kind 分組，各組小計健保點數與病人付。
// 急診收住院的那一段（名稱開頭「急診：」）單獨一組放最前面，不和住院的混在一起
import type { ChargeLine } from '@/types'

const isEr = (l: ChargeLine) => l.name.startsWith('急診：')
const isMeal = (l: ChargeLine) => l.name.startsWith('伙食費')
const special = (l: ChargeLine) => isEr(l) || isMeal(l)

export const IPD_BILL_GROUPS: { label: string; kinds: ChargeLine['kind'][]; match?: (l: ChargeLine) => boolean }[] = [
  { label: '急診（收住院前：急診與留觀）', kinds: [], match: isEr },
  { label: '病房、護理、診察（每日）', kinds: ['ward'] },
  { label: '藥費', kinds: ['drug'] },
  { label: '檢驗、處置、影像', kinds: ['procedure'] },
  { label: '伙食費（自費，依每天的飲食醫囑）', kinds: [], match: isMeal },
  { label: '自費（差額床費、自費項目）', kinds: ['self'] },
  { label: '部分負擔', kinds: ['copay-ipd'] },
]

export const groupIpdLines = (lines: ChargeLine[]) =>
  IPD_BILL_GROUPS.map((g) => ({ ...g, lines: lines.filter((l) => (g.match ? g.match(l) : !special(l) && g.kinds.includes(l.kind))) })).filter((g) => g.lines.length)

export const sumLines = (ls: ChargeLine[]) => Math.round(ls.reduce((n, l) => n + l.amount, 0))
