// 抗生素管理（每日審視，純函式＋靜態主檔）：院內抗生素的分類（β-lactam 等）與窄廣效順序、可改口服的藥、
// 療程從哪天算起（停藥 48 小時內再開接續；修改醫囑沿用）、換同類的提示、每日審視的五條規則。
// 感染科每日審視頁、主治的建議、首頁待辦、開醫囑的提示、測試都用這一份
import type { AbxAdviceKind, CultureIsolate, DietKind, RenalBand, SirResult } from '@/types'
import { renalAdjust } from './renal-rules'
import { PROPHYLAXIS_STOP_HOURS, prophylaxisOverdueHours } from './prophylaxis-rules'
import { parseDate } from '@/utils/date'
import { abxDay } from './abx-rules'
import { astKeyOfDrug, AST_DRUGS, mdroOf, organismName } from './culture-rules'

export const ABX_ADVICE_LABEL: Record<AbxAdviceKind, string> = {
  ineffective: '藥敏無效',
  overlap: '抗菌範圍重疊',
  renal: '腎功能需調整',
  prophylaxis: '預防用藥超過 24 小時',
  deescalate: '可降階',
  ivpo: '可改口服',
  duration: '療程超過 7 天',
}
/** 顯示順序：無效、重疊最要緊 */
export const ABX_ADVICE_KINDS: AbxAdviceKind[] = ['ineffective', 'overlap', 'renal', 'prophylaxis', 'deescalate', 'ivpo', 'duration']
export const ABX_INTERVENTION_STATUS: Record<'sent' | 'accepted' | 'declined' | 'dismissed', string> = { sent: '待主治回覆', accepted: '已接受', declined: '不接受', dismissed: '不用介入' }

/** 停藥後多久內再開同一支，接續原療程（不重新算第 1 天） */
export const ABX_RESTART_HOURS = 48
/** 靜脈注射滿多久、能進食，就評估改口服 */
export const ABX_IVPO_HOURS = 72
/** 一般療程天數：超過就提醒評估停藥 */
export const ABX_LONG_DAYS = 7

type AbxClass = 'beta-lactam' | 'glycopeptide' | 'macrolide'
export const ABX_CLASS_LABEL: Record<AbxClass, string> = { 'beta-lactam': 'β-lactam', glycopeptide: '醣胜肽類', macrolide: '巨環類' }
/** 院內抗生素：分類、是不是口服（主檔沒有分類欄位，展示用寫在這裡） */
export const ABX_PROFILE: Record<string, { cls: AbxClass; oral: boolean }> = {
  M003: { cls: 'beta-lactam', oral: true },
  M004: { cls: 'beta-lactam', oral: true },
  M005: { cls: 'beta-lactam', oral: true },
  M006: { cls: 'macrolide', oral: true },
  M036: { cls: 'beta-lactam', oral: false },
  M042: { cls: 'glycopeptide', oral: false },
  M043: { cls: 'beta-lactam', oral: false },
  M044: { cls: 'beta-lactam', oral: false },
}
/** 窄效 → 廣效（藥敏項目）：降階就是往前換。Vancomycin 是保留給抗藥菌的，排最後 */
const BREADTH: Record<string, number> = { AMP: 1, CEX: 2, AMC: 3, CRO: 4, TZP: 5, MEM: 6, VAN: 7 }
/** 沒有培養結果時，靜脈注射可以換的口服藥（經驗性的對照） */
export const ABX_ORAL_SWITCH: Record<string, string[]> = { M036: ['M004', 'M005'], M044: ['M004'] }

/** 某一株菌對某支院內藥的藥敏：MRSA 對所有 β-lactam 天生抗藥（藥敏沒測也算 R）；沒測回 undefined */
export function sirOf(iso: Pick<CultureIsolate, 'organism' | 'ast'>, drugId: string): SirResult | undefined {
  if (mdroOf(iso) === 'MRSA' && ABX_PROFILE[drugId]?.cls === 'beta-lactam') return 'R'
  const k = astKeyOfDrug(drugId)
  return k ? iso.ast[k] : undefined
}

/** 每一株都敏感的院內藥（窄效在前）；only 限定候選（例：只看口服的） */
export function susceptibleDrugs(isolates: Pick<CultureIsolate, 'organism' | 'ast'>[], only?: (drugId: string) => boolean): string[] {
  if (!isolates.length) return []
  return AST_DRUGS.filter((d) => d.key in BREADTH)
    .sort((a, b) => BREADTH[a.key] - BREADTH[b.key])
    .flatMap((d) => d.drugIds)
    .filter((id) => (!only || only(id)) && isolates.every((iso) => sirOf(iso, id) === 'S'))
}

const hoursBetween = (a: string, b: string) => (parseDate(b).getTime() - parseDate(a).getTime()) / 3600000

export interface CourseOrder {
  id: string
  drugId?: string
  startAt: string
  stopAt?: string
  status: 'active' | 'stopped' | 'done'
  replaces?: string
}

/**
 * 療程第一天：往回找「同一支藥」的前一筆——修改醫囑的前身，或停藥 48 小時內又開的那一筆——一路接到最早那筆。
 * history＝同一次住院的醫囑（含已停的）
 */
export function abxCourseStart(o: CourseOrder, history: CourseOrder[]): string {
  let cur = o
  const seen = new Set([o.id])
  for (;;) {
    const prev = (cur.replaces ? history.find((x) => x.id === cur.replaces) : undefined) ??
      history
        .filter((x) => x.drugId === cur.drugId && !seen.has(x.id) && x.status !== 'active' && x.stopAt && x.stopAt <= cur.startAt && hoursBetween(x.stopAt, cur.startAt) <= ABX_RESTART_HOURS)
        .sort((a, b) => b.stopAt!.localeCompare(a.stopAt!))[0]
    if (!prev || seen.has(prev.id)) return cur.startAt
    seen.add(prev.id)
    cur = prev
  }
}

/**
 * 開抗生素時的提示：同一支 48 小時內停過 → 接續原療程第幾天；換同類（例：Ceftriaxone 換 Augmentin）→ 抗生素療程第幾天。
 * 不是抗生素、或沒有接得上的，回 undefined
 */
export function abxCourseHint(drugId: string, history: CourseOrder[], t: string, drugName: (id: string) => string): { day: number; text: string } | undefined {
  const cls = ABX_PROFILE[drugId]?.cls
  if (!cls) return undefined
  const recent = (x: CourseOrder) => x.status === 'active' || (!!x.stopAt && x.stopAt <= t && hoursBetween(x.stopAt, t) <= ABX_RESTART_HOURS)
  const same = history.filter((x) => x.drugId === drugId && x.status !== 'active' && recent(x)).sort((a, b) => b.stopAt!.localeCompare(a.stopAt!))[0]
  if (same) {
    const day = abxDay(abxCourseStart(same, history), t)
    return { day, text: `${drugName(drugId)} ${same.stopAt!.slice(5).replace('-', '/')} 才停（${ABX_RESTART_HOURS} 小時內）：再開接續原療程，今天是第 ${day} 天` }
  }
  const others = history.filter((x) => x.drugId && x.drugId !== drugId && ABX_PROFILE[x.drugId]?.cls === cls && recent(x))
  if (!others.length) return undefined
  const start = others.map((x) => abxCourseStart(x, history)).sort()[0]
  const day = abxDay(start, t)
  const names = [...new Set(others.map((x) => drugName(x.drugId!)))].join('、')
  return { day, text: `同類抗生素（${ABX_CLASS_LABEL[cls]}）${names} 從 ${start.slice(5, 10).replace('-', '/')} 開始用：換藥不重新起算，抗生素療程今天是第 ${day} 天` }
}

export interface StewardOrder {
  id: string
  drugId: string
  route?: string
  freq?: string
  /** 療程第一天（abxCourseStart；管制性抗生素用 abx.courseStart） */
  courseStart: string
  startAt: string
  /** 管制性抗生素已核准到第幾天（感染科核准過長療程，就不再提醒超過 7 天） */
  approvedDays?: number
}
export interface StewardFinding {
  orderId: string
  kind: AbxAdviceKind
  text: string
  /** 建議可以換的藥（窄效在前） */
  drugIds?: string[]
  /** 重疊：和哪幾筆醫囑重疊 */
  withOrderIds?: string[]
}

/**
 * 每日審視的五條規則（一位病人的所有抗生素一起看）：
 *  - 藥敏無效：最近一次有長菌的培養，有任何一株對這支藥抗藥（MRSA 對 β-lactam 天生抗藥）
 *  - 可降階：沒有抗藥、藥敏有更窄效的敏感藥
 *  - 可改口服：靜脈注射滿 72 小時、能進食（飲食醫囑不是禁食）、有敏感的口服藥（沒有培養就用經驗對照）
 *  - 療程超過 7 天：今天第 8 天以上（感染科核准過更長的、已經無效的不算）
 *  - 腎功能需調整：CrCl 算得出、主檔有腎功能分級、目前的頻率比建議的多（已經無效的不提）
 *  - 預防用藥超過 24 小時：術前準備連的抗生素，手術結束滿 24 小時還在用
 *  - 抗菌範圍重疊：兩支同類（例：兩支 β-lactam）同時在用——兩筆都標，審視者決定建議停哪一支
 */
export function stewardFindings(x: {
  orders: StewardOrder[]
  isolates: Pick<CultureIsolate, 'organism' | 'ast'>[]
  diet?: DietKind
  now: string
  drugName: (id: string) => string
  /** 腎功能（沒給或算不出就不看）：CrCl、藥品的分級、頻率每天幾次 */
  renal?: { crcl: number | null; bandsOf: (drugId: string) => RenalBand[] | undefined; perDay: (code: string) => number | undefined }
  /** 做完的手術連的預防性抗生素：醫囑 id → 手術結束時間、術式 */
  prophylaxis?: Record<string, { endAt: string; name: string }>
}): StewardFinding[] {
  const out: StewardFinding[] = []
  const names = (ids: string[]) => ids.map(x.drugName).join('、')
  // 敏感的藥可能有四五支：只寫最窄效的兩支（drugIds 有全部）
  const few = (ids: string[]) => `${names(ids.slice(0, 2))}${ids.length > 2 ? ' 等' : ''}`
  for (const o of x.orders) {
    const name = x.drugName(o.drugId)
    const cls = ABX_PROFILE[o.drugId]?.cls
    const resist = x.isolates.filter((iso) => sirOf(iso, o.drugId) === 'R')
    const sens = susceptibleDrugs(x.isolates)
    if (resist.length) {
      const alt = sens.filter((id) => id !== o.drugId)
      out.push({ orderId: o.id, kind: 'ineffective', text: `${resist.map((iso) => organismName(iso.organism)).join('、')} 對 ${name} 抗藥${alt.length ? `；藥敏敏感：${few(alt)}` : ''}`, ...(alt.length ? { drugIds: alt } : {}) })
    } else {
      const k = astKeyOfDrug(o.drugId)
      const narrower = k && k in BREADTH ? sens.filter((id) => BREADTH[astKeyOfDrug(id)!] < BREADTH[k]) : []
      if (narrower.length) out.push({ orderId: o.id, kind: 'deescalate', text: `藥敏有較窄效的敏感藥：${few(narrower)}（目前 ${name}）`, drugIds: narrower })
    }
    const adj = x.renal && !resist.length ? renalAdjust(x.renal.bandsOf(o.drugId), o.freq, x.renal.crcl, x.renal.perDay) : undefined
    if (adj) out.push({ orderId: o.id, kind: 'renal', text: adj.text })
    const px = x.prophylaxis?.[o.id]
    const pxH = px ? prophylaxisOverdueHours(px.endAt, x.now) : undefined
    if (px && pxH !== undefined) out.push({ orderId: o.id, kind: 'prophylaxis', text: `${px.name}結束已 ${pxH} 小時：預防性抗生素超過 ${PROPHYLAXIS_STOP_HOURS} 小時，建議停藥（若已有感染請寫明治療療程）` })
    const ivH = o.route === 'IV' ? hoursBetween(o.courseStart, x.now) : 0
    if (ivH >= ABX_IVPO_HOURS && x.diet && x.diet !== 'npo' && !resist.length) {
      const oral = x.isolates.length ? susceptibleDrugs(x.isolates, (id) => !!ABX_PROFILE[id]?.oral) : ABX_ORAL_SWITCH[o.drugId] ?? []
      if (oral.length) out.push({ orderId: o.id, kind: 'ivpo', text: `靜脈注射已 ${Math.floor(ivH / 24)} 天、可以進食：評估改口服 ${few(oral)}${x.isolates.length ? '（藥敏敏感）' : ''}`, drugIds: oral })
    }
    const day = abxDay(o.courseStart, x.now)
    // 已經無效的藥要停，不必再提天數
    if (day > ABX_LONG_DAYS && !resist.length && !(o.approvedDays && o.approvedDays >= day)) out.push({ orderId: o.id, kind: 'duration', text: `已使用第 ${day} 天（超過 ${ABX_LONG_DAYS} 天）：評估停藥，或寫明預計療程` })
    const mates = cls ? x.orders.filter((y) => y.id !== o.id && y.drugId !== o.drugId && ABX_PROFILE[y.drugId]?.cls === cls) : []
    if (mates.length && cls) out.push({ orderId: o.id, kind: 'overlap', text: `與 ${names(mates.map((y) => y.drugId))} 同為 ${ABX_CLASS_LABEL[cls]}，抗菌範圍重疊：建議擇一`, withOrderIds: mates.map((y) => y.id) })
  }
  return out.sort((a, b) => ABX_ADVICE_KINDS.indexOf(a.kind) - ABX_ADVICE_KINDS.indexOf(b.kind))
}
