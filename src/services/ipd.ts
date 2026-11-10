// 住院醫囑與病程紀錄。
// 開立長期給藥醫囑時依頻率的給藥時間點產生 MAR（給藥排程），護理站立即看得到。
import type { IpdOrder, MarRecord, ProgressNote } from '@/types'
import { commit, db, newId } from '@/mock/db'
import { addDays, now } from '@/utils/date'
import { audit, fail, failField, must, mutate, query, requireUser } from './http'
import { doseLevel, doseNote } from './dose-rules'
import { doseUnitOf } from './billing'
import { find, nameOf, usable } from './views'

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
  doctorName: string
  highAlert: boolean
  freqLabel: string
  /** 劑量單位：醫囑上的劑量必須帶單位，「1」不知道是 1 瓶還是 1 克 */
  unit: string
}

export const orderView = (o: IpdOrder): OrderView => {
  const drug = o.drugId ? find.drug(o.drugId) : undefined
  return {
    ...o,
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
    requireUser('doctor')
    const o = must(db.ipdOrders.find((x) => x.id === orderId), '醫囑')
    if (o.status !== 'active') fail('此醫囑已停止或完成')
    const t = now()
    o.status = 'stopped'
    o.stopAt = t
    db.mar = db.mar.filter((m) => !(m.orderId === o.id && m.status === 'pending'))
    audit('停止住院醫囑', o.content)
    return orderView(o)
  })
}

export interface MarView extends MarRecord {
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
      return {
        ...m,
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
    if (ensureMar(admissionId, date)) commit()
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
