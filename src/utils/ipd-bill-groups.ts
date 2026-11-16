// 住院帳單明細的分類（住院結帳畫面、費用明細表共用）：依 ChargeLine.kind 分組，各組小計健保點數與病人付
import type { ChargeLine } from '@/types'

export const IPD_BILL_GROUPS: { label: string; kinds: ChargeLine['kind'][] }[] = [
  { label: '病房、護理、診察（每日）', kinds: ['ward'] },
  { label: '藥費', kinds: ['drug'] },
  { label: '檢驗、處置、影像', kinds: ['procedure'] },
  { label: '自費（差額床費、自費項目）', kinds: ['self'] },
  { label: '部分負擔', kinds: ['copay-ipd'] },
]

export const groupIpdLines = (lines: ChargeLine[]) =>
  IPD_BILL_GROUPS.map((g) => ({ ...g, lines: lines.filter((l) => g.kinds.includes(l.kind)) })).filter((g) => g.lines.length)

export const sumLines = (ls: ChargeLine[]) => Math.round(ls.reduce((n, l) => n + l.amount, 0))
