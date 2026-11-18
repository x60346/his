// 住院醫囑與病程紀錄。
// 開立長期給藥醫囑時依頻率的給藥時間點產生 MAR（給藥排程），護理站立即看得到。
import type { DischargeSummary, DrugTiming, IpdOrder, MarRecord, ProgressNote, MedicationOrder, TubeFormula } from '@/types'
import { commitIfPossible, db, newId } from '@/mock/db'
import { addDays, addMinutes, now } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requireUser, requirePermission } from './http'
import { dischargeRxDaysProblem, doseLevel, doseNote } from './dose-rules'
import { autoQty } from './billing'
import { CONTROLLED_LEVEL_LABEL, licenseProblem, needsSpecialRx } from './controlled-rules'
import { doseUnitOf } from './billing'
import { effectiveTiming, marTimes, normalizeRxTiming, timingApplies, timingText, residualOf, doseStrengthText } from './drug-rules'
import { find, nameOf, openDeptTransfer, usable } from './views'
import { CONSULT_ORDER_HOURS, requireCare } from './care-team'
import { openQuery } from './nursing-rules'
import { stopOrderRecord } from './order-ops'
import { udDelivery, udStage } from './ud-work'
import { checkRxAlerts, type RxAlert } from './interaction-rules'
import { drugRefs, ipdInUse, settleRxAlerts } from './rx-alert-work'
import { ABX_DEFAULT_DAYS, ABX_REASON_LABEL, abxText, checkAbxInput } from './abx-rules'
import { checkTubePlan, DIET_KINDS, dietKindOfText, dietText } from './nutrition-rules'
import { checkInfusionInput } from './infusion-rules'
import { activeLines } from './line-work'
import { abxInfoOf, isInfectious, type AbxInfo } from './abx-work'
import { acceptAdviceOn, adviceOfOrder, medHistory, type AbxAdviceView } from './abx-steward-work'
import { abxCourseStart } from './abx-steward-rules'

function activeAdmission(admissionId: string) {
  const a = must(find.admission(admissionId), '住院紀錄')
  if (a.status !== 'admitted') fail('病人目前不在住院中', 'CONFLICT')
  return a
}

/** 補齊某日的給藥排程（只處理有固定時間點的長期給藥醫囑），回傳是否有新增。服務層內部使用 */
export function ensureMar(admissionId: string, date: string): boolean {
  let added = false
  // 點滴（連續輸注）不排給藥時間：由護理師接上、換瓶（infusion.ts）
  const orders = db.ipdOrders.filter((o) => o.admissionId === admissionId && o.category === 'medication' && o.type === 'long' && !o.infusion)
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
  /** 管制藥給不是整數的劑量：每次給藥要見證銷毀的殘餘量（PRN 給藥畫面用） */
  residualQty?: number
  /** 劑量換算成含量（0.5 AMP →「5 mg」）；只在不是整數的劑量時給 */
  doseStrength?: string
  /** 管制性抗生素：第幾天、審核狀態（醫囑列、審核頁顯示） */
  abxInfo?: AbxInfo
  /** 感染科每日審視發出、待主治回覆的建議（停止或修改這筆＝接受；不接受要寫原因） */
  abxAdvice?: AbxAdviceView[]
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
    ...(drug && residualOf(drug, o.dose) ? { residualQty: residualOf(drug, o.dose)!.residual } : {}),
    ...(drug && o.dose && !Number.isInteger(o.dose) && doseStrengthText(drug, o.dose) ? { doseStrength: doseStrengthText(drug, o.dose) } : {}),
    ...(o.abx && o.status === 'active' ? { abxInfo: abxInfoOf(o.abx) } : {}),
    ...(o.status === 'active' && o.category === 'medication' && adviceOfOrder(o.id).length ? { abxAdvice: adviceOfOrder(o.id) } : {}),
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

export type OrderInput = Pick<IpdOrder, 'admissionId' | 'type' | 'category' | 'drugId' | 'procId' | 'content' | 'dose' | 'freq' | 'route' | 'diet' | 'infusion'> & {
  /** 醫師指定的服用時機（空＝照主檔）；開立時會把有效時機存在醫囑上 */
  timing?: DrugTiming | ''
  /** 已有執行中的同藥醫囑時，醫師確認仍要再開一筆 */
  allowDuplicate?: boolean
  /** 劑量偏高時，醫師確認無誤 */
  confirmHighDose?: boolean
  /** 交互作用、重複用藥提醒的確認（key → 原因；嚴重的原因必填）——這次送出的確認，原因存在醫囑的 rxAlerts */
  rxAlertReasons?: Record<string, string>
  /** 管制性抗生素的使用申請（理由、感染部位、菌種、說明）；修改醫囑不用填（沿用） */
  abx?: { reason: NonNullable<IpdOrder['abx']>['reason']; site: string; organism?: string; note?: string }
}

/** 開醫囑前查詢：這個藥和病人執行中的其他給藥醫囑之間的交互作用、成分／同類重複（同一種藥另有 listActiveSameDrug） */
export function orderRxAlerts(admissionId: string, drugId: string): Promise<RxAlert[]> {
  return query(() => checkRxAlerts(drugRefs([drugId]), ipdInUse(admissionId, drugId)))
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
    let rxAlerts: IpdOrder['rxAlerts']
    let abx: IpdOrder['abx']
    let dietValue: IpdOrder['diet']
    let infusionValue: IpdOrder['infusion']

    if (input.category === 'medication') {
      const drug = usable.drug(input.drugId ?? '')
      // 管制性抗生素：先用後審——要填使用理由與感染部位（依培養結果要寫菌種），感染科 48 小時內審核。
      // 修改醫囑（同一個藥、只改劑量頻率）沿用療程與審核結果；感染科醫師自己開的直接核准
      const prev = extra.replaces ? db.ipdOrders.find((x) => x.id === extra.replaces) : undefined
      if (drug.restrictedAbx) {
        if (prev?.abx) abx = structuredClone(prev.abx)
        else {
          failFields(checkAbxInput(input.abx))
          const x = input.abx!
          const self = isInfectious(user.doctorId)
          const why = `${ABX_REASON_LABEL[x.reason]}${x.organism?.trim() ? `（${x.organism.trim()}）` : ''}・${x.site.trim()}${x.note?.trim() ? `：${x.note.trim()}` : ''}`
          abx = {
            reason: x.reason, site: x.site.trim(), ...(x.reason === 'culture' ? { organism: x.organism!.trim() } : {}), ...(x.note?.trim() ? { note: x.note.trim() } : {}),
            // 同一支停藥 48 小時內又開：接續原療程（不從第 1 天重算）
            courseStart: abxCourseStart({ id: '', drugId: drug.id, startAt: extra.startAt ?? t, status: 'active' }, medHistory(a.id)), status: self ? 'approved' : 'pending', requestedAt: t, ...(self ? { approvedDays: ABX_DEFAULT_DAYS } : {}),
            steps: [{ action: 'request', at: t, by: user.id, text: why }, ...(self ? [{ action: 'approve' as const, at: t, by: user.id, text: '感染科醫師開立，免審', days: ABX_DEFAULT_DAYS }] : [])],
          }
        }
      }
      // 第一～三級管制藥：開立的醫師（會診醫師開的就是會診醫師）要有有效的管制藥品使用執照
      if (needsSpecialRx(drug.controlled)) {
        const doc = find.doctor(user.doctorId ?? a.doctorId)
        const why = licenseProblem(doc?.controlledLicense, t.slice(0, 10))
        if (why) failField('drugId', `${doc?.name ?? '醫師'}${why}，不能開立${CONTROLLED_LEVEL_LABEL[drug.controlled!]}管制藥 ${drug.name}`)
      }
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
      // 交互作用、成分／同類重複：和這次住院執行中的其他給藥醫囑比。修改醫囑（同一個藥、只改劑量頻率）沿用原本的確認
      const old = extra.replaces ? db.ipdOrders.find((x) => x.id === extra.replaces) : undefined
      rxAlerts = old ? old.rxAlerts : settleRxAlerts(drugRefs([drug.id]), ipdInUse(a.id, drug.id), input.rxAlertReasons)
      content = content || drug.name
      // 點滴：長期、注射；每瓶容量、流速、加藥（加藥也要是能開的藥）；內容寫成「NS 500 ml @ 80 ml/h ＋ KCl 20 mEq」
      if (input.infusion) {
        if (input.type !== 'long') failField('infusion', '點滴請開長期醫囑')
        if (drug.category !== '注射') failField('drugId', '點滴要選注射用的輸液')
        failFields(checkInfusionInput(input.infusion))
        const adds = (input.infusion.additives ?? []).map((x) => ({ drug: usable.drug(x.drugId), dose: x.dose }))
        infusionValue = { volumeMl: input.infusion.volumeMl, rateMlH: input.infusion.rateMlH, ...(adds.length ? { additives: adds.map((x) => ({ drugId: x.drug.id, dose: x.dose })) } : {}) }
        content = `${drug.name} ${infusionValue.volumeMl} ml @ ${infusionValue.rateMlH} ml/h${adds.map((x) => ` ＋ ${x.drug.name} ${x.dose} ${doseUnitOf(x.drug)}`).join('')}`
      }
      // 服用時機：開立時決定、存在醫囑上（排程依它排）。只有長期、適用的（口服、非睡前／需要時）才有
      const rx = normalizeRxTiming(drug.timing, { timing: input.timing, freq: input.freq, route: input.route ?? '' })
      if (rx === 'invalid') failField('timing', '服用時機不正確')
      timing = input.type === 'long' && timingApplies(input.freq, input.route) ? { timing: effectiveTiming(drug.timing, rx), ...(rx ? { timingSet: true } : {}) } : {}
    } else if (input.category === 'procedure') {
      const proc = usable.procedure(input.procId ?? '')
      content = content || proc.name
    } else if (input.category === 'diet') {
      // 飲食醫囑選種類（伙食費、送餐清單、術前禁食都看種類）；只寫文字的（舊的呼叫方式）依關鍵字推斷
      if (input.diet) {
        if (!DIET_KINDS.some((k) => k.kind === input.diet!.kind)) failField('diet', '請選飲食種類')
        // 管灌：配方、總量、灌法；身上要有鼻胃管或胃造口（沒有管路不能灌）
        let formula: TubeFormula | undefined
        if (input.diet.kind === 'tube') {
          failFields(checkTubePlan(input.diet.tube))
          formula = db.tubeFormulas.find((x) => x.id === input.diet!.tube!.formulaId && x.active)
          if (!formula) failField('formulaId', '找不到這個配方（或已停用）')
          if (!activeLines(a.id).some((l) => l.kind === 'ngt' || l.kind === 'peg')) failField('diet', '病人沒有鼻胃管或胃造口：請先放置並在護理站「管路」登錄，才能開管灌')
        }
        const tp = input.diet.tube
        dietValue = {
          kind: input.diet.kind, ...(input.diet.note?.trim() ? { note: input.diet.note.trim() } : {}),
          ...(input.diet.kind === 'tube' && tp ? { tube: { formulaId: tp.formulaId, totalMl: tp.totalMl, mode: tp.mode, ...(tp.mode === 'bolus' ? { feeds: tp.feeds } : { rateMlH: tp.rateMlH }) } } : {}),
        }
        content = dietText(dietValue, formula)
      } else if (!content) fail('請選飲食種類')
      else dietValue = { kind: dietKindOfText(content) }
    } else if (!content) {
      fail('請輸入醫囑內容')
    }

    // allowDuplicate 是「這次送出的確認」，不是醫囑本身的資料，不能存進資料庫
    const { allowDuplicate: _dup, confirmHighDose: _high, timing: _timing, rxAlertReasons: _rx, abx: _abx, diet: _diet, infusion: _inf, ...fields } = input
    const o: IpdOrder = {
      ...fields,
      ...timing,
      ...(rxAlerts?.length ? { rxAlerts } : {}),
      ...(abx ? { abx } : {}),
      ...(dietValue ? { diet: dietValue } : {}),
      ...(infusionValue ? { infusion: infusionValue } : {}),
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
    const severe = (o.rxAlerts ?? []).filter((x) => x.level === 'severe')
    audit('開立住院醫囑', `${a.admitNo} ${o.content}${role.kind === 'consult' ? `（會診：${nameOf.dept(role.consult.toDeptId)}）` : ''}${severe.length ? `；嚴重交互作用仍開立：${severe.map((x) => `${x.title}（${x.reason}）`).join('、')}` : ''}`)
    return orderView(o)
  })
}

/**
 * 依營養師的管灌建議開管灌醫囑（主治一鍵帶入，開的人仍是醫師）：同一筆建議只能帶一次；
 * 一併記為已閱（醫師看過才帶入）
 */
export function orderTubeFromAssessment(assessmentId: string, note = ''): Promise<OrderView> {
  return mutate(() => {
    const user = requirePermission('order.write')
    const x = must(db.nutritionAssessments.find((y) => y.id === assessmentId), '營養評估')
    if (!x.tube) fail('這份營養評估沒有管灌建議')
    if (x.tubeOrderId) fail('這份建議已經帶入過了', 'CONFLICT')
    const a = activeAdmission(x.admissionId)
    const role = requireCare(user.doctorId, a, '開管灌醫囑', { consult: false })
    const t = now()
    const o = createOrder(user, a, { admissionId: a.id, type: 'long', category: 'diet', content: '', diet: { kind: 'tube', tube: x.tube, note } }, t, role.kind === 'consult' ? { consultId: role.consult.id } : {})
    Object.assign(x, { tubeOrderId: o.id, ...(x.seenAt ? {} : { seenBy: user.id, seenAt: t }) })
    audit('開立住院醫囑', `${a.admitNo} ${o.content}（依營養師建議）`)
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
    // 感染科的建議待回覆：修改＝接受
    acceptAdviceOn(old, user.id, t, `修改醫囑：${orderSummary(o, unit)}（${reason}）`)
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
    // 升壓劑：在「加護病房」分頁停（劑量還高要先調降或寫原因），一般醫囑的停止不走這條
    if (o.infusion?.vaso) fail('升壓劑請在「加護病房」分頁停止（劑量還高要先逐步調降或寫原因）', 'CONFLICT')
    const role = requireCare(user.doctorId, must(find.admission(o.admissionId), '住院紀錄'), '停止這位病人的醫囑', { consult: true })
    if (role.kind === 'consult' && o.doctorId !== user.doctorId) fail('會診醫師只能停止自己開的醫囑', 'FORBIDDEN')
    // 有疑問的醫囑被停止：疑問就此解決（醫師通常會另開正確的一筆）
    const t = now()
    const q = stopOrderRecord(o, user.id, t)
    // 感染科的建議待回覆：停止＝接受
    acceptAdviceOn(o, user.id, t, '停止醫囑')
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
  /** 管制藥給不是整數的劑量：給的時候要見證銷毀的殘餘量 */
  residualQty?: number
  residualWitnessName?: string
  /** 劑量換算成含量（不是整數的劑量才給） */
  doseStrength?: string
  /** 管制性抗生素：「使用第 3 天」、審核未通過（只標示，不擋給藥——停不停藥是醫師的決定） */
  abxText?: string
  abxRejected?: boolean
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
        ...(d && residualOf(d, o?.dose) ? { residualQty: residualOf(d, o?.dose)!.residual } : {}),
        ...(m.residual ? { residualWitnessName: nameOf.user(m.residual.witnessBy) } : {}),
        ...(o?.abx ? { abxText: abxText(o.abx, m.scheduledAt > now() ? now() : m.scheduledAt), ...(o.abx.status === 'rejected' && o.status === 'active' ? { abxRejected: true } : {}) } : {}),
        ...(d && o?.dose && !Number.isInteger(o.dose) && doseStrengthText(d, o.dose) ? { doseStrength: doseStrengthText(d, o.dose) } : {}),
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
export type DischargeSummaryInput = Pick<DischargeSummary, 'diagnosis' | 'course' | 'condition' | 'followUp' | 'dischargeType' | 'meds' | 'chronicRx'> & {
  /** 出院帶藥有劑量偏高的，醫師已確認（不存進病摘） */
  confirmHighDose?: boolean
}

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
    if (a.obs && !a.obs.endAt) fail('急診留觀不寫出院病摘：在「急診」看板結束留觀（離院、收住院、轉院）', 'CONFLICT')
    if (a.death) fail('已宣告死亡：出院病摘由死亡紀錄帶入', 'CONFLICT')
    if (input.dischargeType === '死亡') fail('出院類別「死亡」：請在「死亡」分頁宣告死亡（死因、死亡方式），病摘會自動帶入', 'CONFLICT')
    if (a.dischargeSummary?.signedAt) fail('已准予出院，要修改病摘請先取消准予出院', 'CONFLICT')
    if (sign && openDeptTransfer(a)) fail(`轉科申請中（轉${find.dept(openDeptTransfer(a)!.toDeptId)?.name}），不能准予出院；要出院請先撤回轉科申請`, 'CONFLICT')
    if (sign) failFields(dischargeSummaryProblems(input))
    else if (![input.diagnosis, input.course, input.condition, input.followUp].some((x) => x.trim())) fail('病摘是空白的，不需要儲存')
    const meds = dischargeMeds(input, sign)
    const t = now()
    const trim = (x: string) => x.trim()
    a.dischargeSummary = {
      diagnosis: trim(input.diagnosis), course: trim(input.course), condition: trim(input.condition), followUp: trim(input.followUp),
      dischargeType: input.dischargeType, doctorId: user.doctorId ?? a.doctorId, writtenAt: t, ...(sign ? { signedAt: t } : {}),
      ...(meds.length ? { meds, ...(input.chronicRx ? { chronicRx: true } : {}) } : {}),
    }
    audit(sign ? '准予出院' : '出院病摘草稿', `${a.admitNo} ${find.patient(a.patientId)?.name}${sign ? `（${input.dischargeType}）` : ''}`)
    return a.dischargeSummary
  })
}

/**
 * 出院帶藥的檢查（存草稿只擋明顯打錯的；簽署時天數上限、劑量偏高要確認都要過）：
 * 藥要能用、劑量 > 0、天數（一般 7 天、慢性病 30 天）、總量自動換算（換算不了要填）。回傳整理過的處方
 */
function dischargeMeds(input: DischargeSummaryInput, sign: boolean): MedicationOrder[] {
  const out: MedicationOrder[] = []
  for (const m of input.meds ?? []) {
    const d = usable.drug(m.drugId)
    if (!(m.dose > 0)) fail(`出院帶藥 ${d.name} 的劑量必須大於 0`)
    if (!find.freq(m.freq)) fail(`出院帶藥 ${d.name} 請選擇頻率`)
    const days = dischargeRxDaysProblem(m.days, !!input.chronicRx)
    if (days && sign) failField('meds', `${d.name}：${days}`)
    const level = doseLevel(d, m.dose)
    if (level === 'absurd') fail(`出院帶藥 ${d.name}：${doseNote(d, m.dose)}，請確認是否打錯`)
    if (sign && level === 'high' && !input.confirmHighDose) fail(`出院帶藥 ${d.name} 劑量偏高：${doseNote(d, m.dose)}，如確定請確認`, 'CONFLICT')
    let qty = m.qty
    if (!(qty > 0)) {
      const q = autoQty(d, m.dose, find.freq(m.freq)?.timesPerDay ?? 1, m.days)
      if (q === null) fail(`出院帶藥 ${d.name} 的給藥單位與調劑單位不同，請填寫總量`)
      qty = q!
    }
    if (!Number.isInteger(qty)) fail(`出院帶藥 ${d.name} 的總量要是整數（${d.unit}）`)
    out.push({ drugId: d.id, dose: m.dose, freq: m.freq, route: m.route, days: m.days, qty, selfPay: false, ...(m.timing ? { timing: m.timing } : {}) })
  }
  return out
}

/** 取消准予出院（例：病人又發燒）：簽署取消，內容保留成草稿。出院帶藥已調劑的要藥局先退回 */
export function cancelDischargeOrder(admissionId: string, reason: string): Promise<DischargeSummary> {
  return mutate(() => {
    const user = requireUser('doctor')
    const a = activeAdmission(admissionId)
    requireCare(user.doctorId, a, '取消准予出院', { consult: false })
    if (a.death) fail('已宣告死亡：不能取消（死亡出院）', 'CONFLICT')
    const ds = a.dischargeSummary
    if (!ds?.signedAt) fail('病人尚未准予出院', 'CONFLICT')
    if (a.dischargeRx) fail('出院帶藥已經調劑：請住院藥局先「退回」，才能取消准予出院、修改處方', 'CONFLICT')
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
