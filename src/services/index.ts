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

export { ServiceError } from './http'
export { dbVersion } from '@/mock/db'
export * from './billing'
export type { SafeUser } from './auth'
export type { AllergyWarning } from './allergy'
export type { Eligibility } from './prevent-rules'
export * from './nursing-rules'
export * from './stock-rules'
export * from './dose-rules'
export type { VisitView, AdmissionView, PatientBrief } from './views'
export type { MarView, OrderView } from './ipd'
export type { WardPatient, MarBoard, PrnView, HandoverView } from './nursing'
export type { SessionView, WeeklySlotView, SessionImpact, AffectedVisit, NoticeRow, SlotResult } from './schedule'
export type { UserRow, UserInput, DepartmentRow, DoctorRow, DoctorImpact, AuditRow } from './admin'
export type { InventoryRow, InventorySummary, DrugLedger, StockTxnView, ReceiveInput } from './inventory'
export type { PreventProfile, PreventRecordView, PreventStat, WorklistRow } from './prevent'
