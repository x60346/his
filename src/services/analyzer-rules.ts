// 檢驗儀器自動傳輸與自動審核的規則（純函式，畫面、服務層、測試共用）。
// 只做數值型、上儀器的項目（CBC、生化、電解質、血糖）；文字型（尿液、快篩、抗酸菌、培養）與血液氣體（床邊機）照舊人工登打。
// 自動審核：品管通過、沒有危急值、和 30 天內上一次差距在範圍內（delta check）、在儀器可測範圍內 → 直接發報告；
// 任一條沒過 → 待醫檢師審核（標出是哪一條、哪一項）
import type { AnalyzerResult, AutoVerifyHold, Gender, LabItemDef, QcRun } from '@/types'
import { judgeLab } from './lab-rules'
import { qcAnalyte, qcStatusToday } from './qc-rules'

/** 上儀器的檢驗醫令 */
export const ANALYZER_PROCS = ['P003', 'P004', 'P005', 'P006', 'P007', 'P008', 'P009', 'P011', 'P053', 'P055']
export const isAnalyzerProc = (procId: string) => ANALYZER_PROCS.includes(procId)

/** 各項目：儀器可測範圍（lo–hi，超出要稀釋重測）、小數位數、delta check 門檻（差多少算太多：絕對值或百分比） */
export const ANALYZER_ITEMS: Record<string, { lo: number; hi: number; dp: number; delta?: { abs?: number; pct?: number } }> = {
  WBC: { lo: 0.1, hi: 100, dp: 1, delta: { pct: 50 } },
  Hb: { lo: 2, hi: 25, dp: 1, delta: { abs: 2 } },
  HCT: { lo: 5, hi: 75, dp: 0, delta: { abs: 6 } },
  PLT: { lo: 5, hi: 2000, dp: 0, delta: { pct: 40 } },
  NA: { lo: 80, hi: 200, dp: 0, delta: { abs: 8 } },
  K: { lo: 1, hi: 10, dp: 1, delta: { abs: 1 } },
  'GLU-AC': { lo: 10, hi: 700, dp: 0, delta: { pct: 50 } },
  HbA1c: { lo: 3, hi: 18, dp: 1 },
  'T-CHO': { lo: 20, hi: 700, dp: 0 },
  TG: { lo: 10, hi: 1000, dp: 0 },
  CRE: { lo: 0.1, hi: 25, dp: 1, delta: { pct: 50 } },
  GPT: { lo: 3, hi: 3000, dp: 0, delta: { pct: 100 } },
  CRP: { lo: 0.02, hi: 30, dp: 2, delta: { pct: 100 } },
  'T-BIL': { lo: 0.1, hi: 30, dp: 1, delta: { pct: 100 } },
}
/** delta check 只比 30 天內的上一次 */
export const DELTA_DAYS = 30

export const AUTO_RULE_LABEL: Record<AutoVerifyHold['rule'], string> = { qc: '品管', critical: '危急值', delta: '差異檢查', amr: '超出可測範圍' }

/** 一個 0–1 的固定亂數（同一個字串永遠一樣：示範資料與測試可重現，不用 Math.random） */
function unit(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return ((h >>> 0) % 10000) / 10000
}

/**
 * 模擬儀器回傳：有上一次的值（或重測時的這一次）就以它為準，沒有就取參考範圍中間；加 ±3% 的小波動（由 seed 決定）。
 * 測試、示範要特定數值時，服務層直接用指定值，不呼叫這裡
 */
export function simulateAnalyzer(defs: LabItemDef[], gender: Gender, base: Record<string, string | undefined>, seed: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const d of defs) {
    const a = ANALYZER_ITEMS[d.code]
    if (!a) continue
    const lo = gender === 'F' ? d.lowF ?? d.low : d.low
    const hi = gender === 'F' ? d.highF ?? d.high : d.high
    const b = Number(base[d.code])
    const mid = base[d.code] !== undefined && Number.isFinite(b) ? b : lo !== undefined && hi !== undefined ? (lo + hi) / 2 : hi !== undefined ? hi * 0.6 : (lo ?? 1) * 1.2
    const v = Math.min(a.hi, Math.max(a.lo, mid * (1 + (unit(`${seed}:${d.code}`) - 0.5) * 0.06)))
    out[d.code] = v.toFixed(a.dp)
  }
  return out
}

/**
 * 自動審核：回傳沒通過的規則（空陣列＝可以自動發報告）。
 * qc：這些項目今天品管沒做或被拒絕；prev：30 天內上一次的值
 */
export function autoVerify(x: { defs: LabItemDef[]; values: Record<string, string>; gender: Gender; prev: Record<string, string | undefined>; qcFailed: string[] }): AutoVerifyHold[] {
  const holds: AutoVerifyHold[] = []
  for (const d of x.defs) {
    const raw = x.values[d.code]
    const a = ANALYZER_ITEMS[d.code]
    if (x.qcFailed.includes(d.code)) holds.push({ rule: 'qc', code: d.code, text: `${d.name}今天品管沒通過` })
    if (raw === undefined || !a) continue
    const v = Number(raw)
    if (!Number.isFinite(v) || v < a.lo || v > a.hi) {
      holds.push({ rule: 'amr', code: d.code, text: `${d.name} ${raw} 超出儀器可測範圍（${a.lo}–${a.hi}），要稀釋重測或人工確認` })
      continue
    }
    const j = judgeLab(d, raw, x.gender)
    if (!('error' in j) && j.critical) holds.push({ rule: 'critical', code: d.code, text: `${d.name} ${raw} 是危急值，要人工確認後通知醫師` })
    const p = Number(x.prev[d.code])
    if (a.delta && x.prev[d.code] !== undefined && Number.isFinite(p)) {
      const diff = Math.abs(v - p)
      const over = (a.delta.abs !== undefined && diff > a.delta.abs) || (a.delta.pct !== undefined && p !== 0 && (diff / Math.abs(p)) * 100 > a.delta.pct)
      if (over) holds.push({ rule: 'delta', code: d.code, text: `${d.name} ${raw}，上次 ${x.prev[d.code]}：差異超過${a.delta.abs !== undefined ? ` ${a.delta.abs}` : ` ${a.delta.pct}%`}（檢體對不對、有沒有輸血或治療）` })
    }
  }
  return holds
}

/** 這些項目裡今天品管沒做或被拒絕的（沒有品管的項目不算） */
export const qcFailedCodes = (runs: Pick<QcRun, 'analyte' | 'date' | 'at' | 'result'>[], codes: string[], date: string) =>
  codes.filter((c) => qcAnalyte(c) && ['missing', 'reject'].includes(qcStatusToday(runs, c, date)))

/** 自動發報告比例（某段期間上機的結果） */
export function autoRate(rs: Pick<AnalyzerResult, 'status'>[]): { total: number; auto: number; pct: number } {
  const auto = rs.filter((r) => r.status === 'auto').length
  return { total: rs.length, auto, pct: rs.length ? Math.round((auto / rs.length) * 100) : 0 }
}
