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
export * from './queue-rules'
export * from './refill-rules'
export * from './idle-rules'
export * from './password-rules'
export * from './role-rules'
export * from './report-csv'
export * from './phrase-rules'
export * from './rx-rules'
export { REPORT_MAX_DAYS } from './charge'
export type { VisitView, AdmissionView, PatientBrief } from './views'
export type { DrugView } from './master'
export type { RefillView } from './booking'
export type { MarView, OrderView } from './ipd'
export type { WardPatient, MarBoard, PrnView, HandoverView, HandoverGroup, WardTask } from './nursing'
export type { RoomRow } from './schedule'
export type { SessionView, WeeklySlotView, SessionImpact, AffectedVisit, NoticeRow, SlotResult } from './schedule'
export type { UserRow, UserInput, DepartmentRow, DoctorRow, DoctorImpact, AuditRow, DiscountInput } from './admin'
export type { InventoryRow, InventorySummary, DrugLedger, StockTxnView, ReceiveInput, ReceiveResult, RestockView, RestockPlan, RestockInput, RestockWaiting } from './inventory'
export type { PreventProfile, PreventRecordView, PreventStat, WorklistRow } from './prevent'
