// 檢驗儀器自動傳輸與自動審核的規則（純函式，畫面、服務層、測試共用）。
// 只做數值型、上儀器的項目（CBC、生化、電解質、血糖）；文字型（尿液、快篩、抗酸菌、培養）與血液氣體（床邊機）照舊人工登打。
// 自動審核：品管通過、沒有危急值、和 30 天內上一次差距在範圍內（delta check）、在儀器可測範圍內 → 直接發報告；
// 任一條沒過 → 待醫檢師審核（標出是哪一條、哪一項）
import type { AnalyzerResult, AutoVerifyHold, Gender, LabItemDef, QcRun, SerumIndices } from '@/types'
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

export const AUTO_RULE_LABEL: Record<AutoVerifyHold['rule'], string> = { qc: '品管', critical: '危急值', delta: '差異檢查', amr: '超出可測範圍', hil: '檢體品質' }

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
export function autoVerify(x: { defs: LabItemDef[]; values: Record<string, string>; gender: Gender; prev: Record<string, string | undefined>; qcFailed: string[]; indices?: SerumIndices }): AutoVerifyHold[] {
  const holds: AutoVerifyHold[] = x.indices ? hilHolds(x.defs, x.indices) : []
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

// ── 檢體品質指數（溶血、黃疸、脂血）：儀器量紅頭檢體的血清，超過門檻的話受影響的項目不能自動發出 ──

export type SerumIndex = keyof SerumIndices
export const HIL_LABEL: Record<SerumIndex, string> = { H: '溶血', I: '黃疸', L: '脂血' }
/** 門檻（統一一組）：溶血分輕度（≥ 50）、嚴重（≥ 200）；黃疸 ≥ 20、脂血 ≥ 500 */
export const HIL_LIMITS = { H: { mild: 50, severe: 200 }, I: 20, L: 500 } as const
/** 各項目會被哪個指數影響、往哪個方向（溶血：紅血球裡的鉀、GPT、膽紅素跑出來；黃疸干擾酵素法肌酸酐、膽固醇；脂血讓鈉、血糖、CRP 不準） */
export const HIL_AFFECTS: Record<string, Partial<Record<SerumIndex, string>>> = {
  K: { H: '可能偏高' },
  GPT: { H: '可能偏高' },
  'T-BIL': { H: '可能偏高' },
  CRE: { I: '可能偏低' },
  'T-CHO': { I: '可能偏低' },
  NA: { L: '可能偏低' },
  'GLU-AC': { L: '可能不準' },
  CRP: { L: '可能不準' },
}
/** 嚴重溶血時不能發（附註也不安全）的項目：只能退件重抽 */
export const HIL_BLOCK = ['K']

/** 超過門檻的指數 */
export const hilOver = (ix: SerumIndices): SerumIndex[] =>
  (['H', 'I', 'L'] as const).filter((k) => ix[k] >= (k === 'H' ? HIL_LIMITS.H.mild : HIL_LIMITS[k]))
export const hemolyzed = (ix: SerumIndices | undefined) => !!ix && ix.H >= HIL_LIMITS.H.mild
export const severeHemolysis = (ix: SerumIndices | undefined) => !!ix && ix.H >= HIL_LIMITS.H.severe
const ixText = (k: SerumIndex, ix: SerumIndices) => `${k === 'H' && ix.H >= HIL_LIMITS.H.severe ? '嚴重' : ''}${HIL_LABEL[k]}（${k} ${ix[k]}）`

/** 檢體品質沒通過的：受影響的每一項一條；嚴重溶血的鉀標 block（不能發） */
export function hilHolds(defs: Pick<LabItemDef, 'code' | 'name'>[], ix: SerumIndices): AutoVerifyHold[] {
  const over = hilOver(ix)
  const out: AutoVerifyHold[] = []
  for (const d of defs) {
    const ks = over.filter((k) => HIL_AFFECTS[d.code]?.[k])
    if (!ks.length) continue
    const block = HIL_BLOCK.includes(d.code) && severeHemolysis(ix) && ks.includes('H')
    out.push({
      rule: 'hil', code: d.code,
      text: `${d.name}受檢體${ks.map((k) => ixText(k, ix)).join('、')}影響，${ks.map((k) => HIL_AFFECTS[d.code][k]).join('、')}${block ? '：嚴重溶血不能發，請退件重抽' : '：退件重抽或附註發出'}`,
      ...(block ? { block: true as const } : {}),
    })
  }
  return out
}

/** 報告附註（醫檢師附註發出時寫在報告上）：沒有受影響的項目＝不用附註 */
export function hilNote(defs: Pick<LabItemDef, 'code' | 'name'>[], ix: SerumIndices | undefined): string | undefined {
  if (!ix) return undefined
  const parts = hilOver(ix).map((k) => {
    // 同方向的併在一起：「鉀、GPT 可能偏高」
    const dirs = new Map<string, string[]>()
    for (const d of defs) {
      const dir = HIL_AFFECTS[d.code]?.[k]
      if (dir) dirs.set(dir, [...(dirs.get(dir) ?? []), d.name])
    }
    return dirs.size ? `檢體${ixText(k, ix)}：${[...dirs].map(([dir, ns]) => `${ns.join('、')}${dir}`).join('、')}` : ''
  }).filter(Boolean)
  return parts.length ? parts.join('；') : undefined
}

/** 模擬儀器量的指數（同一個 seed 永遠一樣）：一般檢體都很低（H 3–25、I 0–3、L 5–65） */
export function simulateIndices(seed: string): SerumIndices {
  return { H: 3 + Math.round(unit(`${seed}:H`) * 22), I: Math.round(unit(`${seed}:I`) * 3), L: 5 + Math.round(unit(`${seed}:L`) * 60) }
}

/** 溶血率看幾天 */
export const HEMOLYSIS_DAYS = 30
/** 溶血率：量過指數的檢體裡，溶血（H ≥ 輕度門檻）的比例（同一支檢體算一次） */
export function hemolysisRate(rs: Pick<AnalyzerResult, 'barcode' | 'indices'>[]): { total: number; hemolyzed: number; pct: number } {
  const by = new Map<string, boolean>()
  for (const r of rs) if (r.indices) by.set(r.barcode, (by.get(r.barcode) ?? false) || hemolyzed(r.indices))
  const h = [...by.values()].filter(Boolean).length
  return { total: by.size, hemolyzed: h, pct: by.size ? Math.round((h / by.size) * 100) : 0 }
}

/** 這些項目裡今天品管沒做或被拒絕的（沒有品管的項目不算） */
export const qcFailedCodes = (runs: Pick<QcRun, 'analyte' | 'date' | 'at' | 'result'>[], codes: string[], date: string) =>
  codes.filter((c) => qcAnalyte(c) && ['missing', 'reject'].includes(qcStatusToday(runs, c, date)))

/** 自動發報告比例（某段期間上機的結果） */
export function autoRate(rs: Pick<AnalyzerResult, 'status'>[]): { total: number; auto: number; pct: number } {
  const auto = rs.filter((r) => r.status === 'auto').length
  return { total: rs.length, auto, pct: rs.length ? Math.round((auto / rs.length) * 100) : 0 }
}
