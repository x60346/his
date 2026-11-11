// 預防保健：資格查詢（規則在 prevent-rules.ts 的純函式）、今日待執行、服務紀錄、月統計。
import type { PreventItem, PreventRecord, Visit } from '@/types'
import { db, newId } from '@/mock/db'
import { now, today } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requireUser } from './http'
import { checkEligibility, checkPreventResult, withDerivedFields, type Eligibility } from './prevent-rules'
import { find, nameOf, patientBrief, visitView, type PatientBrief, type VisitView } from './views'

/** 提供中的項目（停用的項目不再判斷資格、不能登錄；歷史紀錄照常顯示） */
const activeItems = () => db.preventItems.filter((i) => i.active !== false)

export const listPreventItems = (): Promise<PreventItem[]> => query(() => db.preventItems)

export function eligibilityFor(patientId: string, at = today()): Promise<Eligibility[]> {
  return query(() => {
    const p = must(find.patient(patientId), '病患')
    return activeItems().map((item) => checkEligibility(p, item, db.preventRecords, at))
  })
}

/** 預防保健頁的病人資料（BFF）：病人資訊、各項資格、歷次紀錄一次取回，三者是同一時間點的結果 */
export interface PreventProfile {
  patient: PatientBrief
  eligibility: Eligibility[]
  records: PreventRecordView[]
}

export function getPreventProfile(patientId: string): Promise<PreventProfile> {
  return query(() => {
    const p = must(find.patient(patientId), '病患')
    return {
      patient: patientBrief(p.id),
      eligibility: activeItems().map((item) => checkEligibility(p, item, db.preventRecords, today())),
      records: db.preventRecords.filter((r) => r.patientId === p.id).sort((a, b) => b.date.localeCompare(a.date)).map(recordView),
    }
  })
}

// ---------- 今日待執行 ----------
export interface WorklistRow {
  visit: VisitView
  items: { code: string; name: string; done: boolean }[]
}

/** 這次就醫掛的預防保健項目，各自是否已登錄（同一病人、同一項目、就醫當天、未作廢）——工作清單與看診頁共用 */
function visitItems(v: Visit) {
  return v.preventItems.map((code) => {
    const rec = db.preventRecords.find((r) => !r.voided && r.patientId === v.patientId && r.itemCode === code && r.date === v.date)
    return { code, name: db.preventItems.find((i) => i.code === code)?.name ?? code, done: !!rec, result: rec?.result }
  })
}

/** 今天掛號時勾了預防保健的病人（掛號 → 預防保健的連動）。已登錄的項目標記為完成 */
export function todayWorklist(): Promise<WorklistRow[]> {
  return query(() => {
    const t = today()
    return db.visits
      .filter((v) => v.date === t && v.status !== 'cancelled' && v.preventItems.length)
      .map((v) => ({ visit: visitView(v), items: visitItems(v) }))
      .sort((a, b) => Number(a.items.every((i) => i.done)) - Number(b.items.every((i) => i.done)) || a.visit.createdAt.localeCompare(b.visit.createdAt))
  })
}

/**
 * 看診頁用：這次就醫的預防保健項目與登錄狀態，連同項目主檔（登錄框要依項目欄位顯示）。
 * 醫師在看診頁直接登錄，不必換到預防保健頁重找病人。
 */
export function visitPreventStatus(visitId: string): Promise<{ item: PreventItem; done: boolean; result?: PreventRecord['result'] }[]> {
  return query(() => {
    const v = must(find.visit(visitId), '掛號紀錄')
    return visitItems(v)
      .map((x) => ({ x, item: db.preventItems.find((i) => i.code === x.code) }))
      .filter((y): y is { x: typeof y.x; item: PreventItem } => !!y.item)
      .map(({ x, item }) => ({ item, done: x.done, result: x.result }))
  })
}

// ---------- 紀錄 ----------
export interface PreventRecordView extends PreventRecord, PatientBrief {
  itemName: string
  doctorName: string
  /** 作廢人姓名（有作廢時） */
  voidedByName?: string
}

/** 紀錄查詢（例：待補登報告）。作廢的紀錄預設不列出；病人的歷次紀錄（getPreventProfile）則照常顯示作廢紀錄 */
export function listPreventRecords(q: { patientId?: string; itemCode?: string; from?: string; to?: string; result?: PreventRecord['result']; includeVoided?: boolean } = {}): Promise<PreventRecordView[]> {
  return query(() =>
    db.preventRecords
      .filter(
        (r) =>
          (q.includeVoided || !r.voided) &&
          (!q.patientId || r.patientId === q.patientId) &&
          (!q.itemCode || r.itemCode === q.itemCode) &&
          (!q.from || r.date >= q.from) &&
          (!q.to || r.date <= q.to) &&
          (!q.result || r.result === q.result),
      )
      .sort((a, b) => b.date.localeCompare(a.date))
      .map(recordView),
  )
}

function recordView(r: PreventRecord): PreventRecordView {
  return {
    ...r,
    ...patientBrief(r.patientId),
    itemName: db.preventItems.find((i) => i.code === r.itemCode)?.name ?? r.itemCode,
    doctorName: nameOf.doctor(r.doctorId),
    voidedByName: r.voided ? nameOf.user(r.voided.by) : undefined,
  }
}

export type PreventRecordInput = Pick<PreventRecord, 'patientId' | 'itemCode' | 'result' | 'data'> & { visitId?: string; doctorId?: string }

export function addPreventRecord(input: PreventRecordInput): Promise<PreventRecord> {
  return mutate(() => {
    const user = requireUser('doctor', 'nurse')
    const p = must(find.patient(input.patientId), '病患')
    const item = must(db.preventItems.find((i) => i.code === input.itemCode), '預防保健項目')
    if (item.active === false) fail(`「${item.name}」已停止提供`)
    const t = today()

    // 寫入前再檢查一次資格：畫面上的「可做」是查詢當下的判斷，送出時可能已經不成立（例如另一個櫃台剛登錄）
    const el = checkEligibility(p, item, db.preventRecords, t)
    if (!el.eligible) fail(`${p.name} 目前不符合「${item.name}」資格：${el.reason}`, 'CONFLICT')

    // 執行醫師：醫師登錄就是自己；護理師登錄必須指定。不可以默默補一個預設醫師——那是捏造紀錄
    const doctorId = user.role === 'doctor' ? user.doctorId : input.doctorId
    // 執行醫師、結果、檢查內容一起檢查，所有問題一次標出
    failFields({
      ...(!doctorId || !find.doctor(doctorId) ? { doctorId: '請選擇執行醫師' } : {}),
      ...checkPreventResult(item, input.result, input.data, { allowPending: true }),
    })
    if (input.visitId) {
      const v = must(find.visit(input.visitId), '掛號紀錄')
      if (v.patientId !== p.id || v.date !== t) fail('掛號紀錄與病人或日期不符')
    }
    // 只保留有填的欄位
    // BMI 等衍生欄位由系統計算（見 withDerivedFields）
    const data = withDerivedFields(Object.fromEntries(Object.entries(input.data ?? {}).map(([k, v]) => [k, String(v).trim()]).filter(([, v]) => v)))

    const r: PreventRecord = { id: newId('PR'), patientId: p.id, itemCode: item.code, date: t, visitId: input.visitId, doctorId: doctorId!, result: input.result, data }
    db.preventRecords.push(r)
    audit('預防保健服務', `${p.name} ${item.name} ${input.result}`)
    return r
  })
}

/** 補登報告：只有「待報告」的紀錄可以補，補一次就定案（紀錄只能增補，不能改寫） */
export function fillReport(recordId: string, result: PreventRecord['result'], data: Record<string, string>): Promise<PreventRecord> {
  return mutate(() => {
    requireUser('doctor', 'nurse')
    const r = must(db.preventRecords.find((x) => x.id === recordId), '預防保健紀錄')
    if (r.voided) fail('此紀錄已作廢，不能補登報告', 'CONFLICT')
    if (r.result !== '待報告') fail('此紀錄已有結果，不可修改', 'CONFLICT')
    // 和登錄同一條規則：定案的結果，欄位都要填（補登時不能再選「待報告」）
    const item = must(db.preventItems.find((i) => i.code === r.itemCode), '預防保健項目')
    failFields(checkPreventResult(item, result, data, { allowPending: false }))
    const filled = withDerivedFields(Object.fromEntries(Object.entries(data ?? {}).map(([k, v]) => [k, String(v).trim()]).filter(([, v]) => v)))
    r.result = result
    r.data = { ...r.data, ...filled }
    r.reportedAt = now()
    // 稽核一律寫中文項目名稱（和登錄、作廢一致；以前寫代碼 CERVIX，非工程人員看不懂）
    audit('補登預防保健報告', `${nameOf.patient(r.patientId)} ${item.name} ${result}`)
    return r
  })
}

/**
 * 作廢：登錄錯誤（選錯病人、選錯項目、數值打錯）時使用。
 * 紀錄只能增補不能改寫——不刪除、不修改原內容，只加上作廢註記（原因、時間、作廢人）並寫入稽核。
 * 作廢後不佔資格（可重新登錄正確的一筆）、不計統計、不能補登報告。
 */
export function voidPreventRecord(recordId: string, reason: string): Promise<PreventRecord> {
  return mutate(() => {
    const u = requireUser('doctor', 'nurse')
    const r = must(db.preventRecords.find((x) => x.id === recordId), '預防保健紀錄')
    if (r.voided) fail('此紀錄已經作廢', 'CONFLICT')
    if (!reason?.trim()) failField('reason', '請填寫作廢原因')
    r.voided = { reason: reason.trim(), at: now(), by: u.id }
    const itemName = db.preventItems.find((i) => i.code === r.itemCode)?.name ?? r.itemCode
    audit('作廢預防保健紀錄', `${nameOf.patient(r.patientId)} ${itemName}（${r.date}，${r.result}）：${reason.trim()}`)
    return r
  })
}

// ---------- 統計 ----------
export interface PreventStat {
  code: string
  name: string
  count: number
  abnormal: number
  pending: number
}

/** 某月（YYYY-MM）各項目服務人次 */
export function monthlyStats(month: string): Promise<PreventStat[]> {
  return query(() =>
    db.preventItems.map((i) => {
      const list = db.preventRecords.filter((r) => !r.voided && r.itemCode === i.code && r.date.startsWith(month))
      return {
        code: i.code,
        name: i.name,
        count: list.length,
        abnormal: list.filter((r) => r.result === '異常需追蹤').length,
        pending: list.filter((r) => r.result === '待報告').length,
      }
    }),
  )
}
