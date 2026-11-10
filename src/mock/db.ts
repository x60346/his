// Mock 資料庫：記憶體物件 + localStorage 持久化。
// 服務層（src/services）是唯一可以讀寫這裡的程式；頁面一律透過服務層存取。
import { ref } from 'vue'
import type {
  Admission,
  AuditLog,
  Bed,
  BillingSettings,
  Charge,
  ClinicSession,
  Department,
  Dispense,
  Doctor,
  Drug,
  DrugLot,
  Encounter,
  Frequency,
  HandoverNote,
  IcdCode,
  Identity,
  IpdOrder,
  MarRecord,
  NursingNote,
  Patient,
  PreventItem,
  PreventRecord,
  Procedure,
  ProgressNote,
  StockTxn,
  User,
  Visit,
  VitalRecord,
  WeeklySlot,
} from '@/types'
import { today } from '@/utils/date'
import { buildSeed } from './seed'

export interface Database {
  /** 資料結構版本，結構變更時遞增，舊資料會被重建 */
  schema: number
  /** 建立展示資料的日期 */
  seededAt: string
  users: User[]
  departments: Department[]
  doctors: Doctor[]
  identities: Identity[]
  /** 收費參數 */
  billingSettings: BillingSettings
  weeklySlots: WeeklySlot[]
  /** 已展開的每日診次；新日期由 schedule 服務依 weeklySlots 自動產生 */
  sessions: ClinicSession[]
  patients: Patient[]
  visits: Visit[]
  encounters: Encounter[]
  charges: Charge[]
  dispenses: Dispense[]
  drugs: Drug[]
  /** 藥品批號與各批剩餘量 */
  drugLots: DrugLot[]
  /** 庫存異動帳 */
  stockTxns: StockTxn[]
  procedures: Procedure[]
  icdCodes: IcdCode[]
  frequencies: Frequency[]
  beds: Bed[]
  admissions: Admission[]
  ipdOrders: IpdOrder[]
  mar: MarRecord[]
  vitals: VitalRecord[]
  nursingNotes: NursingNote[]
  progressNotes: ProgressNote[]
  handovers: HandoverNote[]
  preventItems: PreventItem[]
  preventRecords: PreventRecord[]
  auditLogs: AuditLog[]
  /** 流水號計數器，例：receipt:2024-05-01 */
  counters: Record<string, number>
}

/** 資料結構或種子內容變更時遞增，使用者瀏覽器裡的舊資料會自動重建 */
export const SCHEMA_VERSION = 15
const STORAGE_KEY = 'his-demo-db'

function freshSeed(): Database {
  return { ...buildSeed(), schema: SCHEMA_VERSION }
}

function load(): Database {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Database
      if (parsed.schema === SCHEMA_VERSION) return parsed
    }
  } catch {
    // localStorage 不可用或資料損毀時改用新的展示資料
  }
  return freshSeed()
}

export let db: Database = load()

/** 資料版本號：每次寫入遞增，頁面可 watch 它來重新查詢 */
export const dbVersion = ref(0)

export function commit(): void {
  dbVersion.value++
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db))
  } catch {
    // 無法儲存時資料仍保留在記憶體中，重新整理後才會遺失
  }
}

/** 以快照取代整個資料庫（服務層交易失敗時回滾用） */
export function replaceDatabase(next: Database): void {
  db = next
}

/** 重建為今日的展示資料 */
export function resetDatabase(): void {
  db = freshSeed()
  commit()
}

export function isSeedStale(): boolean {
  return db.seededAt !== today()
}

/** 取得下一個流水號 */
export function nextCounter(key: string, start = 1): number {
  const n = (db.counters[key] ?? start - 1) + 1
  db.counters[key] = n
  return n
}

let idSeq = 0
export function newId(prefix: string): string {
  idSeq = (idSeq + 1) % 1000
  return `${prefix}${Date.now().toString(36)}${idSeq.toString(36).padStart(2, '0')}`
}

// 第一次載入（含重建）時立即寫入，確保重新整理後資料一致
commit()
