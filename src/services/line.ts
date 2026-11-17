// 管路（導尿管、中心靜脈導管、周邊留置針、鼻胃管）：護理師或醫師登錄放置、每天評估還需要嗎（導尿管、CVC）、移除寫原因；
// 病房層級的管路日統計。提醒（滿 7 天、留置針滿 96 小時、今天還沒評估）只提醒不擋。規則在 line-rules
import type { LineDevice, LineKind } from '@/types'
import { db, newId } from '@/mock/db'
import { addDays, now, today } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requireUser } from './http'
import { find, nameOf } from './views'
import { INFECTION_KINDS, per1000 } from './infection-rules'
import { checkLineInput, LINE_KINDS, LINE_REMOVE_REASONS, lineDays, lineKind, lineState, type LineState } from './line-rules'

export interface LineView extends LineDevice {
  label: string
  state: LineState
  recordedByName: string
  removedByName?: string
  needChecks: (NonNullable<LineDevice['needChecks']>[number] & { byName: string })[]
}

const lineView = (l: LineDevice, t: string): LineView => ({
  ...l, label: lineKind(l.kind).label, state: lineState(l, t), recordedByName: nameOf.user(l.recordedBy),
  ...(l.removedBy ? { removedByName: nameOf.user(l.removedBy) } : {}),
  needChecks: (l.needChecks ?? []).map((c) => ({ ...c, byName: nameOf.user(c.by) })),
})

const admittedOf = (admissionId: string) => {
  const a = must(find.admission(admissionId), '住院紀錄')
  if (a.status !== 'admitted') fail('病人目前不在住院中', 'CONFLICT')
  return a
}

/** 這位病人的管路：在身上的（放最久的在前）、已移除的（最近的在前） */
export function listLines(admissionId: string): Promise<{ active: LineView[]; removed: LineView[] }> {
  return query(() => {
    requireUser('nurse', 'doctor')
    const t = now()
    const mine = db.lines.filter((l) => l.admissionId === admissionId)
    return {
      active: mine.filter((l) => !l.removedAt).sort((a, b) => a.insertedAt.localeCompare(b.insertedAt)).map((l) => lineView(l, t)),
      removed: mine.filter((l) => l.removedAt).sort((a, b) => b.removedAt!.localeCompare(a.removedAt!)).map((l) => lineView(l, t)),
    }
  })
}

export interface LineInput {
  admissionId: string
  kind: LineKind
  site: string
  size: string
  /** YYYY-MM-DD HH:mm（外院或稍早放的可以補登） */
  insertedAt: string
  placedBy: string
}

/** 登錄放置：同一種管路同時只能一條（周邊留置針可以多條） */
export function addLine(input: LineInput): Promise<LineView> {
  return mutate(() => {
    const u = requireUser('nurse', 'doctor')
    const a = admittedOf(input.admissionId)
    const t = now()
    failFields(checkLineInput(input, t))
    if (a.admittedAt && input.insertedAt < addDays(a.admittedAt.slice(0, 10), -30)) failField('insertedAt', '放置時間太早（入院前 30 天以上）')
    if (input.kind !== 'pivc' && db.lines.some((l) => l.admissionId === a.id && l.kind === input.kind && !l.removedAt)) fail(`已經有一條${lineKind(input.kind).label}，要換新的請先移除舊的（原因「到期更換」）`, 'CONFLICT')
    const l: LineDevice = { id: newId('LN'), admissionId: a.id, kind: input.kind, site: input.site.trim(), size: input.size.trim(), insertedAt: input.insertedAt, placedBy: input.placedBy.trim(), recordedBy: u.id, recordedAt: t }
    db.lines.push(l)
    audit('管路放置', `${a.admitNo} ${nameOf.patient(a.patientId)}：${lineKind(l.kind).label} ${l.site} ${l.size}（${l.insertedAt}，${l.placedBy}）`)
    return lineView(l, t)
  })
}

/** 每天評估「還需要嗎」（導尿管、CVC）：同一天可以改（取最後一次）；說不需要的，看板提醒移除 */
export function checkLineNeed(lineId: string, needed: boolean, note = ''): Promise<LineView> {
  return mutate(() => {
    const u = requireUser('nurse', 'doctor')
    const l = must(db.lines.find((x) => x.id === lineId), '管路')
    admittedOf(l.admissionId)
    if (l.removedAt) fail('已經移除了', 'CONFLICT')
    if (!lineKind(l.kind).dailyNeed) fail(`${lineKind(l.kind).label}不用每天評估`)
    if (!needed && !note.trim()) failField('note', '可以移除：請寫依據（例：已可自解、改口服）')
    const t = now()
    ;(l.needChecks ??= []).push({ date: today(), at: t, by: u.id, needed, ...(note.trim() ? { note: note.trim() } : {}) })
    audit('管路評估', `${nameOf.patient(find.admission(l.admissionId)?.patientId)} ${lineKind(l.kind).label}：${needed ? '還需要' : '可以移除'}${note.trim() ? `（${note.trim()}）` : ''}`)
    return lineView(l, t)
  })
}

/** 移除：原因必填（「其他」要寫說明） */
export function removeLine(lineId: string, reason: string, note = ''): Promise<LineView> {
  return mutate(() => {
    const u = requireUser('nurse', 'doctor')
    const l = must(db.lines.find((x) => x.id === lineId), '管路')
    if (l.removedAt) fail('已經移除了', 'CONFLICT')
    if (!LINE_REMOVE_REASONS.includes(reason)) failField('reason', '請選移除原因')
    if (reason === '其他' && !note.trim()) failField('note', '請寫說明')
    const t = now()
    Object.assign(l, { removedAt: t, removedBy: u.id, removeReason: reason === '其他' ? `其他：${note.trim()}` : note.trim() ? `${reason}（${note.trim()}）` : reason })
    audit('管路移除', `${nameOf.patient(find.admission(l.admissionId)?.patientId)} ${lineKind(l.kind).label} ${l.site}：${l.removeReason}`)
    return lineView(l, t)
  })
}

export interface WardLineStats {
  from: string
  to: string
  /** 住院人日（分母參考）與各種管路的管路日、目前在身上的條數、期間內移除的原因 */
  patientDays: number
  rows: { kind: LineKind; label: string; lineDays: number; active: number; utilization: number | null; removed: Record<string, number>; infections?: number; infectionRate?: number | null }[]
}

/** 病房管路日統計（最近 days 天，含今天）：依病人現在住哪個病房（轉床前在別病房的也算在這裡，簡化） */
export function wardLineStats(ward: string, days = 30): Promise<WardLineStats> {
  return query(() => {
    requireUser('nurse', 'doctor', 'admin')
    const to = today()
    const from = addDays(to, -(days - 1))
    const adms = db.admissions.filter((a) => a.bedId && find.bed(a.bedId)?.ward === ward && a.admittedAt && a.status !== 'cancelled')
    const ids = new Set(adms.map((a) => a.id))
    const patientDays = adms.reduce((n, a) => n + lineDays({ insertedAt: a.admittedAt!, removedAt: a.dischargedAt }, from, to), 0)
    const rows = LINE_KINDS.map((k) => {
      const ls = db.lines.filter((l) => ids.has(l.admissionId) && l.kind === k.kind)
      const ld = ls.reduce((n, l) => n + lineDays(l, from, to), 0)
      const removed: Record<string, number> = {}
      for (const l of ls.filter((x) => x.removedAt && x.removedAt.slice(0, 10) >= from)) {
        const r = (l.removeReason ?? '').split(/[：（]/)[0]
        removed[r] = (removed[r] ?? 0) + 1
      }
      // 院內感染（判定成立、期間內發生、那條管路）：導尿管→CAUTI、CVC→CLABSI，每千管路日幾例
      const inf = INFECTION_KINDS.find((x) => x.line === k.kind)
      const cases = inf ? db.infectionCases.filter((c) => c.kind === inf.kind && c.status === 'confirmed' && c.onsetAt >= from && c.onsetAt <= to && ls.some((l) => l.id === c.lineId)).length : 0
      return { kind: k.kind, label: k.label, lineDays: ld, active: ls.filter((l) => !l.removedAt).length, utilization: patientDays ? Math.round((ld / patientDays) * 1000) / 1000 : null, removed, ...(inf ? { infections: cases, infectionRate: per1000(cases, ld) } : {}) }
    })
    return { from, to, patientDays, rows }
  })
}
