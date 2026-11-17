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
import * as blood from './blood'
import * as copy from './copy'
import * as management from './management'
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
export const bloodApi = overNetwork(blood)
export const copyApi = overNetwork(copy)
export const managementApi = overNetwork(management)
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
export type { ControlledLedger, ControlledLedgerRow, ControlledLedgerOptions, ControlledReport, ControlledReportRow, SpecialRxSheet } from './controlled'
export type { PhraseView, PhraseShareTarget, PhraseHospitalTarget } from './phrase'
export type { OrderSetView, ExpandedOrderSet, ExpandedOrders } from './orderset'
export type { ExpandedEncounter } from './opd'

export { ServiceError } from './http'
export { dbVersion, storageIssue, storageMode } from '@/mock/db'
export * from './billing'
export type { SafeUser, SessionUser, LoginResult } from './auth'
export type { AllergyWarning } from './allergy'
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
export * from './blood-rules'
export * from './copy-rules'
export * from './management-rules'
export * from './certificate-rules'
export * from './referral-rules'
export * from './interaction-rules'
export * from './stocktake-rules'
export * from './purchase-rules'
export * from './ud-rules'
export * from './permission-rules'
export type { PermissionRow } from './permission'
export type { WardStockView, WardStockRow } from './ward-stock'
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
export type { RefillView, NoShowItem, AfterDischargeOptions } from './booking'
export type { MarView, OrderView } from './ipd'
export type { WardPatient, MarBoard, PrnView, HandoverView, HandoverGroup, WardTask } from './nursing'
export type { ScanPolicy, WristbandView, ScanDemoCodes, ScanStats } from './scan'
export type { ScanInput } from './scan-work'
export type { RiskOverview, RiskAssessmentView, RiskInput } from './risk'
export type { IsolationView, DnrView, PatientFlagsDetail, IsolationInput, DnrInput, WardFlagRow } from './flag'
export type { PatientFlags } from './flag-work'
export type { AbxReviewItem } from './abx'
export type { AbxInfo } from './abx-work'
export type { PatientBlood, BloodOrderInput, BloodWork, BloodReceiveInput, BloodScanDemo, BloodScanInput, StartTransfusionInput, TransfusionVitalsInput } from './blood'
export type { BloodRequestView, BloodUnitView, BloodIssueRow } from './blood-work'
export type { ManagementReport, MonthMetrics } from './management'
export type { CopySource, CopySources, RecordCopyView, RecordCopyInput, CopyPage, CopyPrint } from './copy'
export type { RoomRow } from './schedule'
export type { SessionView, WeeklySlotView, SessionImpact, AffectedVisit, NoticeRow, SlotResult } from './schedule'
export type { UserRow, UserInput, DepartmentRow, DoctorRow, DoctorImpact, AuditRow, DiscountInput } from './admin'
export type { InventoryRow, InventorySummary, DrugLedger, StockTxnView, ReceiveInput, ReceiveResult, RestockView, RestockPlan, RestockInput, RestockWaiting, StockLocationView, StockLocationInput, QuarantineRow } from './inventory'
export type { PreventProfile, PreventRecordView, PreventStat, WorklistRow } from './prevent'
