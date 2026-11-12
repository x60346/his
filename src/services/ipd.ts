// 住院醫囑與病程紀錄。
// 開立長期給藥醫囑時依頻率的給藥時間點產生 MAR（給藥排程），護理站立即看得到。
import type { DischargeSummary, IpdOrder, MarRecord, ProgressNote } from '@/types'
import { commitIfPossible, db, newId } from '@/mock/db'
import { addDays, now } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requireUser } from './http'
import { doseLevel, doseNote } from './dose-rules'
import { doseUnitOf } from './billing'
import { find, nameOf, usable } from './views'
import { openQuery } from './nursing-rules'

function activeAdmission(admissionId: string) {
  const a = must(find.admission(admissionId), '住院紀錄')
  if (a.status !== 'admitted') fail('病人目前不在住院中', 'CONFLICT')
  return a
}

/** 補齊某日的給藥排程（只處理有固定時間點的長期給藥醫囑），回傳是否有新增。服務層內部使用 */
export function ensureMar(admissionId: string, date: string): boolean {
  let added = false
  const orders = db.ipdOrders.filter((o) => o.admissionId === admissionId && o.category === 'medication' && o.type === 'long')
  for (const o of orders) {
    const times = find.freq(o.freq ?? '')?.times ?? []
    for (const t of times) {
      const at = `${date} ${t}`
      if (at < o.startAt || (o.stopAt && at >= o.stopAt)) continue
      if (db.mar.some((m) => m.orderId === o.id && m.scheduledAt === at)) continue
      db.mar.push({ id: newId('MAR'), orderId: o.id, admissionId, scheduledAt: at, status: 'pending' })
      added = true
    }
  }
  return added
}

export interface OrderView extends IpdOrder {
  /** 護理師的疑問（待醫師回覆）；醫師在醫囑上看到原因與提問的人 */
  pendingQuery?: { reason: string; byName: string; at: string }
  doctorName: string
  highAlert: boolean
  freqLabel: string
  /** 劑量單位：醫囑上的劑量必須帶單位，「1」不知道是 1 瓶還是 1 克 */
  unit: string
}

export const orderView = (o: IpdOrder): OrderView => {
  const drug = o.drugId ? find.drug(o.drugId) : undefined
  const q = openQuery(o)
  return {
    ...o,
    ...(q ? { pendingQuery: { reason: q.reason, byName: nameOf.user(q.by), at: q.at } } : {}),
    doctorName: nameOf.doctor(o.doctorId),
    highAlert: drug?.highAlert ?? false,
    freqLabel: o.freq ? find.freq(o.freq)?.label ?? o.freq : '',
    unit: drug ? doseUnitOf(drug) : '',
  }
}

export function listOrders(admissionId: string): Promise<OrderView[]> {
  return query(() =>
    db.ipdOrders
      .filter((o) => o.admissionId === admissionId)
      .sort((a, b) => Number(a.status !== 'active') - Number(b.status !== 'active') || b.createdAt.localeCompare(a.createdAt))
      .map(orderView),
  )
}

export type OrderInput = Pick<IpdOrder, 'admissionId' | 'type' | 'category' | 'drugId' | 'procId' | 'content' | 'dose' | 'freq' | 'route'> & {
  /** 已有執行中的同藥醫囑時，醫師確認仍要再開一筆 */
  allowDuplicate?: boolean
  /** 劑量偏高時，醫師確認無誤 */
  confirmHighDose?: boolean
}

/** 這位病人執行中的同藥醫囑（重複開立前要先讓醫師看到） */
export function activeSameDrug(admissionId: string, drugId: string): IpdOrder[] {
  return db.ipdOrders.filter((o) => o.admissionId === admissionId && o.drugId === drugId && o.status === 'active')
}

/** 頁面送出前查詢：已有哪些執行中的同藥醫囑 */
export function listActiveSameDrug(admissionId: string, drugId: string): Promise<OrderView[]> {
  return query(() => activeSameDrug(admissionId, drugId).map(orderView))
}

export function addOrder(input: OrderInput): Promise<OrderView> {
  return mutate(() => {
    const user = requireUser('doctor')
    const a = activeAdmission(input.admissionId)
    const t = now()
    let content = input.content.trim()

    if (input.category === 'medication') {
      const drug = usable.drug(input.drugId ?? '')
      if (!input.dose || input.dose <= 0) fail('請輸入劑量')
      const level = doseLevel(drug, input.dose)
      if (level === 'absurd') failField('dose', `${doseNote(drug, input.dose)}，請確認是否打錯`)
      if (level === 'high' && !input.confirmHighDose) fail(`劑量偏高：${doseNote(drug, input.dose)}，如確定請確認`, 'CONFLICT')
      if (!input.freq || !find.freq(input.freq)) fail('請選擇頻率')
      if (input.type === 'long' && input.freq === 'STAT') fail('STAT 請改用臨時醫囑')
      // 重複開立同一種藥：可能是忘了已開過（病人會被給兩倍劑量），也可能是刻意加開。
      // 不直接禁止，但必須由醫師明確確認——頁面會先列出既有醫囑讓醫師判斷
      const dup = activeSameDrug(a.id, drug.id)
      if (dup.length && !input.allowDuplicate) {
        fail(`病人已有執行中的 ${drug.name}（${dup.map((o) => `每次 ${o.dose} ${doseUnitOf(drug)} ${o.freq}`).join('、')}），如確定要再開一筆請確認`, 'CONFLICT')
      }
      content = content || drug.name
    } else if (input.category === 'procedure') {
      const proc = usable.procedure(input.procId ?? '')
      content = content || proc.name
    } else if (!content) {
      fail('請輸入醫囑內容')
    }

    // allowDuplicate 是「這次送出的確認」，不是醫囑本身的資料，不能存進資料庫
    const { allowDuplicate: _dup, confirmHighDose: _high, ...fields } = input
    const o: IpdOrder = {
      ...fields,
      content,
      id: newId('IO'),
      startAt: t,
      status: 'active',
      doctorId: user.doctorId ?? a.doctorId,
      createdAt: t,
    }
    // 同一時間只能有一種飲食：開立新的長期飲食醫囑時，自動停止舊的（否則廚房不知道該送哪一種）
    if (o.category === 'diet' && o.type === 'long') {
      for (const old of db.ipdOrders.filter((x) => x.admissionId === a.id && x.category === 'diet' && x.type === 'long' && x.status === 'active')) {
        old.status = 'stopped'
        old.stopAt = t
      }
    }
    db.ipdOrders.push(o)

    if (o.category === 'medication') {
      if (o.type === 'long') {
        // 今天剩下的時間點 + 明天，讓護理站跨夜也有排程
        ensureMar(a.id, t.slice(0, 10))
        ensureMar(a.id, addDays(t, 1))
      } else {
        db.mar.push({ id: newId('MAR'), orderId: o.id, admissionId: a.id, scheduledAt: t, status: 'pending' })
      }
    }
    audit('開立住院醫囑', `${a.admitNo} ${content}`)
    return orderView(o)
  })
}

/** 停止醫囑：之後尚未執行的給藥排程一併刪除 */
export function stopOrder(orderId: string): Promise<OrderView> {
  return mutate(() => {
    const user = requireUser('doctor')
    const o = must(db.ipdOrders.find((x) => x.id === orderId), '醫囑')
    if (o.status !== 'active') fail('此醫囑已停止或完成')
    const t = now()
    o.status = 'stopped'
    o.stopAt = t
    db.mar = db.mar.filter((m) => !(m.orderId === o.id && m.status === 'pending'))
    // 有疑問的醫囑被停止：疑問就此解決（醫師通常會另開正確的一筆）
    const q = openQuery(o)
    if (q) Object.assign(q, { replyBy: user.id, replyAt: t, reply: '已停止此醫囑', resolution: 'stopped' })
    audit('停止住院醫囑', `${o.content}${q ? `（回覆護理師疑問：${q.reason}）` : ''}`)
    return orderView(o)
  })
}

export interface MarView extends MarRecord {
  /** 醫囑有疑問、待醫師回覆：給藥暫停（緊急時寫原因強制） */
  queried?: string
  content: string
  dose?: number
  unit: string
  route?: string
  freq?: string
  /** 長期排程或臨時（STAT）給藥 */
  orderType: IpdOrder['type']
  highAlert: boolean
  nurseName: string
}

/** 組出某日的給藥紀錄檢視（服務層內部共用：不補排程、不包 query） */
export function marViews(admissionId: string, date: string): MarView[] {
  return db.mar
    .filter((m) => m.admissionId === admissionId && m.scheduledAt.startsWith(date))
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
    .map((m) => {
      const o = db.ipdOrders.find((x) => x.id === m.orderId)
      const d = o?.drugId ? find.drug(o.drugId) : undefined
      const q = o ? openQuery(o) : undefined
      return {
        ...m,
        ...(q && m.status === 'pending' ? { queried: q.reason } : {}),
        content: o?.content ?? '',
        dose: o?.dose,
        unit: d ? doseUnitOf(d) : '',
        route: o?.route,
        freq: o?.freq,
        orderType: o?.type ?? 'long',
        highAlert: d?.highAlert ?? false,
        nurseName: nameOf.user(m.nurseId),
      }
    })
}

/** 讀取某日給藥紀錄；必要時補產生排程 */
export function listMar(admissionId: string, date: string): Promise<MarView[]> {
  return query(() => {
    if (ensureMar(admissionId, date)) commitIfPossible()
    return marViews(admissionId, date)
  })
}

export function listProgressNotes(admissionId: string): Promise<(ProgressNote & { doctorName: string })[]> {
  return query(() =>
    db.progressNotes
      .filter((n) => n.admissionId === admissionId)
      .sort((a, b) => b.at.localeCompare(a.at))
      .map((n) => ({ ...n, doctorName: nameOf.doctor(n.doctorId) })),
  )
}

export function addProgressNote(input: Pick<ProgressNote, 'admissionId' | 'subjective' | 'objective' | 'assessment' | 'plan'>): Promise<ProgressNote> {
  return mutate(() => {
    const user = requireUser('doctor')
    const a = activeAdmission(input.admissionId)
    if (![input.subjective, input.objective, input.assessment, input.plan].some((x) => x.trim())) fail('病程紀錄不可空白')
    const n: ProgressNote = { ...input, id: newId('PN'), at: now(), doctorId: user.doctorId ?? a.doctorId }
    db.progressNotes.push(n)
    audit('病程紀錄', a.admitNo)
    return n
  })
}

// ---------- 出院病摘（醫師） ----------
export type DischargeSummaryInput = Pick<DischargeSummary, 'diagnosis' | 'course' | 'condition' | 'followUp' | 'dischargeType'>

/** 簽署前的必填檢查：一次列出所有空白欄位 */
export function dischargeSummaryProblems(input: DischargeSummaryInput): Record<string, string> {
  const e: Record<string, string> = {}
  if (!input.diagnosis.trim()) e.diagnosis = '請填寫出院診斷'
  if (!input.course.trim()) e.course = '請填寫住院經過'
  if (!input.condition.trim()) e.condition = '請填寫出院時狀況'
  if (!input.followUp.trim()) e.followUp = '請填寫出院後追蹤'
  if (!input.dischargeType) e.dischargeType = '請選擇出院轉歸'
  return e
}

/**
 * 儲存出院病摘。sign = true：簽署並准予出院（必填欄位要齊）；false：存草稿。
 * 已簽署的不能直接改——要先「取消准予出院」，避免住院中心正在辦出院時內容被換掉。
 */
export function saveDischargeSummary(admissionId: string, input: DischargeSummaryInput, sign: boolean): Promise<DischargeSummary> {
  return mutate(() => {
    const user = requireUser('doctor')
    const a = activeAdmission(admissionId)
    if (a.dischargeSummary?.signedAt) fail('已准予出院，要修改病摘請先取消准予出院', 'CONFLICT')
    if (sign) failFields(dischargeSummaryProblems(input))
    else if (![input.diagnosis, input.course, input.condition, input.followUp].some((x) => x.trim())) fail('病摘是空白的，不需要儲存')
    const t = now()
    const trim = (x: string) => x.trim()
    a.dischargeSummary = {
      diagnosis: trim(input.diagnosis), course: trim(input.course), condition: trim(input.condition), followUp: trim(input.followUp),
      dischargeType: input.dischargeType, doctorId: user.doctorId ?? a.doctorId, writtenAt: t, ...(sign ? { signedAt: t } : {}),
    }
    audit(sign ? '准予出院' : '出院病摘草稿', `${a.admitNo} ${find.patient(a.patientId)?.name}${sign ? `（${input.dischargeType}）` : ''}`)
    return a.dischargeSummary
  })
}

/** 取消准予出院（例：病人又發燒）：簽署取消，內容保留成草稿 */
export function cancelDischargeOrder(admissionId: string, reason: string): Promise<DischargeSummary> {
  return mutate(() => {
    requireUser('doctor')
    const a = activeAdmission(admissionId)
    const ds = a.dischargeSummary
    if (!ds?.signedAt) fail('病人尚未准予出院', 'CONFLICT')
    if (!reason.trim()) failField('reason', '請輸入取消原因')
    delete ds!.signedAt
    audit('取消准予出院', `${a.admitNo} ${find.patient(a.patientId)?.name}：${reason.trim()}`)
    return ds!
  })
}

/**
 * 醫師回覆護理師的疑問：確認原醫囑無誤（寫說明）。回覆後這筆醫囑要護理師重新核對（看到回覆才簽收）。
 * 要改醫囑的，請停止這筆（疑問自動解決）再開正確的一筆。
 */
export function replyOrderQuery(orderId: string, reply: string): Promise<OrderView> {
  return mutate(() => {
    const user = requireUser('doctor')
    const o = must(db.ipdOrders.find((x) => x.id === orderId), '醫囑')
    const q = openQuery(o)
    if (!q) fail('這筆醫囑沒有待回覆的疑問', 'CONFLICT')
    const text = reply?.trim()
    if (!text) failField('reply', '請寫回覆（例：劑量無誤，依體重計算）')
    Object.assign(q!, { replyBy: user.id, replyAt: now(), reply: text, resolution: 'confirmed' })
    // 要護理師看到回覆再核對一次
    delete o.ackAt
    delete o.ackBy
    audit('回覆醫囑疑問', `${o.content}：${text}`)
    return orderView(o)
  })
}
