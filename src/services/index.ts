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
export type { PhraseView, PhraseShareTarget } from './phrase'
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
export * from './phrase-rules'
export * from './rx-rules'
export * from './stocktake-rules'
export * from './purchase-rules'
export * from './ud-rules'
export * from './permission-rules'
export type { PermissionRow } from './permission'
export type { WardStockView, WardStockRow } from './ward-stock'
export type { ConsultView, ConsultPatientSummary, IncomingConsult, ConsultInput } from './consult'
export { REPORT_MAX_DAYS } from './charge'
export type { VisitView, AdmissionView, PatientBrief, DeptTransferView } from './views'
export type { IncomingTransfer } from './admission'
export type { DrugView, IdentityView, ProcedureView } from './master'
export type { BillingSettingsView } from './admin'
export type { StocktakeView, StocktakeLineView, StocktakeInput } from './stocktake'
export type { PurchaseView, PurchaseLineView, PurchaseInput, PurchaseCandidate, SupplierView, SupplierInput, SupplierPrice } from './purchase'
export type { TransferView, TransferLineView, TransferCandidate, ReturnCandidate, ReceiveTransferInput } from './transfer'
export type { DispenseView, DispenseItem, ReturnInput } from './pharmacy'
export type { PendingRefund } from './charge'
export type { UdWork, UdWorkGroup, UdWorkLine, UdReturnRow, UdDispenseView, UdDispenseInput, UdVerifyBox, UdCart, UdIssueRow } from './ud'
export type { RefillView } from './booking'
export type { MarView, OrderView } from './ipd'
export type { WardPatient, MarBoard, PrnView, HandoverView, HandoverGroup, WardTask } from './nursing'
export type { RoomRow } from './schedule'
export type { SessionView, WeeklySlotView, SessionImpact, AffectedVisit, NoticeRow, SlotResult } from './schedule'
export type { UserRow, UserInput, DepartmentRow, DoctorRow, DoctorImpact, AuditRow, DiscountInput } from './admin'
export type { InventoryRow, InventorySummary, DrugLedger, StockTxnView, ReceiveInput, ReceiveResult, RestockView, RestockPlan, RestockInput, RestockWaiting, StockLocationView, StockLocationInput, QuarantineRow } from './inventory'
export type { PreventProfile, PreventRecordView, PreventStat, WorklistRow } from './prevent'
