// 床邊處置的內部工具（index 不匯出、不會被包成 API）：送檢報告的值、判讀、帶入病程紀錄的文字、首頁的異常判讀待確認。
// 規則在 bedside-rules；API 在 bedside.ts
import type { BedsideProcedure } from '@/types'
import { db } from '@/mock/db'
import { find } from './views'
import { ascitesPmn, BEDSIDE_FLUID, bedsideTitle, csfRead, lightCriteria, PLEURAL_KINDS, saagRead, SERUM_PAIR_HOURS, SERUM_PROC, type FluidRead } from './bedside-rules'

export interface BedsideReading {
  /** 判讀（可能好幾項：腹水嗜中性球＋SAAG）；報告還沒齊＝readingWaiting 寫還缺什麼 */
  readings: FluidRead[]
  readingWaiting?: string
  /** 判讀用到的報告最後一份發出的時間（異常判讀從這時候開始算知悉時限） */
  readyAt?: string
}
const num = (v?: string) => (v === undefined || v === '' ? undefined : Number(v))
/** 這筆處置送檢的某項報告的值（code → 數字） */
function reportValues(p: BedsideProcedure, procId: string): Record<string, number | undefined> | undefined {
  const o = (p.labOrderIds ?? []).map((id) => db.ipdOrders.find((x) => x.id === id)).find((x) => x?.procId === procId)
  const r = o ? db.labReports.find((x) => x.orderId === o.id) : undefined
  return r ? Object.fromEntries(r.values.map((v) => [v.code, num(v.value)])) : undefined
}
/** 執行時病人幾天大（腦脊髓液正常值依年齡） */
const ageDaysAt = (p: BedsideProcedure) => {
  const b = find.patient(p.patientId)?.birthDate
  return b ? Math.floor((Date.parse(p.performedAt.slice(0, 10)) - Date.parse(b)) / 86400000) : undefined
}

/** 帶入病程紀錄：O＝處置與送檢數值，A＝判讀（還沒判讀的寫等哪些報告） */
export function noteOf(p: BedsideProcedure, r: BedsideReading): { objective: string; assessment: string } {
  const title = bedsideTitle(p.kind, p.side)
  const proc = [`外觀 ${p.appearance}`, p.volumeMl !== undefined && `引流 ${p.volumeMl} mL`, p.openingPressure !== undefined && `開口壓 ${p.openingPressure} cmH2O`, p.complication !== '無' && `併發症：${p.complication}`].filter(Boolean).join('，')
  const labs = (p.labOrderIds ?? []).map((id) => db.ipdOrders.find((o) => o.id === id)).flatMap((o) => {
    const rep = o ? db.labReports.find((x) => x.orderId === o.id) : undefined
    return rep ? [`${find.procedure(rep.procId)?.name.replace(/（[^）]*）$/, '') ?? rep.procId}：${rep.values.map((v) => `${v.name} ${v.value}${v.unit ? ` ${v.unit}` : ''}`).join('、')}`] : []
  })
  return {
    objective: [`${p.performedAt.slice(5)} 床邊${title}：${proc}。`, ...labs.map((l) => `${l}。`)].join(''),
    assessment: [...r.readings.map((x) => `${BEDSIDE_FLUID[p.kind]}：${x.label}（${x.reasons.join('；')}）`), r.readingWaiting && `${BEDSIDE_FLUID[p.kind]}判讀${r.readingWaiting}`].filter(Boolean).join('；'),
  }
}

/** 判讀：胸水（體液生化＋血清：Light's criteria）、腹水（體液常規：嗜中性球；體液生化＋血清：SAAG）、腦脊髓液（體液常規，有生化、血清就加蛋白與血糖比值） */
export function readingOf(p: BedsideProcedure): BedsideReading {
  const ordered = (procId: string) => (p.labOrderIds ?? []).some((id) => db.ipdOrders.find((x) => x.id === id)?.procId === procId)
  const routine = reportValues(p, 'P072')
  const chem = reportValues(p, 'P073')
  const ms = SERUM_PAIR_HOURS * 3600000
  const at = Date.parse(p.performedAt.replace(' ', 'T'))
  const serumRep = db.labReports.filter((r) => r.patientId === p.patientId && r.procId === SERUM_PROC && Math.abs(Date.parse((db.ipdOrders.find((o) => o.id === r.orderId)?.createdAt ?? r.orderedAt).replace(' ', 'T')) - at) <= ms).sort((x, y) => y.reportedAt.localeCompare(x.reportedAt))[0]
  const serum = serumRep ? Object.fromEntries(serumRep.values.map((v) => [v.code, num(v.value)])) : undefined
  const wait: string[] = []
  const need = (have: unknown, procId: string, label: string) => { if (!have && ordered(procId)) wait.push(label) }
  const out: FluidRead[] = []
  if (PLEURAL_KINDS.includes(p.kind)) {
    if (chem && serum) { const r = lightCriteria({ pro: chem['F-PRO'], ldh: chem['F-LDH'] }, { pro: serum.TP, ldh: serum.LDH }); if (r) out.push(r) }
    need(chem, 'P073', '體液生化'); need(serum, SERUM_PROC, '血清生化')
  } else if (p.kind === 'paracentesis') {
    if (routine) { const r = ascitesPmn(routine['F-WBC'], routine['F-PMN']); if (r) out.push(r) }
    if (chem && serum) { const r = saagRead(serum.ALB, chem['F-ALB']); if (r) out.push(r) }
    need(routine, 'P072', '體液常規'); need(chem, 'P073', '體液生化'); need(serum, SERUM_PROC, '血清生化')
  } else if (p.kind === 'lp') {
    // 腦脊髓液：生化、血清有開就等齊了再判讀（血糖比值是細菌性腦膜炎的重要依據）
    need(routine, 'P072', '體液常規'); need(chem, 'P073', '體液生化'); need(serum, SERUM_PROC, '血清生化')
    if (routine && !wait.length) { const r = csfRead({ wbc: routine['F-WBC'], pmn: routine['F-PMN'], rbc: routine['F-RBC'], glu: chem?.['F-GLU'], proGdl: chem?.['F-PRO'] }, serum?.GLU, ageDaysAt(p)); if (r) out.push(r) }
  }
  const repAt = (procId: string) => { const o = (p.labOrderIds ?? []).map((id) => db.ipdOrders.find((x) => x.id === id)).find((x) => x?.procId === procId); return o ? db.labReports.find((x) => x.orderId === o.id)?.reportedAt : undefined }
  const readyAt = [repAt('P072'), repAt('P073'), serumRep?.reportedAt].filter((x): x is string => !!x).sort().at(-1)
  return { readings: out, ...(wait.length ? { readingWaiting: `等${wait.join('、')}報告` } : {}), ...(out.length && readyAt ? { readyAt } : {}) }
}


/** 要主治確認的異常判讀（滲出液、腹膜炎、細菌性腦膜炎）：還沒按已知悉、或已知悉之後判讀又變了 */
export function readingAlertKinds(p: BedsideProcedure): string {
  return readingOf(p).readings.filter((r) => r.alert).map((r) => r.kind).join(',')
}
export const readingAlertPending = (p: BedsideProcedure) => ((k) => !!k && p.readingAck?.kinds !== k)(readingAlertKinds(p))
/** 主治幾小時沒知悉就升級給同科醫師（主治不在：下班、開刀） */
export const READING_ESCALATE_HOURS = 2
/** 異常判讀待知悉、而且報告出來已經超過 2 小時 */
export function readingEscalated(p: BedsideProcedure, t: string): boolean {
  if (!readingAlertPending(p)) return false
  const at = readingOf(p).readyAt
  return !!at && Date.parse(t.replace(' ', 'T')) - Date.parse(at.replace(' ', 'T')) >= READING_ESCALATE_HOURS * 3600000
}
