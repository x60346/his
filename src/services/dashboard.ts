// 首頁儀表板：今日營運指標與近 7 日門診人次趨勢。
import { db } from '@/mock/db'
import { riskStateOf } from './risk-work'
import { isImportantNoShow, isNoShow, NO_SHOW_TRACK_DAYS, noShowClosed } from './followup-rules'
import { addDays, now, today, addMinutes } from '@/utils/date'
import { permissionsOf, query, sessionRole, sessionUser } from './http'
import { openQuery, shiftInstanceOf, shiftOf } from './nursing-rules'
import { nameOf, openDeptTransfer, stockLoc } from './views'
import { usableQty } from './stock-rules'
import { pendingRefundOf } from './money'
import { suspendNoticeVisits } from './schedule'
import { awaitingPickup } from './pharmacy'
import { pendingReturn, udCandidate } from './ud-work'
import { labAckCount, labWorkCount } from './lab-work'
import { imagingAckCount, imagingWorkCount } from './imaging-work'
import { abxAttendingTodo, abxPendingCounts, isInfectious } from './abx-work'
import { activeIpdChargeOf, dischargeRxPending, interimSuggestion, ipdBillOf } from './ipd-bill'
import { pendingReplyVisits } from './referral-work'
import { bloodLabCounts, reactionsToAck, transfusionTodoCount } from './blood-work'
import { surgeryCounts } from './surgery-work'
import { erCounts, isErDoctor } from './er-work'
import { erBillMode } from './er-rules'
import { attendingLineAlerts, lineTodosOf, painStateOf } from './line-work'
import { nutritionCounts, screenable, screenStateOf } from './nutrition-work'
import { myScope } from './staffing-work'
import { planCounts } from './discharge-plan-work'
import { pcaOpenAlert, pcaRecordState, runningPca } from './pca-work'
import { infusionTodosOf } from './infusion-work'
import { woundStallCount } from './wound-work'
import { icuHourly } from './icu-work'
import { careRoleOf } from './care-team'
import { deliriumDoctorCounts, restraintTodosOf } from './delirium-work'
import { isObsBed, obsOpen } from './bed-work'

export interface DashboardStats {
  date: string
  opd: { total: number; waiting: number; inConsult: number; toCharge: number; toDispense: number; done: number; cancelled: number }
  /** 今日收入：只回傳給掛號批價與管理員——財務數字不是每個角色都該看到（只在畫面上藏起來不夠，資料本身就不送） */
  revenue?: { patientTotal: number; nhiPoints: number; receipts: number }
  ipd: { admitted: number; reservedToday: number; emptyBeds: number; totalBeds: number; overdueMar: number }
  /** 停診退掛、還沒電話通知的病人數（櫃台待辦） */
  suspendNoticesPending: number
  lowStockDrugs: number
  /** 補貨申請待到貨（和藥品庫存頁「待到貨」卡片同一個來源） */
  restockOpen: number
  /** 採購單待核准（管理員待辦）、已訂購待到貨（藥師待辦） */
  purchasePending: number
  purchaseOrdered: number
  /** 醫師：我（主治）的住院病人有幾筆醫囑疑問待回覆 */
  orderQueries?: number
  /** 醫師：轉入我科、等我接的轉科申請 */
  transferIncoming?: number
  /** 醫師：待我（我這科）回覆的會診；其中急會診幾張 */
  consultIncoming?: number
  /** 我申請的門診會診已回覆、還沒看 */
  consultReplies?: number
  /** 醫師：持外院轉診單、我看過、還沒開轉診回覆單 */
  referralReplies?: number
  /** 待我（我這科）回覆的門診會診 */
  opdConsultIncoming?: number
  /** 我的病人（我是主治）有會診醫師新開、還沒按已閱的醫囑：病人數 */
  consultOrdersUnseen?: number
  /** 醫師：危急值或更正過、待我確認的檢驗報告 */
  labAcks?: number
  /** 檢驗科：可以登打的待檢驗（住院還沒採檢的不算） */
  labWork?: number
  /** 醫師：待我判讀的影像（放射科；心電圖是開立醫師自己）、待我確認的影像報告（重要發現或補充） */
  imagingWork?: number
  imagingAcks?: number
  /** 感染科：管制性抗生素待審核（其中超過 48 小時的）；主治：審核未通過待處理、核准天數快到（要申請續用） */
  abxPending?: number
  abxOverdue?: number
  abxRejected?: number
  abxExtend?: number
  consultUrgent?: number
  /** 血庫：待驗血型或交叉試驗沒配滿的備血單（其中急件）；護理站：已發血待輸、輸血中該量 15 分鐘生命徵象的（全院）；醫師：我的病人輸血反應待確認 */
  bloodWork?: number
  bloodUrgent?: number
  transfusionTodo: number
  bloodReactions?: number
  /** 手術：待排程（有手術排程權限的人）、今明兩天要開但術前準備沒完成（護理站）、我是主刀手術紀錄待寫 */
  surgeryToSchedule?: number
  surgeryPrepDue: number
  /** 急診：待看診（其中超過目標等候時間）、待決定去向（急診醫師）、收住院待床（護理師、櫃台） */
  erWaiting: number
  erOverdue: number
  erDeciding?: number
  erBed: number
  /** 急診留觀：待排留觀床（護理師）、留觀超過 48 小時要決定去向（急診醫師） */
  erObsBed: number
  erObsOverdue?: number
  /** 疼痛 ≥4 處置後 1 小時沒重評（護理師，全院）；管路待處理（今天未評估、評估可移除、留置針滿 96 小時）；主治的病人管路滿 7 天（醫師） */
  painReassessOverdue: number
  lineTodo: number
  lineAttending?: number
  /** 營養：篩檢快到期或逾時（護理師）、營養師待評估（營養師）、營養評估待已閱（主治） */
  nutritionScreenDue: number
  nutritionToAssess?: number
  nutritionUnseen?: number
  /** 約束查核逾時（護理師，全院）；譫妄陽性待確認、約束醫囑待補或到期（醫師，本科住院病人） */
  restraintCheckOverdue: number
  deliriumPositive?: number
  restraintOrder?: number
  /** 出院準備（有「出院準備」權限的人）：待篩選快到期或逾時、出院後待電話追蹤 */
  planScreenDue?: number
  planFollowUp?: number
  /** 換班請假：別人請我換班（等我回覆）、我的申請最近 24 小時有結果、待核准（護理長） */
  swapToRespond?: number
  myRequestResults?: number
  shiftRequestsToApprove?: number
  /** PCA：警示待醫師處理（醫師，本科住院病人）；紀錄逾時（護理師） */
  pcaAlerts?: number
  pcaRecordOverdue: number
  /** 院內感染個案待判定（有「感染管制」權限的人） */
  infectionToDecide?: number
  /** 點滴已滴完沒換、醫囑停了還在滴（護理師） */
  infusionOverdue: number
  /** 傷口 2 週沒變小（醫師，本科住院病人） */
  woundStall?: number
  /** 加護病房重症流程表超過 75 分鐘沒記的病人（護理師，我的病人範圍） */
  icuHourlyLate?: number
  opRecordsDue?: number
  /** 住院藥局：今天還沒調劑的劑量（補調劑）、已送回待點收的項數、待核對的藥盒數；護理站：待送回藥局的項數（全院） */
  udExtra: number
  udReturns: number
  udVerify: number
  udSendBack: number
  /** 病房常備：低於基準量待補充的品項（住院藥局）；本班還沒點班的病房數（護理站，全院） */
  wardRefillDue: number
  /** 部分退藥後、櫃台還沒退差額的收據（不限哪天看的診） */
  pendingRefunds: number
  /** 醫師已簽准出院、還沒住院結帳的病人（櫃台待辦） */
  ipdToBill: number
  /** 住很久、累計很多，建議期中繳款的住院病人（櫃台待辦；和住院結帳清單的標記同一個判斷） */
  ipdInterim: number
  /** 預約未到、臨床上要追（出院後回診、醫師約的回診、慢性病）、最近 14 天、還沒結案的（櫃台待辦；和未到追蹤清單同一個判斷） */
  noShowsToFollow: number
  /** 准出院、出院帶藥還沒調劑（住院藥局待辦） */
  dischargeRxToDispense: number
  wardCountDue: number
  /** 風險評估逾時的份數（跌倒、壓傷各算一份；全院住院中，和護理站待辦同一個判斷） */
  riskOverdue: number
  /** 藥車交接：已核對送出、病房還沒點收的藥盒（護理站，全院）；病房回報不符、藥局還沒處理的（住院藥局） */
  udToReceive: number
  udIssues: number
  /** 大型醫院：撥補單待撥發（請領中）、待簽收（運送中）；小型醫院沒有（不回傳） */
  transferRequested?: number
  transferIssued?: number
  /** 退回藥庫：待藥庫審核、已核准待藥局送出 */
  returnToReview?: number
  returnToShip?: number
  byDept: { deptName: string; count: number }[]
  trend: { date: string; count: number }[]
}

export function getDashboard(): Promise<DashboardStats> {
  return query(() => {
    const seesRevenue = ['clerk', 'admin'].includes(sessionRole() ?? '') // 看「現在用的角色」：護理師兼櫃台，以護理師身分時看不到收入
    const t = today()
    const n = now()
    const visits = db.visits.filter((v) => v.date === t)
    const active = visits.filter((v) => v.status !== 'cancelled')
    const count = (s: string) => visits.filter((v) => v.status === s && !(s === 'consulted' && erBillMode(v.er) !== 'opd')).length
    const charges = db.charges.filter((c) => !c.voided && c.paidAt.startsWith(t))

    const dept = new Map<string, number>()
    for (const v of active) dept.set(v.deptId, (dept.get(v.deptId) ?? 0) + 1)

    return {
      date: t,
      opd: {
        total: active.length,
        waiting: count('registered'),
        inConsult: count('in-consult'),
        toCharge: count('consulted'),
        // 與藥局清單同一規則：今天以前開立、還沒發藥的都算（前幾日沒領的也還在等）
        toDispense: db.dispenses.filter((d) => awaitingPickup(d, t)).length,
        done: count('charged') + count('dispensed'),
        cancelled: count('cancelled'),
      },
      revenue: seesRevenue
        ? {
            patientTotal: charges.reduce((s, c) => s + c.patientTotal, 0),
            nhiPoints: charges.reduce((s, c) => s + c.nhiPoints, 0),
            receipts: charges.length,
          }
        : undefined,
      ipd: {
        admitted: db.admissions.filter((a) => a.status === 'admitted' && !obsOpen(a)).length,
        reservedToday: db.admissions.filter((a) => a.status === 'reserved' && a.expectedDate <= t).length,
        // 急診留觀床不算病房床位
        emptyBeds: db.beds.filter((b) => b.status === 'empty' && !isObsBed(b)).length,
        totalBeds: db.beds.filter((b) => !isObsBed(b)).length,
        overdueMar: db.mar.filter((m) => m.status === 'pending' && m.scheduledAt < n).length,
      },
      suspendNoticesPending: suspendNoticeVisits(t).filter((v) => !v.notifiedAt).length,
      // 門診藥局的可用量（不含過期品）低於該地點的安全庫存；和藥品庫存頁的「缺貨／偏低」同一個判斷
      lowStockDrugs: db.drugs.filter((d) => d.active && usableQty(stockLoc.lots(d.id, stockLoc.opd()), today()) <= stockLoc.safety(d, stockLoc.opd())).length,
      udExtra: db.mar.filter((m) => m.scheduledAt.slice(0, 10) <= today() && !!udCandidate(m)).length,
      udReturns: db.udDispenses.flatMap((u) => u.lines).filter((l) => pendingReturn(l).sent.marIds.length > 0).length,
      udVerify: db.udDispenses.reduce((n, u) => n + u.boxes.filter((b) => b.status === 'prepared').length, 0),
      udSendBack: db.udDispenses.flatMap((u) => u.lines).filter((l) => pendingReturn(l).waiting.marIds.length > 0).length,
      pendingRefunds: db.charges.filter((c) => !!pendingRefundOf(c)).length,
      dischargeRxToDispense: db.admissions.filter((a) => a.status === 'admitted' && a.dischargeSummary?.signedAt && dischargeRxPending(a)).length,
      ipdToBill: db.admissions.filter((a) => a.status === 'admitted' && a.dischargeSummary?.signedAt && !activeIpdChargeOf(a.id)).length,
      riskOverdue: db.admissions.filter((a) => a.status === 'admitted' && (sessionRole() !== 'nurse' || !myScope(sessionUser()?.id, now()) || myScope(sessionUser()?.id, now())!.has(a.id))).reduce((n, a) => {
        const rs = riskStateOf(a, now())
        return n + Number(rs.fall.due.status === 'overdue') + Number(rs.pressure.due.status === 'overdue')
      }, 0),
      noShowsToFollow: db.visits.filter((v) => isNoShow(v, today()) && v.date >= addDays(today(), -NO_SHOW_TRACK_DAYS) && isImportantNoShow(v) && !noShowClosed(v)).length,
      ipdInterim: db.admissions.filter((a) => a.status === 'admitted' && !a.dischargeSummary?.signedAt && !activeIpdChargeOf(a.id) && !!interimSuggestion(a, ipdBillOf(a))).length,
      wardRefillDue: db.wardStockItems.filter((x) => { const l = stockLoc.ward(x.ward); return l && usableQty(stockLoc.lots(x.drugId, l.id), now()) < x.par }).length,
      wardCountDue: (() => {
        const t = now()
        const cur = shiftInstanceOf(shiftOf(t), t)
        return db.stockLocations.filter((l) => l.kind === 'ward' && l.active && !db.wardCounts.some((c) => c.ward === l.ward && c.shift === cur.shift && c.date === cur.date)).length
      })(),
      udToReceive: db.udDispenses.reduce((n, u) => n + u.boxes.filter((b) => b.status === 'verified' && !b.receivedAt).length, 0),
      udIssues: db.udDispenses.reduce((n, u) => n + u.boxes.filter((b) => b.issue && !b.issue.resolvedAt).length, 0),
      restockOpen: db.restockRequests.filter((x) => x.status === 'open' && db.drugs.some((d) => d.id === x.drugId && d.active)).length,
      purchasePending: db.purchaseOrders.filter((p) => p.status === 'pending').length,
      ...(() => {
        const me = sessionUser()
        if (sessionRole() !== 'doctor' || !me?.doctorId) return {}
        const mine = new Set(db.admissions.filter((a) => a.status === 'admitted' && a.doctorId === me.doctorId).map((a) => a.id))
        const myDept = db.doctors.find((d) => d.id === me.doctorId)?.deptId
        return {
          orderQueries: db.ipdOrders.filter((o) => mine.has(o.admissionId) && !!openQuery(o)).length,
          referralReplies: pendingReplyVisits(me.doctorId).length,
          labAcks: labAckCount(me.doctorId),
          bloodReactions: reactionsToAck(me.doctorId).length,
          opRecordsDue: surgeryCounts(now(), me.doctorId).recordDue,
          imagingWork: imagingWorkCount(me.doctorId),
          imagingAcks: imagingAckCount(me.doctorId),
          ...(isInfectious(me.doctorId) ? (({ pending, overdue }) => ({ abxPending: pending, abxOverdue: overdue }))(abxPendingCounts(now())) : {}),
          ...(({ rejected, extend }) => ({ abxRejected: rejected.length, abxExtend: extend.length }))(abxAttendingTodo(me.doctorId, now())),
          consultOrdersUnseen: new Set(db.ipdOrders.filter((o) => mine.has(o.admissionId) && o.consultId && !o.consultSeenAt).map((o) => o.admissionId)).size,
          transferIncoming: db.admissions.filter((a) => {
            const x = a.status === 'admitted' ? openDeptTransfer(a) : undefined
            return x && x.toDeptId === myDept && (!x.toDoctorId || x.toDoctorId === me.doctorId)
          }).length,
          ...(() => {
            // 待我（我這科）回覆的會診：急會診另外算（首頁標紅）
            const mineTo = (c: (typeof db.consults)[number]) => c.status === 'pending' && c.toDeptId === myDept && (!c.toDoctorId || c.toDoctorId === me.doctorId)
            const cs = db.consults.filter((c) => mineTo(c) && !!c.admissionId && db.admissions.find((a) => a.id === c.admissionId)?.status === 'admitted')
            return {
              consultIncoming: cs.length, consultUrgent: cs.filter((c) => c.urgent).length,
              opdConsultIncoming: db.consults.filter((c) => mineTo(c) && !!c.visitId).length,
              // 我申請的門診會診已回覆、還沒看
              consultReplies: db.consults.filter((c) => c.visitId && c.fromDoctorId === me.doctorId && c.status === 'answered' && !c.replySeenAt).length,
            }
          })(),
        }
      })(),
      purchaseOrdered: db.purchaseOrders.filter((p) => p.status === 'ordered').length,
      ...(['lab', 'admin'].includes(sessionRole() ?? '') ? { labWork: labWorkCount(), ...(({ work, urgent }) => ({ bloodWork: work, bloodUrgent: urgent }))(bloodLabCounts()) } : {}),
      transfusionTodo: transfusionTodoCount(now()),
      ...(() => {
        const t = now()
        const me = sessionUser()
        // 護理師這一班有分到病人：只算自己的病人（責任分床）；沒分到＝全院
        const scope = sessionRole() === 'nurse' ? myScope(me?.id, t) : undefined
        const inpt = db.admissions.filter((a) => a.status === 'admitted' && (!scope || scope.has(a.id)))
        return {
          painReassessOverdue: inpt.filter((a) => painStateOf(a.id, t).reassess?.status === 'overdue').length,
          lineTodo: inpt.reduce((n, a) => n + lineTodosOf(a.id, t).filter((x) => x.kind !== 'attending').length, 0),
          ...(sessionRole() === 'doctor' && me?.doctorId ? { lineAttending: attendingLineAlerts(me.doctorId, t), nutritionUnseen: nutritionCounts(t, me.doctorId).unseen } : {}),
          nutritionScreenDue: scope ? inpt.filter((a) => screenable(a) && ['due', 'overdue'].includes(screenStateOf(a, t).due.status)).length : nutritionCounts(t).screenDue,
          ...(me && permissionsOf({ ...me, role: sessionRole()! }).includes('discharge.plan') ? (({ screenDue, followUp }) => ({ planScreenDue: screenDue, planFollowUp: followUp }))(planCounts(t)) : {}),
          ...(sessionRole() === 'nurse' && me ? {
            swapToRespond: db.shiftRequests.filter((r) => r.targetId === me.id && r.status === 'pending-peer').length,
            myRequestResults: db.shiftRequests.filter((r) => r.requesterId === me.id && ['approved', 'rejected', 'declined'].includes(r.status) && (r.decidedAt ?? r.peer?.at ?? '') >= addMinutes(t, -24 * 60)).length,
          } : {}),
          ...(me && permissionsOf({ ...me, role: sessionRole()! }).includes('nursing.schedule') ? { shiftRequestsToApprove: db.shiftRequests.filter((r) => r.status === 'pending').length } : {}),
          ...(me && permissionsOf({ ...me, role: sessionRole()! }).includes('infection.control') ? { infectionToDecide: db.infectionCases.filter((c) => c.status === 'reported').length } : {}),
          ...(sessionRole() === 'doctor' && me?.doctorId ? { woundStall: woundStallCount(me.doctorId, t) } : {}),
          ...(sessionRole() === 'nurse' ? { icuHourlyLate: inpt.filter((a) => !!icuHourly(a, t)?.late).length } : {}),
          infusionOverdue: inpt.reduce((n, a) => n + infusionTodosOf(a.id, t).filter((x) => x.urgency === 'overdue').length, 0),
          pcaRecordOverdue: inpt.reduce((n, a) => { const p = runningPca(a.id); return n + (p && pcaRecordState(p, t)?.status === 'overdue' ? 1 : 0) }, 0),
          ...(sessionRole() === 'doctor' && me?.doctorId ? { pcaAlerts: db.admissions.filter((a) => a.status === 'admitted' && (careRoleOf(me.doctorId, a)?.kind ?? 'consult') !== 'consult').filter((a) => { const p = runningPca(a.id); return !!p && !!pcaOpenAlert(p) }).length } : {}),
          restraintCheckOverdue: inpt.reduce((n, a) => n + restraintTodosOf(a.id, t).filter((x) => x.kind === 'check' && x.urgency === 'overdue').length, 0),
          ...(sessionRole() === 'doctor' && me?.doctorId ? (({ positive, restraintOrder }) => ({ deliriumPositive: positive, restraintOrder }))(deliriumDoctorCounts(me.doctorId, t)) : {}),
          ...(['diet', 'admin'].includes(sessionRole() ?? '') ? { nutritionToAssess: nutritionCounts(t).toAssess } : {}),
        }
      })(),
      surgeryPrepDue: surgeryCounts(now()).prepDue,
      ...(({ waiting, overdue, deciding, bed, obsBed, obsOverdue }) => ({ erWaiting: waiting, erOverdue: overdue, erBed: bed, erObsBed: obsBed, ...(isErDoctor(sessionUser()?.doctorId) && sessionRole() === 'doctor' ? { erDeciding: deciding, erObsOverdue: obsOverdue } : {}) }))(erCounts(now())),
      ...(() => {
        const me = sessionUser()
        const role = sessionRole()
        return me && role && permissionsOf({ ...me, role }).includes('surgery.schedule') ? { surgeryToSchedule: surgeryCounts(now()).toSchedule } : {}
      })(),
      ...(db.stockLocations.filter(stockLoc.isWork).length > 1
        ? {
            transferRequested: db.transfers.filter((x) => x.status === 'requested' && x.kind !== 'return').length,
            transferIssued: db.transfers.filter((x) => x.status === 'issued').length,
            returnToReview: db.transfers.filter((x) => x.kind === 'return' && x.status === 'requested').length,
            returnToShip: db.transfers.filter((x) => x.kind === 'return' && x.status === 'approved').length,
          }
        : {}),
      byDept: [...dept.entries()].map(([id, c]) => ({ deptName: nameOf.dept(id), count: c })).sort((a, b) => b.count - a.count),
      trend: Array.from({ length: 7 }, (_, i) => {
        const date = addDays(t, i - 6)
        return { date, count: db.visits.filter((v) => v.date === date && v.status !== 'cancelled').length }
      }),
    }
  })
}
