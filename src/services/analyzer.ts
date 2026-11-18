// 檢驗儀器（醫檢師）：收件後的檢體掃條碼「上機」→ 儀器回傳數值（展示用模擬：依上一次的值加小波動）→ 自動審核（analyzer-rules）：
// 品管通過、沒有危急值、和上次差距在範圍、在儀器可測範圍 → 直接發報告（標「自動審核」）；沒過的進「待審核」，標出哪一條、哪一項，
// 醫檢師看過後「確認發出」（可改值）或「重測」（同一支檢體再跑一次，舊值留著）。只做數值型、上儀器的項目，其他照舊人工登打。
// 發報告走和人工登打同一條路（lab-issue）：採檢、收件、品管、單號、稽核都一樣
import type { AnalyzerResult, AutoVerifyHold, LabFlag } from '@/types'
import { db, newId } from '@/mock/db'
import { addDays, now } from '@/utils/date'
import { audit, fail, must, mutate, query, requireUser } from './http'
import { find, nameOf } from './views'
import { autoRate, autoVerify, DELTA_DAYS, isAnalyzerProc, qcFailedCodes, simulateAnalyzer } from './analyzer-rules'
import { judgeLab, labRefText } from './lab-rules'
import { issueLabReport } from './lab-issue'
import { pendingLabWork, procItems, type LabWorkItem } from './lab-work'

/** 這支檢體驗哪些（待檢驗的 key） */
const keysOf = (s: { opdKeys?: string[]; orderIds: string[] }) => s.opdKeys ?? s.orderIds.map((id) => `O:${id}`)
/** 30 天內這位病人每個項目的上一次值（delta check 用） */
function prevValues(patientId: string, t: string): Record<string, { value: string; at: string }> {
  const since = `${addDays(t.slice(0, 10), -DELTA_DAYS)} ${t.slice(11)}`
  const out: Record<string, { value: string; at: string }> = {}
  for (const r of db.labReports.filter((x) => x.patientId === patientId && x.reportedAt >= since && x.reportedAt <= t).sort((a, b) => a.reportedAt.localeCompare(b.reportedAt))) {
    for (const v of r.values) out[v.code] = { value: v.value, at: r.reportedAt }
  }
  return out
}
const flat = (p: Record<string, { value: string }>) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.value]))
const qcFailed = (codes: string[]) => qcFailedCodes(db.qcRuns, codes, now().slice(0, 10))
const active = (key: string) => db.analyzerResults.find((x) => x.key === key && (x.status === 'held' || x.status === 'auto'))
/** 可以上機：收件了、還沒發報告、上儀器的項目、還沒上過機 */
const loadable = (w: LabWorkItem) => !w.awaitingCollection && w.awaitingReceipt === undefined && isAnalyzerProc(w.procId) && !active(w.key)

export interface AnalyzerRow {
  code: string
  name: string
  unit?: string
  value: string
  ref: string
  flag: LabFlag
  critical: boolean
  prev?: { value: string; at: string }
  /** 這一項沒過的規則 */
  holds: string[]
}
export interface AnalyzerHeldView {
  id: string
  key: string
  barcode: string
  patientName: string
  chartNo: string
  where: string
  procName: string
  loadedAt: string
  holds: AutoVerifyHold[]
  rows: AnalyzerRow[]
  reruns: { at: string; values: Record<string, string> }[]
}
export interface AnalyzerLoadable {
  barcode: string
  patientName: string
  where: string
  tests: string[]
}
export interface AnalyzerBoard {
  toLoad: AnalyzerLoadable[]
  held: AnalyzerHeldView[]
  /** 今天上機的：總數、自動發報告數、比例 */
  today: { total: number; auto: number; pct: number }
  /** 今天自動發出的（新的在前） */
  autoToday: { no: string; patientName: string; procName: string; at: string }[]
}

function heldView(x: AnalyzerResult): AnalyzerHeldView {
  const p = find.patient(x.patientId)
  const g = p?.gender ?? 'M'
  const prev = prevValues(x.patientId, x.loadedAt)
  const w = pendingLabWork().find((v) => v.key === x.key)
  return {
    id: x.id, key: x.key, barcode: x.barcode, patientName: p?.name ?? '', chartNo: p?.chartNo ?? '', where: w?.where ?? '', procName: find.procedure(x.procId)?.name ?? x.procId, loadedAt: x.loadedAt, holds: x.holds,
    rows: procItems(x.procId).map((d) => {
      const j = judgeLab(d, x.values[d.code] ?? '', g)
      return {
        code: d.code, name: d.name, ...(d.unit ? { unit: d.unit } : {}), value: x.values[d.code] ?? '', ref: labRefText(d, g), flag: 'error' in j ? '' : j.flag, critical: 'error' in j ? false : j.critical,
        ...(prev[d.code] ? { prev: prev[d.code] } : {}), holds: x.holds.filter((h) => h.code === d.code).map((h) => h.text),
      }
    }),
    reruns: x.reruns ?? [],
  }
}

/** 儀器畫面：待上機的檢體、待審核、今天自動發報告的比例 */
export function analyzerBoard(): Promise<AnalyzerBoard> {
  return query(() => {
    requireUser('lab')
    const work = pendingLabWork().filter(loadable)
    const toLoad: AnalyzerLoadable[] = []
    for (const s of db.specimens.filter((s) => s.receivedAt && !s.rejected)) {
      const ws = work.filter((w) => keysOf(s).includes(w.key))
      if (ws.length) toLoad.push({ barcode: s.barcode, patientName: ws[0].patientName, where: ws[0].where, tests: ws.map((w) => w.procName) })
    }
    const d = now().slice(0, 10)
    const todays = db.analyzerResults.filter((x) => x.loadedAt.startsWith(d))
    return {
      toLoad,
      held: db.analyzerResults.filter((x) => x.status === 'held').sort((a, b) => a.loadedAt.localeCompare(b.loadedAt)).map(heldView),
      today: autoRate(todays),
      autoToday: todays.filter((x) => x.status === 'auto' && x.reportId).sort((a, b) => b.loadedAt.localeCompare(a.loadedAt)).map((x) => ({ no: db.labReports.find((r) => r.id === x.reportId)?.no ?? '', patientName: nameOf.patient(x.patientId), procName: find.procedure(x.procId)?.name ?? '', at: x.loadedAt })),
    }
  })
}

/**
 * 上機（掃條碼）：這支檢體上儀器的項目各跑一次 → 自動審核 → 通過的直接發報告、沒過的進待審核。
 * values：指定儀器回傳的數值（依醫令；測試、示範用），沒給就模擬
 */
export function loadAnalyzer(barcode: string, values?: Record<string, Record<string, string>>): Promise<{ auto: number; held: number; results: AnalyzerResult[] }> {
  return mutate(() => {
    const u = requireUser('lab')
    const s = must(db.specimens.find((x) => x.barcode === barcode?.trim()), '檢體（條碼）')
    if (s.rejected) fail('這支檢體已退件', 'CONFLICT')
    if (!s.receivedAt) fail('這支檢體還沒收件，請先掃條碼收件', 'CONFLICT')
    const ws = pendingLabWork().filter((w) => keysOf(s).includes(w.key) && loadable(w))
    if (!ws.length) fail('這支檢體沒有要上機的檢驗（已發報告、已上機，或是要人工登打的項目）', 'CONFLICT')
    const t = now()
    const out: AnalyzerResult[] = []
    for (const w of ws) {
      const defs = procItems(w.procId)
      const prev = flat(prevValues(w.patientId, t))
      const vals = values?.[w.procId] ?? simulateAnalyzer(defs, w.gender, prev, `${s.barcode}:${w.key}`)
      const holds = autoVerify({ defs, values: vals, gender: w.gender, prev, qcFailed: qcFailed(defs.map((d) => d.code)) })
      const x: AnalyzerResult = { id: newId('AR'), key: w.key, barcode: s.barcode, patientId: w.patientId, procId: w.procId, values: vals, holds, status: holds.length ? 'held' : 'auto', loadedAt: t, loadedBy: u.id }
      if (!holds.length) x.reportId = issueLabReport(w.key, vals, u, { auto: true }).id
      db.analyzerResults.push(x)
      out.push(x)
    }
    const auto = out.filter((x) => x.status === 'auto').length
    audit('檢驗儀器上機', `${s.barcode} ${nameOf.patient(s.patientId)}：${out.map((x) => `${find.procedure(x.procId)?.name}${x.status === 'auto' ? '（自動發出）' : '（待審核）'}`).join('、')}`)
    return { auto, held: out.length - auto, results: out }
  })
}

/** 審核後發出：醫檢師看過（可改值）→ 發報告；品管沒過一樣擋（同人工登打） */
export function releaseAnalyzer(id: string, values?: Record<string, string>): Promise<AnalyzerResult> {
  return mutate(() => {
    const u = requireUser('lab')
    const x = must(db.analyzerResults.find((v) => v.id === id), '儀器結果')
    if (x.status !== 'held') fail('這筆已經發出了', 'CONFLICT')
    const vals = values ?? x.values
    const r = issueLabReport(x.key, vals, u, { analyzer: true })
    Object.assign(x, { values: vals, status: 'released', reportId: r.id, releasedAt: r.reportedAt, releasedBy: u.id })
    return x
  })
}

/** 重測：同一支檢體再跑一次（舊值留在 reruns），重新跑自動審核；結果仍要醫檢師確認發出 */
export function rerunAnalyzer(id: string, values?: Record<string, string>): Promise<AnalyzerResult> {
  return mutate(() => {
    const u = requireUser('lab')
    const x = must(db.analyzerResults.find((v) => v.id === id), '儀器結果')
    if (x.status !== 'held') fail('這筆已經發出了', 'CONFLICT')
    const p = must(find.patient(x.patientId), '病患')
    const defs = procItems(x.procId)
    const t = now()
    ;(x.reruns ??= []).push({ at: t, values: x.values })
    x.values = values ?? simulateAnalyzer(defs, p.gender, x.values, `${x.barcode}:${x.key}:r${x.reruns.length}`)
    x.holds = autoVerify({ defs, values: x.values, gender: p.gender, prev: flat(prevValues(x.patientId, x.loadedAt)), qcFailed: qcFailed(defs.map((d) => d.code)) })
    audit('檢驗儀器重測', `${x.barcode} ${p.name} ${find.procedure(x.procId)?.name}（第 ${x.reruns.length} 次重測，操作 ${nameOf.user(u.id)}）`)
    return x
  })
}
