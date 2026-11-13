// 權限目錄（純資料與純函式）：每個受控的操作一筆。服務層把關（http.requirePermission）、權限設定畫面、說明表格都讀這一份——
// 以前「主要操作權限」是手寫的摘要，第一版就有兩處和程式不符；現在畫面上顯示的就是程式實際檢查的規則。
//
// 只開放「在規則內調整」，不做任意勾選：
//   - candidates：法規與醫療責任允許的角色（開醫囑只能是醫師——勾給櫃台會出現沒有醫師的醫囑），設定只能在這個範圍內
//   - fixed：完全不能調整（臨床操作、帳號與權限本身）
//   - grantable：除了整個角色，也可以指定給個人（主管型權限：藥劑部主管核准採購）
//   - grantOnly：只能指定給個人（優免核准：不是每個櫃台都能核准）
import type { Role } from '@/types'

export const ROLE_NAME: Record<Role, string> = { admin: '系統管理員', doctor: '醫師', nurse: '護理師', pharmacist: '藥師', clerk: '掛號批價' }

export type PermKey =
  | 'visit.register'
  | 'patient.edit'
  | 'admission.desk'
  | 'schedule.suspend'
  | 'schedule.notice'
  | 'purchase.approve'
  | 'stocktake.review'
  | 'supplier.edit'
  | 'location.edit'
  | 'transfer.warehouse'
  | 'phrase.hospital'
  | 'charge.approveDiscount'
  | 'order.write'
  | 'mar.give'
  | 'dispense'
  | 'charge.pay'
  | 'system.accounts'

export interface PermDef {
  key: PermKey
  group: '門診' | '住院' | '藥局' | '排班' | '收費' | '病歷' | '系統'
  label: string
  /** 包含哪些動作（設定畫面顯示，讓人知道勾了會影響什麼） */
  covers: string
  /** 法規與醫療責任允許的角色：設定只能在這裡面 */
  candidates: Role[]
  /** 預設（＝以前寫死在程式裡的） */
  defaults: Role[]
  fixed?: boolean
  grantable?: boolean
  grantOnly?: boolean
  /** 為什麼固定或為什麼有這個範圍 */
  note?: string
}

export const PERMISSIONS: PermDef[] = [
  { key: 'visit.register', group: '門診', label: '掛號、退掛、改期', covers: '掛號、改期、退掛、慢箋領藥登記', candidates: ['clerk', 'nurse'], defaults: ['clerk', 'nurse'], note: '小診所跟診護理師常兼掛號；大醫院可以只留給櫃台' },
  { key: 'patient.edit', group: '門診', label: '建立／修改病人資料', covers: '初診建檔、修改基本資料', candidates: ['clerk', 'doctor', 'nurse'], defaults: ['clerk', 'doctor', 'nurse'] },
  { key: 'admission.desk', group: '住院', label: '住院報到、轉床、取消預約', covers: '住院報到、轉床、取消住院預約、病床狀態', candidates: ['clerk', 'nurse'], defaults: ['clerk', 'nurse'] },
  { key: 'schedule.suspend', group: '排班', label: '停診、代診', covers: '停診（退掛並列入通知名單）、代診（系統管理頁與掛號頁）', candidates: ['admin', 'clerk'], defaults: ['admin'], grantable: true, note: '停診會一次退掉整個診次的掛號：預設只有管理員，可以指定給個人（例：櫃台組長）' },
  { key: 'schedule.notice', group: '排班', label: '記錄停診通知', covers: '標記已通知、撤銷通知紀錄', candidates: ['admin', 'clerk'], defaults: ['admin', 'clerk'] },
  { key: 'purchase.approve', group: '藥局', label: '採購單核准、退回', covers: '核准訂購、退回採購單', candidates: ['admin', 'pharmacist'], defaults: ['admin'], grantable: true, note: '開單的藥師不能核准自己開的單；常見做法是只指定給藥劑部主管' },
  { key: 'stocktake.review', group: '藥局', label: '盤點覆核', covers: '盤點單過帳、退回重盤', candidates: ['admin', 'pharmacist'], defaults: ['admin', 'pharmacist'], grantable: true, note: '清點的人不能覆核自己的盤點單（規則不變）' },
  { key: 'supplier.edit', group: '藥局', label: '供應商維護', covers: '新增、修改、停用供應商', candidates: ['admin', 'pharmacist'], defaults: ['admin', 'pharmacist'] },
  { key: 'location.edit', group: '藥局', label: '庫存地點維護', covers: '新增、改名、停用地點，改由哪個地點負責發藥／調劑／入庫', candidates: ['admin', 'pharmacist'], defaults: ['admin', 'pharmacist'], grantable: true, note: '改負責地點影響每天的發藥，常見做法是只給藥劑部主管' },
  { key: 'transfer.warehouse', group: '藥局', label: '藥庫作業（撥發、審核退回）', covers: '撥補單撥發、審核藥局的退回申請（同意、少收、不收）', candidates: ['pharmacist'], defaults: ['pharmacist'], grantable: true, note: '預設所有藥師都能做；要限定藥庫藥師：先指定給藥庫藥師個人，再把角色取消。藥局端的請領、申請退回、送出、簽收不受影響' },
  { key: 'charge.approveDiscount', group: '收費', label: '優免核准', covers: '需主管核准的優免，結帳時當場輸入帳密核准', candidates: ['clerk', 'admin'], defaults: [], grantOnly: true, note: '只能指定給個人（櫃台組長、主管）；不能核准自己結帳的' },
  { key: 'phrase.hospital', group: '病歷', label: '維護全院片語', covers: '新增、修改、刪除全院共用片語（醫師、護理師各一組，各自維護自己那組）', candidates: ['doctor', 'nurse'], defaults: [], grantOnly: true, note: '全院都在用的文字：只指定給個人（例：醫療部主任、護理部督導），其他人只能用' },
  { key: 'order.write', group: '住院', label: '開立／修改／停止醫囑、完成看診', covers: '門診完成看診（處方）、住院醫囑開立修改停止', candidates: ['doctor'], defaults: ['doctor'], fixed: true, note: '醫療紀錄要記在有執業資格的醫師名下' },
  { key: 'mar.give', group: '住院', label: '給藥', covers: '執行給藥、暫停、拒絕、補登', candidates: ['nurse'], defaults: ['nurse'], fixed: true, note: '給藥紀錄要記在執行的護理師名下' },
  { key: 'dispense', group: '藥局', label: '核對處方、發藥', covers: '門診核對、發藥、退藥', candidates: ['pharmacist'], defaults: ['pharmacist'], fixed: true, note: '藥事法：調劑由藥師執行' },
  { key: 'charge.pay', group: '收費', label: '批價收費、作廢、退費', covers: '結帳、收回欠款、作廢收據、退費', candidates: ['clerk'], defaults: ['clerk'], fixed: true, note: '收錢的人要對自己的錢箱負責；管理員不碰現金' },
  { key: 'system.accounts', group: '系統', label: '帳號與權限', covers: '新增帳號、重設密碼、權限設定', candidates: ['admin'], defaults: ['admin'], fixed: true, note: '固定給管理員：權限設定本身若能被改，管理員可能把自己鎖在門外' },
]

export const permDef = (key: PermKey): PermDef => {
  const d = PERMISSIONS.find((p) => p.key === key)
  if (!d) throw new Error(`未定義的權限：${key}`)
  return d
}

/** 目前的角色設定（沒設定＝預設；固定的一律預設） */
export const rolesOf = (def: PermDef, settings?: Partial<Record<PermKey, Role[]>>): Role[] =>
  def.fixed ? def.defaults : (settings?.[def.key] ?? def.defaults).filter((r) => def.candidates.includes(r))

/**
 * 這個人（目前的作業角色）能不能做：角色在設定裡；或被指定（grantable／grantOnly），且目前角色在法規允許的範圍內
 */
export function permits(def: PermDef, settings: Partial<Record<PermKey, Role[]>> | undefined, role: Role, grants: readonly string[] = []): boolean {
  if (rolesOf(def, settings).includes(role)) return true
  return !!(def.grantable || def.grantOnly) && grants.includes(def.key) && def.candidates.includes(role)
}

/** 改角色設定的檢查：固定的不能改、只能在法規範圍內、至少留一個角色（只指定個人的沒有角色設定） */
/**
 * 角色設定檢查。grantees＝目前被指定這項權限、帳號啟用中的人數：可指定個人的權限，角色全部取消也可以
 * （例：藥庫作業只給藥庫藥師個人），但至少要有一個人能做
 */
export function checkPermissionRoles(def: PermDef, roles: Role[], grantees = 0): string | null {
  if (def.fixed) return `「${def.label}」是固定的權限，不能調整${def.note ? `（${def.note}）` : ''}`
  if (def.grantOnly) return `「${def.label}」只能指定給個人，不能整個角色開放`
  const bad = roles.filter((r) => !def.candidates.includes(r))
  if (bad.length) return `「${def.label}」只能給 ${def.candidates.map((r) => ROLE_NAME[r]).join('、')}`
  if (!roles.length && !(def.grantable && grantees > 0)) return `「${def.label}」至少要留一個角色${def.grantable ? '，或先指定給個人' : ''}（不然沒有人能做）`
  return null
}
