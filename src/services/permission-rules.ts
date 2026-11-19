// 權限目錄（純資料與純函式）：每個受控的操作一筆。服務層把關（http.requirePermission）、權限設定畫面、說明表格都讀這一份——
// 以前「主要操作權限」是手寫的摘要，第一版就有兩處和程式不符；現在畫面上顯示的就是程式實際檢查的規則。
//
// 只開放「在規則內調整」，不做任意勾選：
//   - candidates：法規與醫療責任允許的角色（開醫囑只能是醫師——勾給櫃台會出現沒有醫師的醫囑），設定只能在這個範圍內
//   - fixed：完全不能調整（臨床操作、帳號與權限本身）
//   - grantable：除了整個角色，也可以指定給個人（主管型權限：藥劑部主管核准採購）
//   - grantOnly：只能指定給個人（優免核准：不是每個櫃台都能核准）
import type { Role } from '@/types'

export const ROLE_NAME: Record<Role, string> = { admin: '系統管理員', doctor: '醫師', nurse: '護理師', pharmacist: '藥師', clerk: '掛號批價', lab: '醫檢師', diet: '營養師', radtech: '放射師' }

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
  | 'record.copy'
  | 'report.management'
  | 'surgery.schedule'
  | 'nursing.schedule'
  | 'discharge.plan'
  | 'infection.control'
  | 'icu.attending'
  | 'anesthesia'
  | 'pathology'
  | 'rrt'
  | 'palliative'
  | 'mortality.review'
  | 'lab.limits'
  | 'incident.review'
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
  { key: 'record.copy', group: '病歷', label: '病歷影本申請', covers: '受理病歷影本申請（核對申請人、選範圍）、收費、列印與補印、當天作廢', candidates: ['clerk'], defaults: ['clerk'], grantable: true, note: '病人個資：可以只交給病歷組的櫃台人員（先指定給個人，再把角色取消）' },
  { key: 'incident.review', group: '系統', label: '病安事件審查', covers: '看全院的病安事件通報（匿名的看不到通報人）、評定嚴重度、寫原因分析與改善措施、結案、看統計', candidates: ['admin', 'nurse', 'doctor'], defaults: ['admin'], grantable: true, note: '品管審查：預設管理員，可以指定給個人（示範 nurse02 護理長）' },
  { key: 'lab.limits', group: '系統', label: '檢驗時限設定', covers: '依檢驗醫令設定急件與一般時效、危急值通報時限、不計時效（修改要寫原因、留紀錄）', candidates: ['admin', 'lab'], defaults: ['admin'], grantable: true, note: '影響檢驗科的逾時與危急值通報判斷：預設只有管理員，可以指定給檢驗科主管（示範 lab01）' },
  { key: 'report.management', group: '系統', label: '經營月報', covers: '看全院的門診人次、住院佔床、收入、藥費占比、檢驗影像量，匯出 Excel', candidates: ['admin', 'doctor', 'nurse', 'pharmacist', 'clerk'], defaults: ['admin'], grantable: true, note: '全院營運與財務數字：預設只有管理員，可以指定給院長、主任等個人' },
  { key: 'surgery.schedule', group: '住院', label: '手術排程', covers: '排手術房間與時間、改期', candidates: ['nurse', 'admin'], defaults: ['nurse'], grantable: true, note: '預設所有護理師；要只交給手術室護理長：先指定給個人，再把角色取消' },
  { key: 'nursing.schedule', group: '住院', label: '護理排班', covers: '排各病房每天三班的護理師、複製上個月', candidates: ['nurse', 'admin'], defaults: ['admin'], grantable: true, note: '交給護理長：指定給個人（示範 nurse02）；所有護理師都看得到班表' },
  { key: 'discharge.plan', group: '住院', label: '出院準備', covers: '出院準備篩選、需求評估、長照與居家轉介、出院後電話追蹤', candidates: ['nurse', 'admin'], defaults: ['nurse'], grantable: true, note: '預設所有護理師；要只交給出院準備個管師：先指定給個人（示範 nurse03），再把角色取消' },
  { key: 'icu.attending', group: '住院', label: '加護病房主治', covers: '同意或不同意轉入加護病房、排加護病房的床、看全院的轉入申請', candidates: ['doctor', 'admin'], defaults: ['admin'], grantable: true, note: '交給加護病房主治醫師：指定給個人（示範 dr03）。管理員只能看，同意要醫師' },
  { key: 'anesthesia', group: '住院', label: '麻醉', covers: '麻醉前評估（ASA、呼吸道、禁食、病史、麻醉計畫）、術中麻醉紀錄、恢復室轉出放行', candidates: ['doctor', 'admin'], defaults: ['admin'], grantable: true, note: '交給麻醉科醫師：指定給個人（示範 dr03，加護病房團隊兼麻醉）。管理員只能看，評估與紀錄要醫師' },
  { key: 'pathology', group: '住院', label: '病理', covers: '手術病理檢體收件（醫檢師，逐件核對）、發病理報告（醫師）、看全院的病理檢體與報告', candidates: ['lab', 'doctor', 'admin'], defaults: ['admin'], grantable: true, note: '沒有病理科：收件指定給醫檢師（示範 lab01）、報告指定給醫師（示範 dr10）。管理員只能看' },
  { key: 'rrt', group: '住院', label: '快速反應小組', covers: '看全院的快速反應呼叫（NEWS2 ≥7 自動、護理師手動）、到場評估（留原病房或申請轉加護病房）', candidates: ['doctor', 'admin'], defaults: ['admin'], grantable: true, note: '交給快速反應小組的醫師（多半是加護病房團隊）：指定給個人（示範 dr03）。管理員只能看，評估要醫師' },
  { key: 'palliative', group: '住院', label: '安寧共同照護', covers: '看全院的安寧照會、末期評估與收案（或婉拒）、安寧訪視（症狀評估、共照費）、家屬會議', candidates: ['doctor', 'admin'], defaults: ['admin'], grantable: true, note: '交給安寧共照醫師：指定給個人（示範 dr01 家醫科）。管理員只能看，收案、訪視要醫師' },
  { key: 'mortality.review', group: '住院', label: '死亡病例審查', covers: '看全院的死亡病例與品質指標（院內死亡率、加護病房 SMR）、審查非預期死亡、排病例討論', candidates: ['doctor', 'admin'], defaults: ['admin'], grantable: true, note: '交給醫療品質負責人：指定給個人（示範 dr02 內科主任）。管理員只能看，審查要醫師' },
  { key: 'infection.control', group: '住院', label: '感染管制', covers: '判定院內感染個案成立或不成立、看全院感染個案', candidates: ['doctor', 'nurse', 'admin'], defaults: ['admin'], grantable: true, note: '交給感染科醫師與感管護理師：指定給個人（示範 dr11 感染科）' },
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
