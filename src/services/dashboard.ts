// 首頁儀表板：今日營運指標與近 7 日門診人次趨勢。
import { commitIfPossible, db } from '@/mock/db'
import { riskStateOf } from './risk-work'
import { adviceState, isImportantNoShow, isNoShow, NO_SHOW_TRACK_DAYS, noShowClosed } from './followup-rules'
import { addDays, now, today, addMinutes } from '@/utils/date'
import { permissionsOf, query, sessionRole, sessionUser } from './http'
import { openQuery, shiftInstanceOf, shiftOf } from './nursing-rules'
import { nameOf, openDeptTransfer, stockLoc } from './views'
import { usableQty } from './stock-rules'
import { pendingRefundOf } from './money'
import { suspendNoticeVisits } from './schedule'
import { awaitingPickup } from './pharmacy'
import { pendingReturn, udCandidate } from './ud-work'
import { analyzerHeldCount, calloutCounts, deskToCollectCount, labAckCount, labWorkCount, pendingLabWork } from './lab-work'
import { imagingAckCount, imagingWorkCount, noShowOf } from './imaging-work'
import { abxAttendingTodo, abxPendingCounts, isInfectious } from './abx-work'
import { openAdvice, stewardTodoCount } from './abx-steward-work'
import { tdmAlerts } from './renal-work'
import { pharmPending, pharmQueried } from './pharm-work'
import { medRecState } from './medrec-rules'
import { prophylaxisOverdue } from './prophylaxis-work'
import { activeIpdChargeOf, dayToBill, deathToBill, dischargeRxPending, interimSuggestion, ipdBillOf } from './ipd-bill'
import { pendingReplyVisits } from './referral-work'
import { bloodLabCounts, reactionsToAck, transfusionTodoCount } from './blood-work'
import { sterileCounts } from './sterile-work'
import { implantCardDueCount, implantRecallOpen } from './implant-work'
import { pullBackOf } from './or-shift-rules'
import { opdExpiringOf, preAuthCounts, preAuthExpiringCount } from './preauth-work'
import { progressMissingCount, recordCounts } from './record-audit-work'
import { wardExpiryCounts } from './ward-stock-work'
import { claimDeadlineOf, cutReplyDue, daysUntil, deadlineText, disputeCheck, monthOf, nextMonth } from './claim-rules'
import { codingCounts } from './coding-work'
import { drgAlertCounts } from './drg-work'
import { dayCounts, delayCounts, surgeryOf, frozenCounts, pacuCounts, pathCounts, postopCounts, preAnesCounts, surgeryCounts } from './surgery-work'
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
import { newsAlertCount, newsStateOf } from './news-work'
import { visitDueOf } from './palliative-rules'
import { mdroAlertsOf, negativeRoomState } from './flag-work'
import { currentClusters, pendingNotifiable } from './ipc-work'
import { needsMortalityReview } from './mortality-work'
import { rassOutCount, weanDueCount } from './vent-work'
import { careRoleOf } from './care-team'
import { deliriumDoctorCounts, restraintTodosOf } from './delirium-work'
import { specimenLate, specimenStage } from './specimen-rules'
import { toRecollect } from './specimen-work'
import { ensureLabDraws } from './ipd'
import { isLabOrder } from './specimen-work'
import { QC_ANALYTES, qcStatusToday } from './qc-rules'
import { examOfKey, isRadiologist, pendingImagingWork } from './imaging-work'
import { tatOpen } from './tat-work'
import { downtimeClash, downtimeEnd, examDayOf, outOfHours } from './exam-rules'
import { planOverdue } from './incident-rules'
import { emergencyState } from './surgery-rules'
import { isObsBed, obsOpen } from './bed-work'
import { lateFirstCases } from './or-metrics-rules'

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
  /** 感染科：抗生素每日審視有建議還沒處理的醫囑；主治：感染科建議待我回覆 */
  abxSteward?: number
  abxAdvice?: number
  /** 主治：我的病人 Vancomycin 谷濃度過高或過低、還沒改劑量 */
  tdmAlerts?: number
  /** 主治：我的病人手術結束滿 24 小時、預防性抗生素還在用 */
  prophylaxisDue?: number
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
  /** 主治：加護病房病人最近一次 RASS 超出鎮靜目標、插管接呼吸器今天還沒做脫離評估 */
  rassOut?: number
  /** 加護病房主治：待同意的轉入申請、同意了候床中 */
  icuRequestsPending?: number
  /** 早期預警：主治自己的一般病房病人最近一次 NEWS2 中或高；護理師的病人 NEWS2 再量逾時；快速反應小組待到場評估（權限 rrt） */
  newsAlerts?: number
  /** 安寧（權限 palliative 的醫師）：照會待收案、每週訪視到期或逾時 */
  palliativeRequests?: number
  /** 死亡病例待審查（權限 mortality.review 的醫師） */
  mortalityToReview?: number
  /** 負壓隔離室這一班沒記錄壓差、或負壓不足（護理師，全院） */
  negativeRoomTodo?: number
  /** 感染管制：疑似群聚待判定、法定傳染病通報逾時（全院）；醫師：自己病人待通報 */
  clustersOpen?: number
  notifiableOverdue?: number
  notifiablePending?: number
  /** 醫師：自己的住院病人培養出多重抗藥菌、還沒開接觸隔離 */
  mdroAlerts?: number
  palliativeVisitDue?: number
  newsRecheckOverdue?: number
  rrtPending?: number
  weanDue?: number
  opRecordsDue?: number
  /** 主刀：術後醫囑待開、完成超過 4 小時還沒開 */
  postopDue?: number
  postopLate?: number
  /** 主刀：病理報告待確認（惡性或和術前診斷不符） */
  pathAckDue?: number
  /** 權限「病理」：待收件（其中逾時）、待發報告 */
  pathToReceive?: number
  pathOverdue?: number
  pathToReport?: number
  /** 病理醫師：冰凍切片等待回報（其中超過 20 分鐘） */
  frozenWaiting?: number
  frozenOverdue?: number
  /** 住院藥局：今天還沒調劑的劑量（補調劑）、已送回待點收的項數、待核對的藥盒數；護理站：待送回藥局的項數（全院） */
  udExtra: number
  /** 藥師：住院醫囑待審核（其中臨時醫囑） */
  pharmReview?: number
  pharmReviewStat?: number
  /** 醫師：我的病人的藥師疑義待回覆 */
  pharmQueries?: number
  /** 藥師：藥物不良反應待評估（其中嚴重型 24 小時內） */
  adrPending?: number
  adrUrgent?: number
  /** 護理師、藥師：住院中還沒建居家用藥清單的病人（其中超過入院 24 小時）；醫師：我的病人用藥整合待決定（其中逾時） */
  medRecToBuild?: number
  medRecToBuildLate?: number
  medRecToDecide?: number
  medRecLate?: number
  /** 醫師：我的病人的藥師建議（藥事照護）待回覆 */
  pharmCareToReply?: number
  /** 檢驗科：已採檢待收件（其中採檢超過 60 分鐘）；護理師：被退件要重新採檢的檢體 */
  specimenToReceive?: number
  specimenLate?: number
  specimenRecollect?: number
  /** 急診：醫師已送出、還沒床邊採檢的病人數 */
  erLabToCollect?: number
  /** 檢驗科：抽血櫃台待採檢的門診病人 */
  deskToCollect?: number
  /** 檢驗科：儀器結果待審核（沒通過自動審核） */
  analyzerHeld?: number
  /** 檢驗科：危急值還沒通報（其中逾時 30 分鐘） */
  calloutPending?: number
  /** 檢驗時效：還沒發、已逾時／快逾時的 */
  tatLate?: number
  tatWarn?: number
  calloutLate?: number
  /** 護理師：今天待採檢的住院檢驗（含長期檢驗今天到期的） */
  labToCollect?: number
  /** 檢驗科：今天品管還沒通過的項目（其中被拒絕的） */
  qcPending?: number
  qcRejected?: number
  /** 櫃台、放射科醫師：影像待排程；今天已排還沒完成的 */
  examToSchedule?: number
  /** 排在停機時段、還沒報到的影像檢查（需改期） */
  examNeedsReschedule?: number
  /** 放射師：今天已報到、等著做的；今天還沒報到的 */
  examArrived?: number
  examWaiting?: number
  examToday?: number
  /** 門診開立醫師：病人沒來做影像（過了排程 30 分鐘沒報到） */
  examNoShow?: number
  /** 主治：做完含顯影劑檢查、要暫停 Metformin 48 小時（還沒按已處理） */
  metforminAlerts?: number
  examNoShowText?: string
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
  /** 病安事件審查：還沒結案的；RCA 行動計畫過期的 */
  incidentPending?: number
  rcaOverdue?: number
  /** 手術排程：急刀還沒入刀房的、已超過時限的 */
  emergencyWaiting?: number
  /** 恢復室：在恢復室的、停留超過 2 小時的、已轉出待病房接回的 */
  pacuIn?: number
  pacuLong?: number
  pacuToReceive?: number
  /** 日間手術：今天待報到、待出院評估（第二期）、回家後待電話追蹤 */
  dayToCheckIn?: number
  dayPhase2?: number
  dayFollowUp?: number
  /** 麻醉：評估待做（急刀、今明兩天的）、急刀精簡版待補 */
  preAnesDue?: number
  preAnesBrief?: number
  emergencyOverdue?: number
  /** 手術排程：今天首台排程開始過了 15 分鐘還沒做麻醉前查核 */
  orFirstLate?: number
  /** 急刀插台順延：主刀還沒讀（醫師）、病房還沒讀（護理師）；順延超過開放時段待處理（手術排程） */
  delaySurgeonUnread?: number
  delayWardUnread: number
  /** 最近 7 天手術放了植入物、還沒印植入物卡的病人 */
  implantCardDue: number
  delayOverflow?: number
  /** 可以拉回原時間的（插台的急刀已取消或改期） */
  orPullBack?: number
  /** 供應中心：生物指示劑該判讀、召回用過的還沒通知、要收回的器械包 */
  cssdBiDue?: number
  cssdRecallOpen?: number
  cssdToWithdraw?: number
  /** 植入物召回：用過那批、還沒通知主刀的手術 */
  implantRecallOpen?: number
  /** 健保核減：主治待回覆（醫師）；申復中待記結果（健保申報） */
  claimCutsToReply?: number
  /** 主治：核減回覆逾期（核減後 14 天） */
  claimCutsReplyOverdue?: number
  /** 申報組：還沒送的已結束月份（門診、住院各算一筆）、最近的期限 */
  claimToSubmit?: number
  claimSubmitText?: string
  claimSubmitUrgent?: boolean
  /** 主治：門診事前審查快到期或快用完 */
  preAuthExpiring?: number
  /** 申報組：全院門診事前審查快到期（還沒續約） */
  preAuthExpiringAll?: number
  claimCutsAppealed?: number
  /** 爭議審議：可以申請（期限內）＋審議中待記結果（健保申報） */
  claimDisputes?: number
  /** 事前審查：主治待填寫（含補件）；申報組待送審、審查中超過 14 天 */
  preAuthToFill?: number
  /** 疾病分類：主治編碼修改未讀；病歷管理師待審查、出院超過 7 天還沒審查 */
  codingChanged?: number
  /** 主治：出院病歷還沒完成、逾期（出院 14 天）；病歷室：全院逾期 */
  recordIncomplete?: number
  recordOverdue?: number
  recordOverdueAll?: number
  /** 主治：住院中最近 7 天缺病程紀錄的病人 */
  progressMissing?: number
  /** 病歷室：門診抽審待審查；醫師：抽審有不符合待回覆 */
  opdReviewPending?: number
  /** 藥師：病房常備已過期、30 天內到期的批號 */
  wardExpired?: number
  wardExpirySoon?: number
  opdReviewToAck?: number
  codingDue?: number
  codingOverdue?: number
  /** DRG：我主治的住院，點數接近上限（80% 以上）、超過上限 */
  drgNear?: number
  drgOver?: number
  preAuthToSubmit?: number
  preAuthOverdue?: number
  /** 醫師建議回診：該掛了（建議日前後一週）、過期（過了一週還沒處理） */
  adviceToBook: number
  adviceOverdue: number
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

/** 今天待採檢：先補齊長期檢驗今天到期的那一次，再數住院中還沒採檢的檢驗醫囑（今天以前開的） */
function labToCollectToday(): number {
  const d = today()
  let added = false
  for (const a of db.admissions.filter((x) => x.status === 'admitted')) added = ensureLabDraws(a.id, d) || added
  if (added) commitIfPossible()
  return db.ipdOrders.filter((o) => o.status === 'active' && isLabOrder(o) && o.startAt.slice(0, 10) <= d && db.admissions.some((a) => a.id === o.admissionId && a.status === 'admitted')).length
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
      ...((r) => (r === 'nurse' || r === 'pharmacist' ? (() => { const xs = db.admissions.filter((a) => a.status === 'admitted' && !a.obs && !(a.day && !a.day.converted) && !a.medRec); return { medRecToBuild: xs.length, medRecToBuildLate: xs.filter((a) => medRecState(undefined, a.admittedAt ?? now(), now()).overdue).length } })() : {}))(sessionRole()),
      ...((r) => (r === 'lab' ? (() => { const xs = db.specimens.filter((x) => specimenStage(x) === 'collected'); const qs = QC_ANALYTES.map((a) => qcStatusToday(db.qcRuns, a.code, today())); const tat = tatOpen(); return { ...(({ pending, late }) => ({ calloutPending: pending, calloutLate: late }))(calloutCounts()), tatLate: tat.filter((x) => x.status.state === 'late').length, tatWarn: tat.filter((x) => x.status.state === 'warn').length, deskToCollect: deskToCollectCount(), analyzerHeld: analyzerHeldCount(), specimenToReceive: xs.length, specimenLate: xs.filter((x) => specimenLate(x, now())).length, qcPending: qs.filter((x) => x === 'missing' || x === 'reject').length, qcRejected: qs.filter((x) => x === 'reject').length } })() : r === 'nurse' ? { specimenRecollect: toRecollect().length, labToCollect: labToCollectToday(), erLabToCollect: new Set(pendingLabWork().filter((w) => w.er && w.awaitingCollection).map((w) => w.patientId)).size } : {}))(sessionRole()),
      ...((r) => (r === 'clerk' || (r === 'doctor' && isRadiologist(sessionUser()?.doctorId)) ? { examToSchedule: pendingImagingWork().filter((w) => w.awaitingExam && !examOfKey(w.key)).length, examToday: db.imagingExams.filter((e) => e.start.slice(0, 10) === today() && !e.doneAt && !e.cancelled).length, examNeedsReschedule: db.imagingExams.filter((e) => !e.cancelled && !e.arrivedAt && (downtimeClash(db.roomDowntimes.filter((d) => downtimeEnd(d) > d.from), e) || outOfHours(e.start, e.minutes, examDayOf(db.examHours, db.examClosures, e.room, e.start.slice(0, 10))))).length } : {}))(sessionRole()),
      ...(sessionRole() === 'radtech' ? ((xs) => ({ examArrived: xs.filter((e) => e.arrivedAt).length, examWaiting: xs.filter((e) => !e.arrivedAt).length }))(db.imagingExams.filter((e) => e.start.slice(0, 10) === today() && !e.doneAt && !e.cancelled)) : {}),
      udExtra: db.mar.filter((m) => m.scheduledAt.slice(0, 10) <= today() && !!udCandidate(m)).length,
      ...(sessionRole() === 'pharmacist' ? (() => { const p = pharmPending(); const ad = db.adrReports.filter((r) => !r.assessment); const we = wardExpiryCounts(today()); return { pharmReview: p.length, pharmReviewStat: p.filter((o) => o.type === 'stat').length, adrPending: ad.length, adrUrgent: ad.filter((r) => r.serious).length, wardExpired: we.expired, wardExpirySoon: we.soon } })() : {}),
      udReturns: db.udDispenses.flatMap((u) => u.lines).filter((l) => pendingReturn(l).sent.marIds.length > 0).length,
      udVerify: db.udDispenses.reduce((n, u) => n + u.boxes.filter((b) => b.status === 'prepared').length, 0),
      udSendBack: db.udDispenses.flatMap((u) => u.lines).filter((l) => pendingReturn(l).waiting.marIds.length > 0).length,
      pendingRefunds: db.charges.filter((c) => !!pendingRefundOf(c)).length,
      dischargeRxToDispense: db.admissions.filter((a) => a.status === 'admitted' && a.dischargeSummary?.signedAt && dischargeRxPending(a)).length,
      ipdToBill: db.admissions.filter((a) => (a.status === 'admitted' && !a.death && a.dischargeSummary?.signedAt && !activeIpdChargeOf(a.id)) || deathToBill(a) || dayToBill(a)).length,
      riskOverdue: db.admissions.filter((a) => a.status === 'admitted' && (sessionRole() !== 'nurse' || !myScope(sessionUser()?.id, now()) || myScope(sessionUser()?.id, now())!.has(a.id))).reduce((n, a) => {
        const rs = riskStateOf(a, now())
        return n + Number(rs.fall.due.status === 'overdue') + Number(rs.pressure.due.status === 'overdue')
      }, 0),
      ...((xs) => ({ adviceToBook: xs.filter((s) => s === 'due' || s === 'overdue').length, adviceOverdue: xs.filter((s) => s === 'overdue').length }))(db.followUpAdvices.map((a) => adviceState(a, today()))),
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
          delaySurgeonUnread: delayCounts(me.doctorId).unread,
          claimCutsToReply: db.claimCuts.filter((c) => c.doctorId === me.doctorId && !c.reply).length,
          claimCutsReplyOverdue: db.claimCuts.filter((c) => c.doctorId === me.doctorId && !c.reply && today() > cutReplyDue(c)).length,
          preAuthExpiring: preAuthExpiringCount(today(), me.doctorId),
          preAuthToFill: preAuthCounts(now(), me.doctorId).toFill,
          codingChanged: codingCounts(now(), me.doctorId).changed,
          ...((r) => ({ recordIncomplete: r.incomplete, recordOverdue: r.overdue }))(recordCounts(today(), me.doctorId)),
          progressMissing: progressMissingCount(today(), me.doctorId),
          opdReviewToAck: db.opdReviews.filter((r) => r.doctorId === me.doctorId && r.result && !r.ack && Object.values(r.result.items).some((v) => !v)).length,
          ...((c) => ({ drgNear: c.near, drgOver: c.over }))(drgAlertCounts(me.doctorId)),
          ...((c) => ({ postopDue: c.due, postopLate: c.late }))(postopCounts(now(), me.doctorId)),
          pathAckDue: pathCounts(now(), me.doctorId).ackDue,
          ...(permissionsOf({ ...me, role: 'doctor' }).includes('pathology') ? { pathToReport: pathCounts(now()).toReport, ...((c) => ({ frozenWaiting: c.waiting, frozenOverdue: c.overdue }))(frozenCounts(now())) } : {}),
          ...(permissionsOf({ ...me, role: 'doctor' }).includes('anesthesia') ? ((c) => ({ preAnesDue: c.due, preAnesBrief: c.brief }))(preAnesCounts(now())) : {}),
          imagingWork: imagingWorkCount(me.doctorId),
          imagingAcks: imagingAckCount(me.doctorId),
          metforminAlerts: db.imagingExams.filter((e) => e.metforminAlert && !e.metforminAlert.ackAt && e.metforminAlert.doctorId === me.doctorId).length,
          ...((xs) => ({ examNoShow: xs.length, examNoShowText: xs.map((e) => `${db.patients.find((p) => p.id === e.patientId)?.name} ${db.procedures.find((p) => p.id === e.procId)?.name}（${e.start.slice(5)}）`).join('、') }))(noShowOf(me.doctorId)),
          ...(isInfectious(me.doctorId) ? (({ pending, overdue }) => ({ abxPending: pending, abxOverdue: overdue, abxSteward: stewardTodoCount(now()) }))(abxPendingCounts(now())) : {}),
          ...(({ rejected, extend }) => ({ abxRejected: rejected.length, abxExtend: extend.length }))(abxAttendingTodo(me.doctorId, now())),
          abxAdvice: openAdvice(me.doctorId).length,
          tdmAlerts: tdmAlerts(me.doctorId).length,
          pharmCareToReply: db.pharmCareNotes.filter((x) => x.status === 'sent' && db.admissions.some((a) => a.id === x.admissionId && a.status === 'admitted' && a.doctorId === me.doctorId)).length,
          ...(() => { const xs = db.admissions.filter((a) => a.status === 'admitted' && a.doctorId === me.doctorId && a.medRec && !a.medRec.completedAt); return { medRecToDecide: xs.length, medRecLate: xs.filter((a) => medRecState(a.medRec, a.admittedAt ?? now(), now()).overdue).length } })(),
          pharmQueries: pharmQueried(me.doctorId).length,
          prophylaxisDue: prophylaxisOverdue(now(), me.doctorId).length,
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
          ...(me && permissionsOf({ ...me, role: sessionRole()! }).includes('surgery.schedule') ? ((xs) => ({ emergencyWaiting: xs.length, emergencyOverdue: xs.filter((s) => emergencyState(s, t)?.state === 'overdue').length }))(db.surgeries.filter((s) => s.urgency && !s.sentAt && (s.status === 'requested' || s.status === 'scheduled') && db.admissions.find((a) => a.id === s.admissionId)?.status === 'admitted')) : {}),
          ...(me && sessionRole() === 'lab' && permissionsOf({ ...me, role: 'lab' }).includes('pathology') ? ((c) => ({ pathToReceive: c.toReceive, pathOverdue: c.overdue }))(pathCounts(t)) : {}),
          ...(me && permissionsOf({ ...me, role: sessionRole()! }).includes('incident.review') ? { incidentPending: db.incidents.filter((x) => x.status !== 'closed').length, rcaOverdue: db.incidents.flatMap((x) => x.rca?.plans ?? []).filter((p) => planOverdue(p, today())).length } : {}),
          ...(me && permissionsOf({ ...me, role: sessionRole()! }).includes('nursing.schedule') ? { shiftRequestsToApprove: db.shiftRequests.filter((r) => r.status === 'pending').length } : {}),
          ...(me && sessionRole() === 'doctor' && permissionsOf({ ...me, role: sessionRole()! }).includes('icu.attending') ? { icuRequestsPending: db.icuRequests.filter((r) => r.status === 'pending' || r.status === 'accepted').length } : {}),
          ...(me && permissionsOf({ ...me, role: sessionRole()! }).includes('infection.control') ? { infectionToDecide: db.infectionCases.filter((c) => c.status === 'reported').length, clustersOpen: currentClusters().filter((c) => !c.decision).length, notifiableOverdue: db.admissions.flatMap(pendingNotifiable).filter((p) => p.dueAt < t).length } : {}),
          ...(sessionRole() === 'doctor' && me?.doctorId ? { mdroAlerts: db.admissions.filter((a) => a.status === 'admitted' && (careRoleOf(me.doctorId, a)?.kind ?? 'consult') !== 'consult' && mdroAlertsOf(a.patientId, t).length > 0).length } : {}),
          ...(sessionRole() === 'doctor' && me?.doctorId ? { notifiablePending: db.admissions.filter((a) => a.status === 'admitted' && (careRoleOf(me.doctorId, a)?.kind ?? 'consult') !== 'consult').flatMap(pendingNotifiable).length } : {}),
          ...(sessionRole() === 'doctor' && me?.doctorId ? { woundStall: woundStallCount(me.doctorId, t), rassOut: rassOutCount(me.doctorId, t), weanDue: weanDueCount(me.doctorId, t) } : {}),
          ...(sessionRole() === 'nurse' ? { negativeRoomTodo: db.beds.filter((b) => b.negativePressure && negativeRoomState(b, t).state !== 'ok').length } : {}),
          ...(sessionRole() === 'nurse' ? { icuHourlyLate: inpt.filter((a) => !!icuHourly(a, t)?.late).length, newsRecheckOverdue: inpt.filter((a) => newsStateOf(a, t)?.recheck?.status === 'overdue').length } : {}),
          ...(sessionRole() === 'doctor' && me?.doctorId ? { newsAlerts: newsAlertCount(me.doctorId, t) } : {}),
          ...(me && sessionRole() === 'doctor' && permissionsOf({ ...me, role: sessionRole()! }).includes('mortality.review') ? { mortalityToReview: db.admissions.filter((a) => needsMortalityReview(a) && !a.mortalityReview).length } : {}),
          ...(me && sessionRole() === 'doctor' && permissionsOf({ ...me, role: sessionRole()! }).includes('palliative') ? (() => {
            const live = db.palliativeCases.filter((c) => db.admissions.find((a) => a.id === c.admissionId)?.status === 'admitted')
            return { palliativeRequests: live.filter((c) => c.status === 'requested').length, palliativeVisitDue: live.filter((c) => (visitDueOf(c, t)?.status ?? 'ok') !== 'ok').length }
          })() : {}),
          ...(me && sessionRole() === 'doctor' && permissionsOf({ ...me, role: sessionRole()! }).includes('rrt') ? { rrtPending: db.rrtCalls.filter((c) => c.status === 'pending').length } : {}),
          infusionOverdue: inpt.reduce((n, a) => n + infusionTodosOf(a.id, t).filter((x) => x.urgency === 'overdue').length, 0),
          pcaRecordOverdue: inpt.reduce((n, a) => { const p = runningPca(a.id); return n + (p && pcaRecordState(p, t)?.status === 'overdue' ? 1 : 0) }, 0),
          ...(sessionRole() === 'doctor' && me?.doctorId ? { pcaAlerts: db.admissions.filter((a) => a.status === 'admitted' && (careRoleOf(me.doctorId, a)?.kind ?? 'consult') !== 'consult').filter((a) => { const p = runningPca(a.id); return !!p && !!pcaOpenAlert(p) }).length } : {}),
          restraintCheckOverdue: inpt.reduce((n, a) => n + restraintTodosOf(a.id, t).filter((x) => x.kind === 'check' && x.urgency === 'overdue').length, 0),
          ...(sessionRole() === 'doctor' && me?.doctorId ? (({ positive, restraintOrder }) => ({ deliriumPositive: positive, restraintOrder }))(deliriumDoctorCounts(me.doctorId, t)) : {}),
          ...(['diet', 'admin'].includes(sessionRole() ?? '') ? { nutritionToAssess: nutritionCounts(t).toAssess } : {}),
        }
      })(),
      surgeryPrepDue: surgeryCounts(now()).prepDue,
      delayWardUnread: delayCounts().unread,
      implantCardDue: implantCardDueCount(today()),
      ...((me, role) => (me && role && permissionsOf({ ...me, role }).includes('coding') ? ((c) => ({ codingDue: c.due, codingOverdue: c.overdue, recordOverdueAll: recordCounts(today()).overdue, opdReviewPending: db.opdReviews.filter((r) => !r.result).length }))(codingCounts(now())) : {}))(sessionUser(), sessionRole()),
      ...((me, role) => (me && role && permissionsOf({ ...me, role }).includes('nhi.claim') ? { claimCutsAppealed: db.claimCuts.filter((c) => c.reply?.action === 'appeal' && !c.result).length, ...claimSubmitDue(today()), claimDisputes: db.claimCuts.filter((c) => (c.dispute && !c.dispute.result) || disputeCheck(c, today()).ok).length, ...((c) => ({ preAuthToSubmit: c.toSubmit, preAuthOverdue: c.overdue }))(preAuthCounts(now())), preAuthExpiringAll: db.preAuths.filter((p) => opdExpiringOf(p, today())).length } : {}))(sessionUser(), sessionRole()),
      ...((me, role) => (me && role && permissionsOf({ ...me, role }).includes('cssd') ? ((c) => ({ cssdBiDue: c.biDue, cssdRecallOpen: c.recallOpen, cssdToWithdraw: c.toWithdraw, implantRecallOpen: implantRecallOpen() }))(sterileCounts(now())) : {}))(sessionUser(), sessionRole()),
      ...((c) => ({ pacuIn: c.in, pacuLong: c.long, pacuToReceive: c.out }))(pacuCounts(now())),
      ...((c) => ({ dayToCheckIn: c.toCheckIn, dayPhase2: c.phase2, dayFollowUp: c.followUp }))(dayCounts(now())),
      ...(({ waiting, overdue, deciding, bed, obsBed, obsOverdue }) => ({ erWaiting: waiting, erOverdue: overdue, erBed: bed, erObsBed: obsBed, ...(isErDoctor(sessionUser()?.doctorId) && sessionRole() === 'doctor' ? { erDeciding: deciding, erObsOverdue: obsOverdue } : {}) }))(erCounts(now())),
      ...(() => {
        const me = sessionUser()
        const role = sessionRole()
        return me && role && permissionsOf({ ...me, role }).includes('surgery.schedule') ? { surgeryToSchedule: surgeryCounts(now()).toSchedule, orFirstLate: lateFirstCases(db.surgeries.filter((s) => db.admissions.find((a) => a.id === s.admissionId)?.status === 'admitted'), today(), now()).length, delayOverflow: delayCounts().overflow, orPullBack: db.surgeries.filter((s) => db.admissions.find((a) => a.id === s.admissionId)?.status === 'admitted' && pullBackOf(s, surgeryOf)).length } : {}
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

/** 申報組首頁：已結束、還沒送的月份（門診、住院各算一筆；有就醫或出院的月份才算），最早的期限 */
function claimSubmitDue(t: string): { claimToSubmit?: number; claimSubmitText?: string; claimSubmitUrgent?: boolean } {
  const cur = monthOf(t)
  const pend: { kind: string; month: string; due: string }[] = []
  for (const kind of ['opd', 'ipd'] as const) {
    const months = new Set(kind === 'opd' ? db.visits.map((v) => monthOf(v.date)) : db.admissions.filter((a) => a.dischargedAt).map((a) => monthOf(a.dischargedAt!)))
    const sent = new Set(db.claimSubmissions.filter((s) => s.kind === kind).map((s) => s.month))
    // 只看最近一個結束的月份（更早還沒送的通常是示範資料的過去，不提醒）
    const last = [...months].filter((m) => m < cur).sort().at(-1)
    if (last && !sent.has(last) && nextMonth(last) === cur) pend.push({ kind, month: last, due: claimDeadlineOf(last) })
  }
  if (!pend.length) return {}
  const due = pend.map((p) => p.due).sort()[0]
  return { claimToSubmit: pend.length, claimSubmitText: `${pend.map((p) => `${p.month} ${p.kind === 'opd' ? '門診' : '住院'}`).join('、')}：期限 ${due}（${deadlineText(due, t)}）`, claimSubmitUrgent: daysUntil(due, t) <= 5 }
}
