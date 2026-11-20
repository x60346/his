// 器械包與滅菌（純函式）：包的種類、效期、生物指示劑（BI）判讀、能不能用在這台手術、召回。
// 服務層（sterile.ts、surgery.ts finishSurgery）、手術室「器械滅菌」分頁、手術視窗、首頁待辦、種子、測試都用這一份
import type { InstrumentPack, PackSet, SterileBatch } from '@/types'
import { addDays, addMinutes } from '@/utils/date'

export const PACK_SET_LABEL: Record<PackSet, string> = { basic: '基本手術包', lap: '腹腔鏡器械包', ortho: '骨科器械包', minor: '小手術包' }
export const PACK_SETS = Object.keys(PACK_SET_LABEL) as PackSet[]
/** 滅菌後幾天有效（含滅菌當天算第 0 天，第 30 天是最後一天） */
export const PACK_VALID_DAYS = 30
/** 生物指示劑培養多久可以判讀 */
export const BI_HOURS = 24
/** 幾天內到期算「快到期」（先用） */
export const PACK_EXPIRING_DAYS = 3
export const STERILIZERS = ['S1', 'S2']

export const expiresOnOf = (sterilizedAt: string): string => addDays(sterilizedAt.slice(0, 10), PACK_VALID_DAYS)
/** 這鍋的生物指示劑什麼時候可以判讀 */
export const biDueAt = (b: Pick<SterileBatch, 'at'>): string => addMinutes(b.at, BI_HOURS * 60)

export type PackState = 'available' | 'used' | 'expired' | 'recalled' | 'withdrawn'
export const PACK_STATE_LABEL: Record<PackState, string> = { available: '可用', used: '已使用', expired: '過期', recalled: '召回待收回', withdrawn: '已收回' }

/** 包的狀態：收回、用過、召回（BI 陽性、還沒用）、過期、可用 */
export function packState(p: Pick<InstrumentPack, 'used' | 'withdrawn' | 'expiresOn'>, b: Pick<SterileBatch, 'bi'> | undefined, today: string): PackState {
  if (p.withdrawn) return 'withdrawn'
  if (p.used) return 'used'
  if (b?.bi?.result === 'positive') return 'recalled'
  if (p.expiresOn < today) return 'expired'
  return 'available'
}

/** BI 狀態文字：陰性（放行）、陽性（召回）、培養中（幾點可判讀）、該判讀了 */
export function biText(b: Pick<SterileBatch, 'at' | 'bi'>, now: string): string {
  if (b.bi) return b.bi.result === 'negative' ? '生物指示劑陰性' : '生物指示劑陽性（召回）'
  const due = biDueAt(b)
  return due <= now ? '生物指示劑該判讀了' : `生物指示劑培養中（${due.slice(5)} 可判讀）`
}

/**
 * 這包能不能用在這台手術（掃描時）：已收回、已用過、召回、過期都不行；
 * 會放植入物的手術要等生物指示劑陰性。回傳不能用的原因
 */
export function packUseProblem(p: Pick<InstrumentPack, 'used' | 'withdrawn' | 'expiresOn'>, b: Pick<SterileBatch, 'at' | 'bi'> | undefined, today: string, now: string, implant: boolean): string | undefined {
  const st = packState(p, b, today)
  if (st === 'withdrawn') return '這包已經收回（召回或過期重新滅菌），不能用'
  if (st === 'used') return '這包已經用過了'
  if (st === 'recalled') return '這鍋生物指示劑陽性，整鍋召回，不能用'
  if (st === 'expired') return `已過效期（${p.expiresOn}），要重新滅菌`
  if (implant && b?.bi?.result !== 'negative') return `會放植入物的手術要等生物指示劑陰性才能用（${b ? biText(b, now) : '沒有鍋次'}）：請換一包已判讀陰性的`
  return undefined
}

/** 庫存（各種類）：可用、其中 BI 還沒出來的、快到期的；過期待收回、召回待收回 */
export function packStock(packs: Pick<InstrumentPack, 'set' | 'used' | 'withdrawn' | 'expiresOn' | 'batchId'>[], batchOf: (id: string) => Pick<SterileBatch, 'bi'> | undefined, today: string) {
  const soon = addDays(today, PACK_EXPIRING_DAYS)
  return PACK_SETS.map((set) => {
    const xs = packs.filter((p) => p.set === set)
    const st = (p: (typeof xs)[number]) => packState(p, batchOf(p.batchId), today)
    const avail = xs.filter((p) => st(p) === 'available')
    return {
      set, label: PACK_SET_LABEL[set], available: avail.length,
      biPending: avail.filter((p) => !batchOf(p.batchId)?.bi).length,
      expiring: avail.filter((p) => p.expiresOn <= soon).length,
      expired: xs.filter((p) => st(p) === 'expired').length,
      recalled: xs.filter((p) => st(p) === 'recalled').length,
    }
  })
}

/** 登記一鍋：滅菌鍋、化學指示劑合格、每種幾包（至少一包、每種最多 20） */
export function checkBatchInput(input: { sterilizer?: string; ciPass?: boolean; packs?: Partial<Record<PackSet, unknown>> }): Record<string, string> {
  const e: Record<string, string> = {}
  if (!STERILIZERS.includes(input.sterilizer ?? '')) e.sterilizer = '請選滅菌鍋'
  if (input.ciPass !== true) e.ciPass = '化學指示劑要合格才能登記（不合格整鍋重新滅菌）'
  let total = 0
  for (const set of PACK_SETS) {
    const v = input.packs?.[set]
    if (v === undefined || v === '' || v === null) continue
    const n = Number(v)
    if (!Number.isInteger(n) || n < 0 || n > 20) e[set] = '0–20 包'
    else total += n
  }
  if (!total && !Object.keys(e).some((k) => k in PACK_SET_LABEL)) e.packs = '至少要有一包'
  return e
}

/** 每種包的內容清單（逐件清點用） */
export const PACK_CONTENTS: Record<PackSet, { name: string; qty: number }[]> = {
  basic: [{ name: '持針器', qty: 2 }, { name: '止血鉗', qty: 6 }, { name: '組織鑷', qty: 2 }, { name: '組織剪', qty: 2 }, { name: '刀柄', qty: 1 }, { name: '拉鉤', qty: 2 }],
  lap: [{ name: '腹腔鏡抓鉗', qty: 2 }, { name: '腹腔鏡剪刀', qty: 1 }, { name: '穿刺套管', qty: 3 }, { name: '電燒鉤', qty: 1 }, { name: '持針器', qty: 1 }],
  ortho: [{ name: '骨撬', qty: 2 }, { name: '骨鉗', qty: 2 }, { name: '鑽頭', qty: 2 }, { name: '螺絲起子', qty: 1 }, { name: '深度尺', qty: 1 }, { name: '持針器', qty: 1 }],
  minor: [{ name: '持針器', qty: 1 }, { name: '止血鉗', qty: 2 }, { name: '組織鑷', qty: 1 }, { name: '組織剪', qty: 1 }, { name: '刀柄', qty: 1 }],
}
export const packTotal = (set: PackSet): number => PACK_CONTENTS[set].reduce((n, x) => n + x.qty, 0)

/** 這台掃過的包合起來的器械清單（同名的加總，照第一次出現的順序） */
export function expectedInstruments(sets: PackSet[]): { name: string; qty: number }[] {
  const out: { name: string; qty: number }[] = []
  for (const set of sets) for (const x of PACK_CONTENTS[set]) {
    const cur = out.find((y) => y.name === x.name)
    if (cur) cur.qty += x.qty
    else out.push({ ...x })
  }
  return out
}

/** 逐件清點：每一件都要填（0–999 整數）；術後和清單不同的列出來（「持針器 術前 3、術後 2」） */
export function instrumentItemsProblem(expected: { name: string; qty: number }[], after: Record<string, unknown> | undefined): { field?: string; mismatch: string[]; rows: { name: string; before: number; after: number }[] } {
  const bad = expected.filter((x) => {
    const v = after?.[x.name]
    return v === undefined || v === null || v === '' || !Number.isInteger(Number(v)) || Number(v) < 0 || Number(v) > 999
  })
  if (bad.length) return { field: `請逐件清點（術後數量）：${bad.map((x) => x.name).join('、')} 還沒填`, mismatch: [], rows: [] }
  const rows = expected.map((x) => ({ name: x.name, before: x.qty, after: Number(after![x.name]) }))
  return { mismatch: rows.filter((r) => r.before !== r.after).map((r) => `${r.name} 術前 ${r.before}、術後 ${r.after}`), rows }
}
