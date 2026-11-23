// 服務層統一出入口：頁面一律 `import { bookingApi } from '@/services'`，不直接引用 mock/db。
// 每個模組都經過 overNetwork 包裝，模擬「參數經網路序列化」，行為與真實後端一致。
import { overNetwork } from './http'
import * as auth from './auth'
import * as master from './master'
import * as patient from './patient'
import * as schedule from './schedule'
import * as booking from './booking'
import * as opd from './opd'
import * as charge from './charge'
import * as pharmacy from './pharmacy'
import * as admission from './admission'
import * as ipd from './ipd'
import * as nursing from './nursing'
import * as scan from './scan'
import * as risk from './risk'
import * as flag from './flag'
import * as abx from './abx'
import * as abxSteward from './abx-steward'
import * as abxMetrics from './abx-metrics'
import * as renal from './renal'
import * as abxTimeline from './abx-timeline'
import * as pharm from './pharm'
import * as adr from './adr'
import * as medrec from './medrec'
import * as pharmcare from './pharmcare'
import * as specimen from './specimen'
import * as qc from './qc'
import * as exam from './exam'
import * as labDesk from './lab-desk'
import * as analyzer from './analyzer'
import * as blood from './blood'
import * as copy from './copy'
import * as management from './management'
import * as surgery from './surgery'
import * as anesthesia from './anesthesia'
import * as postop from './postop'
import * as pathology from './pathology'
import * as day from './day'
import * as sterile from './sterile'
import * as implant from './implant'
import * as claim from './claim'
import * as claimCut from './claim-cut'
import * as preauth from './preauth'
import * as drg from './drg'
import * as coding from './coding'
import * as recordAudit from './record-audit'
import * as opdReview from './opd-review'
import * as consent from './consent'
import * as line from './line'
import * as bedside from './bedside'
import * as radRoster from './rad-roster'
import * as duty from './duty'
import * as doctorCall from './doctor-call'
import * as nutrition from './nutrition'
import * as tube from './tube'
import * as delirium from './delirium'
import * as staffing from './staffing'
import * as dischargePlan from './discharge-plan'
import * as shiftRequest from './shift-request'
import * as pca from './pca'
import * as infection from './infection'
import * as infusion from './infusion'
import * as wound from './wound'
import * as icu from './icu'
import * as vent from './vent'
import * as icuMove from './icu-move'
import * as rrt from './rrt'
import * as code from './code'
import * as vaso from './vaso'
import * as death from './death'
import * as palliative from './palliative'
import * as mortality from './mortality'
import * as pressure from './pressure'
import * as ipc from './ipc'
import * as er from './er'
import * as erLab from './er-lab'
import * as opdAddon from './opd-addon'
import * as incident from './incident'
import * as prevent from './prevent'
import * as dashboard from './dashboard'
import * as inventory from './inventory'
import * as admin from './admin'
import * as orderset from './orderset'
import * as phrase from './phrase'
import * as stocktake from './stocktake'
import * as purchase from './purchase'
import * as transfer from './transfer'
import * as ud from './ud'
import * as permission from './permission'
import * as consult from './consult'
import * as wardStock from './ward-stock'
import * as witness from './witness'
import * as controlled from './controlled'
import * as lab from './lab'
import * as tat from './tat'
import * as labLimits from './lab-limits'
import * as imaging from './imaging'
import * as ipdCharge from './ipd-charge'
import * as dischargeRx from './discharge-rx'
import * as certificate from './certificate'
import * as referral from './referral'

export const authApi = overNetwork(auth)
export const masterApi = overNetwork(master)
export const patientApi = overNetwork(patient)
export const scheduleApi = overNetwork(schedule)
export const bookingApi = overNetwork(booking)
export const opdApi = overNetwork(opd)
export const chargeApi = overNetwork(charge)
export const pharmacyApi = overNetwork(pharmacy)
export const admissionApi = overNetwork(admission)
export const ipdApi = overNetwork(ipd)
export const nursingApi = overNetwork(nursing)
export const scanApi = overNetwork(scan)
export const riskApi = overNetwork(risk)
export const flagApi = overNetwork(flag)
export const abxApi = overNetwork(abx)
export const abxStewardApi = overNetwork(abxSteward)
export const abxMetricsApi = overNetwork(abxMetrics)
export const renalApi = overNetwork(renal)
export const abxTimelineApi = overNetwork(abxTimeline)
export const pharmApi = overNetwork(pharm)
export const adrApi = overNetwork(adr)
export const medrecApi = overNetwork(medrec)
export const pharmCareApi = overNetwork(pharmcare)
export const specimenApi = overNetwork(specimen)
export const qcApi = overNetwork(qc)
export const examApi = overNetwork(exam)
export const labDeskApi = overNetwork(labDesk)
export const analyzerApi = overNetwork(analyzer)
export const bloodApi = overNetwork(blood)
export const copyApi = overNetwork(copy)
export const managementApi = overNetwork(management)
export const surgeryApi = overNetwork(surgery)
export const postopApi = overNetwork(postop)
export const pathologyApi = overNetwork(pathology)
export const dayApi = overNetwork(day)
export const sterileApi = overNetwork(sterile)
export const implantApi = overNetwork(implant)
export const claimApi = overNetwork(claim)
export const claimCutApi = overNetwork(claimCut)
export const preAuthApi = overNetwork(preauth)
export const drgApi = overNetwork(drg)
export const codingApi = overNetwork(coding)
export const recordAuditApi = overNetwork(recordAudit)
export const opdReviewApi = overNetwork(opdReview)
export const consentApi = overNetwork(consent)
export const anesthesiaApi = overNetwork(anesthesia)
export const lineApi = overNetwork(line)
export const bedsideApi = overNetwork(bedside)
export const radRosterApi = overNetwork(radRoster)
export const dutyApi = overNetwork(duty)
export const doctorCallApi = overNetwork(doctorCall)
export const nutritionApi = overNetwork(nutrition)
export const tubeApi = overNetwork(tube)
export const deliriumApi = overNetwork(delirium)
export const staffingApi = overNetwork(staffing)
export const dischargePlanApi = overNetwork(dischargePlan)
export const shiftRequestApi = overNetwork(shiftRequest)
export const pcaApi = overNetwork(pca)
export const infectionApi = overNetwork(infection)
export const infusionApi = overNetwork(infusion)
export const woundApi = overNetwork(wound)
export const icuApi = overNetwork(icu)
export const ventApi = overNetwork(vent)
export const icuMoveApi = overNetwork(icuMove)
export const rrtApi = overNetwork(rrt)
export const codeApi = overNetwork(code)
export const vasoApi = overNetwork(vaso)
export const deathApi = overNetwork(death)
export const palliativeApi = overNetwork(palliative)
export const mortalityApi = overNetwork(mortality)
export const pressureApi = overNetwork(pressure)
export const ipcApi = overNetwork(ipc)
export const erApi = overNetwork(er)
export const erLabApi = overNetwork(erLab)
export const opdAddonApi = overNetwork(opdAddon)
export const incidentApi = overNetwork(incident)
export const preventApi = overNetwork(prevent)
export const dashboardApi = overNetwork(dashboard)
export const inventoryApi = overNetwork(inventory)
export const adminApi = overNetwork(admin)
export const orderSetApi = overNetwork(orderset)
export const phraseApi = overNetwork(phrase)
export const stocktakeApi = overNetwork(stocktake)
export const purchaseApi = overNetwork(purchase)
export const transferApi = overNetwork(transfer)
export const udApi = overNetwork(ud)
export const permissionApi = overNetwork(permission)
export const consultApi = overNetwork(consult)
export const wardStockApi = overNetwork(wardStock)
export const witnessApi = overNetwork(witness)
export const controlledApi = overNetwork(controlled)
export const labApi = overNetwork(lab)
export const tatApi = overNetwork(tat)
export const labLimitApi = overNetwork(labLimits)
export const imagingApi = overNetwork(imaging)
export const ipdChargeApi = overNetwork(ipdCharge)
export const dischargeRxApi = overNetwork(dischargeRx)
export const certificateApi = overNetwork(certificate)
export const referralApi = overNetwork(referral)
export type { CertificateView, CertificateInput } from './certificate'
export type { ReferralInView, ReferralOutView, ReferralOutInput, ReferralReplyInput, PendingReferralReply } from './referral'
export type { DischargeRxView, DischargeRxItem } from './discharge-rx'
export type { IpdBillingItem, IpdBillView, IpdInterimView, IpdStatement } from './ipd-charge'
export type { IpdBill } from './ipd-bill'
export type { ImagingWorkItem, ImagingReportView } from './imaging'
export type { LabWorkItem, LabReportView, LabTrend } from './lab'
export type { TatBoard, TatOpenView } from './tat'
export type { LabLimitRow } from './lab-limits'
export type { ErLabs, ErSpecimenView } from './er-lab'
export type { OpdAddonOption, AddonDue } from './opd-addon'
export type { DispenseScanStats, DispenseScanInput } from './pharmacy'
export type { IncidentView, IncidentInput, RcaInput } from './incident'
export type { ControlledLedger, ControlledLedgerRow, ControlledLedgerOptions, ControlledReport, ControlledReportRow, SpecialRxSheet } from './controlled'
export type { PhraseView, PhraseShareTarget, PhraseHospitalTarget } from './phrase'
export type { OrderSetView, ExpandedOrderSet, ExpandedOrders } from './orderset'
export type { ExpandedEncounter } from './opd'

export { ServiceError } from './http'
export { dbVersion, storageIssue, storageMode } from '@/mock/db'
export * from './billing'
export type { SafeUser, SessionUser, LoginResult } from './auth'
export type { AllergyWarning } from './allergy'
export { allergenOfDrug } from './allergy'
export type { Eligibility } from './prevent-rules'
export { calcBmi, FIELD_FORMATS } from './prevent-rules'
export * from './nursing-rules'
export * from './stock-rules'
export * from './dose-rules'
export * from './drug-rules'
export * from './dated-rules'
export * from './queue-rules'
export * from './refill-rules'
export * from './idle-rules'
export * from './password-rules'
export * from './role-rules'
export * from './report-csv'
export * from './report-xlsx'
export { XLSX_MIME } from './xlsx'
export * from './phrase-rules'
export * from './rx-rules'
export * from './controlled-rules'
export * from './lab-rules'
export * from './followup-rules'
export * from './scan-rules'
export * from './risk-rules'
export * from './flag-rules'
export * from './abx-rules'
export * from './abx-steward-rules'
export * from './abx-metrics-rules'
export * from './renal-rules'
export * from './prophylaxis-rules'
export * from './abx-timeline-rules'
export * from './pharm-rules'
export * from './adr-rules'
export * from './medrec-rules'
export * from './pharmcare-rules'
export * from './specimen-rules'
export * from './lab-queue-rules'
export * from './tat-rules'
export * from './incident-rules'
export * from './lab-schedule-rules'
export * from './qc-rules'
export * from './analyzer-rules'
export * from './callout-rules'
export * from './exam-rules'
export * from './blood-rules'
export * from './copy-rules'
export * from './management-rules'
export * from './surgery-rules'
export * from './anesthesia-rules'
export * from './pathology-rules'
export * from './or-metrics-rules'
export * from './or-shift-rules'
export * from './sterile-rules'
export * from './implant-rules'
export * from './claim-rules'
export * from './preauth-rules'
export * from './drg-rules'
export * from './pcs-rules'
export * from './record-audit-rules'
export * from './opd-review-rules'
export * from './consent-rules'
export * from './bedside-rules'
export * from './rad-roster-rules'
export * from './duty-rules'
export * from './day-rules'
export * from './line-rules'
export * from './nutrition-rules'
export * from './delirium-rules'
export * from './staffing-rules'
export * from './discharge-plan-rules'
export * from './pca-rules'
export * from './infection-rules'
export * from './infusion-rules'
export * from './wound-rules'
export * from './icu-rules'
export * from './vent-rules'
export * from './icu-score-rules'
export * from './news-rules'
export * from './code-rules'
export * from './vaso-rules'
export * from './death-rules'
export * from './palliative-rules'
export * from './mortality-rules'
export * from './pressure-rules'
export * from './iso-rules'
export * from './ipc-rules'
export * from './culture-rules'
export * from './er-rules'
export * from './certificate-rules'
export * from './referral-rules'
export * from './interaction-rules'
export * from './stocktake-rules'
export * from './purchase-rules'
export * from './ud-rules'
export * from './permission-rules'
export type { PermissionRow } from './permission'
export type { WardStockView, WardStockRow } from './ward-stock'
export type { WardExpiryLot } from './ward-stock-work'
export type { ConsultView, ConsultPatientSummary, IncomingConsult, ConsultInput, IncomingOpdConsult, OpdConsultSummary } from './consult'
export { REPORT_MAX_DAYS, REPORT_MONTHLY_AFTER } from './charge'
export type { VisitView, AdmissionView, PatientBrief, DeptTransferView } from './views'
export type { IncomingTransfer } from './admission'
export type { DrugView, IdentityView, ProcedureView } from './master'
export type { BillingSettingsView } from './admin'
export type { StocktakeView, StocktakeLineView, StocktakeInput } from './stocktake'
export type { PurchaseView, PurchaseLineView, PurchaseInput, PurchaseCandidate, SupplierView, SupplierInput, SupplierPrice } from './purchase'
export type { TransferView, TransferLineView, TransferCandidate, ReturnCandidate, ReceiveTransferInput } from './transfer'
export type { DispenseView, DispenseItem, ReturnInput } from './pharmacy'
export type { PendingRefund } from './charge'
export type { UdWork, UdWorkGroup, UdWorkLine, UdReturnRow, UdDispenseView, UdDispenseInput, UdVerifyBox, UdCart, UdCartSheet, UdIssueRow } from './ud'
export type { RefillView, NoShowItem, AfterDischargeOptions, AdviceView, FollowUpSession } from './booking'
export type { MarView, OrderView } from './ipd'
export type { WardPatient, MarBoard, PrnView, HandoverView, HandoverGroup, WardTask } from './nursing'
export type { ScanPolicy, WristbandView, ScanDemoCodes, ScanStats } from './scan'
export type { ScanInput } from './scan-work'
export type { RiskOverview, RiskAssessmentView, RiskInput } from './risk'
export type { IsolationView, DnrView, PatientFlagsDetail, IsolationInput, DnrInput, WardFlagRow } from './flag'
export type { PatientFlags } from './flag-work'
export type { AbxReviewItem } from './abx'
export type { AbxInfo } from './abx-work'
export type { StewardItem, StewardFindingView, AbxInterventionView } from './abx-steward'
export type { AbxAdviceView } from './abx-steward-work'
export type { AbxMetrics } from './abx-metrics'
export type { AbxTimeline } from './abx-timeline'
export type { PharmItem } from './pharm'
export type { PharmIssue } from './pharm-work'
export type { AdrView, AdrStats, AdrInput } from './adr'
export type { MedRecView, HomeMedView, HomeMedInput, DischargeRecon, DischargeMedList } from './medrec'
export type { PharmCareView, PharmCarePatient } from './pharmcare'
export type { SpecimenView, WardSpecimens } from './specimen'
export type { QcOverview, QcRunView } from './qc'
export type { ExamView, ExamBoard, DowntimeView, ExamHoursSettings } from './exam'
export type { DeskPatient, DeskQueue, DeskSpecimen, QueueDisplay } from './lab-desk'
export type { AddonOption } from './specimen'
export type { AnalyzerBoard, AnalyzerHeldView, AnalyzerLoadable, AnalyzerRow } from './analyzer'
export type { PatientBlood, BloodOrderInput, BloodWork, BloodReceiveInput, BloodScanDemo, BloodScanInput, StartTransfusionInput, TransfusionVitalsInput } from './blood'
export type { BloodRequestView, BloodUnitView, BloodIssueRow } from './blood-work'
export type { ManagementReport, MonthMetrics } from './management'
export type { PatientSurgeries, SurgeryInput, OpRecordInput, OrBoard } from './surgery'
export type { AnesChart, PacuItem } from './anesthesia'
export type { PathItem, PathBoard, FrozenItem } from './pathology'
export type { PostopPlan, PostopPreviewItem, PostopSetView } from './postop'
export type { SurgeryView } from './surgery-work'
export type { OrMetrics } from './surgery'
export type { DayItem, DayBoard } from './day'
export type { BatchItem, RecallItem, SterileBoard } from './sterile'
export type { ClaimBoard, ClaimBoardRow, RejectFilePreview } from './claim'
export type { CutBoard, CutFilePreview, CutItem, CutMonth } from './claim-cut'
export type { RecordAudit, RecordItem } from './record-audit'
export type { OpdReviewBoard, OpdReviewView } from './opd-review'
export type { ConsentView } from './consent'
export type { BedsideView } from './bedside'
export type { RadRoster, RadRequestView } from './rad-roster'
export type { DutyRoster } from './duty'
export type { DoctorCallView } from './doctor-call'
export type { PreAuthView } from './preauth'
export type { DrgEstimate } from './drg'
export type { CodingItem } from './coding'
export type { ImplantCard, PatientImplants } from './implant'
export type { ImplantBoard, ImplantOption, LotItem, LotRecallItem } from './implant'
export type { LineView, LineInput, WardLineStats } from './line'
export type { TubeFeedingView, FeedInput } from './tube'
export type { MonthSchedule, ScheduleCell, WardAssignments } from './staffing'
export type { PatientPlan, PlanView, PlanWorkItem } from './discharge-plan'
export type { ShiftRequestView, ShiftRequestLists } from './shift-request'
export type { PcaView, PatientPca, PcaInput, PcaRecordInput } from './pca'
export type { InfectionView, PatientInfections, InfectionInput } from './infection'
export type { InfusionView, PatientInfusions } from './infusion'
export type { WoundView, PatientWounds, CareInput } from './wound'
export type { Flowsheet, FlowHour, FlowCell, FlowInput, IcuBedRow } from './icu'
export type { PatientVent, VentOrderView } from './vent'
export type { IcuRequestView, IcuWork, PatientIcu, SofaDay, IcuStats } from './icu-move'
export type { RrtView, RrtWork, PatientNews } from './rrt'
export type { CodeView, PatientCode } from './code'
export type { PatientVaso, VasoItem } from './vaso'
export type { DeathView, PatientDeath } from './death'
export type { PalliativeView, PatientPalliative, PalliativeWork } from './palliative'
export type { MortalityCase, MortalityWork } from './mortality'
export type { NegativeRoom } from './pressure'
export type { IpcStats, NotifiableView } from './ipc'
export type { PatientSafety, DeliriumView, RestraintView, CamInput, RestraintInput, WardSafetyStats } from './delirium'
export type { FeedSlot } from './tube-work'
export type { PatientNutrition, NutritionScreenView, NutritionAssessmentView, ScreenInput, AssessmentInput, NutritionWorkItem, MealRow } from './nutrition'
export type { ErBoard, TriageInput, DispositionInput } from './er'
export type { ErBoardItem } from './er-work'
export type { CopySource, CopySources, RecordCopyView, RecordCopyInput, CopyPage, CopyPrint } from './copy'
export type { RoomRow } from './schedule'
export type { SessionView, WeeklySlotView, SessionImpact, AffectedVisit, NoticeRow, SlotResult } from './schedule'
export type { UserRow, UserInput, DepartmentRow, DoctorRow, DoctorImpact, AuditRow, DiscountInput } from './admin'
export type { InventoryRow, InventorySummary, DrugLedger, StockTxnView, ReceiveInput, ReceiveResult, RestockView, RestockPlan, RestockInput, RestockWaiting, StockLocationView, StockLocationInput, QuarantineRow } from './inventory'
export type { PreventProfile, PreventRecordView, PreventStat, WorklistRow } from './prevent'
