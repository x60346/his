// 病人自控止痛 PCA（純函式）：醫囑範圍、鎮靜量表（POSS）、警示（鎮靜 ≥3 或呼吸 <10）、每 4 小時紀錄的期限、用量檢查。
// 醫囑畫面、紀錄畫面即時算、服務層把關、護理站待辦、測試都用這一份
import type { PcaOrder } from '@/types'
import { addMinutes } from '@/utils/date'

export const POSS: { score: 1 | 2 | 3 | 4; text: string }[] = [
  { score: 1, text: '清醒、警覺' },
  { score: 2, text: '輕微嗜睡，容易叫醒' },
  { score: 3, text: '常常昏睡，叫得醒但對話中會睡著' },
  { score: 4, text: '昏睡，叫不醒或很難叫醒' },
]
/** 警示門檻：鎮靜幾分以上、呼吸每分鐘少於幾次 */
export const PCA_SEDATION_ALERT = 3
export const PCA_RESP_ALERT = 10
/** 每幾小時紀錄一次 */
export const PCA_RECORD_HOURS = 4
export const PCA_END_REASONS = ['醫師停止（改口服止痛）', '藥袋用完', '病人不需要了', '管路問題', '出院前停止', '其他']

export const pcaAlert = (x: { sedation: number; resp: number }) => x.sedation >= PCA_SEDATION_ALERT || x.resp < PCA_RESP_ALERT
export const pcaAlertText = (x: { sedation: number; resp: number }) =>
  [x.sedation >= PCA_SEDATION_ALERT && `鎮靜 ${x.sedation} 分`, x.resp < PCA_RESP_ALERT && `呼吸 ${x.resp} 次/分`].filter(Boolean).join('、')

/** 醫囑：單次 0.5–3 mg、鎖定 5–30 分、每小時上限 1–20 mg（不能低於單次＋基礎）、基礎 0–2 mg/h */
export function checkPcaInput(x: { bolusMg?: number; lockoutMin?: number; hourLimitMg?: number; basalMgH?: number }): Record<string, string> {
  const e: Record<string, string> = {}
  const n = (v: unknown) => typeof v === 'number' && !Number.isNaN(v)
  if (!n(x.bolusMg) || x.bolusMg! < 0.5 || x.bolusMg! > 3) e.bolusMg = '單次劑量 0.5–3 mg'
  if (!n(x.lockoutMin) || !Number.isInteger(x.lockoutMin) || x.lockoutMin! < 5 || x.lockoutMin! > 30) e.lockoutMin = '鎖定時間 5–30 分鐘'
  if (!n(x.basalMgH) || x.basalMgH! < 0 || x.basalMgH! > 2) e.basalMgH = '基礎速率 0–2 mg/小時（不用填 0）'
  if (!n(x.hourLimitMg) || x.hourLimitMg! < 1 || x.hourLimitMg! > 20) e.hourLimitMg = '每小時上限 1–20 mg'
  else if (!e.bolusMg && !e.basalMgH && x.hourLimitMg! < x.bolusMg! + x.basalMgH!) e.hourLimitMg = '每小時上限不能低於一次按壓加基礎速率'
  return e
}

/** 理論上每小時最多給多少 mg（按壓次數受鎖定時間限制、再受上限限制） */
export const pcaMaxPerHour = (p: Pick<PcaOrder, 'bolusMg' | 'lockoutMin' | 'hourLimitMg' | 'basalMgH'>) => Math.min(p.hourLimitMg, Math.floor(60 / p.lockoutMin) * p.bolusMg + p.basalMgH)

/** 下一次紀錄的期限：架設或上一次紀錄＋4 小時；到期前 30 分鐘起 due，過了 overdue */
export function pcaRecordDue(lastAt: string, now: string): { dueAt: string; status: 'ok' | 'due' | 'overdue' } {
  const dueAt = addMinutes(lastAt, PCA_RECORD_HOURS * 60)
  return { dueAt, status: now > dueAt ? 'overdue' : now >= addMinutes(dueAt, -30) ? 'due' : 'ok' }
}

/** 紀錄的欄位：按壓 ≥ 給藥、累計用量只增不減且不超過一袋 */
export function checkPcaRecord(x: { demands?: number; delivered?: number; usedMl?: number; pain?: number; sedation?: number; resp?: number }, prevUsedMl: number, volumeMl: number): Record<string, string> {
  const e: Record<string, string> = {}
  const int = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi
  if (!int(x.demands, 0, 999)) e.demands = '按壓次數 0–999'
  if (!int(x.delivered, 0, 999)) e.delivered = '給藥次數 0–999'
  else if (!e.demands && x.delivered! > x.demands!) e.delivered = '給藥次數不能多於按壓次數'
  if (typeof x.usedMl !== 'number' || Number.isNaN(x.usedMl) || x.usedMl < prevUsedMl || x.usedMl > volumeMl) e.usedMl = `累計用量 ${prevUsedMl}–${volumeMl} ml（看機器上的累計量）`
  if (!int(x.pain, 0, 10)) e.pain = '疼痛 0–10'
  if (![1, 2, 3, 4].includes(x.sedation as number)) e.sedation = '請選鎮靜分數'
  if (!int(x.resp, 4, 60)) e.resp = '呼吸 4–60 次/分'
  return e
}
