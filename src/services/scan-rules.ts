// 給藥條碼核對（純函式）：掃腕帶（條碼＝住院號）、掃藥品（條碼＝健保碼），核對「對的病人、對的藥」。
// 時間已經由 marUrgency 把關。畫面即時檢查（scanCheck）與服務層給藥前再檢查（executeMar、givePrn）用同一份
import type { ScanSkipReason } from '@/types'

export const SCAN_SKIP_LABEL: Record<ScanSkipReason, string> = {
  wristband: '腕帶損壞或未配戴',
  barcode: '藥品條碼無法讀取',
  scanner: '掃描器故障',
  emergency: '緊急狀況',
}
export const SCAN_SKIP_REASONS = Object.keys(SCAN_SKIP_LABEL) as ScanSkipReason[]

/** 掃描槍會帶空白、換行，大小寫也可能不同 */
export const normalizeCode = (code: string) => (code ?? '').trim().toUpperCase()

export interface ScanResult {
  ok: boolean
  /** 不符時：講清楚錯在哪（大紅字）；符合時：確認了什麼 */
  message: string
}

/** 住院紀錄的最少欄位（給核對用） */
export interface ScanAdmission {
  id: string
  admitNo: string
  patientId: string
  status: string
  patientName: string
  bedNo?: string
}

/**
 * 腕帶：條碼是住院號。要給藥的那位病人這次住院的腕帶才對；
 * 同一位病人上次住院的舊腕帶、別的病人的腕帶、不認得的條碼都擋，訊息說清楚是誰的
 */
export function checkPatientScan(code: string, target: ScanAdmission, all: ScanAdmission[]): ScanResult {
  const c = normalizeCode(code)
  if (!c) return { ok: false, message: '請掃描病人腕帶' }
  if (c === normalizeCode(target.admitNo)) return { ok: true, message: `病人正確：${target.bedNo ?? ''} ${target.patientName}（${target.admitNo}）` }
  const hit = all.find((a) => normalizeCode(a.admitNo) === c)
  if (!hit) return { ok: false, message: `不是本院住院病人的腕帶條碼（${c}）` }
  if (hit.patientId === target.patientId) return { ok: false, message: `這是 ${hit.patientName} 之前住院（${hit.admitNo}）的舊腕帶：請換上這次住院的腕帶` }
  if (hit.status === 'admitted') return { ok: false, message: `病人不對！這是 ${hit.bedNo ?? ''} ${hit.patientName} 的腕帶，不是 ${target.bedNo ?? ''} ${target.patientName}` }
  return { ok: false, message: `病人不對！這是 ${hit.patientName}（${hit.admitNo}，已不在院）的腕帶` }
}

/** 藥品：條碼是健保碼，要和這一劑醫囑的藥一樣（同成分不同劑量的健保碼不同，拿錯規格也會擋） */
export function checkDrugScan(code: string, target: { nhiCode: string; name: string }, all: { nhiCode: string; name: string }[]): ScanResult {
  const c = normalizeCode(code)
  if (!c) return { ok: false, message: '請掃描藥品條碼' }
  if (c === normalizeCode(target.nhiCode)) return { ok: true, message: `藥品正確：${target.name}` }
  const hit = all.find((d) => normalizeCode(d.nhiCode) === c)
  return { ok: false, message: hit ? `藥品不對！掃到的是 ${hit.name}，這一劑是 ${target.name}` : `不認得的藥品條碼（${c}）：請確認藥品` }
}
