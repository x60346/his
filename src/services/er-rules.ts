// 急診（純函式）：檢傷五級（依台灣急診檢傷分類的精神簡化）、主訴預設級數、生命徵象判級、等候時間目標、觀察床時數、看板狀態。
// 檢傷畫面即時建議、服務層把關、看板、批價（觀察床費）都用這一份
import type { ErInfo, TriageLevel, TriageVitals, VisitStatus } from '@/types'
import { vitalInputProblem } from './nursing-rules'

export const TRIAGE_LEVELS: TriageLevel[] = [1, 2, 3, 4, 5]
export const TRIAGE_LABEL: Record<TriageLevel, string> = { 1: '復甦急救', 2: '危急', 3: '緊急', 4: '次緊急', 5: '非緊急' }
/** 目標等候時間（分鐘）：檢傷後多久內要看到醫師 */
export const TRIAGE_TARGET_MIN: Record<TriageLevel, number> = { 1: 0, 2: 10, 3: 30, 4: 60, 5: 120 }

/** 常見主訴與預設級數（實際級數再看生命徵象，取比較嚴重的） */
export const ER_COMPLAINTS: { text: string; level: TriageLevel }[] = [
  { text: '心跳或呼吸停止', level: 1 },
  { text: '胸痛', level: 2 },
  { text: '呼吸困難', level: 2 },
  { text: '疑似中風（肢體無力、口齒不清）', level: 2 },
  { text: '腹痛', level: 3 },
  { text: '發燒', level: 3 },
  { text: '頭痛', level: 3 },
  { text: '頭暈', level: 3 },
  { text: '嘔吐、腹瀉', level: 3 },
  { text: '外傷：撕裂傷', level: 4 },
  { text: '外傷：扭傷、挫傷', level: 4 },
  { text: '皮疹、搔癢', level: 4 },
  { text: '喉嚨痛、咳嗽', level: 5 },
  { text: '慢性病藥物用完', level: 5 },
]
/** 自由輸入的主訴（不在清單裡）：預設 3 級，再看生命徵象 */
export const complaintLevel = (complaint: string): TriageLevel => ER_COMPLAINTS.find((c) => c.text === complaint.trim())?.level ?? 3

/** 依生命徵象判級（各項取最嚴重的）；回傳級數與原因（給檢傷畫面顯示「為什麼是 2 級」） */
export function vitalsLevel(v: TriageVitals): { level: TriageLevel; reasons: string[] } {
  const hit: { level: TriageLevel; why: string }[] = []
  const has = (x: number | undefined): x is number => x !== undefined && x !== null && !Number.isNaN(x)
  if (has(v.gcs)) { if (v.gcs <= 8) hit.push({ level: 1, why: `GCS ${v.gcs}` }); else if (v.gcs <= 13) hit.push({ level: 2, why: `GCS ${v.gcs}` }) }
  if (has(v.spo2)) { if (v.spo2 < 80) hit.push({ level: 1, why: `血氧 ${v.spo2}%` }); else if (v.spo2 < 90) hit.push({ level: 2, why: `血氧 ${v.spo2}%` }); else if (v.spo2 < 94) hit.push({ level: 3, why: `血氧 ${v.spo2}%` }) }
  if (has(v.sbp)) { if (v.sbp < 70) hit.push({ level: 1, why: `收縮壓 ${v.sbp}` }); else if (v.sbp < 90) hit.push({ level: 2, why: `收縮壓 ${v.sbp}` }); else if (v.sbp > 220) hit.push({ level: 2, why: `收縮壓 ${v.sbp}` }); else if (v.sbp > 200) hit.push({ level: 3, why: `收縮壓 ${v.sbp}` }) }
  if (has(v.pulse)) { if (v.pulse < 30) hit.push({ level: 1, why: `脈搏 ${v.pulse}` }); else if (v.pulse < 40 || v.pulse > 140) hit.push({ level: 2, why: `脈搏 ${v.pulse}` }); else if (v.pulse > 120) hit.push({ level: 3, why: `脈搏 ${v.pulse}` }) }
  if (has(v.resp)) { if (v.resp < 8) hit.push({ level: 1, why: `呼吸 ${v.resp}` }); else if (v.resp > 30) hit.push({ level: 2, why: `呼吸 ${v.resp}` }); else if (v.resp > 24) hit.push({ level: 3, why: `呼吸 ${v.resp}` }) }
  if (has(v.temp)) { if (v.temp >= 41 || v.temp <= 35) hit.push({ level: 2, why: `體溫 ${v.temp}` }); else if (v.temp >= 39) hit.push({ level: 3, why: `體溫 ${v.temp}` }) }
  const level = hit.reduce<TriageLevel>((m, h) => (h.level < m ? h.level : m), 5)
  return { level, reasons: hit.filter((h) => h.level === level).map((h) => h.why) }
}

/** 建議級數：主訴與生命徵象取比較嚴重的（數字小） */
export function suggestLevel(complaint: string, v: TriageVitals): { level: TriageLevel; why: string } {
  const c = complaintLevel(complaint)
  const vl = vitalsLevel(v)
  if (vl.level < c) return { level: vl.level, why: `生命徵象：${vl.reasons.join('、')}` }
  return { level: c, why: `主訴「${complaint.trim() || '—'}」` }
}

/**
 * 檢傷欄位檢查（欄位 key 對應畫面）：主訴必填；生命徵象脈搏、血壓、血氧必填（1 級急救中可以先不填）、範圍合理；
 * 級數不能比建議輕；比建議重（調升）要寫原因
 */
export function checkTriageInput(x: { complaint?: string; vitals?: TriageVitals; level?: number; reason?: string }): Record<string, string> {
  const e: Record<string, string> = {}
  const v = x.vitals ?? {}
  if (!x.complaint?.trim()) e.complaint = '請寫主訴'
  if (!TRIAGE_LEVELS.includes(x.level as TriageLevel)) e.level = '請選檢傷級數'
  for (const k of ['temp', 'pulse', 'resp', 'sbp', 'dbp', 'spo2'] as const) {
    const n = v[k]
    if (n === undefined || n === null || Number.isNaN(n)) {
      if (x.level !== 1 && (k === 'pulse' || k === 'sbp' || k === 'spo2')) e[k] = '必填'
      continue
    }
    const p = vitalInputProblem(k, n)
    if (p) e[k] = p
  }
  if (v.gcs !== undefined && v.gcs !== null && !Number.isNaN(v.gcs) && (!Number.isInteger(v.gcs) || v.gcs < 3 || v.gcs > 15)) e.gcs = 'GCS 是 3–15'
  if (!e.level && !e.complaint) {
    const s = suggestLevel(x.complaint!, v)
    if ((x.level as number) > s.level) e.level = `依${s.why}至少是 ${s.level} 級，不能比建議輕`
    else if ((x.level as number) < s.level && !x.reason?.trim()) e.reason = `比建議（${s.level} 級）嚴重：請寫調升原因`
  }
  return e
}

/** 等候：檢傷後到醫師看到（叫號）的分鐘數、目標、是否超過 */
export function waitState(level: TriageLevel, triagedAt: string, seenAt: string | undefined, now: string): { minutes: number; target: number; overdue: boolean } {
  const end = seenAt ?? now
  const minutes = Math.max(0, Math.round((Date.parse(end.replace(' ', 'T')) - Date.parse(triagedAt.replace(' ', 'T'))) / 60000))
  const target = TRIAGE_TARGET_MIN[level]
  return { minutes, target, overdue: minutes > target }
}

/** 觀察床費：到院到離開急診（去向決定）滿 6 小時才收，每滿 6 小時一單位 */
export function erObsBlocks(arrivedAt: string, endAt: string): number {
  const h = (Date.parse(endAt.replace(' ', 'T')) - Date.parse(arrivedAt.replace(' ', 'T'))) / 3600000
  return h >= 6 ? Math.floor(h / 6) : 0
}

export type ErStage = 'waiting' | 'seeing' | 'deciding' | 'obs-bed' | 'obs' | 'billing' | 'bed' | 'admitted' | 'left'
export const ER_STAGE_LABEL: Record<ErStage, string> = { waiting: '待看診', seeing: '看診中', deciding: '待決定去向', 'obs-bed': '待排留觀床', obs: '留觀中', billing: '待批價', bed: '待床', admitted: '已住院', left: '已離院' }

/**
 * 看板階段：看就醫狀態與去向。收住院看住院報到了沒（留觀轉住院還在留觀床上＝待床）；
 * 留觀看留觀住院排床了沒、結束了沒（結束後依結束的去向：離院、轉院要批價；收住院同上）
 */
export function erStage(status: VisitStatus, er: Pick<ErInfo, 'disposition' | 'obsEnd'>, adm?: { status: string; inObsBed?: boolean }): ErStage {
  if (status === 'registered') return 'waiting'
  if (status === 'in-consult') return 'seeing'
  const d = er.disposition
  if (!d) return status === 'consulted' ? 'deciding' : 'left'
  const admitted = (): ErStage => (adm && (adm.status === 'discharged' || (adm.status === 'admitted' && !adm.inObsBed)) ? 'admitted' : 'bed')
  if (d.kind === 'obs') {
    if (!er.obsEnd) return adm?.status === 'admitted' ? 'obs' : 'obs-bed'
    if (er.obsEnd.kind === 'admit') return admitted()
  } else if (d.kind === 'admit') return admitted()
  return status === 'consulted' ? 'billing' : 'left'
}

export const ER_DISPOSITION_LABEL: Record<NonNullable<ErInfo['disposition']>['kind'], string> = { home: '離院', admit: '收住院', transfer: '轉院', obs: '留觀' }

// ---------- 留觀 ----------
/** 留觀超過幾小時看板標紅、超過幾小時列首頁待辦（急診醫師要決定去向） */
export const OBS_LONG_HOURS = 24
export const OBS_TODO_HOURS = 48
/** 留觀了幾小時（從決定留觀起算，到結束或現在；無條件捨去） */
export const obsHours = (from: string, to: string) => Math.max(0, Math.floor((Date.parse(to.replace(' ', 'T')) - Date.parse(from.replace(' ', 'T'))) / 3600000))
/** 急診費用怎麼結：留觀中還不能結；收住院（直接或留觀後）併入住院帳單；其他（離院、轉院）在批價結 */
export function erBillMode(er: Pick<ErInfo, 'disposition' | 'obsEnd'> | undefined): 'opd' | 'obs-open' | 'ipd' {
  const d = er?.disposition
  if (!d) return 'opd'
  if (d.kind === 'admit') return 'ipd'
  if (d.kind === 'obs') return !er!.obsEnd ? 'obs-open' : er!.obsEnd.kind === 'admit' ? 'ipd' : 'opd'
  return 'opd'
}
/** 觀察床費算到什麼時候：留觀結束 → 決定去向 → 看完診 */
export const erEndAt = (er: Pick<ErInfo, 'disposition' | 'obsEnd' | 'arrivedAt'>, completedAt?: string) => er.obsEnd?.at ?? er.disposition?.at ?? completedAt ?? er.arrivedAt
export const ER_TRANSFER_HOSPITALS = ['區域醫學中心', '台大醫院', '榮民總醫院', '長庚紀念醫院']
