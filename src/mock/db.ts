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
export const SCHEMA_VERSION = 22
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

/**
 * 寫入失敗的原因：
 *   full    儲存空間已滿（QuotaExceededError）——清出空間或匯出後重置就能恢復
 *   blocked 瀏覽器不允許網站儲存（隱私設定、部分無痕模式，通常是 SecurityError）
 * 兩者處理方式完全不同，提示要說對原因：以前一律說「瀏覽器不允許儲存」，空間滿的使用者照著去改隱私設定也沒用。
 */
export type StorageIssue = 'full' | 'blocked'
export function classifyStorageError(e: unknown): StorageIssue {
  const err = e as { name?: string; code?: number } | null
  // 各瀏覽器的名稱與代碼：Chrome／Safari 為 QuotaExceededError（code 22），舊版 Firefox 為 NS_ERROR_DOM_QUOTA_REACHED（code 1014）
  return err && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED' || err.code === 22 || err.code === 1014) ? 'full' : 'blocked'
}

/**
 * 儲存模式：
 *   persistent 正常，資料存在瀏覽器
 *   memory     存不進去，只能暫存在記憶體，重新整理就會消失——畫面會一直顯示警告（原因見 storageIssue）
 */
export const storageIssue = ref<StorageIssue | null>(null)
function probeStorage(): 'persistent' | 'memory' {
  try {
    localStorage.setItem('his-demo-probe', '1')
    localStorage.removeItem('his-demo-probe')
    return 'persistent'
  } catch (e) {
    storageIssue.value = classifyStorageError(e)
    return 'memory'
  }
}
export const storageMode = ref(probeStorage())

/** 可以儲存、但這次寫入失敗（reason：空間已滿或瀏覽器不允許） */
export class StorageWriteError extends Error {
  constructor(public reason: StorageIssue) {
    super(reason === 'full' ? '瀏覽器儲存空間已滿，資料無法儲存' : '瀏覽器不允許儲存資料')
  }
}

/**
 * 存檔。寫入失敗時丟出 StorageWriteError，由交易（mutate）回滾並告訴使用者「這次沒有完成」。
 * 以前這裡是默默吞掉錯誤：畫面顯示收款成功、給了收據號，重新整理後資料卻消失。
 */
export function commit(): void {
  if (storageMode.value === 'persistent') {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(db))
    } catch (e) {
      throw new StorageWriteError(classifyStorageError(e))
    }
  }
  dbVersion.value++
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

// 第一次載入（含重建）時立即寫入，確保重新整理後資料一致；這時寫不進去就改用暫存模式（畫面會顯示警告）
try {
  commit()
} catch (e) {
  storageMode.value = 'memory'
  storageIssue.value = e instanceof StorageWriteError ? e.reason : classifyStorageError(e)
  dbVersion.value++
}

/**
 * 多分頁同步：其他分頁寫入 localStorage 時，這裡會收到 storage 事件（同一分頁自己的寫入不會觸發）。
 * 重新載入資料並遞增 dbVersion，頁面就會重新查詢。
 * 少了這一步，每個分頁各自握著一份舊資料，下次寫入時會把整份蓋回去——另一分頁剛建的病人就消失了。
 * （寫入是同步完成的：mutate 的「快照 → 修改 → 存檔」中間沒有 await，不會被這裡插隊改到一半。）
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY || !e.newValue) return
    try {
      const parsed = JSON.parse(e.newValue) as Database
      if (parsed.schema !== SCHEMA_VERSION) return
      db = parsed
      dbVersion.value++
    } catch {
      // 另一分頁寫入的內容無法解析時維持現狀
    }
  })
}

/**
 * 讀取時順便產生的資料（診次、給藥排程）用這個存檔：存不進去也不影響這次讀取，
 * 下次會再產生一次。真正的寫入（使用者的操作）一律走 mutate → commit，失敗就要讓使用者知道。
 */
export function commitIfPossible(): void {
  try {
    commit()
  } catch {
    dbVersion.value++
  }
}
