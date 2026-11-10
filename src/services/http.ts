// 服務層共用核心：模擬網路延遲、交易（失敗回滾）、回傳複本、統一錯誤、稽核紀錄。
// 將來改接真實後端時，這個檔案會換成 fetch 包裝，其餘服務的函式簽章不變。
import type { User } from '@/types'
import { commit, db, newId, replaceDatabase } from '@/mock/db'
import { now } from '@/utils/date'

/** 業務錯誤：頁面 catch 後直接把 message 顯示給使用者 */
export class ServiceError extends Error {
  constructor(
    message: string,
    public code: 'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'UNAUTHORIZED' = 'BAD_REQUEST',
    /** 出錯的欄位名稱；有值時頁面會把訊息顯示在該欄位下方 */
    public field?: string,
  ) {
    super(message)
    this.name = 'ServiceError'
  }
}

export function fail(message: string, code?: ServiceError['code'], field?: string): never {
  throw new ServiceError(message, code, field)
}

/** 欄位驗證失敗的簡寫 */
export function failField(field: string, message: string, code: ServiceError['code'] = 'BAD_REQUEST'): never {
  throw new ServiceError(message, code, field)
}

/** 找不到就丟 NOT_FOUND，省去每個服務重複寫判斷 */
export function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) fail(`找不到${what}`, 'NOT_FOUND')
  return value
}

// ---------- 模擬延遲 ----------
let latency: [number, number] = [100, 300]

/** 測試或腳本可設為 [0, 0] 關閉延遲 */
export function setLatency(min: number, max: number): void {
  latency = [min, max]
}

function delay(): Promise<void> {
  const [min, max] = latency
  if (max <= 0) return Promise.resolve()
  return new Promise((r) => setTimeout(r, min + Math.random() * (max - min)))
}

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v))

/** 讀取：延遲後回傳複本，頁面拿到的資料怎麼改都不會影響資料庫 */
/**
 * 讀取：預設必須登入。
 * 登入檢查集中在這裡，而不是每個讀取函式各自呼叫 requireUser()——
 * 新增的讀取函式「預設就安全」，忘了寫也不會變成任何人都能讀病歷。
 * 確定要公開的（例如登入頁的展示帳號清單），必須明確寫 { public: true }。
 */
export async function query<T>(fn: () => T, opts: { public?: boolean } = {}): Promise<T> {
  await delay()
  if (!opts.public) requireUser()
  return clone(fn())
}

/**
 * 寫入：延遲後在「交易」中執行。
 * fn 中途丟出錯誤時整個資料庫回到執行前的狀態，不會留下改到一半的資料；
 * 成功才 commit（存入 localStorage 並通知頁面重新查詢）。
 */
export async function mutate<T>(fn: () => T): Promise<T> {
  await delay()
  const snapshot = structuredClone(db)
  try {
    // 可能失敗的步驟（包含複製回傳值）都要在 commit 之前完成；
    // 否則會出現「已存檔、但記憶體被回滾」的不一致
    const result = clone(fn())
    commit()
    return result
  } catch (e) {
    replaceDatabase(snapshot)
    throw e
  }
}

/**
 * 模擬網路邊界：呼叫參數先經過 JSON 序列化。
 * 真實後端收到的永遠是「純資料」；頁面若傳入 Vue 的響應式 Proxy（ref 陣列、reactive 物件），
 * 沒有這一層就會被原封不動存進資料庫，之後 structuredClone 失敗，或頁面改了資料庫跟著變。
 */
export function overNetwork<T extends object>(mod: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(mod)) {
    out[key] =
      typeof value === 'function'
        ? (...args: unknown[]) => value(...args.map((a) => (a === undefined ? a : JSON.parse(JSON.stringify(a)))))
        : value
  }
  return out as T
}

// ---------- 登入身分 ----------
// 由 auth 服務設定；其他服務用 requireUser() 取得「誰在操作」，例如批價人員、給藥護理師。
const SESSION_KEY = 'his-demo-session'
let sessionUserId: string | null = (() => {
  try {
    return sessionStorage.getItem(SESSION_KEY)
  } catch {
    return null
  }
})()

export function setSessionUser(userId: string | null): void {
  sessionUserId = userId
  try {
    if (userId) sessionStorage.setItem(SESSION_KEY, userId)
    else sessionStorage.removeItem(SESSION_KEY)
  } catch {
    // 無 sessionStorage 時僅保留在記憶體
  }
}

export function sessionUser(): User | null {
  return db.users.find((u) => u.id === sessionUserId && u.active) ?? null
}

const roleName: Record<User['role'], string> = { admin: '系統管理員', doctor: '醫師', nurse: '護理師', pharmacist: '藥師', clerk: '掛號批價' }

/**
 * 取得目前操作者並檢查角色。
 * 系統管理員「不」自動擁有所有權限：管理員可以檢視所有頁面，但臨床操作（開醫囑、給藥、發藥、收費…）
 * 必須由具該角色的人執行——醫療紀錄要記在有執業資格的人名下。
 * 管理員能做的事，在呼叫端明確寫出 'admin'（例：requireUser('admin', 'pharmacist')）。
 */
export function requireUser(...roles: User['role'][]): User {
  const u = sessionUser()
  if (!u) fail('請先登入', 'UNAUTHORIZED')
  if (roles.length && !roles.includes(u.role)) {
    const need = roles.map((r) => roleName[r]).join('、')
    fail(u.role === 'admin' ? `系統管理員不能執行臨床操作，請以${need}帳號登入` : `您沒有執行此操作的權限（限${need}）`, 'FORBIDDEN')
  }
  return u
}

/** 稽核紀錄：只在 mutate 內呼叫，跟著同一筆交易成功或回滾 */
export function audit(action: string, detail: string): void {
  db.auditLogs.unshift({ id: newId('LOG'), at: now(), userId: sessionUserId ?? '-', action, detail })
  if (db.auditLogs.length > 500) db.auditLogs.length = 500
}
