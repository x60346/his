// 護理站：病房病人總覽、給藥執行（MAR）、生命徵象、護理紀錄（Focus DAR）、交班、執行臨時醫囑。
// 「現在幾點」決定一筆給藥是待給、逾時還是太早——判斷集中在 nursing-rules 的純函式，
// 服務層用它把關（太早不能給），頁面用它上色，兩邊不會各算各的。
import type { HandoverNote, IpdOrder, MarRecord, NursingNote, VitalRecord } from '@/types'
import { commitIfPossible, db, newId } from '@/mock/db'
import { addMinutes, now, today } from '@/utils/date'
import { audit, fail, failField, fieldErrors, must, mutate, query, requireUser, requirePermission } from './http'
import { ensureMar, marViews, orderView, type MarView, type OrderView } from './ipd'
import { doseUnitOf } from './billing'
import { wardStockOut } from './stock-ledger'
import { residualOf } from './drug-rules'
import { consumeWitness, WITNESS_MIN, witnessFor } from './witness-core'
import { udStage } from './ud-work'
import { riskStateOf } from './risk-work'
import { RISK_REASON_LABEL, RISK_SCALE_NAME } from './risk-rules'
import { activeIsolations, placementFor } from './flag-work'
import { ISOLATION_REVIEW_TEXT, isolationReviewDue, isoText } from './flag-rules'
import { scanRequired, scanText, settleScan, type ScanInput } from './scan-work'
import { checkGivenAt, isAbnormal, MAR_EARLY_MIN, marUrgency, measuredThisShift, needsAck, openQuery, orderChange, recentShifts, shiftRange, type OrderChange, shiftInstanceOf, vitalSpecs, type Shift, type ShiftInstance, type VitalKey } from './nursing-rules'
import { admissionView, find, nameOf, wardOf, type AdmissionView } from './views'
import { transfusionTasksOf } from './blood-work'
import { activeLines, drainBetween, lineTodosOf, painStateOf } from './line-work'
import { CHEST_BLEED_MLH, chestState, lineKind } from './line-rules'
import { screenable, screenStateOf } from './nutrition-work'
import { highResidual, tubeSlotsOf } from './tube-work'
import { activeRestraints, deliriumStateOf, restraintTodosOf } from './delirium-work'
import { restraintState } from './delirium-rules'
import { assignedNurse, myWardOf, nextShift, onDuty, shiftNow } from './staffing-work'
import { planOf, plannable, planScreenStateOf } from './discharge-plan-work'
import { openPca, pcaOpenAlert, pcaRecordState, runningPca } from './pca-work'
import { infusedToday, infusionOrders, infusionTodosOf } from './infusion-work'
import { openWounds, woundTodosOf } from './wound-work'
import { buildVital, type VitalInput } from './vital-work'
import { icuHourly, icuTodosOf } from './icu-work'
import { activeVent, rassStateOf, ventTodosOf } from './vent-work'
import { recentIcuOut } from './icu-move-work'
import { autoCallRrt, newsStateOf, openRrt } from './news-work'
import type { NewsLevel } from './news-rules'
import { openPharmQuery } from './pharm-rules'
import { collectRecord, isLabOrder, newSpecimen, recordFasting, specimenOfOrder, tubeOfOrder } from './specimen-work'
import { ppeOf } from './iso-rules'
import { requireDrugPreAuth } from './preauth-work'

export interface WardPatient extends AdmissionView {
  latestVitals?: VitalRecord
  /** 最新生命徵象中超出正常範圍的項目 */
  abnormal: string[]
  /** 已逾時未執行的給藥數 */
  overdueCount: number
  /** 目前在給藥時間窗內（可以給了）的給藥數 */
  dueCount: number
  /** 尚未執行的臨時醫囑數（檢驗、處置） */
  pendingStatCount: number
  /** 等著護理師核對的醫囑異動數（新開未簽收＋停止未確認） */
  unackedCount: number
  /** 這一班量過生命徵象沒有（沒量的在清單上標「本班未量」） */
  measuredThisShift: boolean
  /** 風險評估：逾時、該評了（到期前 2 小時內）的份數（跌倒、壓傷各算一份） */
  riskOverdue: number
  riskDue: number
  /** 隔離要處理的事：要檢討（前次就醫開的、滿 14 天）、和目前的床不合 */
  isolationTodo: number
  /** 輸血：已發血待輸、輸血中的袋數；有沒有該做的（15 分鐘生命徵象、發血超過 30 分鐘）——和本班待辦同一個判斷 */
  bloodIssued: number
  bloodTransfusing: number
  bloodUrgency?: 'overdue' | 'due'
  /** 已發血超過 30 分鐘還沒開始 */
  bloodIssuedLate?: boolean
  /** 疼痛：最近分數；≥4 的重評逾時（overdue）或等重評中（upcoming）；本班評過沒有 */
  painScore?: number
  painReassess?: 'overdue' | 'upcoming'
  painThisShift: boolean
  /** 管路：在身上的條數（種類簡稱）、護理站要處理的（今天還沒評估、評估可移除、留置針滿 96 小時） */
  lines: string[]
  lineTodo: number
  /** 營養篩檢（入院 48 小時內）：還沒篩的狀態（todo 還早、due 快到期、overdue 逾時）；篩過的有營養風險標 nutritionRisk */
  nutritionDue?: 'todo' | 'due' | 'overdue'
  nutritionRisk: boolean
  /** 管灌：有管灌醫囑；今天該灌沒記的（現在、逾時）；最近一次反抽過多 */
  tube?: { due: number; overdue: number; highResidual: boolean }
  /** 譫妄：這一班要評還沒評、最近一次陽性 */
  deliriumDue: boolean
  deliriumPositive: boolean
  /** 約束中：查核狀態、醫囑有沒有問題（緊急約束待補、沒補、到期） */
  restraint?: { check: 'ok' | 'due' | 'overdue'; orderProblem: boolean }
  /** 這一班的責任護理師（沒分＝未分床） */
  nurseId?: string
  nurseName?: string
  /** 出院準備：還沒篩（todo、快到期 due、逾時 overdue）；收案中 */
  planDue?: 'todo' | 'due' | 'overdue'
  planEnrolled: boolean
  /** PCA 使用中：紀錄狀態、有沒有未處理的警示 */
  pca?: { status: 'ordered' | 'running'; record: 'ok' | 'due' | 'overdue'; alert: boolean }
  /** 點滴：有點滴醫囑（或醫囑停了還在滴）；待辦數（待接上、要換瓶、要停止） */
  infusion?: { todo: number; overdue: boolean }
  /** 傷口：還沒癒合的條數、待辦（2 週沒變小、院內壓傷待病情變化加評） */
  wounds: number
  woundTodo: number
  /** 加護病房：重症流程表多久沒記、是否漏記（超過 75 分鐘） */
  icu?: { minutes: number; late: boolean }
  /** 呼吸器使用中；RASS 最近一次超出鎮靜目標；呼吸器實測、RASS 該做（現在、逾時）的數目 */
  vent?: { on: boolean; rassOut: boolean; todo: number; overdue: boolean }
  /** 48 小時內從加護病房轉出：轉出時間與摘要（交班帶出） */
  icuOut?: { at: string; items: { label: string; text: string }[] }
  /** 一般病房：最近一次算得出的 NEWS2（中、高要 1 小時內再量）；快速反應小組呼叫了、還沒到場評估 */
  news?: { score: number; level: NewsLevel; red: boolean; at: string; recheck?: 'upcoming' | 'overdue' }
  rrtPending: boolean
  /** 隔離中要的防護用品（N95、外科口罩、手套、隔離衣） */
  ppe: string[]
}

/** 最新一筆生命徵象：時間只到分鐘，同一分鐘量了兩次時取「後寫入」的那筆（以前排序取到先寫入的舊值） */
function latestVitalOf(admissionId: string): VitalRecord | undefined {
  return db.vitals.filter((v) => v.admissionId === admissionId).reduce<VitalRecord | undefined>((best, v) => (!best || v.at >= best.at ? v : best), undefined)
}

function admitted(admissionId: string) {
  const a = must(find.admission(admissionId), '住院紀錄')
  if (a.status !== 'admitted') fail('病人目前不在住院中', 'CONFLICT')
  return a
}

export function listWardPatients(ward: string): Promise<WardPatient[]> {
  return query(() => {
    const t = now()
    let changed = false
    const list = db.admissions
      .filter((a) => a.status === 'admitted' && wardOf(a) === ward)
      .map((a) => {
        changed = ensureMar(a.id, today()) || changed
        const latest = latestVitalOf(a.id)
        const pending = db.mar.filter((m) => m.admissionId === a.id && m.status === 'pending').map((m) => marUrgency(m.scheduledAt, t))
        return {
          ...admissionView(a),
          latestVitals: latest,
          abnormal: latest ? (Object.keys(vitalSpecs) as VitalKey[]).filter((k) => isAbnormal(k, latest[k])).map((k) => vitalSpecs[k].label) : [],
          overdueCount: pending.filter((u) => u === 'overdue').length,
          dueCount: pending.filter((u) => u === 'due').length,
          // 影像不算護理師的待執行（由檢查室完成）
          pendingStatCount: db.ipdOrders.filter((o) => o.admissionId === a.id && o.type === 'stat' && o.status === 'active' && o.category !== 'medication' && !isImagingOrder(o)).length,
          unackedCount: db.ipdOrders.filter((o) => o.admissionId === a.id && needsAck(o)).length,
          measuredThisShift: measuredThisShift(latest?.at, t),
          ...(() => {
            const rs = riskStateOf(a, t)
            const st = [rs.fall.due.status, rs.pressure.due.status]
            return { riskOverdue: st.filter((s) => s === 'overdue').length, riskDue: st.filter((s) => s === 'due').length }
          })(),
          ...(() => {
            const bt = transfusionTasksOf(a.id, t)
            // 有袋子在輸：急迫度只看輸血中的（另一袋剛發血不算「該量 15 分鐘」）；只有已發血的才看發血
            const tr = bt.filter((x) => x.state === 'transfusing')
            const is = bt.filter((x) => x.state === 'issued')
            const src = tr.length ? tr : is
            const u = src.some((x) => x.urgency === 'overdue') ? 'overdue' : src.some((x) => x.urgency === 'due') ? 'due' : undefined
            return { bloodIssued: is.length, bloodTransfusing: tr.length, ...(u ? { bloodUrgency: u as 'overdue' | 'due' } : {}), ...(is.some((x) => x.urgency === 'overdue') ? { bloodIssuedLate: true } : {}) }
          })(),
          ...(() => {
            const ps = painStateOf(a.id, t)
            return { ...(ps.last ? { painScore: ps.last.score } : {}), ...(ps.reassess ? { painReassess: ps.reassess.status } : {}), painThisShift: ps.thisShift }
          })(),
          lines: activeLines(a.id).map((l) => lineKind(l.kind).short),
          lineTodo: lineTodosOf(a.id, t).filter((x) => x.kind !== 'attending').length,
          ...(() => {
            const h = icuHourly(a, t)
            if (!h) return {}
            const vt = ventTodosOf(a, t)
            const rs = rassStateOf(a, t)
            return { icu: { minutes: h.minutes, late: h.late }, vent: { on: !!activeVent(a.id), rassOut: !!rs?.vs && rs.vs !== 'in', todo: vt.length, overdue: vt.some((x) => x.urgency === 'overdue') } }
          })(),
          ...(() => {
            const s = newsStateOf(a, t)
            return { ppe: ppeOf(activeIsolations(a.patientId).map((i) => i.kind)), rrtPending: !!openRrt(a.id), ...(s ? { news: { score: s.last.news.total, level: s.last.news.level, red: s.last.news.red, at: s.last.v.at, ...(s.recheck ? { recheck: s.recheck.status } : {}) } } : {}) }
          })(),
          ...(() => {
            const o = recentIcuOut(a, t)
            return o ? { icuOut: { at: o.at, items: o.note?.items ?? [] } } : {}
          })(),
          wounds: openWounds(a.id).length,
          woundTodo: woundTodosOf(a, t).length,
          ...(() => {
            const it = infusionTodosOf(a.id, t)
            const has = infusionOrders(a.id).length > 0 || it.length > 0
            return has ? { infusion: { todo: it.length, overdue: it.some((x) => x.urgency === 'overdue') } } : {}
          })(),
          ...(() => {
            const pc = openPca(a.id)
            return pc ? { pca: { status: pc.status as 'ordered' | 'running', record: pc.status === 'running' ? pcaRecordState(pc, t)?.status ?? 'ok' : 'ok', alert: pc.status === 'running' && !!pcaOpenAlert(pc) } } : {}
          })(),
          ...(() => {
            const p = planOf(a.id)
            const ps = plannable(a) && !p ? planScreenStateOf(a, t).status : undefined
            return { ...(ps && ps !== 'done' ? { planDue: ps } : {}), planEnrolled: !!p?.enrolled }
          })(),
          ...(() => {
            const nid = assignedNurse(a.id, shiftNow(t))
            return nid ? { nurseId: nid, nurseName: nameOf.user(nid) } : {}
          })(),
          ...(() => {
            const ds = deliriumStateOf(a, t)
            const r = activeRestraints(a.id)[0]
            const rs = r ? restraintState(r, t) : undefined
            return { deliriumDue: !!ds.target && !ds.thisShift, deliriumPositive: ds.positive, ...(rs ? { restraint: { check: rs.check, orderProblem: rs.order !== 'ok' } } : {}) }
          })(),
          ...(() => {
            const tf = tubeSlotsOf(a.id, t)
            return tf.order ? { tube: { due: tf.slots.filter((x) => x.state === 'due').length, overdue: tf.slots.filter((x) => x.state === 'overdue').length, highResidual: !!highResidual(a.id) } } : {}
          })(),
          ...(() => {
            if (!screenable(a)) return { nutritionRisk: false }
            const ns = screenStateOf(a, t)
            return { ...(ns.due.status !== 'done' ? { nutritionDue: ns.due.status as 'todo' | 'due' | 'overdue' } : {}), nutritionRisk: !!ns.latest && ns.latest.score >= 3 }
          })(),
          isolationTodo: activeIsolations(a.patientId).filter((i) => isolationReviewDue(i, a.admittedAt, t)).length + (a.bedId && placementFor(a.patientId, find.bed(a.bedId)!) ? 1 : 0),
        }
      })
      .sort((x, y) => (x.bed?.bedNo ?? '').localeCompare(y.bed?.bedNo ?? ''))
    if (changed) commitIfPossible()
    return list
  })
}

// ---------- 本班待辦（全病房）----------
// 以前病房層級只有「逾時給藥 N」「待執行臨時醫囑 N」兩個總數，哪一床、哪個藥、幾點要給，
// 得一床一床點進去看。這裡把整個病房該做的事依時間排成一張清單；實際執行仍回到各病人的頁面
// （給藥有高警訊雙人核對、原因填寫，清單上若也能給藥，那些把關就得寫兩份）。

export type WardTaskKind = 'mar' | 'stat' | 'ack' | 'vitals' | 'risk' | 'isolation' | 'blood' | 'pain' | 'line' | 'nutrition' | 'tube' | 'delirium' | 'restraint' | 'plan' | 'pca' | 'infusion' | 'wound' | 'icu' | 'vent' | 'news' | 'death'
export type WardTaskUrgency = 'overdue' | 'due' | 'todo' | 'upcoming'
export interface WardTask {
  id: string
  admissionId: string
  bedNo: string
  patientName: string
  kind: WardTaskKind
  urgency: WardTaskUrgency
  /** 預定時間（給藥）或開立時間（臨時醫囑） */
  at?: string
  text: string
}
const URGENCY_RANK: Record<WardTaskUrgency, number> = { overdue: 0, due: 1, todo: 2, upcoming: 3 }

export function listWardTasks(ward: string): Promise<WardTask[]> {
  return query(() => {
    const t = now()
    const { end } = shiftRange(t)
    const tasks: WardTask[] = []
    let changed = false
    for (const a of db.admissions.filter((x) => x.status === 'admitted' && wardOf(x) === ward)) {
      changed = ensureMar(a.id, today()) || changed
      const base = { admissionId: a.id, bedNo: a.bedId ? (find.bed(a.bedId)?.bedNo ?? '') : '日間', patientName: nameOf.patient(a.patientId) }
      // 給藥：逾時、可給的一律列（不論哪一班留下的，也包括 15:30 時已可提早給的 16:10）；
      // 還沒到時間的只列到這一班結束——和病人清單的「逾時／待給」數字同一個範圍
      for (const m of db.mar.filter((x) => x.admissionId === a.id && x.status === 'pending')) {
        const urgency = marUrgency(m.scheduledAt, t)
        if (urgency === 'upcoming' && m.scheduledAt >= end) continue
        const o = db.ipdOrders.find((x) => x.id === m.orderId)
        const d = o?.drugId ? find.drug(o.drugId) : undefined
        tasks.push({ ...base, id: m.id, kind: 'mar', urgency, at: m.scheduledAt, text: `${o?.content ?? ''}${o?.dose ? ` ${o.dose} ${d ? doseUnitOf(d) : ''}` : ''}${o?.route ? `・${o.route}` : ''}` })
      }
      // 臨時醫囑（檢驗、處置）：開了就該做
      // 影像由檢查室完成，不列；檢驗要掃描採檢的，說要去哪裡做
      for (const o of db.ipdOrders.filter((x) => x.admissionId === a.id && x.type === 'stat' && x.status === 'active' && x.category !== 'medication' && !isImagingOrder(x))) {
        const where = statElsewhere(o)
        tasks.push({ ...base, id: o.id, kind: 'stat', urgency: 'due', at: o.startAt, text: `臨時醫囑：${o.content}${where ? `（${where}）` : ''}` })
      }
      const unacked = db.ipdOrders.filter((o) => o.admissionId === a.id && needsAck(o)).length
      if (unacked) tasks.push({ ...base, id: `ack-${a.id}`, kind: 'ack', urgency: 'todo', text: `${unacked} 項醫囑異動待核對` })
      // 風險評估：逾時、該評了（到期前 2 小時內）——和病人清單的徽章同一個判斷（risk-work.riskStateOf）
      const rs = riskStateOf(a, t)
      for (const scale of ['fall', 'pressure'] as const) {
        const d = rs[scale].due
        if (d.status === 'ok') continue
        tasks.push({ ...base, id: `risk-${scale}-${a.id}`, kind: 'risk', urgency: d.status === 'overdue' ? 'overdue' : 'due', at: d.dueAt, text: `${RISK_SCALE_NAME[scale]}（${RISK_REASON_LABEL[d.reason]}）` })
      }
      // 隔離：前次就醫開的（這次住院要確認是否延續）、滿 14 天沒檢討；住進來之後才開的隔離和目前的床不合（請安排轉床）
      for (const iso of activeIsolations(a.patientId)) {
        const r = isolationReviewDue(iso, a.admittedAt, t)
        if (r) tasks.push({ ...base, id: `iso-${iso.id}`, kind: 'isolation', urgency: 'todo', text: `${isoText([iso])}：${ISOLATION_REVIEW_TEXT[r]}` })
      }
      const misplaced = a.bedId ? placementFor(a.patientId, find.bed(a.bedId)!) : undefined
      if (misplaced) tasks.push({ ...base, id: `isobed-${a.id}`, kind: 'isolation', urgency: 'due', text: `請安排轉床：${misplaced}` })
      // 輸血：已發血待輸、輸血中該量 15 分鐘生命徵象（和病人清單的標記、首頁「輸血待處理」同一個判斷）
      for (const x of transfusionTasksOf(a.id, t)) tasks.push({ ...base, id: x.id, kind: 'blood', urgency: x.urgency, at: x.at, text: x.text })
      // 這一班還沒量過生命徵象：和病人清單的「本班未量」同一條規則（measuredThisShift）
      const measured = measuredThisShift(latestVitalOf(a.id)?.at, t)
      if (!measured) {
        tasks.push({ ...base, id: `vs-${a.id}`, kind: 'vitals', urgency: 'todo', text: '本班尚未測量生命徵象（含疼痛）' })
      }
      // 死亡：遺體護理、送太平間（死亡證明書等醫師）
      if (a.death) tasks.push({ ...base, id: `death-${a.id}`, kind: 'death', urgency: a.death.care ? 'todo' : 'due', at: a.death.declaredAt, text: !a.death.care ? '已宣告死亡：遺體護理' : a.death.cert || a.death.manner !== 'natural' ? '遺體護理完成：送太平間' : '遺體護理完成：等醫師開死亡證明書後送太平間' })
      // NEWS2：中、高 1 小時內再量；快速反應小組呼叫了還沒到
      const ns = newsStateOf(a, t)
      if (ns?.recheck) tasks.push({ ...base, id: `news-${a.id}`, kind: 'news', urgency: ns.recheck.status === 'overdue' ? 'overdue' : 'due', at: ns.recheck.dueAt, text: `NEWS2 ${ns.last.news.total} 分：1 小時內再量生命徵象（含給氧、意識）` })
      if (openRrt(a.id)) tasks.push({ ...base, id: `rrt-${a.id}`, kind: 'news', urgency: 'todo', at: openRrt(a.id)!.calledAt, text: '已呼叫快速反應小組，等到場評估' })
      // 疼痛：≥4 處置後 1 小時重評（逾時、或快到了）；量了生命徵象卻沒評疼痛
      const ps = painStateOf(a.id, t)
      if (ps.reassess) tasks.push({ ...base, id: `pain-${a.id}`, kind: 'pain', urgency: ps.reassess.status === 'overdue' ? 'overdue' : 'upcoming', at: ps.reassess.dueAt, text: `疼痛 ${ps.last!.score} 分處置後重評` })
      else if (measured && !ps.thisShift) tasks.push({ ...base, id: `pain-${a.id}`, kind: 'pain', urgency: 'todo', text: '本班尚未評估疼痛' })
      // 管路：今天還沒評估還需要嗎、評估可以移除、留置針滿 96 小時（滿 7 天提醒主治，在醫師首頁）
      for (const x of lineTodosOf(a.id, t).filter((y) => y.kind !== 'attending')) tasks.push({ ...base, id: x.id, kind: 'line', urgency: x.kind === 'chestBleed' ? 'overdue' : x.kind === 'need' || x.kind === 'chestRemove' ? 'todo' : 'due', text: x.text })
      // 管灌：該灌沒記的（前後 1 小時「現在」、超過「逾時」；連續灌食每班記一次）
      const tf = tubeSlotsOf(a.id, t)
      for (const x of tf.slots.filter((y) => y.state === 'due' || y.state === 'overdue')) tasks.push({ ...base, id: `tube-${a.id}-${x.slot}`, kind: 'tube', urgency: x.state as 'due' | 'overdue', at: x.slot, text: `管灌 ${x.ml} ml${tf.order!.diet.tube.mode === 'continuous' ? '（本班連續灌食量）' : ''}` })
      // 約束：每 2 小時查核；醫囑待補、到期（醫師處理，護理站也列出來提醒）
      for (const x of restraintTodosOf(a.id, t)) tasks.push({ ...base, id: `rs-${x.kind}-${x.restraintId}`, kind: 'restraint', urgency: x.urgency, at: x.at, text: x.text })
      // 譫妄：65 歲以上、術後 72 小時內每班評一次 CAM
      const ds = deliriumStateOf(a, t)
      if (ds.target && !ds.thisShift) tasks.push({ ...base, id: `dl-${a.id}`, kind: 'delirium', urgency: 'todo', text: `譫妄評估 CAM（${ds.target}，每班）` })
      // 傷口：2 週沒變小（提醒主治，護理站也列）、院內壓傷待病情變化加評（點了到風險評估）
      for (const x of woundTodosOf(a, t)) tasks.push({ ...base, id: `wd-${x.kind}-${x.woundId}`, kind: 'wound', urgency: 'todo', text: x.text })
      // 加護病房：重症流程表每小時一筆，超過 75 分鐘沒記列逾時
      for (const x of icuTodosOf(a, t)) tasks.push({ ...base, id: `icu-${a.id}`, kind: 'icu', urgency: 'overdue', at: x.at, text: x.text })
      // 呼吸器實測、RASS：每 4 小時（記在重症流程表）
      for (const x of ventTodosOf(a, t)) tasks.push({ ...base, id: `${x.kind}-${a.id}`, kind: 'vent', urgency: x.urgency, at: x.at, text: x.text })
      // 點滴：待接上、快滴完／已滴完要換瓶、醫囑停了還在滴
      for (const x of infusionTodosOf(a.id, t)) tasks.push({ ...base, id: `iv-${x.kind}-${x.runId ?? x.orderId}`, kind: 'infusion', urgency: x.urgency, ...(x.at ? { at: x.at } : {}), text: x.text })
      // PCA：每 4 小時紀錄（到期前 30 分鐘「現在」、過了「逾時」）；未處理的警示（醫師處理，護理站也列出來）
      const pc = runningPca(a.id)
      if (pc) {
        const rd = pcaRecordState(pc, t)
        if (rd && rd.status !== 'ok') tasks.push({ ...base, id: `pca-${pc.id}`, kind: 'pca', urgency: rd.status === 'overdue' ? 'overdue' : 'due', at: rd.dueAt, text: 'PCA 紀錄（每 4 小時：按壓、用量、疼痛、鎮靜、呼吸）' })
        if (pcaOpenAlert(pc)) tasks.push({ ...base, id: `pca-alert-${pc.id}`, kind: 'pca', urgency: 'overdue', text: 'PCA 警示：鎮靜過深或呼吸過慢，等醫師處理' })
      }
      const po = openPca(a.id)
      if (po?.status === 'ordered') tasks.push({ ...base, id: `pca-setup-${po.id}`, kind: 'pca', urgency: 'due', at: po.orderedAt, text: '新開的 PCA：雙人核對架設' })
      // 出院準備：入院 72 小時內篩選（最後 12 小時「現在」、過了「逾時」）
      if (plannable(a) && !planOf(a.id)) {
        const pd = planScreenStateOf(a, t)
        if (pd.status !== 'todo') tasks.push({ ...base, id: `plan-${a.id}`, kind: 'plan', urgency: pd.status === 'overdue' ? 'overdue' : 'due', at: pd.dueAt, text: '出院準備篩選（入院 72 小時內）' })
      }
      // 營養篩檢：入院 48 小時內（還早的列「待處理」、最後 6 小時「現在」、過了「逾時」）
      if (screenable(a)) {
        const nd = screenStateOf(a, t).due
        if (nd.status !== 'done') tasks.push({ ...base, id: `nut-${a.id}`, kind: 'nutrition', urgency: nd.status === 'overdue' ? 'overdue' : nd.status === 'due' ? 'due' : 'todo', at: nd.dueAt, text: '營養篩檢（入院 48 小時內）' })
      }
    }
    if (changed) commitIfPossible()
    return tasks.sort((x, y) => URGENCY_RANK[x.urgency] - URGENCY_RANK[y.urgency] || (x.at ?? '9').localeCompare(y.at ?? '9') || x.bedNo.localeCompare(y.bedNo))
  })
}

export interface PrnView extends OrderView {
  /** 上次給藥時間：PRN 藥品要避免短時間內重複給 */
  lastGivenAt?: string
}

/** 護理站給藥工作板（BFF）：某日排程 + PRN 藥品 + 待執行的臨時醫囑，一次取回，三塊資料不會彼此不同步 */
export interface MarBoard {
  mar: MarView[]
  prn: PrnView[]
  /** elsewhere：不在這裡按完成（影像由檢查室、要掃描的檢驗到「檢體」），畫面顯示這段說明 */
  stat: (OrderView & { elsewhere?: string })[]
}

export function getMarBoard(admissionId: string, date: string): Promise<MarBoard> {
  return query(() => {
    if (ensureMar(admissionId, date)) commitIfPossible()
    const orders = db.ipdOrders.filter((o) => o.admissionId === admissionId && o.status === 'active')
    return {
      mar: marViews(admissionId, date),
      prn: orders
        .filter((o) => o.category === 'medication' && o.freq === 'PRN')
        .map((o) => ({
          ...orderView(o),
          lastGivenAt: db.mar.filter((m) => m.orderId === o.id && m.status === 'given').map((m) => m.executedAt ?? '').sort().pop(),
        })),
      stat: orders.filter((o) => o.type === 'stat' && o.category !== 'medication').map((o) => ({ ...orderView(o), ...((w) => (w ? { elsewhere: w } : {}))(statElsewhere(o)) })),
    }
  })
}

// ---------- 護理站的醫囑清單（唯讀）----------
// 以前護理站只看得到給藥排程、PRN、臨時非給藥醫囑；長期的護理醫囑（翻身 Q2H）、飲食（禁食）、處置，
// 護理師在任何頁面都看不到——醫師開了，執行的人卻不知道。

export type NursingOrderView = OrderView & {
  change: OrderChange | null
  needsAck: boolean
  /** 待醫師回覆的疑問（不能核對、給藥暫停） */
  pendingQuery?: { reason: string; byName: string; at: string }
  /** 醫師最近一次回覆（核對前要看到） */
  lastReply?: { reply: string; byName: string; at: string; resolution?: string }
}
export interface NursingOrderGroup {
  category: IpdOrder['category']
  label: string
  orders: NursingOrderView[]
}
const ORDER_GROUPS: { category: IpdOrder['category']; label: string }[] = [
  { category: 'diet', label: '飲食' },
  { category: 'nursing', label: '護理' },
  { category: 'procedure', label: '處置・檢查' },
  { category: 'medication', label: '用藥（給藥請至給藥紀錄）' },
]

/** 執行中的醫囑，加上 24 小時內停止或完成的（標示異動），依類別分組；飲食放最前面（禁食最要緊） */
export function listNursingOrders(admissionId: string): Promise<NursingOrderGroup[]> {
  return query(() => {
    const t = now()
    const shown = db.ipdOrders
      .filter((o) => o.admissionId === admissionId)
      .map((o) => {
        const q = openQuery(o)
        const answered = !q ? o.queries?.filter((x) => x.replyAt).at(-1) : undefined
        return {
          ...orderView(o),
          change: orderChange(o, t),
          needsAck: needsAck(o),
          ...(q ? { pendingQuery: { reason: q.reason, byName: nameOf.user(q.by), at: q.at } } : {}),
          ...(answered ? { lastReply: { reply: answered.reply ?? '', byName: nameOf.user(answered.replyBy), at: answered.replyAt!, resolution: answered.resolution } } : {}),
        }
      })
      // 還沒核對的停止醫囑即使超過 24 小時也要列出——沒人確認過，就還不能從清單上消失
      .filter((o) => o.status === 'active' || o.change || o.needsAck)
      // 執行中的在前；同一類裡新開的在前
      .sort((a, b) => Number(a.status !== 'active') - Number(b.status !== 'active') || b.startAt.localeCompare(a.startAt))
    return ORDER_GROUPS.map((g) => ({ ...g, orders: shown.filter((o) => o.category === g.category) })).filter((g) => g.orders.length)
  })
}

/**
 * 核對醫囑：逐筆（orderIds 一筆）或整批（畫面上看得到的全部）核對「新開未簽收、停止未確認」的醫囑。
 * 只核對按下當時看得到的那幾筆：若醫師剛好又開了一筆，畫面還沒顯示，就不能一起被簽掉。
 * 有疑問、待醫師回覆的不能核對（整批核對時跳過並回報 skipped；單筆指定則擋下）。稽核記下核對了哪幾筆。
 */
export function ackOrders(admissionId: string, orderIds: string[]): Promise<{ count: number; skipped: number }> {
  return mutate(() => {
    const nurse = requireUser('nurse')
    admitted(admissionId)
    const t = now()
    const asked = db.ipdOrders.filter((o) => o.admissionId === admissionId && orderIds.includes(o.id) && needsAck(o))
    const targets = asked.filter((o) => !openQuery(o))
    if (asked.length && !targets.length) fail('這筆醫囑有疑問、待醫師回覆，回覆後才能核對', 'CONFLICT')
    if (!targets.length) fail('沒有需要核對的醫囑', 'CONFLICT')
    for (const o of targets) {
      if (o.status === 'active') Object.assign(o, { ackAt: t, ackBy: nurse.id })
      else Object.assign(o, { stopAckAt: t, stopAckBy: nurse.id })
    }
    audit('核對醫囑', targets.map((o) => `${o.status === 'active' ? '新' : '停'}：${o.content}`).join('、'))
    return { count: targets.length, skipped: asked.length - targets.length }
  })
}

/**
 * 有疑問、退回醫師：護理師對某筆執行中的醫囑提出疑問（寫原因）。醫師回覆前不能核對、給藥暫停
 * （緊急時可寫原因強制給藥）。已經核對過的也可以提（疑問可能在執行時才發現）。
 */
export function queryOrder(orderId: string, reason: string): Promise<{ ok: true }> {
  return mutate(() => {
    const nurse = requireUser('nurse')
    const o = must(db.ipdOrders.find((x) => x.id === orderId), '醫囑')
    admitted(o.admissionId)
    if (o.status !== 'active') fail('已停止或完成的醫囑不能再提疑問', 'CONFLICT')
    if (openQuery(o)) fail('這筆醫囑已有疑問、待醫師回覆', 'CONFLICT')
    const why = reason?.trim()
    if (!why) failField('reason', '請寫疑問（例：劑量 1000mg 疑為 100mg）')
    o.queries = [...(o.queries ?? []), { by: nurse.id, at: now(), reason: why! }]
    audit('醫囑疑問', `${o.content}：${why}`)
    return { ok: true as const }
  })
}

/**
 * 執行給藥：given 給藥 / held 暫停 / refused 拒絕（後兩者須註明原因）。
 * 醫囑有疑問、待醫師回覆時，給藥要帶 force 並寫原因（例：醫師電話口頭確認、病人急需）——暫停、拒絕照常。
 * givenAt：補登實際給藥時間（只限 given）；不填就是現在。補登時 recordedAt 記下實際登打的時間。
 */
export function executeMar(marId: string, status: Exclude<MarRecord['status'], 'pending'>, note = '', givenAt?: string, force?: { reason: string }, witness?: string, scan?: ScanInput): Promise<MarRecord> {
  return mutate(() => {
    const nurse = requirePermission('mar.give')
    const m = must(db.mar.find((x) => x.id === marId), '給藥紀錄')
    admitted(m.admissionId)
    if (m.status !== 'pending') fail('此筆已執行', 'CONFLICT')
    if (status !== 'given' && !note.trim()) failField('note', '暫停或拒絕給藥需註明原因')
    const t = now()
    // 暫停、拒絕記的是「決定」，就是現在；只有給藥可以補登實際時間
    const at = status === 'given' && givenAt ? givenAt : t
    if (at !== t) {
      const problem = checkGivenAt(m.scheduledAt, at, t)
      if (problem) failField('givenAt', problem)
    }
    // 提早給藥是給藥錯誤的一種；「暫停」可以提前決定（例如術前禁食），所以只擋給藥
    if (status === 'given' && marUrgency(m.scheduledAt, at) === 'upcoming') {
      fail(`尚未到給藥時間（預定 ${m.scheduledAt.slice(11)}，最早可提前 ${MAR_EARLY_MIN} 分鐘）`)
    }
    const order = must(db.ipdOrders.find((o) => o.id === m.orderId), '醫囑')
    // 需健保事前審查的藥：核准前不能給（病人同意自費、醫師寫緊急理由除外）
    if (status === 'given') requireDrugPreAuth(order)
    // 排程給藥的藥由住院藥局調劑送來（UD）：還沒調劑就是藥還沒到病房，不能記「已給」
    // 核對通過、送到病房才算（只調劑還在藥局核對中，藥也還沒到）
    if (status === 'given' && order.type === 'long' && udStage(m) !== 'verified') {
      fail(udStage(m) === 'prepared' ? `這一劑（${m.scheduledAt.slice(5)}）藥局已調劑、還在核對，核對送出後才能給` : `藥局尚未調劑這一劑（${m.scheduledAt.slice(5)}）：請聯絡住院藥局補調劑`, 'CONFLICT', 'ud')
    }
    // 給藥前核對病人與藥品（條碼）：暫停、拒絕沒有給，不用掃
    const scanned = status === 'given' ? settleScan(admitted(m.admissionId), order, scan) : undefined
    // 暫停、拒絕本來就是「不給」，照常；只有給藥要過這一關
    const forced = status === 'given' ? holdForQuery(order, force) : undefined
    const res = status === 'given' ? residualCheck(order, nurse.id, witness) : undefined
    // 臨時（STAT）給藥用病房常備藥：給的時候扣住院藥局
    const stock = status === 'given' && order.type === 'stat' ? wardStockOut(order, admitted(m.admissionId).admitNo, nurse.id, res?.ledger ?? {}) : undefined
    if (stock) m.stockFrom = stock.from
    if (res) m.residual = res.residual
    const noteText = [note.trim(), forced ? `疑問期間仍給藥：${forced}` : ''].filter(Boolean).join('；')
    Object.assign(m, { status, note: noteText || undefined, executedAt: at, recordedAt: at !== t ? t : undefined, nurseId: nurse.id, ...(scanned ? { scan: scanned } : {}) })
    // 臨時給藥醫囑執行後即完成；完成時間記在 stopAt（和非給藥的臨時醫囑一樣），護理站才看得出「已完成」與時間
    if (order.type === 'stat') {
      order.status = 'done'
      order.stopAt = at
    }
    audit(forced ? '疑問期間仍給藥' : '給藥', `${order.content} ${status}${at !== t ? `（補登 ${at.slice(11)}）` : ''}${noteText ? `：${noteText}` : ''}${res ? `；${res.text}` : ''}${scanned ? `；${scanText(scanned)}` : ''}`)
    if (res) consumeWitness(witness)
    return m
  })
}

/** PRN（需要時）給藥：沒有排程，執行時直接新增一筆已給藥紀錄 */
export function givePrn(orderId: string, note: string, force?: { reason: string }, witness?: string, scan?: ScanInput): Promise<MarRecord> {
  return mutate(() => {
    const nurse = requirePermission('mar.give')
    const o = must(db.ipdOrders.find((x) => x.id === orderId), '醫囑')
    admitted(o.admissionId)
    if (o.status !== 'active' || o.freq !== 'PRN') fail('此醫囑不是有效的 PRN 給藥')
    if (!note.trim()) failField('note', '請註明給藥原因（例：體溫 38.5°C）')
    requireDrugPreAuth(o)
    const scanned = settleScan(admitted(o.admissionId), o, scan)
    const forced = holdForQuery(o, force)
    const res = residualCheck(o, nurse.id, witness)
    // PRN 用病房常備藥：給的時候扣住院藥局
    const stock = wardStockOut(o, admitted(o.admissionId).admitNo, nurse.id, res?.ledger ?? {})
    const t = now()
    const text = [note.trim(), forced ? `疑問期間仍給藥：${forced}` : ''].filter(Boolean).join('；')
    const m: MarRecord = { id: newId('MAR'), orderId: o.id, admissionId: o.admissionId, scheduledAt: t, status: 'given', executedAt: t, nurseId: nurse.id, note: text, ...(stock ? { stockFrom: stock.from } : {}), ...(res ? { residual: res.residual } : {}), ...(scanned ? { scan: scanned } : {}) }
    db.mar.push(m)
    audit(forced ? '疑問期間仍給藥' : 'PRN 給藥', `${o.content}：${text}${res ? `；${res.text}` : ''}${scanned ? `；${scanText(scanned)}` : ''}`)
    if (res) consumeWitness(witness)
    return m
  })
}

/**
 * 管制藥殘餘量：給不是整數的劑量（Morphine 0.5 AMP）時，整支扣、剩下的當場銷毀——要另一位護理師見證（witness.approveWitness residual）。
 * 沒有殘餘量回傳 undefined；有就檢查見證，回傳要記在給藥紀錄、異動帳上的內容
 */
function residualCheck(o: IpdOrder, nurseId: string, token?: string) {
  const drug = find.drug(o.drugId ?? '')
  const r = drug ? residualOf(drug, o.dose) : undefined
  if (!r) return undefined
  const w = witnessFor(token, 'residual', o.id, nurseId)
  if (w === null) failField('witness', `管制藥殘餘 ${r.residual} ${drug!.unit} 要當場銷毀，需另一位護理師見證`)
  if (w === 'expired') failField('witness', `見證已超過 ${WITNESS_MIN} 分鐘，請重新見證`)
  const g = w as Exclude<typeof w, null | 'expired'>
  const text = `給 ${o.dose} ${drug!.unit}、殘餘 ${r.residual} ${drug!.unit} 銷毀（見證 ${g.witnessName}）`
  return { residual: { qty: r.residual, witnessBy: g.witnessId }, ledger: { witnessBy: g.witnessId, reason: text }, text }
}

/**
 * 醫囑有疑問、待醫師回覆：執行要暫停。緊急時可帶 force（寫原因）強制執行，回傳那個原因（寫進紀錄與稽核）。
 * 沒有疑問回傳 undefined。給藥（排程、PRN）與臨時醫囑的執行共用這一條。
 */
function holdForQuery(o: IpdOrder, force?: { reason: string }): string | undefined {
  // 護理師的疑問或藥師的疑義都要等醫師回覆
  const q = openQuery(o)
  const pq = openPharmQuery(o.pharm)
  if (!q && !pq) return undefined
  const why = force?.reason?.trim()
  if (!why) fail(`這筆醫囑${q ? `有疑問、待醫師回覆（${q.reason}）` : `有藥師疑義、待醫師回覆（${pq!.text}）`}；執行暫停，緊急時請寫原因強制執行`, 'CONFLICT', 'query')
  return why
}

/**
 * 這筆臨時醫囑不是在給藥紀錄按「完成」：影像由檢查室完成（醫囑自動完成）；要掃描核對的醫院，檢驗要到「檢體」掃描採檢。
 * 回傳要給護理師看的說明（護理站不顯示「完成」鈕，免得先確認才被告知做不了）
 */
export function statElsewhere(o: IpdOrder): string | undefined {
  if (o.procId && find.procedure(o.procId)?.imaging) return '由影像檢查室排程、完成（完成後醫囑自動完成）'
  if (isLabOrder(o) && scanRequired()) return '到病人分頁「檢體」印條碼、掃描採檢'
  return undefined
}
const isImagingOrder = (o: IpdOrder) => !!o.procId && !!find.procedure(o.procId)?.imaging

/** 執行臨時醫囑（檢驗、處置等非給藥） */
/** 回傳 { ok: true }：讓呼叫端分得出「成功」與「失敗被擋」（void 的話兩者都是 undefined） */
export function completeStatOrder(orderId: string, force?: { reason: string }, fasting?: { fasting?: boolean; note?: string }): Promise<{ ok: true }> {
  return mutate(() => {
    const nurse = requirePermission('mar.give')
    const o = must(db.ipdOrders.find((x) => x.id === orderId), '醫囑')
    admitted(o.admissionId)
    if (o.type !== 'stat' || o.status !== 'active') fail('此醫囑無需執行')
    if (o.category === 'medication') fail('給藥醫囑請由給藥紀錄執行')
    if (o.procId && find.procedure(o.procId)?.imaging) fail('影像檢查由檢查室排程、報到、完成（完成後醫囑自動完成）', 'CONFLICT')
    const forced = holdForQuery(o, force)
    const t = now()
    // 檢驗醫囑：「執行」＝採檢。已印條碼的就採那一支（同管的一起完成）；沒印的當場建一支已採檢的檢體（等檢驗科收件）
    if (isLabOrder(o)) {
      const s = specimenOfOrder(o.id)
      const sp = s && !s.collectedAt ? s : newSpecimen(must(find.admission(o.admissionId), '住院紀錄'), tubeOfOrder(o), [o.id], nurse.id, t, true)
      // 要掃描核對的醫院（和給藥同一個設定）：檢驗要在「檢體」印條碼、掃腕帶與檢體條碼採檢，不能從這裡直接執行
      if (scanRequired()) fail('採檢要掃描核對病人：請到病人分頁「檢體」印條碼，掃腕帶與檢體條碼採檢', 'CONFLICT')
      // 有要空腹的檢驗：要答有沒有空腹（沒空腹不擋，記原因）
      recordFasting(sp, fasting, nurse.id, t)
      const os = collectRecord(sp, nurse.id, t)
      audit(forced ? '疑問期間仍執行' : '採檢', `${sp.barcode} ${os.map((x) => x.content).join('、')}${forced ? `：${forced}` : ''}`)
      return { ok: true as const }
    }
    o.status = 'done'
    o.stopAt = t
    audit(forced ? '疑問期間仍執行' : '執行臨時醫囑', `${o.content}${forced ? `：${forced}` : ''}`)
    return { ok: true as const }
  })
}

// ---------- 生命徵象 ----------
export function listVitals(admissionId: string): Promise<VitalRecord[]> {
  return query(() => db.vitals.filter((v) => v.admissionId === admissionId).sort((a, b) => a.at.localeCompare(b.at)))
}

export type { VitalInput } from './vital-work'

export function addVitals(input: VitalInput): Promise<VitalRecord & { rrtCalled?: boolean }> {
  return mutate(() => {
    const nurse = requireUser('nurse')
    const a = admitted(input.admissionId)
    const t = now()
    const v = buildVital(input, nurse.id, t)
    db.vitals.push(v)
    audit('生命徵象', a.admitNo)
    // NEWS2 ≥7：自動呼叫快速反應小組（已經在等、或已經申請轉加護病房的不重複叫）
    const rrt = autoCallRrt(a, v, t)
    if (rrt) audit('呼叫快速反應小組', `${a.admitNo} ${nameOf.patient(a.patientId)}：NEWS2 ${rrt.score} 分（自動）`)
    return { ...v, ...(rrt ? { rrtCalled: true } : {}) }
  })
}

// ---------- 護理紀錄 ----------
export function listNursingNotes(admissionId: string): Promise<(NursingNote & { nurseName: string })[]> {
  return query(() =>
    db.nursingNotes
      .filter((n) => n.admissionId === admissionId)
      .sort((a, b) => b.at.localeCompare(a.at))
      .map((n) => ({ ...n, nurseName: nameOf.user(n.nurseId) })),
  )
}

export function addNursingNote(input: Pick<NursingNote, 'admissionId' | 'focus' | 'data' | 'action' | 'response'> & { callId?: string }): Promise<NursingNote> {
  return mutate(() => {
    const nurse = requireUser('nurse')
    admitted(input.admissionId)
    const n: NursingNote = {
      admissionId: input.admissionId,
      focus: input.focus.trim(),
      data: input.data.trim(),
      action: input.action.trim(),
      response: input.response.trim(),
      id: newId('NN'),
      at: now(),
      nurseId: nurse.id,
    }
    const errs = fieldErrors()
    if (!n.focus) errs.add('focus', '請輸入焦點（Focus）')
    if (!n.data && !n.action) errs.add('data', '資料（D）與措施（A）至少填寫一項')
    errs.done()
    // 從呼叫醫師帶入：同一位病人、醫師回覆了、還沒寫過護理紀錄的那筆，標記已記錄
    if (input.callId) {
      const c = db.doctorCalls.find((x) => x.id === input.callId)
      if (!c || c.admissionId !== n.admissionId) fail('找不到這位病人的呼叫紀錄', 'NOT_FOUND')
      if (!c!.response) fail('醫師還沒回覆，回覆後再帶入護理紀錄', 'CONFLICT')
      if (c!.noteId) fail('這筆呼叫已經寫過護理紀錄了', 'CONFLICT')
      c!.noteId = n.id
      n.callId = c!.id
    }
    db.nursingNotes.push(n)
    return n
  })
}

/** 補記反應（R）：只能補一次，已寫過的不能覆蓋（醫療紀錄只能增補，不能改寫） */
export function addNoteResponse(noteId: string, response: string): Promise<NursingNote> {
  return mutate(() => {
    requireUser('nurse')
    const n = must(db.nursingNotes.find((x) => x.id === noteId), '護理紀錄')
    if (n.response) fail('此紀錄已有反應（R），如需更正請另寫一筆', 'CONFLICT')
    if (!response.trim()) fail('請輸入反應內容')
    n.response = response.trim()
    n.respondedAt = now()
    return n
  })
}

// ---------- 交班 ----------
/** receiverName：接班的人（下一班分到這位病人的護理師；還沒分床就列下一班上班的人） */
export type HandoverView = HandoverNote & { nurseName: string; patientName: string; bedNo: string; receiverName?: string }

/** 最近幾班的交班：預設 3 班（一整天），接班的人一定看得到上一班——不論中間是否跨過午夜 */
export const HANDOVER_SHIFTS = 3

export interface HandoverGroup extends ShiftInstance {
  items: HandoverView[]
}

/** 依「班」分組，最新的班在前（接班的人先看到上一班）；只回傳有紀錄的班 */
export function listHandovers(ward: string): Promise<HandoverGroup[]> {
  return query(() => {
    const shifts = recentShifts(now(), HANDOVER_SHIFTS)
    return shifts
      .map((s) => ({
        ...s,
        items: db.handovers
          .filter((h) => h.ward === ward && h.date === s.date && h.shift === s.shift)
          .map((h) => {
            const a = find.admission(h.admissionId)
            const nx = nextShift({ date: h.date, shift: h.shift })
            const rid = assignedNurse(h.admissionId, nx)
            const duty = onDuty(ward, nx)
            const receiverName = rid ? nameOf.user(rid) : duty.length ? `${duty.map((id) => nameOf.user(id)).join('、')}（未分床）` : undefined
            return { ...h, nurseName: nameOf.user(h.nurseId), patientName: a ? nameOf.patient(a.patientId) : '', bedNo: a?.bedId ? find.bed(a.bedId)?.bedNo ?? '' : '', ...(receiverName ? { receiverName } : {}) }
          })
          // 交班是沿著病房一床一床走：依床號排，同一床再依時間
          .sort((a, b) => a.bedNo.localeCompare(b.bedNo) || a.createdAt.localeCompare(b.createdAt)),
      }))
      .filter((g) => g.items.length)
  })
}

export function addHandover(input: { ward: string; shift: Shift; admissionId: string; content: string }): Promise<HandoverNote> {
  return mutate(() => {
    const nurse = requireUser('nurse')
    const a = admitted(input.admissionId)
    if (wardOf(a) !== input.ward) fail('病人不在此病房')
    if (!input.content.trim()) failField('content', '交班內容不可空白')
    const t = now()
    // date 是「這一班開始的日期」：午夜後才寫的小夜交班，歸在前一天的小夜
    const h: HandoverNote = { ward: input.ward, shift: input.shift, admissionId: a.id, content: input.content.trim(), id: newId('HO'), date: shiftInstanceOf(input.shift, t).date, nurseId: nurse.id, createdAt: t }
    db.handovers.push(h)
    audit('交班', `${input.ward} ${input.shift}`)
    return h
  })
}

/** 交班：這個病房的病人最近 24 小時的值班紀錄（夜間值班醫師處理過的事；主治看過沒有） */
export function wardDutyNotes(ward: string): Promise<{ id: string; admissionId: string; bedNo: string; patientName: string; at: string; doctorName: string; items: { label: string; text: string }[]; acked: boolean }[]> {
  return query(() => {
    requireUser('nurse', 'doctor')
    const from = addMinutes(now(), -24 * 60)
    const ids = new Map(db.admissions.filter((a) => a.status === 'admitted' && wardOf(a) === ward).map((a) => [a.id, a]))
    return db.progressNotes.filter((n) => n.kind === 'duty' && ids.has(n.admissionId) && n.at >= from)
      .map((n) => ((a) => ({ id: n.id, admissionId: a.id, bedNo: (a.bedId ? find.bed(a.bedId)?.bedNo : undefined) ?? '', patientName: nameOf.patient(a.patientId), at: n.at, doctorName: nameOf.doctor(n.doctorId), items: n.items ?? [], acked: !!n.dutyAck }))(ids.get(n.admissionId)!))
      .sort((x, y) => x.bedNo.localeCompare(y.bedNo) || x.at.localeCompare(y.at))
  })
}

/** 交班：這個病房本班（班開始到現在）呼叫醫師的統計與還沒結束的（還沒回覆、沒升級） */
export function wardCallStats(ward: string): Promise<{ from: string; calls: number; urgent: number; escalated: number; avgWait?: number; open: { id: string; bedNo: string; patientName: string; at: string; toName: string; urgent: boolean; waitMin: number }[] }> {
  return query(() => {
    requireUser('nurse', 'doctor')
    const t = now()
    const from = shiftRange(t).start
    const ids = new Map(db.admissions.filter((a) => a.status === 'admitted' && wardOf(a) === ward).map((a) => [a.id, a]))
    const list = db.doctorCalls.filter((c) => ids.has(c.admissionId) && c.calledAt >= from && c.calledAt <= t)
    const answered = list.filter((c) => c.response)
    const mins = (a: string, b: string) => Math.round((Date.parse(b.replace(' ', 'T')) - Date.parse(a.replace(' ', 'T'))) / 60000)
    return {
      from, calls: list.length, urgent: list.filter((c) => c.urgency === 'urgent').length,
      escalated: list.filter((c) => c.escalatedTo || c.rrtId).length,
      ...(answered.length ? { avgWait: Math.round(answered.reduce((s, c) => s + mins(c.calledAt, c.response!.at), 0) / answered.length) } : {}),
      open: list.filter((c) => !c.response && !c.escalatedTo && !c.rrtId).map((c) => ((a) => ({ id: c.id, bedNo: (a.bedId ? find.bed(a.bedId)?.bedNo : undefined) ?? '', patientName: nameOf.patient(a.patientId), at: c.calledAt, toName: nameOf.user(c.toUserId), urgent: c.urgency === 'urgent', waitMin: mins(c.calledAt, t) }))(ids.get(c.admissionId)!)).sort((x, y) => x.at.localeCompare(y.at)),
    }
  })
}

export interface WardChestTube {
  admissionId: string
  patientName: string
  bedNo: string
  lineId: string
  site: string
  size: string
  /** 放第幾天 */
  day: number
  /** 這一班（班開始到現在）的引流量、筆數 */
  shiftMl: number
  shiftRecords: number
  ml24: number
  /** 本班最後一筆的外觀（本班還沒記就沒有） */
  lastAppearance?: string
  airLeak: boolean
  alerts: string[]
  /** 帶入交班重點的一句話 */
  text: string
}
/** 交班：病房裡身上有胸管的病人，本班引流、24 小時量、漏氣、提醒（帶入交班重點用） */
export function wardChestTubes(ward: string): Promise<WardChestTube[]> {
  return query(() => {
    requireUser('nurse')
    const t = now()
    const { start } = shiftRange(t)
    const out: WardChestTube[] = []
    for (const a of db.admissions.filter((x) => x.status === 'admitted' && wardOf(x) === ward)) {
      for (const l of activeLines(a.id).filter((x) => x.kind === 'chest')) {
        const s = chestState(l, t)
        const recs = (l.drainage ?? []).filter((d) => d.at >= start)
        const shiftMl = recs.reduce((n, d) => n + d.ml, 0)
        const day = Math.floor((Date.parse(t.slice(0, 10)) - Date.parse(l.insertedAt.slice(0, 10))) / 86400000) + 1
        const alerts = [s.bleeding && `每小時 ${s.lastRate} mL（≥${CHEST_BLEED_MLH}），已通知醫師？`, s.recordDue && '超過 8 小時沒記引流', s.removeHint && '24 小時 <200 mL 沒漏氣，可請醫師評估拔管'].filter((x): x is string => !!x)
        const text = `胸管（${l.site} ${l.size}，第 ${day} 天）本班引流 ${shiftMl} mL${recs.length ? `（${recs.at(-1)!.appearance}）` : '（本班還沒記）'}，24 小時 ${s.ml24} mL，${s.airLeak ? '有漏氣' : '無漏氣'}${alerts.length ? `；${alerts.join('；')}` : ''}`
        out.push({ admissionId: a.id, patientName: nameOf.patient(a.patientId), bedNo: (a.bedId ? find.bed(a.bedId)?.bedNo : undefined) ?? '', lineId: l.id, site: l.site, size: l.size, day, shiftMl, shiftRecords: recs.length, ml24: s.ml24, ...(recs.length ? { lastAppearance: recs.at(-1)!.appearance } : {}), airLeak: s.airLeak, alerts, text })
      }
    }
    return out.sort((x, y) => x.bedNo.localeCompare(y.bedNo))
  })
}

/** 我這一班排在哪個病房（護理站沒指定病房時先開這個；首頁的待辦大多依責任分床算） */
export function myWard(): Promise<string | undefined> {
  return query(() => myWardOf(requireUser('nurse').id, now()))
}

// ---------- 今日輸入輸出（生命徵象的輸入量＋管灌灌入量；輸出量） ----------
export function ioToday(admissionId: string): Promise<{ date: string; intake: number; tubeMl: number; ivMl: number; output: number; drainMl: number }> {
  return query(() => {
    requireUser('nurse', 'doctor')
    const d = today()
    const vs = db.vitals.filter((v) => v.admissionId === admissionId && v.at.startsWith(d))
    const tubeMl = db.tubeFeeds.filter((r) => r.admissionId === admissionId && r.at.startsWith(d)).reduce((n, r) => n + r.givenMl, 0)
    const ivMl = infusedToday(admissionId, now())
    // 胸管引流、穿刺放出的量自動算進輸出（今天 00:00 到現在）
    const drainMl = drainBetween(admissionId, `${d} 00:00`, '9999')
    return { date: d, intake: vs.reduce((n, v) => n + (v.intake ?? 0), 0) + tubeMl + ivMl, tubeMl, ivMl, output: vs.reduce((n, v) => n + (v.output ?? 0), 0) + drainMl, drainMl }
  })
}
