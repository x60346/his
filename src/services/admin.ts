// 系統管理：帳號、科別、醫師、稽核紀錄、展示資料匯出入。
//
// 這裡的規則大多不是「欄位格式」，而是「改了之後會不會毀掉系統自己」：
//   - 不能停用自己、不能拿掉自己的管理員角色、系統至少要留一個啟用的管理員（否則沒人能再管）
//   - 有資料在用的東西只能停用、不能刪除；停用前先檢查「已經在用它的資料」
//   - 稽核紀錄只能查，沒有任何修改或刪除的 API
import type { BillingSettings, Department, DiscountRule, Doctor, Identity, Role, User } from '@/types'
import { db, replaceDatabase, SCHEMA_VERSION, type Database } from '@/mock/db'
import { now, today } from '@/utils/date'
import { audit, fail, failField, fieldErrors, must, mutate, query, requireUser, sessionUser, failFields } from './http'
import { checkDiscountRule, discountSummary } from './billing'
import { passwordProblem } from './password-rules'
import { rolesProblem } from './role-rules'
import { toSafeUser, type SafeUser } from './auth'
import { nameOf } from './views'

const ROLES: Role[] = ['admin', 'doctor', 'nurse', 'pharmacist', 'clerk']
/** 帳號規則：檢查與說明文字放在一起，表單的提示直接用同一句（以前提示寫「英數字」、錯誤卻說「英數字、底線或點」） */
const USERNAME_RE = /^[a-z0-9_.]{3,20}$/
export const USERNAME_RULE = '3–20 個英數字、底線或點'

/** 依前綴產生下一個流水代號，例：DR10 */
function nextCode(prefix: string, existing: string[], width = 2): string {
  const max = existing.filter((x) => x.startsWith(prefix)).map((x) => Number(x.slice(prefix.length)) || 0).reduce((a, b) => Math.max(a, b), 0)
  return `${prefix}${String(max + 1).padStart(width, '0')}`
}

// ---------- 帳號 ----------
export interface UserRow extends SafeUser {
  doctorName: string
  /** 最近一次登入（取自稽核紀錄；紀錄只保留最近 500 筆，太久以前的會查不到） */
  lastLoginAt?: string
}

export function listUsers(): Promise<UserRow[]> {
  return query(() => {
    requireUser('admin')
    return db.users.map((u) => ({
      ...toSafeUser(u),
      doctorName: nameOf.doctor(u.doctorId),
      lastLoginAt: db.auditLogs.find((l) => l.action === '登入' && l.userId === u.id)?.at,
    }))
  })
}

export type UserInput = Pick<User, 'username' | 'name' | 'roles' | 'doctorId' | 'active'> & { id?: string; password?: string }

export function saveUser(input: UserInput): Promise<SafeUser> {
  return mutate(() => {
    const me = requireUser('admin')
    const username = input.username.trim().toLowerCase()
    const name = input.name.trim()
    const old = input.id ? must(db.users.find((u) => u.id === input.id), '使用者') : undefined
    // 欄位：一次收集、一起標出
    const v = fieldErrors()
    if (!USERNAME_RE.test(username)) v.add('username', `帳號需為 ${USERNAME_RULE}`)
    if (!name) v.add('name', '請輸入姓名')
    // 去重、只留合法角色，並依固定順序存（畫面顯示、比較都一致）
    const roles = ROLES.filter((x) => (input.roles ?? []).includes(x))
    if ((input.roles ?? []).some((x) => !ROLES.includes(x))) v.add('roles', '角色不正確')
    else {
      const rp = rolesProblem(roles)
      if (rp) v.add('roles', rp)
    }
    const isDoctor = roles.includes('doctor')
    if (isDoctor && !db.doctors.some((x) => x.id === input.doctorId)) v.add('doctorId', '含醫師角色的帳號需對應醫師')
    if (!old) {
      const pwProblem = passwordProblem(input.password, { username })
      if (pwProblem) v.add('password', pwProblem)
    }
    v.done()

    // 規則：欄位都正確後才檢查
    if (db.users.some((u) => u.username === username && u.id !== input.id)) failField('username', '帳號已存在', 'CONFLICT')
    // 醫師帳號必須對應一位在職醫師，且一位醫師只能有一個帳號（否則開的醫囑算誰的？）
    let doctorId: string | undefined
    if (isDoctor) {
      const d = db.doctors.find((x) => x.id === input.doctorId)!
      if (!d.active) failField('doctorId', `${d.name} 已停用，不能建立帳號`)
      const taken = db.users.find((u) => u.doctorId === d.id && u.id !== input.id)
      if (taken) failField('doctorId', `${d.name} 已有帳號（${taken.username}）`, 'CONFLICT')
      doctorId = d.id
    }

    if (old && old.id === me.id) {
      // 防止把自己鎖在門外
      if (!roles.includes('admin')) failField('roles', '不能拿掉自己的管理員角色')
      if (!input.active) failField('active', '不能停用自己的帳號')
    }
    if (old && old.roles.includes('admin') && old.active && (!roles.includes('admin') || !input.active)) {
      const admins = db.users.filter((u) => u.roles.includes('admin') && u.active)
      if (admins.length <= 1) fail('系統至少要保留一個啟用中的管理員帳號', 'CONFLICT')
    }

    const password = old ? old.password : input.password

    const saved: User = {
      ...old,
      id: old?.id ?? nextCode('U9', db.users.map((u) => u.id)), username, name, roles, doctorId, active: input.active, password: password!,
      // 管理員設定的初始密碼：本人第一次登入就要改掉（管理員知道這組密碼）
      ...(old ? {} : { mustChangePassword: true, passwordChangedAt: Date.now() }),
    }
    if (old) Object.assign(old, saved)
    else db.users.push(saved)
    audit(old ? '修改帳號' : '新增帳號', `${username}（${saved.roles.join('+')}${old && old.active !== saved.active ? `，${saved.active ? '啟用' : '停用'}` : ''}）`)
    return toSafeUser(saved)
  })
}

/** 重設密碼：管理員設定新密碼，稽核紀錄只記「誰重設了誰」，不記密碼本身 */
/**
 * 重設密碼（忘記密碼、疑似外洩）：本人下次登入必須改掉；已登入的分頁全部失效（外洩時就是要把別人踢出去）。
 * 不能重設自己的——那會把自己踢出去，自己的密碼請用右上角「變更密碼」。
 */
export function resetPassword(userId: string, password: string): Promise<void> {
  return mutate(() => {
    const me = requireUser('admin')
    const u = must(db.users.find((x) => x.id === userId), '使用者')
    if (u.id === me.id) fail('自己的密碼請用右上角「變更密碼」')
    const problem = passwordProblem(password, { username: u.username })
    if (problem) failField('password', problem)
    u.password = password
    u.mustChangePassword = true
    u.passwordChangedAt = Date.now()
    audit('重設密碼', `${u.username}（下次登入須變更）`)
  })
}

// ---------- 科別 ----------
export interface DepartmentRow extends Department {
  activeDoctors: number
}

export function listDepartments(): Promise<DepartmentRow[]> {
  return query(() => db.departments.map((d) => ({ ...d, activeDoctors: db.doctors.filter((x) => x.deptId === d.id && x.active).length })))
}

export function saveDepartment(input: Omit<Department, 'id'> & { id?: string }): Promise<Department> {
  return mutate(() => {
    requireUser('admin')
    const code = input.code.trim().toUpperCase()
    const name = input.name.trim()
    const v = fieldErrors()
    if (!/^[A-Z0-9]{2,4}$/.test(code)) v.add('code', '科別代碼為 2–4 個英數字')
    if (!name) v.add('name', '請輸入科別名稱')
    v.done()
    if (db.departments.some((d) => d.code === code && d.id !== input.id)) failField('code', '科別代碼已存在', 'CONFLICT')
    if (db.departments.some((d) => d.name === name && d.id !== input.id)) failField('name', '科別名稱已存在', 'CONFLICT')
    const old = input.id ? must(db.departments.find((d) => d.id === input.id), '科別') : undefined
    if (old?.active && !input.active) {
      const n = db.doctors.filter((x) => x.deptId === old.id && x.active).length
      if (n) failField('active', `${old.name}仍有 ${n} 位在職醫師，請先將醫師停用或轉科`, 'CONFLICT')
    }
    const saved: Department = { id: old?.id ?? nextCode('D', db.departments.map((d) => d.id)), code, name, active: input.active }
    if (old) Object.assign(old, saved)
    else db.departments.push(saved)
    audit(old ? '修改科別' : '新增科別', `${code} ${name}`)
    return saved
  })
}

// ---------- 醫師 ----------
/** 停用醫師前要處理的事：任何一項不為 0 都不能停用 */
export interface DoctorImpact {
  /** 今天以後、尚未看診的掛號 */
  futureVisits: number
  /** 擔任主治醫師、仍在院的住院病人 */
  admittedPatients: number
  /** 每週排班 */
  weeklySlots: number
  /** 對應的啟用中帳號 */
  activeAccount?: string
}

function impactOf(doctorId: string): DoctorImpact {
  const t = today()
  return {
    futureVisits: db.visits.filter((v) => v.doctorId === doctorId && v.date >= t && v.status === 'registered').length,
    admittedPatients: db.admissions.filter((a) => a.doctorId === doctorId && (a.status === 'admitted' || a.status === 'reserved')).length,
    weeklySlots: db.weeklySlots.filter((s) => s.doctorId === doctorId).length,
    activeAccount: db.users.find((u) => u.doctorId === doctorId && u.active)?.username,
  }
}

export interface DoctorRow extends Doctor {
  deptName: string
  impact: DoctorImpact
}

export function listDoctors(): Promise<DoctorRow[]> {
  return query(() => db.doctors.map((d) => ({ ...d, deptName: nameOf.dept(d.deptId), impact: impactOf(d.id) })))
}

export function saveDoctor(input: Omit<Doctor, 'id'> & { id?: string }): Promise<Doctor> {
  return mutate(() => {
    requireUser('admin')
    const name = input.name.trim()
    const licenseNo = input.licenseNo.trim()
    const dept = db.departments.find((d) => d.id === input.deptId)
    const v = fieldErrors()
    if (!name) v.add('name', '請輸入姓名')
    if (!dept) v.add('deptId', '請選擇科別')
    if (!licenseNo) v.add('licenseNo', '請輸入醫事人員代碼')
    v.done()
    if (!dept!.active) failField('deptId', `${dept!.name}已停用`)
    if (db.doctors.some((d) => d.licenseNo === licenseNo && d.id !== input.id)) failField('licenseNo', '醫事人員代碼重複', 'CONFLICT')

    const old = input.id ? must(db.doctors.find((d) => d.id === input.id), '醫師') : undefined
    if (old?.active && !input.active) {
      const im = impactOf(old.id)
      const todo = [
        im.futureVisits && `${im.futureVisits} 筆未看診的掛號（請先通知病人改掛或退掛）`,
        im.admittedPatients && `${im.admittedPatients} 位住院或預約住院病人（請住院中心「變更主治醫師」）`,
        im.weeklySlots && `${im.weeklySlots} 個每週診次（請先調整排班）`,
        im.activeAccount && `帳號 ${im.activeAccount} 仍為啟用（請先停用）`,
      ].filter(Boolean)
      if (todo.length) failField('active', `${old.name}還有：${todo.join('；')}`, 'CONFLICT')
    }
    const saved: Doctor = { id: old?.id ?? nextCode('DR', db.doctors.map((d) => d.id)), name, deptId: dept!.id, title: input.title.trim() || '主治醫師', licenseNo, active: input.active }
    if (old) Object.assign(old, saved)
    else db.doctors.push(saved)
    audit(old ? '修改醫師' : '新增醫師', `${saved.id} ${name}（${dept!.name}）`)
    return saved
  })
}

// ---------- 稽核紀錄 ----------
export interface AuditRow {
  id: string
  at: string
  userId: string
  /** 當時用的作業角色 */
  role?: Role
  userName: string
  action: string
  detail: string
}

export function listAuditLogs(q: { keyword?: string; userId?: string; action?: string; date?: string } = {}): Promise<{ rows: AuditRow[]; actions: string[] }> {
  return query(() => {
    requireUser('admin')
    const kw = q.keyword?.trim().toLowerCase()
    const rows = db.auditLogs
      .filter((l) => (!q.userId || l.userId === q.userId) && (!q.action || l.action === q.action) && (!q.date || l.at.startsWith(q.date)))
      .map((l) => ({ ...l, userName: nameOf.user(l.userId) }))
      .filter((l) => !kw || `${l.action} ${l.detail} ${l.userName}`.toLowerCase().includes(kw))
    return { rows, actions: [...new Set(db.auditLogs.map((l) => l.action))].sort() }
  })
}

// ---------- 展示資料匯出入 ----------
/** 匯出整個資料庫（JSON 字串）。展示系統的密碼是明文，匯出檔請勿外流 */
export function exportData(): Promise<string> {
  return query(() => {
    requireUser('admin')
    return JSON.stringify(db)
  })
}

/**
 * 匯入：先完整驗證，再整個替換。驗證不過就什麼都不改。
 * 版本不同的資料不硬轉——結構不一樣，硬塞進來只會在某個頁面出錯，而且很難追。
 */
export function importData(json: string): Promise<{ users: number; sessionKept: boolean }> {
  return mutate(() => {
    const me = requireUser('admin')
    let parsed: Database
    try {
      parsed = JSON.parse(json)
    } catch {
      fail('檔案不是有效的 JSON')
    }
    if (!parsed! || typeof parsed !== 'object') fail('檔案內容不是資料庫格式')
    if (parsed!.schema !== SCHEMA_VERSION) fail(`資料版本不符：檔案為第 ${parsed!.schema ?? '?'} 版，系統為第 ${SCHEMA_VERSION} 版。請在相同版本的系統匯出後再匯入`)
    const missing = (Object.keys(db) as (keyof Database)[]).filter((k) => !(k in parsed!) || (Array.isArray(db[k]) && !Array.isArray(parsed![k])))
    // 先說「怎麼辦」（使用者看得懂），缺少的名稱只列前 5 個放在後面給工程人員查（以前一口氣列出約 40 個英文表名）
    if (missing.length) {
      const names = missing.slice(0, 5).join('、') + (missing.length > 5 ? `… 等 ${missing.length} 項` : '')
      fail(`這不是完整的匯出檔（缺少 ${missing.length} 項資料），請使用本系統「匯出資料」產生的檔案。\n缺少：${names}`)
    }
    if (!parsed!.users.some((u) => u.roles?.includes('admin') && u.active)) fail('匯入的資料沒有啟用中的管理員，匯入後將無人能管理系統')

    replaceDatabase(parsed!)
    const sessionKept = !!sessionUser()
    audit('匯入展示資料', `匯入者 ${me.username}`)
    return { users: parsed!.users.length, sessionKept }
  })
}

// ---------- 收費設定 ----------
// 規則（怎麼算）在 billing.ts；這裡維護參數（算多少）。
// 已收費的收據存的是「當時算好的明細」，參數改了也不會變；只有「還沒收費」的會用新參數計算。

export const getBillingSettings = (): Promise<BillingSettings> => query(() => db.billingSettings)

/** 目前「已看完診、還沒收費」的掛號數：調整收費參數會影響它們 */
const pendingChargeCount = () => db.visits.filter((v) => v.status === 'consulted').length

export function saveBillingSettings(input: BillingSettings): Promise<{ settings: BillingSettings; affectedPending: number }> {
  return mutate(() => {
    const u = requireUser('admin')
    const keys: (keyof BillingSettings)[] = ['basicCopay', 'drugCopayFreeUpTo', 'drugCopayStep', 'drugCopayPerStep', 'drugCopayMax']
    const v = fieldErrors()
    for (const k of keys) {
      const n = input[k] as number
      if (!Number.isInteger(n) || n < 0 || n > 10000) v.add(k, '需為 0–10000 的整數')
    }
    if (input.drugCopayStep < 1) v.add('drugCopayStep', '級距至少 1 元（不能為 0，否則無法計算）')
    if (input.drugCopayMax < input.drugCopayPerStep) v.add('drugCopayMax', '上限不能小於每級加收金額')
    v.done()
    const old = { ...db.billingSettings }
    db.billingSettings = {
      basicCopay: input.basicCopay, drugCopayFreeUpTo: input.drugCopayFreeUpTo, drugCopayStep: input.drugCopayStep,
      drugCopayPerStep: input.drugCopayPerStep, drugCopayMax: input.drugCopayMax, updatedAt: now(), updatedBy: u.id,
    }
    const changed = keys.filter((k) => old[k] !== db.billingSettings[k]).map((k) => `${k} ${old[k]}→${db.billingSettings[k]}`)
    audit('修改收費設定', changed.join('、') || '無變更')
    return { settings: db.billingSettings, affectedPending: pendingChargeCount() }
  })
}

export function saveIdentity(input: Identity): Promise<{ identity: Identity; affectedPending: number }> {
  return mutate(() => {
    requireUser('admin')
    // 身分代碼對應健保規定，只能調整參數，不能新增或改代碼
    const idt = must(db.identities.find((x) => x.code === input.code), '就醫身分')
    const v = fieldErrors()
    if (!input.name.trim()) v.add('name', '請輸入名稱')
    if (!Number.isInteger(input.regFee) || input.regFee < 0 || input.regFee > 2000) v.add('regFee', '掛號費需為 0–2000 的整數')
    v.done()
    const before = `${idt.regFee}`
    Object.assign(idt, { name: input.name.trim(), regFee: input.regFee, copayExempt: !!input.copayExempt, selfPay: !!input.selfPay })
    audit('修改就醫身分', `${idt.code} ${idt.name} 掛號費 ${before}→${idt.regFee}`)
    return { identity: idt, affectedPending: pendingChargeCount() }
  })
}

// ---------- 優免類別 ----------
export type DiscountInput = Omit<DiscountRule, 'code'> & { code?: string }

/** 新增或修改優免類別。只能停用、不能刪除（舊收據還記著它）；代碼由系統編 */
export function saveDiscount(input: DiscountInput): Promise<DiscountRule> {
  return mutate(() => {
    requireUser('admin')
    const old = input.code ? db.discounts.find((x) => x.code === input.code) : undefined
    if (input.code && !old) fail('找不到優免類別', 'NOT_FOUND')
    const e = checkDiscountRule(input)
    const name = input.name?.trim() ?? ''
    if (!e.name && db.discounts.some((d) => d.name === name && d.code !== old?.code)) e.name = '已有同名的優免類別'
    failFields(e)
    const saved: DiscountRule = {
      code: old?.code ?? `DC${String(db.discounts.length + 1).padStart(2, '0')}`,
      name,
      regMode: input.regMode,
      regAmount: input.regMode === 'amount' ? input.regAmount : 0,
      selfPayRate: input.selfPayRate,
      needsReason: !!input.needsReason,
      active: input.active !== false,
    }
    if (old) Object.assign(old, saved)
    else db.discounts.push(saved)
    audit(old ? '修改優免類別' : '新增優免類別', `${saved.code} ${saved.name}：${discountSummary(saved)}${saved.needsReason ? '（需註明原因）' : ''}${saved.active ? '' : '（停用）'}`)
    return saved
  })
}
