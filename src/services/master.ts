// 主檔（參考資料）查詢與維護：科別、醫師、身分、藥品、醫令、ICD、頻率，以及展示資料重置。
// 帳號、科別醫師的維護在 admin.ts（有較多連動規則）。
import type { Department, Doctor, Drug, Frequency, IcdCode, Identity, PreventItem, Procedure } from '@/types'
import * as codes from '@/mock/codes'
import { db, isSeedStale, resetDatabase, SCHEMA_VERSION } from '@/mock/db'
import { audit, fail, failField, fieldErrors, must, mutate, query, requireUser } from './http'
import { contains } from './views'
import { describeDrugs, needsSameNameCheck, sameNameDrugs } from './drug-rules'

// ---------- 唯讀代碼（不會在系統中修改） ----------
export const staticCodes = {
  caseTypes: codes.caseTypes,
  routes: codes.routes,
  wards: codes.wards,
  dischargeTypes: codes.dischargeTypes,
  familyHistoryOptions: codes.familyHistoryOptions,
  allergyOptions: codes.allergyOptions,
}

// ---------- 查詢 ----------
export const listDepartments = (all = false): Promise<Department[]> => query(() => db.departments.filter((d) => all || d.active))
export const listDoctors = (deptId?: string, all = false): Promise<Doctor[]> =>
  query(() => db.doctors.filter((d) => (all || d.active) && (!deptId || d.deptId === deptId)))
export const listIdentities = (): Promise<Identity[]> => query(() => db.identities)
export const listFrequencies = (): Promise<Frequency[]> => query(() => db.frequencies)

export function searchIcd(keyword: string, limit = 20): Promise<IcdCode[]> {
  return query(() => {
    const kw = keyword.trim()
    const codes = db.icdCodes.filter((c) => c.active !== false)
    if (!kw) return codes.slice(0, limit)
    return codes.filter((c) => contains(c.code, kw) || contains(c.name, kw) || contains(c.nameEn, kw)).slice(0, limit)
  })
}

export interface DrugQuery {
  keyword?: string
  category?: Drug['category']
  lowStockOnly?: boolean
  includeInactive?: boolean
}

export function listDrugs(q: DrugQuery = {}): Promise<Drug[]> {
  return query(() =>
    db.drugs.filter((d) => {
      if (!q.includeInactive && !d.active) return false
      if (q.category && d.category !== q.category) return false
      if (q.lowStockOnly && d.stock > d.safetyStock) return false
      const kw = q.keyword?.trim()
      return !kw || contains(d.name, kw) || contains(d.generic, kw) || contains(d.nhiCode, kw) || contains(d.id, kw)
    }),
  )
}

export function listProcedures(q: { keyword?: string; category?: Procedure['category']; includeInactive?: boolean } = {}): Promise<Procedure[]> {
  return query(() =>
    db.procedures.filter((p) => {
      if (!q.includeInactive && !p.active) return false
      if (q.category && p.category !== q.category) return false
      const kw = q.keyword?.trim()
      return !kw || contains(p.name, kw) || contains(p.code, kw)
    }),
  )
}

// ---------- 維護（管理員） ----------
function upsert<T extends { id: string }>(table: T[], item: T): T {
  const i = table.findIndex((x) => x.id === item.id)
  if (i >= 0) table[i] = item
  else table.push(item)
  return item
}

function nextCode(prefix: string, existing: string[], width: number): string {
  const max = existing.filter((x) => x.startsWith(prefix)).map((x) => Number(x.slice(prefix.length)) || 0).reduce((m, n) => Math.max(m, n), 0)
  return `${prefix}${String(max + 1).padStart(width, '0')}`
}

/**
 * 主檔維護共同原則：
 *   - 只能停用、不能刪除（舊病歷、舊處方都指向它）
 *   - 停用前檢查「還在用它的」：例如仍有執行中的住院醫囑，就不能停用該藥
 *   - 停用後不能再開立（服務層 usable.* 把關），但歷史紀錄照常顯示
 */
export type DrugInput = Omit<Drug, 'id' | 'stock'> & {
  id?: string
  stock?: number
  /** 已有同名藥品時，使用者已確認仍要儲存（見 drug-rules.ts） */
  allowSameName?: boolean
}

export function saveDrug(input: DrugInput): Promise<Drug> {
  return mutate(() => {
    requireUser('admin', 'pharmacist')
    const old = input.id ? db.drugs.find((x) => x.id === input.id) : undefined
    if (input.id && !old) fail('找不到藥品', 'NOT_FOUND')
    const name = input.name.trim().replace(/\s+/g, ' ') // 連續空白存成一個，避免「看起來一樣」的兩種寫法
    const nhiCode = input.nhiCode.trim().toUpperCase()
    const v = fieldErrors()
    if (!name) v.add('name', '請輸入藥名')
    if (!input.unit.trim()) v.add('unit', '請輸入調劑單位')
    if (!['口服', '外用', '注射', '吸入', '眼用'].includes(input.category)) v.add('category', '請選擇劑型')
    // 價格必須大於 0：批價會把 0 元的健保藥照 0 元申報、病人也付 0 元（醫令有「0 點改收自費」，藥品沒有）
    if (!(input.nhiPrice > 0)) v.add('nhiPrice', '健保價需大於 0')
    if (!(input.selfPrice > 0)) v.add('selfPrice', '自費價需大於 0')
    if (!Number.isInteger(input.safetyStock) || input.safetyStock < 0) v.add('safetyStock', '安全庫存需為 0 以上的整數')
    if (!(input.defaultDose > 0)) v.add('defaultDose', '預設劑量需大於 0')
    if (!db.frequencies.some((f) => f.code === input.defaultFreq)) v.add('defaultFreq', '請選擇預設頻率')
    if (!codes.routes.some((r) => r.code === input.defaultRoute)) v.add('defaultRoute', '請選擇預設途徑')
    // 藥袋必須印出作用與警語（藥師法）：主檔沒填，藥袋就不合規
    if (!input.indication?.trim()) v.add('indication', '請輸入作用或適應症（會印在藥袋上）')
    if (!input.warning?.trim()) v.add('warning', '請輸入警語或副作用（會印在藥袋上）')
    v.done()
    // 規則：欄位都正確後才檢查
    if (nhiCode && db.drugs.some((d) => d.nhiCode === nhiCode && d.id !== input.id)) failField('nhiCode', '健保代碼重複', 'CONFLICT')
    // 同名：不直接擋（真實醫院同成分不同廠牌是常態），但要使用者明確確認——這裡醫師開藥只看得到藥名
    const same = needsSameNameCheck(old?.name, name) ? sameNameDrugs(db.drugs, name, old?.id) : []
    if (same.length && !input.allowSameName) failField('name', `已有同名藥品：${describeDrugs(same)}。若是停用中的同一種藥，請直接啟用那一筆`, 'CONFLICT')
    if (old?.active && !input.active) {
      const n = db.ipdOrders.filter((o) => o.drugId === old.id && o.status === 'active').length
      if (n) failField('active', `仍有 ${n} 筆執行中的住院醫囑使用此藥，請先請醫師停止或改藥`, 'CONFLICT')
    }
    const saved: Drug = {
      id: old?.id ?? nextCode('M', db.drugs.map((d) => d.id), 3),
      nhiCode, name, generic: input.generic.trim(), spec: input.spec.trim(), unit: input.unit.trim(), category: input.category,
      nhiPrice: input.nhiPrice, selfPrice: input.selfPrice, safetyStock: input.safetyStock,
      defaultDose: input.defaultDose, defaultFreq: input.defaultFreq, defaultRoute: input.defaultRoute,
      highAlert: !!input.highAlert, doseUnit: input.doseUnit?.trim() || undefined, active: input.active,
      indication: input.indication.trim(), warning: input.warning.trim(),
      // 庫存不是主檔欄位，只能透過進貨、發藥、盤點的異動改變。
      // 維護主檔時一律沿用目前庫存（新藥從 0 開始），忽略傳入的 stock——否則改個藥名就能順手把庫存改掉，帳就對不起來了
      stock: old?.stock ?? 0,
    }
    audit(old ? '修改藥品主檔' : '新增藥品', `${saved.id} ${name}${old && old.active !== saved.active ? (saved.active ? '（啟用）' : '（停用）') : ''}`)
    return upsert(db.drugs, saved)
  })
}

export function saveProcedure(input: Omit<Procedure, 'id'> & { id?: string }): Promise<Procedure> {
  return mutate(() => {
    requireUser('admin')
    const old = input.id ? db.procedures.find((x) => x.id === input.id) : undefined
    if (input.id && !old) fail('找不到醫令', 'NOT_FOUND')
    const code = input.code.trim().toUpperCase()
    const v = fieldErrors()
    if (!code) v.add('code', '請輸入醫令代碼')
    if (!input.name.trim()) v.add('name', '請輸入名稱')
    if (!['診察', '檢驗', '影像', '處置', '復健'].includes(input.category)) v.add('category', '請選擇類別')
    if (!Number.isInteger(input.points) || input.points < 0) v.add('points', '健保點數需為 0 以上的整數')
    if (!(input.selfPrice >= 0)) v.add('selfPrice', '自費價不可為負數')
    v.done()
    if (db.procedures.some((p) => p.code === code && p.id !== input.id)) failField('code', '醫令代碼重複', 'CONFLICT')
    if (old && old.id === 'P001' && !input.active) failField('active', '一般門診診察費是每次看診必收的項目，不能停用')
    const saved: Procedure = { id: old?.id ?? nextCode('P', db.procedures.map((p) => p.id), 3), code, name: input.name.trim(), category: input.category, points: input.points, selfPrice: input.selfPrice, active: input.active }
    audit(old ? '修改醫令主檔' : '新增醫令', `${code} ${saved.name}`)
    return upsert(db.procedures, saved)
  })
}

/** ICD 全部（含停用，維護用） */
export const listIcdAll = (): Promise<IcdCode[]> => query(() => db.icdCodes)

export function saveIcd(input: IcdCode & { isNew?: boolean }): Promise<IcdCode> {
  return mutate(() => {
    requireUser('admin')
    const code = input.code.trim().toUpperCase()
    const v = fieldErrors()
    // 小數點要跳脫：沒跳脫的「.」代表任意字元，「J06-9」也會被當成合法代碼
    if (!/^[A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/.test(code)) v.add('code', 'ICD-10 格式：英文字母＋兩碼，可接小數點，例：J06.9')
    if (!input.name.trim()) v.add('name', '請輸入中文名稱')
    v.done()
    const old = db.icdCodes.find((c) => c.code === code)
    if (input.isNew && old) failField('code', '此診斷碼已存在', 'CONFLICT')
    if (!input.isNew && !old) fail('找不到診斷碼', 'NOT_FOUND')
    const saved: IcdCode = { code, name: input.name.trim(), nameEn: input.nameEn.trim(), active: input.active !== false }
    if (old) Object.assign(old, saved)
    else db.icdCodes.push(saved)
    audit(old ? '修改診斷碼' : '新增診斷碼', `${code} ${saved.name}`)
    return saved
  })
}

/**
 * 預防保健項目：只能調整「參數」（名稱、說明、間隔、登錄欄位、是否需報告、啟用），不能新增項目。
 * 每個項目的資格條件（年齡、性別、家族史）是程式邏輯（prevent-rules.ts），新項目需要寫新規則——那是程式變更，不是資料變更。
 */
export function savePreventItem(input: PreventItem): Promise<PreventItem> {
  return mutate(() => {
    requireUser('admin')
    const item = must(db.preventItems.find((i) => i.code === input.code), '預防保健項目')
    const fields = [...new Set(input.fields.map((f) => f.trim()).filter(Boolean))]
    const v = fieldErrors()
    if (!input.name.trim()) v.add('name', '請輸入名稱')
    if (!Number.isInteger(input.intervalYears) || input.intervalYears < 0 || input.intervalYears > 10) v.add('intervalYears', '間隔需為 0–10 年（0 表示終身一次）')
    if (!fields.length) v.add('fields', '至少要有一個登錄欄位')
    v.done()
    Object.assign(item, { name: input.name.trim(), ruleText: input.ruleText.trim(), intervalYears: input.intervalYears, fields, needsReport: !!input.needsReport, active: input.active !== false })
    audit('修改預防保健項目', `${item.code} ${item.name}`)
    return item
  })
}

// ---------- 展示資料 ----------
export function seedInfo(): { seededAt: string; stale: boolean; schema: number } {
  return { seededAt: db.seededAt, stale: isSeedStale(), schema: SCHEMA_VERSION }
}

/** 重置為今天的展示資料（登入狀態保留，因為使用者 id 在種子中固定） */
export async function resetDemoData(): Promise<void> {
  await query(() => undefined)
  resetDatabase()
}
