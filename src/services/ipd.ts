// 住院醫囑與病程紀錄。
// 開立長期給藥醫囑時依頻率的給藥時間點產生 MAR（給藥排程），護理站立即看得到。
import type { DischargeSummary, DrugTiming, IpdOrder, MarRecord, ProgressNote } from '@/types'
import { commitIfPossible, db, newId } from '@/mock/db'
import { addDays, addMinutes, now } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requireUser, requirePermission } from './http'
import { doseLevel, doseNote } from './dose-rules'
import { doseUnitOf } from './billing'
import { effectiveTiming, marTimes, normalizeRxTiming, timingApplies, timingText } from './drug-rules'
import { find, nameOf, openDeptTransfer, usable } from './views'
import { CONSULT_ORDER_HOURS, requireCare } from './care-team'
import { openQuery } from './nursing-rules'
import { stopOrderRecord } from './order-ops'
import { udDelivery, udStage } from './ud-work'

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
    // 給藥時間依服用時機對齊用餐（drug-rules.marTimes）；時機是開立時存在醫囑上的，不跟著主檔變
    const times = marTimes(o.freq ?? '', find.freq(o.freq ?? '')?.times ?? [], o.timing, o.route)
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
  /** 服用時機短字（飯前、飯後…）；不適用為空字串 */
  timingShort: string
  /** 劑量單位：醫囑上的劑量必須帶單位，「1」不知道是 1 瓶還是 1 克 */
  unit: string
  /** 修改前／修改後那一筆的摘要（「每次 1 TAB BID PO」） */
  replacesText?: string
  replacedByText?: string
  /** 會診醫師開的：「會診：外科 張皓宇」；本科還沒按已閱的標 consultUnseen */
  consultLabel?: string
  consultUnseen?: boolean
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
    timingShort: o.category === 'medication' && o.type === 'long' ? timingText(o.timing, o.freq ?? '', o.route ?? '', true) : '',
    unit: drug ? doseUnitOf(drug) : '',
    ...(o.replaces ? { replacesText: summaryOf(o.replaces) } : {}),
    ...(o.replacedBy ? { replacedByText: summaryOf(o.replacedBy) } : {}),
    ...(o.consultId ? { consultLabel: `會診：${nameOf.dept(find.doctor(o.doctorId)?.deptId)} ${nameOf.doctor(o.doctorId)}`, ...(o.consultSeenAt ? {} : { consultUnseen: true }) } : {}),
  }
}

function summaryOf(orderId: string): string {
  const x = db.ipdOrders.find((o) => o.id === orderId)
  const d = x?.drugId ? find.drug(x.drugId) : undefined
  return x ? orderSummary(x, d ? doseUnitOf(d) : '') : ''
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
  /** 醫師指定的服用時機（空＝照主檔）；開立時會把有效時機存在醫囑上 */
  timing?: DrugTiming | ''
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

/**
 * 建立一筆醫囑（服務層內部：開立與修改共用）——劑量合理性、重複用藥、服用時機的檢查只有這一份。
 * extra 可帶 startAt（修改時從下一劑開始）、replaces、reviseReason
 */
function createOrder(user: ReturnType<typeof requireUser>, a: ReturnType<typeof activeAdmission>, input: OrderInput, t: string, extra: Partial<IpdOrder> = {}): IpdOrder {
    let content = input.content.trim()
    let timing: Pick<IpdOrder, 'timing' | 'timingSet'> = {}

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
      // 服用時機：開立時決定、存在醫囑上（排程依它排）。只有長期、適用的（口服、非睡前／需要時）才有
      const rx = normalizeRxTiming(drug.timing, { timing: input.timing, freq: input.freq, route: input.route ?? '' })
      if (rx === 'invalid') failField('timing', '服用時機不正確')
      timing = input.type === 'long' && timingApplies(input.freq, input.route) ? { timing: effectiveTiming(drug.timing, rx), ...(rx ? { timingSet: true } : {}) } : {}
    } else if (input.category === 'procedure') {
      const proc = usable.procedure(input.procId ?? '')
      content = content || proc.name
    } else if (!content) {
      fail('請輸入醫囑內容')
    }

    // allowDuplicate 是「這次送出的確認」，不是醫囑本身的資料，不能存進資料庫
    const { allowDuplicate: _dup, confirmHighDose: _high, timing: _timing, ...fields } = input
    const o: IpdOrder = {
      ...fields,
      ...timing,
      content,
      id: newId('IO'),
      startAt: t,
      ...extra,
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
    return o
}

export function addOrder(input: OrderInput): Promise<OrderView> {
  return mutate(() => {
    const user = requirePermission('order.write')
    const a = activeAdmission(input.admissionId)
    const role = requireCare(user.doctorId, a, '開這位病人的醫囑', { consult: true })
    const o = createOrder(user, a, input, now(), role.kind === 'consult' ? { consultId: role.consult.id } : {})
    audit('開立住院醫囑', `${a.admitNo} ${o.content}${role.kind === 'consult' ? `（會診：${nameOf.dept(role.consult.toDeptId)}）` : ''}`)
    return orderView(o)
  })
}

export interface ReviseInput {
  dose: number
  freq: string
  route: string
  /** 空＝照主檔 */
  timing?: DrugTiming
  reason: string
  /** 劑量偏高時醫師確認（這次送出的確認，不存） */
  confirmHighDose?: boolean
}

const orderSummary = (o: Pick<IpdOrder, 'dose' | 'freq' | 'route' | 'timing' | 'timingSet'>, unit: string) =>
  `每次 ${o.dose} ${unit} ${o.freq} ${o.route}${o.timingSet && o.timing ? ` ${timingText(o.timing, o.freq ?? '', o.route ?? '', true)}` : ''}`

/**
 * 修改長期給藥醫囑（劑量、頻率、途徑、服用時機；藥不能換——換藥請停止後另開，要重新看過敏）。
 * 畫面上一步完成，資料上仍是「停止舊的＋開新的」兩筆、互相標記；檢查與開新醫囑同一份（createOrder），護理師要重新核對。
 * 有護理師疑問的，疑問記為「已修改」並自動寫出改了什麼。
 * **從下一劑開始**：新醫囑的起始時間取「現在」與「舊醫囑最後一劑已處理（給、暫停、拒絕）的時間」較晚者——
 * 12:00 那劑 11:40 提早給了、11:55 改劑量，新醫囑不會在 12:00 再排一劑
 */
export function reviseOrder(orderId: string, input: ReviseInput): Promise<OrderView> {
  return mutate(() => {
    const user = requirePermission('order.write')
    const old = must(db.ipdOrders.find((x) => x.id === orderId), '醫囑')
    if (old.status !== 'active') fail('此醫囑已停止或完成', 'CONFLICT')
    if (old.category !== 'medication' || old.type !== 'long') fail('只有長期給藥醫囑（含需要時）可以修改；其他請停止後另開')
    const a = activeAdmission(old.admissionId)
    const role = requireCare(user.doctorId, a, '修改這位病人的醫囑', { consult: true })
    if (role.kind === 'consult' && old.doctorId !== user.doctorId) fail('會診醫師只能修改自己開的醫囑', 'FORBIDDEN')
    const reason = input.reason?.trim()
    if (!reason) failField('reason', '請寫修改原因（例：依腎功能調整劑量）')
    const timingNow = old.timingSet ? old.timing : undefined
    if (input.dose === old.dose && input.freq === old.freq && input.route === old.route && (input.timing || undefined) === timingNow) fail('沒有任何變更')
    const t = now()
    const q = openQuery(old)
    const handled = db.mar.filter((m) => m.orderId === old.id && m.status !== 'pending').map((m) => m.scheduledAt).sort().at(-1)
    const startAt = handled && addMinutes(handled, 1) > t ? addMinutes(handled, 1) : t
    const unit = doseUnitOf(must(find.drug(old.drugId!), '藥品'))
    stopOrderRecord(old, user.id, t)
    // 原本就有的同藥醫囑醫師開立時已確認過，修改不再問一次
    const o = createOrder(user, a, {
      admissionId: a.id, type: 'long', category: 'medication', drugId: old.drugId, content: '',
      dose: input.dose, freq: input.freq, route: input.route, ...(input.timing ? { timing: input.timing } : {}),
      allowDuplicate: true, ...(input.confirmHighDose ? { confirmHighDose: true } : {}),
    }, t, { startAt, replaces: old.id, reviseReason: reason, ...(role.kind === 'consult' ? { consultId: role.consult.id } : {}) })
    old.replacedBy = o.id
    const change = `${orderSummary(old, unit)} → ${orderSummary(o, unit)}`
    if (q) Object.assign(q, { reply: `已修改：${change}（${reason}）`, resolution: 'modified' })
    audit('修改住院醫囑', `${a.admitNo} ${old.content}：${change}（${reason}）${q ? `；回覆護理師疑問：${q.reason}` : ''}`)
    return orderView(o)
  })
}

/** 停止醫囑：之後尚未執行的給藥排程一併刪除 */
export function stopOrder(orderId: string): Promise<OrderView> {
  return mutate(() => {
    const user = requirePermission('order.write')
    const o = must(db.ipdOrders.find((x) => x.id === orderId), '醫囑')
    if (o.status !== 'active') fail('此醫囑已停止或完成')
    const role = requireCare(user.doctorId, must(find.admission(o.admissionId), '住院紀錄'), '停止這位病人的醫囑', { consult: true })
    if (role.kind === 'consult' && o.doctorId !== user.doctorId) fail('會診醫師只能停止自己開的醫囑', 'FORBIDDEN')
    // 有疑問的醫囑被停止：疑問就此解決（醫師通常會另開正確的一筆）
    const q = stopOrderRecord(o, user.id, now())
    audit('停止住院醫囑', `${o.content}${q ? `（回覆護理師疑問：${q.reason}）` : ''}`)
    return orderView(o)
  })
}

export interface MarView extends MarRecord {
  /** 醫囑有疑問、待醫師回覆：給藥暫停（緊急時寫原因強制） */
  queried?: string
  /** 長期排程、藥還沒到病房：pending 藥局還沒調劑（要請補調劑）、checking 已調劑在核對中。都不能給 */
  awaitingUd?: 'pending' | 'checking'
  /** 已核對送出、但病房還沒點收（notReceived）或點收不符藥局處理中（issue）：只提示、不擋給藥 */
  udDelivery?: 'notReceived' | 'issue'
  content: string
  dose?: number
  unit: string
  route?: string
  freq?: string
  /** 服用時機短字（飯前、飯後…）：護理師看得出為什麼排 07:00 而不是 09:00 */
  timingShort: string
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
        ...(m.status === 'pending' && o?.type === 'long' && udStage(m) !== 'verified' ? { awaitingUd: udStage(m) === 'prepared' ? ('checking' as const) : ('pending' as const) } : {}),
        ...(m.status === 'pending' && udDelivery(m) ? { udDelivery: udDelivery(m) } : {}),
        content: o?.content ?? '',
        dose: o?.dose,
        unit: d ? doseUnitOf(d) : '',
        route: o?.route,
        freq: o?.freq,
        timingShort: o?.type === 'long' && o.timing && o.timing !== 'ANY' ? timingText(o.timing, o.freq ?? '', o.route ?? '', true) : '',
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
    requireCare(user.doctorId, a, '寫這位病人的病程紀錄', { consult: true })
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
    requireCare(user.doctorId, a, '寫出院病摘、准予出院', { consult: false })
    if (a.dischargeSummary?.signedAt) fail('已准予出院，要修改病摘請先取消准予出院', 'CONFLICT')
    if (sign && openDeptTransfer(a)) fail(`轉科申請中（轉${find.dept(openDeptTransfer(a)!.toDeptId)?.name}），不能准予出院；要出院請先撤回轉科申請`, 'CONFLICT')
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
    const user = requireUser('doctor')
    const a = activeAdmission(admissionId)
    requireCare(user.doctorId, a, '取消准予出院', { consult: false })
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
    const role = requireCare(user.doctorId, must(find.admission(o.admissionId), '住院紀錄'), '回覆這位病人的醫囑疑問', { consult: true })
    if (role.kind === 'consult' && o.doctorId !== user.doctorId) fail('會診醫師只能回覆自己開的醫囑', 'FORBIDDEN')
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

/**
 * 主治（或同科醫師）看過會診醫師開的醫囑：按「已閱」。會診醫師開的藥會影響主治的治療計畫，
 * 只標在醫囑上不夠——住院頁那位病人上方、首頁待辦都提醒，直到本科醫師看過
 */
export function ackConsultOrders(admissionId: string): Promise<{ count: number }> {
  return mutate(() => {
    const user = requirePermission('order.write')
    const a = must(find.admission(admissionId), '住院紀錄')
    requireCare(user.doctorId, a, '按會診醫囑的「已閱」', { consult: false })
    const list = db.ipdOrders.filter((o) => o.admissionId === a.id && o.consultId && !o.consultSeenAt)
    if (!list.length) fail('沒有待確認的會診醫囑', 'CONFLICT')
    const t = now()
    for (const o of list) Object.assign(o, { consultSeenAt: t, consultSeenBy: user.id })
    audit('已閱會診醫囑', `${a.admitNo} ${find.patient(a.patientId)?.name}：${list.map((o) => o.content).join('、')}`)
    return { count: list.length }
  })
}

/** 會診醫師回覆後還能開醫囑的時數（畫面說明用） */
export const consultOrderHours = (): Promise<number> => query(() => CONSULT_ORDER_HOURS)
