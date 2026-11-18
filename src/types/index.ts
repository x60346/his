// HIS 展示系統的領域型別。所有 mock 資料表與服務層都以此為契約。

/** 某天起生效的變動（藥價、醫令點數、掛號費、部分負擔）：規則見 services/dated-rules.ts */
export interface DatedChange {
  /** 這天（含）起生效 YYYY-MM-DD */
  from: string
  /** 設定的人（使用者 id）與時間 */
  by?: string
  at?: string
}

export type Gender = 'M' | 'F'
/** ER＝急診（24 小時，不排門診表；每天一個急診診次） */
export type Period = 'AM' | 'PM' | 'NIGHT' | 'ER'
export type Role = 'admin' | 'doctor' | 'nurse' | 'pharmacist' | 'clerk' | 'lab' | 'diet'

/** 系統使用者（展示用帳號，密碼明文存於 mock） */
export interface User {
  id: string
  username: string
  password: string
  name: string
  /**
   * 這個帳號可以用的角色（至少一個）。同一時間只用其中一個（作業角色，每個分頁各自記），可在右上角切換——
   * 權限、稽核都看「當下用哪個角色」，每條以角色寫的規則意思不變（例：護理師兼櫃台，新增過敏時是以哪個身分登錄）
   */
  roles: Role[]
  /** 角色含醫師時對應的醫師 id */
  doctorId?: string
  active: boolean
  /** 管理員設定的密碼（新帳號、重設）：登入後必須先改成自己的密碼，才能做其他事 */
  mustChangePassword?: boolean
  /**
   * 密碼最後變更的時間（毫秒）。比這個時間早登入的分頁一律失效——密碼外洩時改密碼，就能把別人踢出去。
   * 用毫秒不用「YYYY-MM-DD HH:mm」：同一分鐘內先登入、後改密碼的分頁也要能分出先後
   */
  passwordChangedAt?: number
  /** 這組密碼是哪天設定的（YYYY-MM-DD）：密碼期限從這天算（password-rules.passwordAge） */
  passwordSetOn?: string
  /**
   * 指定給個人的權限（permission-rules 的 PermKey；只有 grantable／grantOnly 的才能指定）：
   * 例如「優免核准」只給櫃台組長、「採購核准」只給藥劑部主管。在系統管理「權限」設定
   */
  grants?: string[]
  /** 以前用過的密碼（新到舊，最多 10 組）：改密碼時不可重複最近幾次。展示系統存明文（見 README 限制），真實系統只存雜湊 */
  passwordHistory?: string[]
}

export interface Department {
  id: string
  code: string
  name: string
  active: boolean
}

export interface Doctor {
  id: string
  name: string
  deptId: string
  title: string
  /** 醫事人員代碼（展示用） */
  licenseNo: string
  /** 管制藥品使用執照（號碼、有效期限最後一天）：沒有或過期不能開第一～三級管制藥（規則 controlled-rules.licenseProblem） */
  controlledLicense?: { no: string; validUntil: string }
  active: boolean
}

/** 就醫身分：決定掛號費與部分負擔規則 */
export interface Identity {
  code: string
  name: string
  /** 掛號費（元）：最早的值；之後的調整在 feeChanges。某天的掛號費一律用 billing.regFeeOn(身分, 日期) 查 */
  regFee: number
  /** 掛號費調整：from 這天起的掛號費（依看診日，規則見 dated-rules） */
  feeChanges?: (DatedChange & { regFee: number })[]
  /** 是否免除基本與藥品部分負擔 */
  copayExempt: boolean
  /** 是否為自費身分（不走健保） */
  selfPay: boolean
}

/**
 * 收費參數：規則（怎麼算）寫在 billing.ts 的純函式，參數（算多少）放在這裡由管理員維護。
 * 藥品部分負擔：健保藥費 ≤ drugCopayFreeUpTo 免收；超過後每 drugCopayStep 元加收 drugCopayPerStep 元，上限 drugCopayMax。
 */
/** 住院帳單的計費資訊：住院天數（入院當天算、出院當天不算，至少 1 天）、各床等天數、部分負擔分段 */
export interface IpdBillMeta {
  from: string
  to: string
  days: number
  /** waivedDays：隔離期間住單人房，差額免收的天數 */
  beds: { bedNo: string; bedClass: string; days: number; extraFee: number; waivedDays?: number }[]
  copay: { fromDay: number; toDay: number; rate: number; amount: number }[]
  /** 部分負擔超過每次住院上限，被截掉多少 */
  capped?: number
}

/** 住院部分負擔：急性病房依住院日數分段（30 日內、31–60 日、61 日起）的比率（%）與每次住院上限（元） */
export interface IpdCopaySettings {
  rates: [number, number, number]
  cap: number
}

/** 住院期中繳款提醒：住滿幾天、或還沒繳的自付金額超過多少元，任一條件成立就提醒櫃台（0＝不用這個條件） */
export interface IpdInterimSettings {
  days: number
  amount: number
}

/**
 * 住院期中繳款：住院中先繳一部分（收據號和批價同一個序號，算在繳款那天的日結）。
 * 不是分段結帳——出院結帳時算整段住院的總帳，再扣掉期中已繳的，多繳的開退款單退還
 */
export interface IpdInterimPayment {
  id: string
  receiptNo: string
  amount: number
  payMethod: PayMethod
  at: string
  cashierId: string
  /** 繳款當下的試算：截至哪天、到那天的自付累計、之前已繳多少（收據上印「截至 X 住院費用 Y 元」） */
  asOf: string
  billTotal: number
  paidBefore: number
  /** 當天收錯作廢（只限當天、還沒出院結帳扣抵）：不算日結 */
  voided?: { at: string; by: string; reason: string }
}

/** 退還期中繳款（出院結帳時多繳的差額）：依原付款方式，開退款單算在退款那天 */
export interface IpdInterimRefund {
  receiptNo: string
  amount: number
  parts: { payMethod: PayMethod; amount: number }[]
  reason: string
  cashierId: string
  at: string
}

export interface CopayValues {
  /** 門診基本部分負擔（元）：未經轉診 */
  basicCopay: number
  /** 門診基本部分負擔（元）：經轉診（持外院轉診單、或同一療程醫師約的回診） */
  basicCopayReferred: number
  /** 急診部分負擔（元）：檢傷 1、2 級 */
  erCopayUrgent: number
  /** 急診部分負擔（元）：檢傷 3–5 級 */
  erCopay: number
  drugCopayFreeUpTo: number
  drugCopayStep: number
  drugCopayPerStep: number
  drugCopayMax: number
}

/** 部分負擔參數：欄位是最早的值；之後的調整在 changes（某天起整組參數），某天的值用 billing.copayOn(設定, 日期) 查 */
export interface BillingSettings extends CopayValues {
  changes?: (DatedChange & CopayValues)[]
  /** 住院部分負擔（沒設定用 billing.IPD_COPAY_DEFAULT） */
  ipdCopay?: IpdCopaySettings
  /** 住院期中繳款提醒（沒設定用 ipd-bill.IPD_INTERIM_DEFAULT）：只是提醒、不是價格，不分生效日 */
  ipdInterim?: IpdInterimSettings
  updatedAt?: string
  updatedBy?: string
}

/** 醫師每週固定門診表（產生每日診次的範本） */
/** 門診診間（主檔）：排班只能選這裡有的、啟用中的診間——以前診間號自由輸入，打錯就多出一間不存在的診間 */
export interface Room {
  /** 診間號（建立後不可改：門診表、診次都用它對應） */
  roomNo: string
  /** 位置，例：2 樓 內科區（印在掛號單上，病人才找得到） */
  location: string
  active: boolean
}

export interface WeeklySlot {
  id: string
  doctorId: string
  /** 0 = 星期日 … 6 = 星期六 */
  weekday: number
  period: Period
  roomNo: string
  limit: number
}

/** 門診診次（某天某時段某診間的醫師班表） */
export interface ClinicSession {
  id: string
  date: string // YYYY-MM-DD
  period: Period
  deptId: string
  doctorId: string
  roomNo: string
  /** 掛號人數上限 */
  limit: number
  /** 停診：此診次不看診，原有掛號已退掛（需逐一通知病人） */
  suspended?: { reason: string; at: string; by: string }
  /** 代診：原排班醫師（doctorId 已改為代診醫師） */
  originalDoctorId?: string
  substituteReason?: string
}

export interface Patient {
  id: string
  /** 死亡（住院中宣告死亡時記下）：之後不能再掛號、預約住院 */
  deceasedAt?: string
  /** 病歷號 */
  chartNo: string
  name: string
  gender: Gender
  birthDate: string
  /** 身分證字號（展示用假資料） */
  idNo: string
  phone: string
  address: string
  bloodType: 'A' | 'B' | 'O' | 'AB' | ''
  /** 本院血庫驗過的血型（備血時驗；病人自述的 bloodType 不能拿來配血） */
  bloodTypings?: BloodTyping[]
  /** 藥物過敏 */
  allergies: string[]
  /** 家族病史 */
  familyHistory: string[]
  /** 吸菸 / 嚼檳榔，預防保健資格會用到 */
  smoking: boolean
  betelNut: boolean
  defaultIdentity: string
  emergencyContact: string
  emergencyPhone: string
  note: string
  createdAt: string
}

export type VisitStatus =
  | 'registered' // 已掛號，候診
  | 'in-consult' // 看診中
  | 'consulted' // 看診完成，待批價
  | 'charged' // 已批價，待領藥（或無藥直接結束）
  | 'dispensed' // 已領藥
  | 'cancelled' // 退掛

/** 掛號紀錄（一次門診就醫） */
export type NoShowResult = 'rebooked' | 'declined' | 'unreachable'
export interface NoShowContact {
  at: string
  by: string
  result: NoShowResult
  note?: string
  /** 已改約：新的那筆掛號 */
  rebookedVisitId?: string
}

/** 急診檢傷級數：1 復甦急救、2 危急、3 緊急、4 次緊急、5 非緊急 */
export type TriageLevel = 1 | 2 | 3 | 4 | 5

export interface TriageVitals {
  temp?: number
  pulse?: number
  resp?: number
  sbp?: number
  dbp?: number
  spo2?: number
  /** 意識（GCS 3–15） */
  gcs?: number
}

/** 急診去向：離院、收住院（連到住院預約）、轉院 */
export interface ErDisposition {
  /** obs：留觀（建一筆「留觀住院」掛在急診留觀區，admissionId；結束時再決定 ErInfo.obsEnd） */
  kind: 'home' | 'admit' | 'transfer' | 'obs'
  at: string
  by: string
  note?: string
  /** 轉院：哪一家 */
  hospital?: string
  /** 收住院：住院預約；留觀：留觀住院 */
  admissionId?: string
}

/** 結束留觀（急診醫師）：離院、收住院（同一筆住院直接轉成一般住院，不重新報到）、轉院 */
export interface ErObsEnd {
  kind: 'home' | 'admit' | 'transfer'
  at: string
  by: string
  note?: string
  hospital?: string
}

/** 急診（就醫上的急診資料）：檢傷（護理師）、重新檢傷紀錄、去向（醫師） */
export interface ErInfo {
  arrivedAt: string
  complaint: string
  vitals: TriageVitals
  /** 依主訴與生命徵象建議的級數；實際級數比建議嚴重（調升）要寫原因，不能比建議輕 */
  suggested: TriageLevel
  level: TriageLevel
  reason?: string
  triagedBy: string
  triagedAt: string
  /** 重新檢傷（等候中病情變化）：舊的留著 */
  history?: { level: TriageLevel; at: string; by: string; reason: string }[]
  disposition?: ErDisposition
  /** 留觀結束（去向是留觀才有） */
  obsEnd?: ErObsEnd
}

export interface Visit {
  id: string
  /** 急診（急診診次的就醫才有） */
  er?: ErInfo
  date: string
  sessionId: string
  deptId: string
  doctorId: string
  patientId: string
  /** 看診號 */
  seqNo: number
  identityCode: string
  /** 健保案件分類，01 西醫一般、04 慢性病、A3 預防保健… */
  caseType: string
  /** 健保卡就醫序號（模擬） */
  cardSeq: string
  status: VisitStatus
  /** 是否初診 */
  firstVisit: boolean
  /** 本次掛號附帶的預防保健項目代碼 */
  preventItems: string[]
  /** 醫師在看診時預約的回診：哪一次看診、哪位醫師、何時（櫃台掛號清單標「醫師預約」） */
  followUpOf?: { visitId: string; doctorId: string; at: string }
  /** 出院後回診：醫師在住院中（寫出院病摘時）預約的門診；出院後 30 天內第一次實際就醫的那筆，基本部分負擔比照經轉診 */
  afterDischarge?: { admissionId: string; doctorId: string; at: string }
  /**
   * 預約未到的追蹤（櫃台電話聯絡）：就醫日已過、還是已掛號就是「未到」（不改狀態，由 followup-rules.isNoShow 判斷）；
   * 這裡只記聯絡紀錄（只增不改）。最後一筆是「已改約」或「不需要」就結案；「聯絡不到」可以再聯絡
   */
  noShow?: { contacts: NoShowContact[] }
  /** 未到改約：這筆是從哪一筆未到的預約改約來的 */
  rebookedFrom?: string
  createdAt: string
  /**
   * 報到時間：病人人到了。現場掛號同時報到；事先預約的到院後由櫃台按「報到」。
   * 「下一位」只先叫已報到的；醫師要叫未報到的人須先確認（可能還沒到）
   */
  checkedInAt?: string
  calledAt?: string
  /** 過號的時間：醫師叫號時病人不在。「下一位」會先跳過他；再次叫號時清除 */
  skippedAt?: string
  /** 退掛原因（病人自行退掛時為空；停診時系統填入） */
  cancelReason?: string
  /** 停診退掛後，已電話通知病人的時間 */
  notifiedAt?: string
  /** 記錄「已通知」的人（使用者 id）；撤銷時與 notifiedAt 一起清掉，撤銷經過留在稽核紀錄 */
  notifiedBy?: string
  /**
   * 慢箋領藥：原處方的病歷 id。有這個欄位的就醫不看診——櫃台登記後直接是「已看診」，走批價、領藥；
   * 不屬於任何診次（sessionId 空白），不會出現在醫師候診清單
   */
  refillOf?: string
  /** 慢箋第幾次調劑（看診當天那次是第 1 次，所以這裡從 2 開始） */
  refillSeq?: number
  /**
   * 掛號預收款（選填）：掛號時先收，批價時扣抵、多退少補。錢屬於「這次就醫」不屬於某張收據——
   * 收據作廢或退費後預收款還在，重新批價時再扣抵；退掛、停診才退還
   */
  prepay?: VisitPrepay
  /** 外院轉入：病人持轉診單（櫃台掛號時登錄；基本部分負擔收經轉診的金額） */
  referralIn?: ReferralIn
}

/** 外院轉入的轉診單（櫃台登錄；規則見 services/referral-rules.ts） */
export interface ReferralIn {
  /** 轉出院所 */
  fromHospital: string
  /** 轉診單開單日（從這天起 90 天內有效） */
  issuedOn: string
  /** 轉診單上的診斷 */
  diagnosis: string
  /** 轉診目的（轉診單上寫的，選填） */
  purpose?: string
  /** 同一療程醫師約的回診沿用轉診身分：原本持單那次的掛號 id（沿用的不必再回覆） */
  inheritedFrom?: string
  recordedBy: string
  recordedAt: string
  /** 本院醫師給轉出院所的轉診回覆單 */
  reply?: ReferralReply
}

export interface ReferralReply {
  /** 本院診斷 */
  diagnosis: string
  /** 處置與治療經過 */
  treatment: string
  /** 建議（後續追蹤、回原院所繼續治療…） */
  advice: string
  doctorId: string
  at: string
  printed?: { at: string; by: string }[]
}

/** 轉出的轉診單（醫師在看診頁開立，病人帶到別家醫院） */
export interface ReferralOut {
  id: string
  /** 轉診單號：115 轉字第 000001 號 */
  no: string
  patientId: string
  encounterId: string
  deptId: string
  doctorId: string
  /** 看診日 */
  date: string
  /** 建議轉診院所、科別 */
  toHospital: string
  toDept: string
  /** 轉診目的（REFERRAL_PURPOSES） */
  purpose: string
  urgent: boolean
  /** 病情摘要（預設帶這次的 S／O／A，醫師可改） */
  summary: string
  /** 開立當下的快照：診斷、用藥、檢驗檢查（之後病歷改了，已印出的單不會跟著變） */
  diagnoses: string[]
  meds: string[]
  exams: string[]
  issuedAt: string
  printed?: { at: string; by: string }[]
  voided?: { at: string; by: string; reason: string }
}

export interface VisitPrepay {
  amount: number
  payMethod: PayMethod
  /** 預收收據號（和批價收據同一個序號） */
  receiptNo: string
  at: string
  cashierId: string
  /** 退還紀錄（退掛、停診、預收多於應收的差額）：每筆一張退款單 */
  refunds: { receiptNo: string; amount: number; reason: string; cashierId: string; at: string }[]
}

export interface VitalSigns {
  height?: number
  weight?: number
  temp?: number
  pulse?: number
  resp?: number
  sbp?: number
  dbp?: number
  spo2?: number
}

export interface Diagnosis {
  icd: string
  name: string
  primary: boolean
}

/** 藥品醫令 */
export interface MedicationOrder {
  drugId: string
  /** 每次劑量（以藥品單位計） */
  dose: number
  freq: string
  route: string
  days: number
  /** 總量（依 dose * 頻率次數 * 天數 自動計算，可手改） */
  qty: number
  selfPay: boolean
  note?: string
  /** 醫師為這筆處方指定的服用時機；沒有＝照藥品主檔（只存和主檔不同、而且適用的，見 drug-rules.normalizeRxTiming） */
  timing?: DrugTiming
}

/** 處置 / 檢驗 / 影像醫令 */
export interface ProcedureOrder {
  procId: string
  qty: number
  selfPay: boolean
  note?: string
  /**
   * 門診批價後標「未執行」（病人沒做就離開、證明書不需要了）：醫令照留，這是執行狀態；櫃台退差額。
   * settledAt＝已經算進部分退費（之後不能撤銷）。只有 charge.markProcedureNotDone 能設，存病歷時一律拿掉
   */
  notDone?: { reason: string; by: string; at: string; settledAt?: string }
}

export type EncounterStatus = 'draft' | 'completed'

/**
 * 醫師個人組套（常用處方）：診斷、藥品、處置，可選帶主訴與計畫文字。
 * 屬於醫師自己的設定，不是醫療紀錄——可以直接刪除（刪除寫稽核）。
 */
export interface OrderSet {
  id: string
  /** 建立的醫師；個人組套只有他看得到 */
  doctorId: string
  /** personal：醫師個人；dept：科室共用（同科在職醫師都能套用、修改、刪除） */
  scope: 'personal' | 'dept'
  /** 科室組套所屬科別（建立者當時的科別） */
  deptId?: string
  /** 最後修改的醫師（科室組套大家都能改，要看得出是誰改的） */
  updatedBy?: string
  name: string
  diagnoses: Diagnosis[]
  medications: MedicationOrder[]
  procedures: ProcedureOrder[]
  subjective?: string
  plan?: string
  createdAt: string
  updatedAt: string
}

/** 片語：醫師個人的常用文字。在病歷欄位輸入「.簡碼」再按空白鍵或 Tab 展開 */
/** 片語：個人的常用文字（醫師、護理師各自一份），屬於登入帳號 */
export interface Phrase {
  id: string
  /** 個人片語的擁有者；共用片語是建立的人（使用者帳號 id） */
  userId: string
  /** personal（預設）：本人的；dept：醫師科室共用（deptId）；ward：護理病房共用（ward）；hospital：全院共用（forRole 醫師或護理師各一組） */
  scope?: 'personal' | 'dept' | 'ward' | 'hospital'
  deptId?: string
  ward?: string
  /** 全院片語給哪一組用 */
  forRole?: 'doctor' | 'nurse'
  /** 共用片語最後修改的人（大家都能改，要看得出是誰改的） */
  updatedBy?: string
  /** 簡碼：英數字 1–10 碼，存小寫；同一個人不重複 */
  code: string
  text: string
  createdAt: string
  updatedAt: string
}

/** 門診病歷（一次看診的 SOAP 與醫令） */
export interface Encounter {
  id: string
  visitId: string
  patientId: string
  doctorId: string
  deptId: string
  date: string
  subjective: string
  objective: string
  assessment: string
  plan: string
  vitals: VitalSigns
  diagnoses: Diagnosis[]
  medications: MedicationOrder[]
  procedures: ProcedureOrder[]
  /** 慢性病連續處方箋可調劑次數，0 表示非連續處方 */
  refillTimes: number
  /** 看診時建議住院 */
  admissionRequested: boolean
  status: EncounterStatus
  completedAt?: string
  /** 完成看診時醫師確認過的交互作用、重複用藥提醒（嚴重的有原因）；藥局調劑時看得到 */
  rxAlerts?: RxAlertRecord[]
}

export interface ChargeLine {
  /** discount：優免（負數，病人自付欄） */
  kind: 'reg' | 'copay-basic' | 'copay-drug' | 'drug' | 'procedure' | 'consult' | 'self' | 'discount' | 'ward' | 'copay-ipd'
  name: string
  qty: number
  /** 單價（元或點） */
  unitPrice: number
  amount: number
  /** 是否由病患自付（否則為健保申報點數） */
  patientPay: boolean
}

export type PayMethod = 'cash' | 'card' | 'mobile'

/** 批價結帳紀錄（門診一次就醫一張；住院出院結帳一張，visitId 為空字串、記 admissionId） */
export interface Charge {
  id: string
  visitId: string
  /** 住院結帳：哪一次住院（門診收據沒有） */
  admissionId?: string
  /** 病歷影本申請的收據（沒有掛號、沒有住院；visitId 為空字串） */
  copyRequestId?: string
  /** 住院結帳的計費期間與部分負擔分段（收據、帳單顯示用；結帳時就存下，之後設定改了也不變） */
  ipd?: IpdBillMeta
  patientId: string
  lines: ChargeLine[]
  /** 健保申報點數合計 */
  nhiPoints: number
  /** 病患應付合計 */
  patientTotal: number
  payMethod: PayMethod
  received: number
  change: number
  receiptNo: string
  cashierId: string
  paidAt: string
  voided: boolean
  /** 結帳時記下的欠款（實收不足、櫃台同意）；之後收回不改這個數，看 repayments */
  owed?: number
  /** 記欠款的原因（例：忘了帶錢） */
  oweReason?: string
  /** 收回欠款紀錄：可分次，每次一張收據號，日結算在收回那天 */
  repayments?: Repayment[]
  /**
   * 退費（隔天以後、或已收回過欠款的收據不能作廢，只能退費）：這張收據照算在原本那天的日結，
   * 退款另開一張退款單、算在退款那天（負數）。有 refund 的收據 voided 也是 true（不再是這次就醫的有效收據）
   */
  refund?: Refund
  /**
   * 部分退費（部分退藥後）：收據不作廢、原本那天的帳不動；每次差額另記一筆，算在退費那天。
   * 之後全部退完再整張退費時，會扣掉這裡已經退過的
   */
  partialRefunds?: PartialRefund[]
  /** 這張收據扣抵了多少預收款：門診是掛號預收、住院是期中繳款（「本次應收」＝ patientTotal − 這個） */
  prepaidApplied?: number
  /** 優免：當時的類別、名稱、原因與減免金額（明細裡也有對應的負數列）；需主管核准的記下核准人（id 與當時的姓名） */
  discount?: { code: string; name: string; reason?: string; amount: number; approvedBy?: string; approverName?: string }
}

/**
 * 優免類別（管理員維護）：只能減掛號費與自費項目。
 * 健保部分負擔醫院不能自行減免（健保法禁止以減免部分負擔招攬病人；法定免部分負擔由「就醫身分」處理）。
 */
export interface DiscountRule {
  code: string
  name: string
  /** 掛號費：不減／全免／減固定金額 */
  regMode: 'none' | 'all' | 'amount'
  /** regMode = amount 時減多少元 */
  regAmount: number
  /** 自費項目付幾成（百分比）：80 = 8 折，100 = 不打折 */
  selfPayRate: number
  /** 需註明原因（例：專案減免） */
  needsReason: boolean
  /** 需主管核准：結帳時另一位有「可核准優免」權限的人當場輸入帳密 */
  needsApproval?: boolean
  active: boolean
}

/** 退款（一次）：病人付過的錢依原付款方式退（現金退現金、刷卡刷退） */
export interface Refund {
  /** 退款單號 RF+日期+流水號 */
  receiptNo: string
  amount: number
  parts: { payMethod: PayMethod; amount: number }[]
  reason: string
  cashierId: string
  at: string
}

/**
 * 優免送簽：需主管核准的優免，櫃台先送簽（不必請主管到櫃台），主管在自己的首頁核准或退回。
 * 核准綁「這次掛號＋這個類別＋送簽的櫃台」，當天有效，結帳時用掉（used）。和當場輸入帳密核准並存
 */
export interface DiscountRequest {
  id: string
  visitId: string
  code: string
  reason?: string
  /** 送簽時試算的減免金額（給主管看的） */
  amount: number
  cashierId: string
  requestedAt: string
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'used'
  decidedBy?: string
  decidedAt?: string
  rejectReason?: string
  usedChargeId?: string
}

/** 部分退費（一次）：病人實際拿走的藥重算後，應付減少的部分 */
export interface PartialRefund {
  /** 退款單號（有退錢或抵欠款才開；只有申報點數減少時沒有） */
  receiptNo?: string
  /** 應付減少多少（＝抵欠款＋退還的錢） */
  amount: number
  /** 先抵掉這張收據還沒收回的欠款 */
  owedOffset: number
  /** 退還的錢，依原付款方式 */
  parts: { payMethod: PayMethod; amount: number }[]
  /** 健保申報點數減少多少 */
  nhiPoints: number
  /** 退了哪些藥（當時的說明） */
  reason: string
  cashierId: string
  at: string
}

/** 收回欠款（一次） */
export interface Repayment {
  id: string
  amount: number
  payMethod: PayMethod
  receiptNo: string
  cashierId: string
  at: string
}

/** returned＝發出去又退回藥局（門診退藥：病人過敏回診、醫師改處方…）；之後櫃台才能作廢或退費 */
export type DispenseStatus = 'pending' | 'verified' | 'dispensed' | 'returned'

/** 門診藥局調劑單（批價後自動產生） */
export interface Dispense {
  id: string
  visitId: string
  encounterId: string
  patientId: string
  /** 領藥號 */
  pickupNo: number
  status: DispenseStatus
  verifiedBy?: string
  verifiedAt?: string
  dispensedBy?: string
  dispensedAt?: string
  /** 發藥時怎麼確認身分：病人說出生日（birth），或他人代領（proxy，記代領人與關係） */
  pickupCheck?: { method: 'birth' | 'proxy'; proxyName?: string; relation?: string; idNo?: string }
  /** 發藥扣庫存的那幾筆異動：退藥時退回同幾個批號（舊資料沒有，用「領藥號＋發藥日」找） */
  txnIds?: string[]
  /** 門診退藥：全部退完時記下最後一次（狀態變 returned）；每一次退藥的明細在 returns */
  returnedBy?: string
  returnedAt?: string
  returnReason?: string
  /** 退藥紀錄：可以分次、只退部分品項或數量 */
  returns?: DispenseReturn[]
  createdAt: string
}

/** 門診退藥（一次）。idx＝處方第幾項（對應病歷的 medications 與調劑單的 txnIds） */
export interface DispenseReturn {
  id: string
  at: string
  by: string
  reason: string
  /** scrap：不可再用（已拆封、汙損）——退回後直接報廢；lots：退回哪幾個批號（發出時的批號） */
  lines: { idx: number; qty: number; scrap?: boolean; lots: { lotNo: string; qty: number }[] }[]
  /** 有報廢的：覆核藥師 */
  witnessBy?: string
}

export type DrugCategory = '口服' | '外用' | '注射' | '吸入' | '眼用'

/** 服用時機：AC 飯前、PC 飯後、WITH 隨餐、EMPTY 空腹、ANY 飯前飯後皆可（說明見 drug-rules.ts 的 TIMING_LABEL） */
export type DrugTiming = 'AC' | 'PC' | 'WITH' | 'EMPTY' | 'ANY'

/** 藥價調整：from 這天（含）起的價格。健保署公告調價通常是事先公布、某日生效 */
export interface PriceChange extends DatedChange {
  nhiPrice: number
  selfPrice: number
}

/** 腎功能分級：CrCl（ml/min）低於 below 時，建議頻率改成 freq（頻率代碼；沒有＝建議停用），text 是給醫師看的建議 */
export interface RenalBand {
  below: number
  freq?: string
  text: string
}

export interface Drug {
  id: string
  /** 健保藥品代碼 */
  nhiCode: string
  name: string
  /** 中文名（通用的中文學名，印在藥袋、顯示在選單；展示用譯名，非官方核定） */
  nameZh: string
  /** 別名：只用來搜尋、不印出（大家習慣打的叫法，例：普拿疼、美福明、點滴） */
  aliases?: string[]
  generic: string
  spec: string
  unit: string
  category: DrugCategory
  /** 健保單價（點）：最早的價格；之後的調價在 priceChanges。某天的價格一律用 drugPriceOn(drug, 日期) 查 */
  nhiPrice: number
  /** 自費單價（元）：同上 */
  selfPrice: number
  /** 調價紀錄（依生效日排序）：批價依「看診日」的價格，調價前看診、調價後才批價的仍收舊價 */
  priceChanges?: PriceChange[]
  stock: number
  safetyStock: number
  defaultDose: number
  defaultFreq: string
  defaultRoute: string
  /** 是否為高警訊藥品 */
  highAlert: boolean
  /** 管制藥品級別（管制藥品管理條例第一～四級）；沒有＝非管制藥。病房點班含管制藥要雙人、報廢要覆核 */
  controlled?: 1 | 2 | 3 | 4
  /** 管制性抗生素：住院開立要填使用理由，感染科 48 小時內審核（先用後審） */
  restrictedAbx?: boolean
  /**
   * 抗生素用量統計（WHO DDD）：ddd＝WHO 每日定義劑量（克）；dddUnitG＝每一個給藥單位相當幾克（以 DDD 計算的成分，
   * 例：Augmentin 625mg 以 Amoxicillin 500 mg 計＝0.5）。兩個都有才算 DDD
   */
  ddd?: number
  dddUnitG?: number
  /** 腎功能劑量調整（依仿單簡化）：CrCl 低於門檻時建議的頻率；只提醒、不擋開立 */
  renal?: RenalBand[]
  /** 病人自控止痛（PCA）用的藥袋：一袋多少 mg、多少 ml（只能在住院醫囑「PCA」開，不能當一般醫囑或處方） */
  pca?: { totalMg: number; volumeMl: number }
  /** 急救車用藥（腎上腺素、Amiodarone）：只能在急救紀錄給（自動開臨時醫囑、扣病房常備或住院藥局） */
  crash?: boolean
  /**
   * 升壓劑（預混點滴袋）：劑量單位、每 ml 含多少（mcg 或 U）、劑量範圍、可以直接停的劑量（以下才算「調降完」）。
   * 只能在加護病房、有中心靜脈導管時，從住院醫囑「加護病房」分頁開（不能當一般醫囑）
   */
  vaso?: { unit: 'mcg/kg/min' | 'U/min'; perMl: number; bagMl: number; range: [number, number]; weanTo: number }
  /** 作用或適應症（印在藥袋，病人看得懂的白話；藥師法規定的藥袋欄位） */
  indication: string
  /** 警語或副作用（印在藥袋；藥師法規定的藥袋欄位） */
  warning: string
  /** 服用時機（口服藥必填；其他劑型沒有飯前飯後之分，一律 ANY） */
  timing: DrugTiming
  /**
   * 給藥單位（每次用多少），與調劑單位 unit（藥局發多少）不同時才填。
   * 例：Insulin 每次 10 U，但調劑 1 PEN；眼藥水每次 1 滴，調劑 1 BTL。
   * 兩者不同時，總量無法由「劑量 × 次數 × 天數」換算，需由醫師填寫。
   */
  doseUnit?: string
  active: boolean
}

export type ProcedureCategory = '診察' | '檢驗' | '影像' | '處置' | '復健'

/** 檢體容器：紫頭（EDTA，血球）、紅頭（生化）、動脈血氣體、尿杯、拭子、痰盒、培養 */
export type TubeKind = 'purple' | 'red' | 'gas' | 'urine' | 'swab' | 'sputum' | 'culture'
/**
 * 住院檢體（一支條碼）：同一位病人、同管別的檢驗醫囑合併。護理師印條碼 → 採檢（掃條碼或勾選）→ 檢驗科收件後才能發報告；
 * 退件（溶血、量不足…）＝那幾筆醫囑回到待採檢
 */
export interface Specimen {
  id: string
  barcode: string
  /** 住院檢體才有；門診的是 opdKeys */
  admissionId?: string
  patientId: string
  tube: TubeKind
  orderIds: string[]
  /** 門診檢體：裡面的檢驗（E:看診id:醫令id） */
  opdKeys?: string[]
  /** 病人自行收集（尿液、痰液）：printedAt＝發容器、collectedAt＝病人交回 */
  selfCollect?: boolean
  createdAt: string
  printedAt?: string
  printedBy?: string
  collectedAt?: string
  collectedBy?: string
  receivedAt?: string
  receivedBy?: string
  rejected?: { at: string; by: string; reason: string }
}

/** 影像檢查室：X 光室、電腦斷層室、超音波室、心電圖室 */
export type ExamRoom = 'XR' | 'CT' | 'US' | 'ECG'
/**
 * 影像檢查（排程與執行）：一筆待做的影像（門診 E:看診:醫令、住院 O:醫囑）排到檢查室與時間 → 報到 → 完成（住院醫囑一起完成），
 * 完成後才進判讀清單
 */
export interface ImagingExam {
  id: string
  key: string
  patientId: string
  procId: string
  admissionId?: string
  orderId?: string
  room: ExamRoom
  start: string
  minutes: number
  scheduledBy: string
  scheduledAt: string
  arrivedAt?: string
  arrivedBy?: string
  doneAt?: string
  doneBy?: string
  /** 檢查前準備的確認（報到時逐項）：ok＝完成；沒完成的寫原因（例：早上吃過早餐） */
  prep?: Record<string, { ok: boolean; at: string; by: string; note?: string }>
  /** 取消（寫原因）：影像回到待排程 */
  cancelled?: { at: string; by: string; reason: string }
}

/** 自動審核沒通過的規則：品管沒過、危急值、和上次差太多（delta check）、超出儀器可測範圍 */
export interface AutoVerifyHold {
  rule: 'qc' | 'critical' | 'delta' | 'amr'
  code?: string
  text: string
}

/** 檢驗儀器上機結果（自動傳輸）：通過自動審核直接發報告（auto）；沒過的等醫檢師審核（held → released） */
export interface AnalyzerResult {
  id: string
  /** 待檢驗的 key（E:看診:醫令／O:醫囑） */
  key: string
  barcode: string
  patientId: string
  procId: string
  values: Record<string, string>
  holds: AutoVerifyHold[]
  status: 'auto' | 'held' | 'released'
  loadedAt: string
  loadedBy: string
  /** 重測：之前的數值（舊到新） */
  reruns?: { at: string; values: Record<string, string> }[]
  reportId?: string
  releasedAt?: string
  releasedBy?: string
}

/** 門診抽血櫃台報到（一天一位病人一號） */
export interface LabCheckin {
  id: string
  no: number
  patientId: string
  date: string
  at: string
  by: string
}

export interface Procedure {
  id: string
  code: string
  name: string
  category: ProcedureCategory
  /** 健保點數：最早的值；之後的調整在 priceChanges。某天的點數一律用 billing.procPriceOn(醫令, 日期) 查 */
  points: number
  /** 自費價（元） */
  selfPrice: number
  /** 點數／自費價調整：from 這天起（依看診日，規則見 dated-rules） */
  priceChanges?: (DatedChange & { points: number; selfPrice: number })[]
  /** 檢驗醫令包含哪些檢驗值（CBC＝WBC、Hb、PLT）：報告逐項登打，依參考範圍、危急值判讀 */
  labItems?: LabItemDef[]
  /** 檢體容器（試管別）：同一位病人同管別的檢驗合併成一支條碼 */
  tube?: TubeKind
  /** 住院每日計費的項目（病房費、護理費、住院診察費）：出院結帳依住院天數自動帶入，門診與醫囑都不能開 */
  dailyFee?: boolean
  /** 每日計費依病床：generalBed 一般病床的病房費、護理費（住加護病房的那幾天不收）；icu 加護病床的（只收住加護病房的那幾天）。都沒標的（住院診察費）每天都收 */
  generalBed?: boolean
  icu?: boolean
  /** 急救計費項目（心肺復甦術）：急救紀錄開始 CPR 時自動開，醫囑不能另外開 */
  codeBlue?: boolean
  /** 安寧共同照護費：安寧訪視時自動開，醫囑不能另外開 */
  palliative?: boolean
  /** 輸血計費項目（交叉試驗、各種血品）：住院帳單依血庫紀錄自動帶入，門診與醫囑都不能開 */
  blood?: BloodProduct | 'crossmatch'
  /** 病歷影本計費項目（基本費、每頁）：申請時自動帶入，門診與醫囑都不能開 */
  recordCopy?: 'base' | 'page'
  /** 手術術式：預估時間（分鐘）；做完的手術依手術室紀錄列入住院帳單，門診與醫囑都不能開 */
  surgery?: { minutes: number }
  /** 急診計費：診察費（取代門診診察費）、觀察床費（每 6 小時）；急診就醫依紀錄自動帶入，門診與醫囑都不能開 */
  er?: 'consult' | 'obs'
  /** 伙食費（每日，自費）：哪幾種飲食用這個價格；住院帳單依每天的飲食醫囑自動帶入（禁食不收），門診與醫囑都不能開 */
  meal?: DietKind[]
  /** 麻醉費：哪一種麻醉（手術做完依麻醉方式帶入；局部麻醉不另收） */
  anesthesiaFee?: AnesthesiaType
  /** 影像檢查：誰判讀（radiology＝放射科醫師；orderer＝開立醫師自己，例：心電圖）與正常報告範本 */
  imaging?: {
    reader: 'radiology' | 'orderer'
    normal: { findings: string; impression: string }
    room?: ExamRoom
    minutes?: number
    /** 檢查前準備（報到時逐項確認，沒完成不能做）：例 禁食 6 小時、顯影劑同意書、腎功能 */
    prep?: { id: string; label: string }[]
    /** 打顯影劑：腎功能（CrCl）把關 */
    contrast?: boolean
  }
  active: boolean
}

/**
 * 影像檢查報告（判讀醫師寫「所見」與「結論」）。來源同檢驗：門診看診的醫令（encounterId＋procId）或住院臨時醫囑（orderId）。
 * 發出後不能改原文，只能加「補充報告」（addenda）——醫師可能已依原報告處置
 */
export interface ImagingReport {
  id: string
  /** 報告單號 */
  no: string
  patientId: string
  procId: string
  encounterId?: string
  orderId?: string
  admissionId?: string
  /** 開立醫師 */
  doctorId: string
  orderedAt: string
  findings: string
  impression: string
  /** 重要發現（例：氣胸、腦出血）：要開立醫師（住院含主治）確認，比照檢驗危急值 */
  significant?: boolean
  /** 判讀醫師（醫師 id） */
  readerId: string
  reportedAt: string
  addenda?: { at: string; by: string; text: string; significant?: boolean }[]
  ackBy?: string
  ackAt?: string
}

/**
 * 一個檢驗值的定義。數值型：參考範圍（含端點；女性不同時另設 lowF／highF）、危急值；
 * 文字型：可選的結果（options）與哪些算正常（normal）。判讀規則見 lab-rules
 */
export interface LabItemDef {
  code: string
  name: string
  unit?: string
  low?: number
  high?: number
  lowF?: number
  highF?: number
  /** 危急值：低於 critLow 或高於 critHigh（要立刻通知醫師） */
  critLow?: number
  critHigh?: number
  options?: string[]
  normal?: string[]
}

/** H 偏高、L 偏低、A 異常（文字型）、'' 正常 */
export type LabFlag = '' | 'H' | 'L' | 'A'

/** 報告上的一個檢驗值：單位與參考範圍在發報告時一起存下（主檔日後改範圍，舊報告不會跟著變） */
export interface LabValue {
  code: string
  name: string
  unit?: string
  /** 參考範圍文字（例：4.0–10.0、陰性） */
  ref: string
  value: string
  flag: LabFlag
  critical?: boolean
}

/**
 * 檢驗報告（醫檢師發出）。來源：門診看診的檢驗醫令（encounterId＋procId），或住院臨時醫囑（orderId）。
 * 還沒發的不存：待檢驗清單由醫令推算（見 lab.listLabWork）
 */
/** 細菌培養：檢體、藥敏結果（S 敏感、I 中等、R 抗藥） */
export type CultureSpecimen = 'urine' | 'blood' | 'sputum' | 'wound'
export type SirResult = 'S' | 'I' | 'R'
export interface CultureIsolate {
  /** 菌種主檔 id（culture-rules.ORGANISMS） */
  organism: string
  /** 抗生素藥敏（culture-rules.AST_DRUGS 的 key → S/I/R） */
  ast: Record<string, SirResult>
}

export interface LabReport {
  id: string
  /** 細菌培養（P059）的結構化結果：檢體、長出的菌與各自的藥敏；沒長菌＝isolates 空的 */
  culture?: { specimen: CultureSpecimen; isolates: CultureIsolate[] }
  /** 檢驗單號 */
  no: string
  patientId: string
  procId: string
  encounterId?: string
  orderId?: string
  admissionId?: string
  /** 開立醫師 */
  doctorId: string
  orderedAt: string
  values: LabValue[]
  reportedBy: string
  reportedAt: string
  /** 更正（發出後改值）：寫原因、留舊值；更正後要醫師重新確認 */
  corrections?: { at: string; by: string; reason: string; before: LabValue[] }[]
  /** 儀器自動傳輸、通過自動審核直接發出（沒有人工審核） */
  autoVerified?: boolean
  /** 危急值通報（醫檢師打電話）：通報給誰（姓名、職稱）、對方複誦確認、時間。和醫師「已知悉」分開，兩個都要有 */
  callout?: { at: string; by: string; to: string; toRole: 'nurse' | 'doctor'; readBack: true; note?: string }
  /** 醫師確認（有危急值或更正過的才需要）：沒有＝待確認 */
  ackBy?: string
  ackAt?: string
}

export interface IcdCode {
  code: string
  name: string
  nameEn: string
  /** 停用後不能再用於新診斷（舊病歷照常顯示）；未設定視為啟用 */
  active?: boolean
}

export interface Frequency {
  code: string
  label: string
  /** 每日次數；PRN 以 1 計 */
  timesPerDay: number
  /** 住院給藥時間點（HH:mm） */
  times: string[]
}

export type BedStatus = 'empty' | 'occupied' | 'reserved' | 'cleaning'

export interface Bed {
  id: string
  ward: string
  roomNo: string
  bedNo: string
  /** 健保床 / 差額床 */
  bedClass: '健保床' | '雙人房' | '單人房'
  /** 差額費（元/日） */
  extraFee: number
  status: BedStatus
  admissionId?: string
  /** 保留給哪一筆住院預約（保留一定要指定病人；那位病人報到時可以直接選這床） */
  reservedFor?: string
  /** 負壓隔離室：空氣隔離優先排這裡；護理師每班記錄壓差 */
  negativePressure?: boolean
}

/** 群聚判定（感染管制）：key＝病房｜菌種或部位｜最早一例；確認要寫處置、排除要寫原因 */
export interface ClusterDecision {
  key: string
  status: 'confirmed' | 'excluded'
  note: string
  by: string
  at: string
}
/** 法定傳染病通報（模擬：單號系統產生，不連線疾管署） */
export interface NotifiableReport {
  id: string
  patientId: string
  admissionId?: string
  disease: string
  label: string
  /** 從什麼時候起算（開隔離或住院診斷） */
  triggeredAt: string
  dueAt: string
  reportedAt: string
  reportedBy: string
  cdcNo: string
  note?: string
}

/** 負壓隔離室壓差紀錄（每班至少一次；Pa，負值；高於 −2.5 是負壓不足，要寫處理） */
export interface PressureLog {
  id: string
  bedId: string
  at: string
  pa: number
  by: string
  note?: string
}

export type AdmissionStatus = 'reserved' | 'admitted' | 'discharged' | 'cancelled'

/** 入院用藥整合 */
export interface MedRec {
  items: HomeMed[]
  builtBy: string
  builtAt: string
  /** 每一項都決定了（沒有居家用藥的，建立時就完成） */
  completedAt?: string
  completedBy?: string
}
/** 居家用藥一項：院內門診處方帶入的（有 drugId），或院外的藥（手打名稱，可能沒有對應主檔） */
export interface HomeMed {
  id: string
  drugId?: string
  name: string
  dose?: number
  freq?: string
  route?: string
  source: 'opd' | 'outside'
  /** 院內門診：最近一次開的日期 */
  lastDate?: string
  decision?: 'continue' | 'hold' | 'change'
  reason?: string
  /** 續用：連到的住院醫囑（同一個藥、執行中） */
  orderId?: string
  decidedBy?: string
  decidedAt?: string
}

export interface Admission {
  id: string
  /** 住院號 */
  admitNo: string
  patientId: string
  fromVisitId?: string
  deptId: string
  doctorId: string
  bedId?: string
  /** 出院帶藥已調劑（住院藥局，扣帳異動單號「出院帶藥 住院號」）；退回後清掉（退回異動「出院帶藥退回 住院號」） */
  dischargeRx?: { dispensedBy: string; dispensedAt: string; txnIds: string[] }
  /** 床位紀錄（報到、轉床、轉科換床各記一筆）：差額床費依住了幾天算。舊資料沒有，視為整段住目前的床 */
  bedHistory?: { bedId: string; from: string }[]
  /** 鎮靜目標（RASS 範圍，加護病房主治設定）：護理師每 4 小時評，超出範圍列主治首頁 */
  rassTarget?: { min: number; max: number; by: string; at: string }
  /** APACHE II 要手動填的（醫師）：嚴重慢性病（器官衰竭或免疫抑制）、這次是不是手術後（急診／常規手術） */
  apache?: { chronic: boolean; surgery: 'none' | 'emergency' | 'elective'; by: string; at: string; /** 預估死亡率用的診斷類別（mortality-rules.APACHE_CATEGORIES） */ category?: string }
  /** 死亡病例審查（權限 mortality.review）：結論、檢討、改善事項；需提病例討論的排日期與報告人 */
  mortalityReview?: { grade: 'unavoidable' | 'possibly' | 'avoidable' | 'discuss'; findings: string; improvement?: string; conference?: { date: string; presenter: string }; by: string; at: string }
  /**
   * 急診留觀：特別的住院（急診科、急診醫師、急診留觀區的床），沿用住院醫囑、給藥、生命徵象、護理紀錄、腕帶。
   * endAt＝急診醫師結束留觀；outcome admit＝同一筆轉成一般住院（科別、主治改掉，住院號與腕帶不變），帳單從 endAt 起算住院
   */
  obs?: { visitId: string; endAt?: string; outcome?: ErObsEnd['kind'] }
  /** 死亡：宣告（醫師）→ 遺體護理檢核（護理師）→ 死亡證明書 → 送太平間（出院，床位釋放；帳單之後由家屬結） */
  death?: DeathRecord
  /** 預約希望床等 */
  preferBedClass: Bed['bedClass']
  reason: string
  diagnosis: string
  status: AdmissionStatus
  reservedAt: string
  expectedDate: string
  admittedAt?: string
  dischargedAt?: string
  /**
   * 出院病摘：由醫師撰寫。簽署（signedAt）＝准予出院，住院中心才能辦理出院；
   * 出院前醫師可取消（signedAt 清掉，內容留著當草稿）。
   */
  dischargeSummary?: DischargeSummary
  /** 入院用藥整合：護理師或藥師建居家用藥清單，醫師逐項決定續用、暫停或改藥 */
  medRec?: MedRec
  /** 出院轉歸：辦理出院時從醫師簽署的病摘帶入 */
  dischargeType?: string
  /**
   * 主治醫師變更紀錄（只增不改）：醫師離職、休假交班時由住院中心變更。
   * 選用欄位：舊資料沒有它表示從未變更。已開立的醫囑不受影響——醫囑記的是「當時誰開的」。
   */
  attendingHistory?: { from: string; to: string; at: string; by: string; reason: string }[]
  /** 轉科紀錄（只增不改）：原科申請 → 新科接受／婉拒，或原科撤回。同一時間最多一筆 pending */
  deptTransfers?: DeptTransfer[]
  /** 腕帶：報到時印第一條；遺失、弄濕重印要寫原因。條碼＝住院號（每次住院換新，舊腕帶掃了會被擋） */
  wristband?: { printedAt: string; printedBy: string; reprints: { at: string; by: string; reason: string }[] }
  /** 期中繳款（只增不刪；作廢的標 voided） */
  interim?: IpdInterimPayment[]
  /** 退還期中繳款（出院結帳時多繳的） */
  interimRefunds?: IpdInterimRefund[]
}

/**
 * 轉科：原科主治申請（目標科別，可指定接手醫師）→ 新科醫師接受（成為主治；逐筆決定醫囑延續或停止；可一併轉床）或婉拒。
 * 申請期間病人仍歸原科：不能變更主治、不能簽准予出院
 */
export interface DeptTransfer {
  id: string
  fromDeptId: string
  fromDoctorId: string
  toDeptId: string
  /** 指定接手的醫師；沒指定＝新科任一位醫師都能接 */
  toDoctorId?: string
  reason: string
  requestedBy: string
  requestedAt: string
  status: 'pending' | 'accepted' | 'declined' | 'cancelled'
  decidedBy?: string
  decidedAt?: string
  /** 婉拒、撤回的原因 */
  decisionNote?: string
  /** 接受時：成為主治的醫師、停止了哪些醫囑、從哪床轉到哪床（沒轉床就沒有） */
  acceptedDoctorId?: string
  stoppedOrderIds?: string[]
  fromBedId?: string
  toBedId?: string
  /** 轉出摘要（申請時原科寫，必填）：新科決定接不接之前就看得到；也寫進病程紀錄 */
  summary?: { course: string; problems: string; pending?: string }
  /** 接收評估（新科接受時寫，必填）：也寫進病程紀錄 */
  acceptNote?: string
  /** 依哪一張會診單的建議申請的 */
  consultId?: string
}

/**
 * 住院會診單：主治請別科「來看看」——多數只是要建議，不一定轉科。
 * 會診醫師看的是會診單附上的病人摘要（不是整份病歷）；回覆可以「建議轉本科」，原科一鍵帶入轉科申請
 */
export interface Consult {
  id: string
  /** 住院會診：哪一次住院；門診會診：哪一次掛號（visitId）。兩者擇一 */
  admissionId?: string
  visitId?: string
  fromDeptId: string
  /** 申請的醫師 */
  fromDoctorId: string
  toDeptId: string
  /** 指定會診醫師；沒指定＝該科任一位醫師都能回覆 */
  toDoctorId?: string
  /** 會診目的 */
  question: string
  urgent: boolean
  requestedAt: string
  status: 'pending' | 'answered' | 'cancelled'
  answeredBy?: string
  answeredAt?: string
  /** 評估（所見） */
  findings?: string
  /** 建議 */
  recommendation?: string
  /** 會診醫師建議轉入本科（住院） */
  suggestTransfer?: boolean
  /** 會診醫師建議病人掛本科門診（門診會診：書面會診，要當面看診再另外掛號） */
  suggestVisit?: boolean
  /** 門診會診：申請的醫師看過回覆（首頁待辦「會診已回覆」消失） */
  replySeenAt?: string
  cancelledAt?: string
  cancelReason?: string
}

/** 出院病摘 */
export interface DischargeSummary {
  /** 出院診斷（預設帶入院診斷，醫師可改） */
  diagnosis: string
  /** 住院經過 */
  course: string
  /** 出院時狀況 */
  condition: string
  /** 出院後追蹤、注意事項 */
  followUp: string
  /** 出院轉歸：治癒出院、轉院、自動出院… */
  dischargeType: string
  /** 最後撰寫（儲存）的醫師 */
  doctorId: string
  writtenAt: string
  /** 簽署時間＝准予出院；沒有就是草稿 */
  signedAt?: string
  /** 出院帶藥（帶回家吃的藥）：簽署時一起確認，住院藥局調劑扣帳後列入住院帳單。selfPay 不用（依病人身分） */
  meds?: MedicationOrder[]
  /** 慢性病：出院帶藥天數上限 30 天（一般 7 天，規則 dose-rules.dischargeRxDaysProblem） */
  chronicRx?: boolean
  /** 出院用藥整合：每一項居家用藥（HomeMed.id）出院後恢復或停用（停用要原因） */
  homeMedPlan?: Record<string, { resume: boolean; reason?: string }>
}

export type IpdOrderCategory = 'medication' | 'nursing' | 'diet' | 'procedure'

/** 飲食種類：普通、軟質、流質、糖尿病、低鹽、禁食 */
export type DietKind = 'regular' | 'soft' | 'liquid' | 'diabetic' | 'low-salt' | 'npo' | 'tube'

/** 管灌配方（主檔）：每 ml 熱量、每 ml 蛋白質 g */
export interface TubeFormula {
  id: string
  name: string
  kind: '均衡' | '糖尿病' | '高蛋白' | '元素型'
  kcalPerMl: number
  proteinPerMl: number
  active: boolean
}

/** 管灌內容：配方、每天總量；分次（bolus，一天幾餐）或連續（continuous，每小時 ml） */
export interface TubeFeedPlan {
  formulaId: string
  totalMl: number
  mode: 'bolus' | 'continuous'
  feeds?: number
  rateMlH?: number
}

/** 管灌紀錄（護理師）：灌入量、反抽量（殘餘量）；反抽 >200 ml 標「反抽過多」（提醒暫停並通知醫師，不擋） */
export interface TubeFeedRecord {
  id: string
  admissionId: string
  orderId: string
  /** 分次：這一餐預定時間；連續：這一班開始時間 */
  slot: string
  at: string
  by: string
  givenMl: number
  residualMl?: number
  /** 沒灌（反抽過多暫停、病人外出檢查…）：原因 */
  heldReason?: string
  note?: string
}

/**
 * 營養篩檢（護理師，入院 48 小時內；簡化 NRS-2002）：營養狀態受損 0–3、疾病嚴重度 0–3、70 歲以上加 1。
 * ≥3 分有營養風險 → 營養師待評估
 */
export interface NutritionScreen {
  id: string
  admissionId: string
  at: string
  by: string
  impaired: 0 | 1 | 2 | 3
  severity: 0 | 1 | 2 | 3
  age70: boolean
  score: number
  /** 身高體重（選填，算 BMI） */
  heightCm?: number
  weightKg?: number
}

/** 營養評估（營養師）：評估與建議（不開醫囑，由主治決定）；主治按已閱 */
export interface NutritionAssessment {
  id: string
  admissionId: string
  at: string
  by: string
  /** 每日建議熱量（kcal）與蛋白質（g） */
  kcal?: number
  protein?: number
  assessment: string
  recommendation: string
  /** 管灌建議（營養師）：主治可以一鍵帶入成管灌醫囑（仍由醫師開） */
  tube?: TubeFeedPlan
  /** 帶入後的醫囑 */
  tubeOrderId?: string
  seenBy?: string
  seenAt?: string
}

/** 住院醫囑 */
export interface IpdOrder {
  id: string
  admissionId: string
  /** 飲食醫囑：種類＋備註（content 是給人看的「糖尿病飲食・1800 kcal」）；舊資料沒有，依 content 推斷 */
  diet?: { kind: DietKind; note?: string; tube?: TubeFeedPlan }
  /** 點滴（連續輸注）：每瓶容量、每小時流速、加藥（例：KCl）；不排給藥時間，由護理師接上、換瓶、停止 */
  infusion?: {
    volumeMl: number
    rateMlH: number
    additives?: { drugId: string; dose: number }[]
    /** 升壓劑：起始劑量、上限（護理師依血壓在範圍內調流速）、開立時的體重；流速由劑量換算 */
    vaso?: { dose: number; max: number; weightKg: number; target: string }
  }
  /** 停止原因（升壓劑沒有逐步調降就直接停，要寫） */
  stopReason?: string
  /** 呼吸器醫囑（長期、護理類）：模式與設定；改設定＝停掉舊的、開新的（changeReason 寫為什麼改） */
  vent?: VentSetting
  /** 急救時自動開的（急救藥、CPR 處置費）：口頭醫囑記在帶領醫師名下，執行完成 */
  codeBlueId?: string
  /** 隔離連動開的（哪一筆隔離、建議清單的哪一項） */
  isolationId?: string
  isoKey?: string
  /** 長期 / 臨時（STAT / 單次） */
  type: 'long' | 'stat'
  category: IpdOrderCategory
  drugId?: string
  procId?: string
  /** 醫囑內容（護理、飲食醫囑的文字或藥品顯示名） */
  content: string
  dose?: number
  freq?: string
  route?: string
  /**
   * 服用時機：開立時就把「當時的有效時機」存在醫囑上（給藥排程依它排時間）。
   * 不跟著主檔變：主檔改了，已排的 07:00 和新算的 08:00 會同時存在，病人多一劑。要改時機就停掉重開
   */
  timing?: DrugTiming
  /** 時機是醫師指定的（不是照主檔）：藥局、護理站標「醫師指定」 */
  timingSet?: boolean
  startAt: string
  stopAt?: string
  status: 'active' | 'stopped' | 'done'
  doctorId: string
  createdAt: string
  /** 護理師核對（簽收）新醫囑的時間與人：沒核對前，病人清單會一直標「新醫囑」 */
  ackAt?: string
  ackBy?: string
  /** 護理師確認「已停止」的時間與人：醫囑停了也要讓執行的人知道 */
  stopAckAt?: string
  stopAckBy?: string
  /**
   * 護理師的疑問（可多輪）：「有疑問、退回醫師」。最後一筆沒有 replyAt 就是「待醫師回覆」——
   * 這段期間不能核對、給藥暫停（緊急時可寫原因強制給藥）。醫師回覆「確認無誤」或停止這筆醫囑後解除
   */
  queries?: OrderQuery[]
  /**
   * 修改（reviseOrder）：資料上仍是「停止舊的＋開新的」兩筆，互相標記。已給的藥掛在舊醫囑上，
   * 直接改舊醫囑的劑量會讓以前的給藥紀錄看起來像照新劑量給的
   */
  replaces?: string
  replacedBy?: string
  /** 修改原因（新醫囑上） */
  reviseReason?: string
  /** 開立時醫師確認過的交互作用、重複用藥提醒（嚴重的有原因）；修改醫囑沿用 */
  rxAlerts?: RxAlertRecord[]
  /** 會診醫師開的（哪一張會診單）：主治要按「已閱」 */
  consultId?: string
  consultSeenAt?: string
  consultSeenBy?: string
  /** 管制性抗生素的使用申請與感染科審核（修改醫囑沿用：療程、審核結果都跟著走） */
  abx?: AbxRequest
  /**
   * 藥師審核（給藥醫囑）：開立、修改後待審；長期排程的藥審核通過才能每日調劑，臨時與需要時先給後審。
   * 沒有這個欄位＝功能上線前開的醫囑（視同已審）
   */
  pharm?: PharmReview
  /** 病人有過敏紀錄、醫師確認仍要開的過敏原（藥師審核看得到） */
  allergyOverride?: string[]
  /** 長期檢驗醫囑的排程（每日 06:00…）：每一次到期產生一筆臨時檢驗醫囑（parentOrderId 指回來），走檢體條碼與報告 */
  labSchedule?: { every: 'daily' | 'qod' | 'mwf' | 'weekly'; time: string }
  /** 由長期檢驗醫囑產生的那一次採檢 */
  parentOrderId?: string
}

/** 檢驗品管一次（一個項目、兩個濃度）：Westgard 判定；拒絕後重做要寫矯正措施 */
export interface QcRun {
  id: string
  analyte: string
  date: string
  at: string
  by: string
  values: [number, number]
  z: [number, number]
  result: 'accept' | 'warn' | 'reject'
  rules: string[]
  correction?: string
}

export type PharmCareKind = 'dose' | 'monitor' | 'interaction' | 'deprescribe' | 'other'
/** 藥事照護紀錄（臨床藥師查房）：對病人（不綁某一筆醫囑）的建議，主治接受或不接受（寫原因） */
export interface PharmCareNote {
  id: string
  admissionId: string
  patientId: string
  kind: PharmCareKind
  text: string
  by: string
  at: string
  status: 'sent' | 'accepted' | 'declined'
  reply?: { by: string; at: string; text: string }
}

export type AdrSeverity = 'mild' | 'moderate' | 'severe'
/**
 * 藥物不良反應通報（住院）：醫師、護理師通報懷疑的藥（這次住院給過的）；藥師用 Naranjo 量表評估因果，
 * 很可能以上可勾選加入病人的過敏紀錄
 */
export interface AdrReport {
  id: string
  admissionId: string
  patientId: string
  drugId: string
  onsetAt: string
  symptoms: string
  severity: AdrSeverity
  /** 嚴重型：過敏性休克、SJS／TEN（24 小時內要評估） */
  serious?: 'anaphylaxis' | 'sjs'
  /** 處置（停藥、給藥…） */
  action: string
  reportedBy: string
  reportedAt: string
  /** 藥師評估：Naranjo 10 題、分數、判定、說明；加入過敏的話記下過敏原 */
  assessment?: { by: string; at: string; answers: ('yes' | 'no' | 'unknown')[]; score: number; causality: 'definite' | 'probable' | 'possible' | 'doubtful'; note: string; allergyAdded?: string }
}

/** 藥師審核：pending 待審、approved 通過、query 疑義待醫師回覆（回覆「維持原醫囑」後回到待審） */
export interface PharmReview {
  status: 'pending' | 'approved' | 'query'
  /** 送審（開立或修改）時間 */
  at: string
  by?: string
  doneAt?: string
  note?: string
  queries?: PharmQuery[]
}
export interface PharmQuery {
  by: string
  at: string
  text: string
  replyBy?: string
  replyAt?: string
  reply?: string
  /** kept＝醫師寫理由維持原醫囑；modified＝修改（新醫囑重新送審）；stopped＝停止 */
  resolution?: 'kept' | 'modified' | 'stopped'
}

/** 管制性抗生素的使用理由：經驗性治療、依培養結果（要寫菌種）、手術預防 */
export type AbxReason = 'empiric' | 'culture' | 'prophylaxis'
export type AbxStatus = 'pending' | 'approved' | 'rejected'
/** 送審與審核的每一步：開立、核准、不核准、申覆、續用申請 */
export interface AbxStep {
  action: 'request' | 'approve' | 'reject' | 'appeal' | 'extend'
  at: string
  by: string
  text: string
  /** 核准：核准到療程第幾天 */
  days?: number
}
export interface AbxRequest {
  reason: AbxReason
  /** 感染部位 */
  site: string
  /** 依培養結果時的菌種 */
  organism?: string
  note?: string
  /** 療程第一天（第一張醫囑開始的時間；修改劑量後的新醫囑沿用，天數接著算） */
  courseStart: string
  status: AbxStatus
  /** 最近一次送審（開立、申覆、續用申請）：48 小時內要審 */
  requestedAt: string
  /** 核准到療程第幾天（核准過才有；續用申請審核中仍保留上次的） */
  approvedDays?: number
  steps: AbxStep[]
}

/**
 * 抗生素管理的建議類型（每日審視，系統依規則標出）：藥敏無效、抗菌範圍重疊、腎功能需調整、預防用藥超過 24 小時、可降階、可改口服、療程超過 7 天
 */
export type AbxAdviceKind = 'ineffective' | 'overlap' | 'renal' | 'prophylaxis' | 'deescalate' | 'ivpo' | 'duration'
/**
 * 抗生素管理介入（感染科每日審視）：對某一筆抗生素醫囑的某一類建議，發出建議或標「不用介入」。
 * 主治停止或修改這筆醫囑＝接受（系統自動記）；不接受要寫原因
 */
export interface AbxIntervention {
  id: string
  admissionId: string
  orderId: string
  drugId: string
  kind: AbxAdviceKind
  /** 發出當時系統標的那一句（之後規則結果變了，這裡留當時的） */
  finding: string
  /** sent 待主治回覆、accepted 已接受（主治停止或修改了醫囑）、declined 主治不接受、dismissed 審視者標「不用介入」 */
  status: 'sent' | 'accepted' | 'declined' | 'dismissed'
  by: string
  at: string
  /** 審視者的說明（發出建議：給主治的建議；不用介入：理由） */
  note: string
  /** 主治的回覆：接受（停止／修改醫囑，自動寫）或不接受（原因） */
  reply?: { by: string; at: string; text: string }
}

export interface OrderQuery {
  by: string
  at: string
  reason: string
  replyBy?: string
  replyAt?: string
  reply?: string
  /** confirmed＝醫師確認原醫囑無誤（寫說明）；stopped＝醫師停止這筆醫囑（通常會另開正確的）；modified＝醫師直接修改（舊的停止、新的接手） */
  resolution?: 'confirmed' | 'stopped' | 'modified'
}

/** 病房常備品項與基準量（藥師維護，藥劑部與護理部協議的清單）：低於基準量就補 */
export interface WardStockItem {
  ward: string
  drugId: string
  par: number
}

/** 病房點班（每班一次）：逐項實點，差異寫原因、自動調帳 */
export interface WardCount {
  id: string
  ward: string
  shift: '白班' | '小夜' | '大夜'
  /** 這一班的日期（小夜跨午夜寫的算前一天） */
  date: string
  countedBy: string
  /** 管制藥點班的見證護理師 */
  witnessBy?: string
  at: string
  lines: { drugId: string; book: number; counted: number; reason?: string }[]
}

/** 給藥紀錄（MAR） */
export interface MarRecord {
  id: string
  orderId: string
  admissionId: string
  /** 預計給藥時間 YYYY-MM-DD HH:mm */
  scheduledAt: string
  status: 'pending' | 'given' | 'held' | 'refused'
  /** PRN、STAT 給藥扣哪裡：ward 病房常備；pharmacy 病房常備不足、改由住院藥局直送 */
  stockFrom?: 'ward' | 'pharmacy'
  /** 實際給藥（或決定暫停、拒絕）的時間 */
  executedAt?: string
  /** 補登時才有：實際登打的時間（與 executedAt 不同時，畫面標示「補登」）。兩個都是事實，誰也不覆蓋誰 */
  recordedAt?: string
  nurseId?: string
  note?: string
  /**
   * 住院藥局調劑（UD）的哪一筆發的這一劑。排程給藥要有才能給（藥還沒到病房）；
   * PRN、STAT 用病房常備，給藥時直接扣，沒有這個欄位
   */
  udLineId?: string
  /** 管制藥注射劑給不是整數的劑量（例：Morphine 0.5 AMP）：整支扣、剩下的當場銷毀，另一位護理師見證 */
  residual?: { qty: number; witnessBy: string }
  /**
   * 給藥條碼核對：scanned＝掃了腕帶與藥品、都對；skipped＝略過（要選原因）。
   * 沒有這個欄位＝當時不需要掃描（設定關閉、或功能上線前的紀錄）。只有「已給藥」才有
   */
  scan?: { mode: 'scanned' } | { mode: 'skipped'; reason: ScanSkipReason; note?: string }
}

/** 略過掃描的原因 */
export type ScanSkipReason = 'wristband' | 'barcode' | 'scanner' | 'emergency'

/** 掃描不符（差點給錯）：掃到別人的腕帶、舊腕帶、不是這一劑的藥。當場擋下，記下來給護理長看 */
export interface ScanMismatch {
  id: string
  at: string
  nurseId: string
  /** 要給藥的那位病人 */
  admissionId: string
  orderId: string
  kind: 'patient' | 'drug'
  /** 掃到的條碼 */
  code: string
  /** 當時畫面上的說明（例：這是 503-2 董雅惠的腕帶） */
  message: string
}

/**
 * 住院調劑（Unit Dose）：藥師每天下午調次日整天的劑量；當天新開的醫囑「補調劑」今天剩下的。
 * 一次調劑＝藥師按一次「調劑」：每位病人、每筆醫囑一行。兩段：
 *   調劑（備藥，不扣帳）→ 核對：逐位病人的藥盒（boxes）通過才扣住院藥局、送病房，護理師才能給；
 *   核對發現錯誤可以退回重調（那位病人的劑量回到待調劑）。雙人核對設定開啟時，調劑的人不能自己核對
 */
export interface UdDispense {
  id: string
  /** 調劑單號 UD20261112-01 */
  no: string
  locationId: string
  /** daily 每日調劑（次日）；extra 補調劑（今天剩下的、新開的醫囑） */
  kind: 'daily' | 'extra'
  /** 調劑（備藥）的人與時間 */
  dispensedBy: string
  dispensedAt: string
  /** 每位病人一個藥盒：核對以藥盒為單位 */
  boxes: UdBox[]
  lines: UdLine[]
}

export interface UdBox {
  admissionId: string
  /** prepared 已調劑待核對、verified 已核對送病房（已扣帳）、rejected 退回重調（劑量回到待調劑） */
  status: 'prepared' | 'verified' | 'rejected'
  verifiedBy?: string
  verifiedAt?: string
  rejectedBy?: string
  rejectedAt?: string
  rejectReason?: string
  /** 送到哪個病房：調劑時病人所在的病房（之後轉床不跟著改——藥盒已經送去那裡了） */
  ward?: string
  /** 病房點收（護理師）：核對送出後藥車到病房，逐盒點收。點收前照樣可以給藥（不能因為少按一個鍵延誤用藥） */
  receivedBy?: string
  receivedAt?: string
  /** 點收時發現不符（短少、破損、不是這位病人的）：藥局處理後填處理說明 */
  issue?: UdBoxIssue
}

export interface UdBoxIssue {
  cause: string
  note?: string
  by: string
  at: string
  resolvedBy?: string
  resolvedAt?: string
  resolution?: string
  /** 處理時補發的藥（扣住院藥局的異動）：那幾劑已經在這張調劑單上，不會再出現在補調劑 */
  resupplyTxnIds?: string[]
}

export interface UdLine {
  id: string
  admissionId: string
  orderId: string
  drugId: string
  /** 這一行發的是哪幾劑（給藥排程） */
  marIds: string[]
  /** 發出的量（調劑單位）；無法換算的藥由藥師填，0＝床邊已有、這次不發 */
  qty: number
  /** 每劑幾個調劑單位：可換算時才有（沒給的劑量依這個退）；無法換算的（胰島素筆、眼藥水）沒有，也不退 */
  perDose?: number
  /** 扣庫存的那筆異動（核對通過才有；qty 0 沒有）：退藥時退回同幾個批號 */
  txnId?: string
  /** 病房送回藥局（護理師）：送回了哪幾劑。藥師只能點收已送回的 */
  sendBacks?: { at: string; by: string; marIds: string[] }[]
  /** 退藥點收紀錄：每次點收結清哪幾劑、應退、實收（短少要寫原因） */
  returns?: UdReturn[]
}

export interface UdReturn {
  at: string
  by: string
  marIds: string[]
  expected: number
  qty: number
  reason?: string
  txnIds: string[]
}

export interface VitalRecord {
  id: string
  admissionId: string
  at: string
  temp?: number
  pulse?: number
  resp?: number
  sbp?: number
  dbp?: number
  spo2?: number
  /** 給氧（L/min）：0＝室內空氣；沒填＝沒記（算不出 NEWS2） */
  o2?: number
  /** 意識 ACVPU：清醒、新出現的混亂、對聲音有反應、對痛有反應、沒反應 */
  avpu?: Avpu
  /** 疼痛分數 0-10（數字量表；每班至少一次） */
  pain?: number
  /** 疼痛 ≥4 的處置（必填）：之後 1 小時內要重評（下一筆有疼痛分數的紀錄就算重評） */
  painAction?: string
  /** 輸入 / 輸出量 ml */
  intake?: number
  output?: number
  nurseId: string
  /** 加護病房重症流程表（每小時一筆）：意識 GCS 三項、瞳孔大小（mm）與光反射 */
  hourly?: boolean
  /** GCS：插管的病人言語記「T」（vt: true，v 以 1 計，顯示 10T） */
  gcs?: { e: number; v: number; m: number; vt?: boolean }
  pupils?: { l: number; r: number; lightL: PupilLight; lightR: PupilLight }
  /** 鎮靜程度 RASS（−5 昏迷 … 0 清醒平靜 … +4 攻擊） */
  rass?: number
  /** 呼吸器實測（每 4 小時）：尖峰壓 cmH2O、實際潮氣量 ml、實際呼吸次數 */
  vent?: { ppeak: number; vt: number; rr: number }
}

/** 意識 ACVPU（NEWS2）：A 清醒、C 新出現的混亂、V 對聲音有反應、P 對痛有反應、U 沒反應 */
export type Avpu = 'A' | 'C' | 'V' | 'P' | 'U'

/**
 * 快速反應小組（RRT）呼叫：一般病房 NEWS2 ≥7 自動呼叫，或護理師「擔心病人」手動呼叫；
 * 小組（權限 rrt）到場評估，留原病房或申請轉加護病房（直接建一筆轉入申請）
 */
export interface RrtCall {
  id: string
  admissionId: string
  /** 自動：觸發的那筆生命徵象與分數；手動：呼叫原因 */
  trigger: 'auto' | 'manual'
  vitalId?: string
  score?: number
  reason?: string
  calledBy: string
  calledAt: string
  status: 'pending' | 'done'
  assessedBy?: string
  assessedAt?: string
  /** 評估發現、處置 */
  findings?: string
  actions?: string
  disposition?: 'stay' | 'icu'
  icuRequestId?: string
}

/** 急救心律：心室顫動、無脈性心室頻脈（可電擊）；無脈性電氣活動、心搏停止（不可電擊） */
export type CodeRhythm = 'vf' | 'pvt' | 'pea' | 'asystole'
/** 急救事件：開始 CPR、心律判讀、電擊、腎上腺素、Amiodarone、插管、甦醒球人工呼吸、備註 */
export type CodeEventKind = 'cpr' | 'rhythm' | 'shock' | 'epi' | 'amio' | 'intubate' | 'bvm' | 'note'
export interface CodeEvent {
  id: string
  at: string
  kind: CodeEventKind
  by: string
  rhythm?: CodeRhythm
  joules?: number
  /** 藥（mg）：自動開的臨時醫囑 */
  doseMg?: number
  orderId?: string
  note?: string
}
/**
 * 急救（Code Blue）：任何護理師、醫師都能啟動；醫師「帶領」後急救藥、電擊才記得下去（口頭醫囑記在帶領醫師名下）。
 * DNR 硬擋：不按壓不能開始 CPR、不電擊不能電擊、不插管不能插管、不施行急救藥物不能給藥、不施行人工呼吸不能用甦醒球。
 * 結束：恢復自主循環（ROSC）、宣告死亡（醫師）、或依 DNR 不施行急救
 */
export interface CodeBlue {
  id: string
  admissionId: string
  startedAt: string
  startedBy: string
  /** 帶領的醫師（使用者 id） */
  leaderId?: string
  events: CodeEvent[]
  status: 'active' | 'ended'
  endedAt?: string
  endedBy?: string
  outcome?: 'rosc' | 'death' | 'dnr'
  /** 急救後申請轉加護病房 */
  icuRequestId?: string
}

/** 死亡方式（死亡證明書）：自然死、意外、自殺、他殺、未確定（待司法相驗） */
export type DeathManner = 'natural' | 'accident' | 'suicide' | 'homicide' | 'pending'
/** 遺體護理檢核項目 */
export type BodyCareKey = 'lines' | 'clean' | 'family' | 'valuables' | 'tag'
export interface DeathRecord {
  declaredAt: string
  /** 宣告的醫師（使用者 id） */
  declaredBy: string
  /** 急救後宣告的：那次急救 */
  codeBlueId?: string
  /** 預期死亡（有 DNR、或安寧收案）：死亡病例審查用 */
  expected: boolean
  /** 死因（死亡證明書格式）：甲 直接引起死亡的疾病 → 乙 → 丙 → 丁 原始死因；other 其他對死亡有影響的疾病 */
  causes: string[]
  other?: string
  manner: DeathManner
  /** 住院經過（簡述，帶入出院病摘） */
  course: string
  /** 遺體護理（護理師檢核） */
  care?: { items: BodyCareKey[]; valuables: string; by: string; at: string }
  /** 死亡證明書（不收費，開了就能印：家屬辦後事要用） */
  cert?: { no: string; copies: number; issuedAt: string; by: string; printed?: { at: string; by: string }[] }
  morgueAt?: string
  morgueBy?: string
}

/** 安寧症狀評估（0–10）：疼痛、呼吸困難、噁心嘔吐、焦慮、譫妄 */
export type SymptomKey = 'pain' | 'dyspnea' | 'nausea' | 'anxiety' | 'delirium'
/**
 * 安寧共同照護：主治提出照會 → 安寧醫師（權限 palliative）評估末期（疾病別、兩位專科醫師確認）收案、或婉拒 →
 * 收案後每週至少訪視一次（症狀評估、照護目標、靈性與社會需求；每次計一次共照費）、家屬會議
 */
export interface PalliativeCase {
  id: string
  admissionId: string
  status: 'requested' | 'enrolled' | 'declined' | 'cancelled'
  requestedBy: string
  requestedAt: string
  reason: string
  decidedBy?: string
  decidedAt?: string
  declineReason?: string
  /** 末期評估：疾病別、兩位專科醫師（醫師代碼） */
  terminal?: { disease: string; doctorIds: string[]; note?: string }
  /** 照護目標（收案時寫，訪視可以更新） */
  goals?: string
  visits: { id: string; at: string; by: string; symptoms: Record<SymptomKey, number>; note: string; spiritual?: string; social?: string; orderId?: string }[]
  meetings: { id: string; date: string; participants: string; conclusion: string; by: string; at: string }[]
}

/** 瞳孔光反射：靈敏、遲鈍、無反應 */
export type PupilLight = 'brisk' | 'sluggish' | 'none'

/** 管路：導尿管、中心靜脈導管、周邊靜脈留置針、鼻胃管 */
export type LineKind = 'foley' | 'cvc' | 'pivc' | 'ngt' | 'peg' | 'ett'

/** 呼吸器模式：容積控制、壓力控制、同步間歇強制換氣、壓力支持、持續正壓 */
export type VentMode = 'AC/VC' | 'AC/PC' | 'SIMV' | 'PSV' | 'CPAP'
export interface VentSetting {
  mode: VentMode
  /** 氧氣濃度 21–100 % */
  fio2: number
  /** 吐氣末正壓 cmH2O */
  peep: number
  /** 設定潮氣量 ml（AC/VC、SIMV） */
  vt?: number
  /** 吸氣壓力 cmH2O（AC/PC） */
  pinsp?: number
  /** 設定呼吸次數（AC/VC、AC/PC、SIMV） */
  rr?: number
  /** 壓力支持 cmH2O（PSV；SIMV 可加） */
  ps?: number
  /** 改設定的原因（第一次開不用） */
  changeReason?: string
}

/** 轉入加護病房的類別 */
export type IcuCategory = 'resp' | 'shock' | 'postop' | 'other'
/**
 * 轉入加護病房申請：主治（本科醫師）申請、寫原因與類別 → 加護病房主治（權限）同意（有床就排床）或不同意（寫原因）→
 * 同意了沒床先候床，有床再排（placed）。住院中轉床進加護病房一定要有同意的申請
 */
export interface IcuRequest {
  id: string
  admissionId: string
  category: IcuCategory
  reason: string
  requestedBy: string
  requestedAt: string
  status: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'placed'
  decidedBy?: string
  decidedAt?: string
  decideNote?: string
  placedAt?: string
  bedId?: string
  /** 快速反應小組評估後申請的 */
  rrtCallId?: string
  /** 急救後申請的 */
  codeBlueId?: string
}

/** 每日脫離評估：自發性甦醒試驗（停鎮靜，SAT）→ 通過才做自發性呼吸試驗（SBT）；不適合要寫原因 */
export type WeanResult = 'pass' | 'fail' | 'na'
export interface WeanTrial {
  id: string
  admissionId: string
  date: string
  at: string
  by: string
  sat: WeanResult
  sbt: WeanResult
  note?: string
}

/**
 * 管路（護理師或醫師登錄）：放置時間、部位、尺寸、放置者；導尿管與 CVC 每天評估「還需要嗎」；
 * 移除要寫原因（出院、結束留觀時自動移除，原因「出院」）。只提醒不擋
 */
export interface LineDevice {
  id: string
  admissionId: string
  kind: LineKind
  site: string
  size: string
  insertedAt: string
  /** 放置者（姓名，可能是醫師或外院）；登錄的人另記 recordedBy */
  placedBy: string
  recordedBy: string
  recordedAt: string
  /** 每天的「還需要嗎」評估（導尿管、CVC） */
  needChecks?: { date: string; at: string; by: string; needed: boolean; note?: string }[]
  removedAt?: string
  removedBy?: string
  removeReason?: string
}

/**
 * 譫妄評估（護理師，CAM）：急性發作或波動、注意力不集中，加上思考紊亂或意識改變其中一項＝陽性。
 * 65 歲以上、術後 72 小時內每班一次；陽性主治要確認（ackAt）
 */
export interface DeliriumAssessment {
  id: string
  admissionId: string
  at: string
  by: string
  acute: boolean
  inattention: boolean
  disorganized: boolean
  consciousness: boolean
  positive: boolean
  note?: string
  ackBy?: string
  ackAt?: string
}

/**
 * 身體約束：醫師開醫囑（原因、部位、方式，每次最長 24 小時，到期要續開）；緊急時護理師先約束（emergency），1 小時內補醫囑。
 * 約束中每 2 小時查一次（末梢循環、皮膚、是否還需要）；解除寫原因
 */
export interface Restraint {
  id: string
  admissionId: string
  reason: string
  sites: string[]
  method: string
  startedAt: string
  startedBy: string
  emergency: boolean
  /** 醫師醫囑（開立、續開）：每筆有效到 until */
  orders: { by: string; at: string; until: string }[]
  checks: { at: string; by: string; circulationOk: boolean; skinOk: boolean; stillNeeded: boolean; note?: string }[]
  endedAt?: string
  endedBy?: string
  endReason?: string
}

/** 風險評估量表：fall＝跌倒（Morse）、pressure＝壓傷（Braden） */
export type RiskScale = 'fall' | 'pressure'
export type RiskLevel = 'high' | 'moderate' | 'low'
/** 評估的時機：入院 24 小時內、例行重評、轉床或轉科後、病情變化加評 */
export type RiskReason = 'admission' | 'routine' | 'transfer' | 'change'

/** 風險評估（護理師）：每次一筆、只增不改；填錯的當班由本人作廢（留著、劃線） */
export interface RiskAssessment {
  id: string
  admissionId: string
  scale: RiskScale
  at: string
  nurseId: string
  /** 每一題選的分數（題目 key → 分數） */
  answers: Record<string, number>
  score: number
  /** 依當時的切點判斷（之後改切點，舊紀錄不變） */
  level: RiskLevel
  reason: RiskReason
  /** 高風險時已採取的預防措施（措施 key） */
  measures?: string[]
  /** 一起寫的護理紀錄 */
  noteId?: string
  voided?: { at: string; by: string; reason: string }
}

/** 風險評估切點（管理員可調；沒設定用 risk-rules.RISK_DEFAULT）。Morse 越高越危險、Braden 越低越危險 */
export interface RiskSettings {
  /** Morse ≥ 這個分數＝高風險 */
  fallHigh: number
  /** Morse ≥ 這個分數＝中度 */
  fallModerate: number
  /** Braden ≤ 這個分數＝高風險 */
  pressureHigh: number
  /** Braden ≤ 這個分數＝中度 */
  pressureModerate: number
}

// ---------- 手術排程與術前核對 ----------

export type SurgerySide = 'left' | 'right' | 'bilateral' | 'na'
export type AnesthesiaType = 'general' | 'spinal' | 'regional' | 'local'
/** 術前準備（病房護理師）：同意書、禁食、部位標記、備血、預防性抗生素 */
export type SurgeryPrepKey = 'consent' | 'npo' | 'siteMark' | 'blood' | 'abx'
/** 手術安全查核三階段：麻醉前（sign in）、劃刀前暫停確認（time out）、離開手術室前（sign out） */
export type SurgeryCheckStage = 'signIn' | 'timeOut' | 'signOut'
export type SurgeryStatus = 'requested' | 'scheduled' | 'sent' | 'in-progress' | 'done' | 'cancelled'

export interface SurgeryPrepMark {
  by: string
  at: string
  /** 不需要（例：小手術不用備血）：要寫原因 */
  notNeeded?: string
  /** 備血：連到哪張備血單；抗生素：連到哪筆醫囑 */
  refId?: string
}

/**
 * 手術（住院病人的排程手術）：主治申請 → 手術室排程（房間、時間）→ 病房術前準備 → 送手術室
 * → 三段安全查核（麻醉前、劃刀前暫停確認、離開前含紗布器械計數）→ 手術紀錄。
 * 做完自動把術式與麻醉費列入住院帳單
 */
export interface Surgery {
  id: string
  /** 手術單號 */
  no: string
  admissionId: string
  patientId: string
  /** 主刀（申請的醫師） */
  doctorId: string
  /** 術式（主檔 Procedure.surgery） */
  procId: string
  side: SurgerySide
  anesthesia: AnesthesiaType
  diagnosis: string
  /** 希望的日期 */
  requestedDate: string
  estMinutes: number
  note?: string
  status: SurgeryStatus
  createdAt: string
  schedule?: { room: string; start: string; by: string; at: string }
  prep: Partial<Record<SurgeryPrepKey, SurgeryPrepMark>>
  sentAt?: string
  sentBy?: string
  checks: Partial<Record<SurgeryCheckStage, { by: string; at: string }>>
  startAt?: string
  endAt?: string
  /** 開始手術時的預防性抗生素時機（有連抗生素醫囑才有）：劃刀前多久給；不符要寫原因 */
  abxTiming?: { ok: boolean; givenAt?: string; minutes?: number; reason?: string }
  counts?: { spongeBefore: number; spongeAfter: number; instrumentBefore: number; instrumentAfter: number; mismatchReason?: string }
  /** 手術紀錄（主刀或本科醫師） */
  record?: { performed: string; findings: string; bloodLoss: number; complications: string; specimen: string; by: string; at: string }
  cancelled?: { by: string; at: string; reason: string }
}

// ---------- 病歷影本申請 ----------

/** 影本可以申請的項目：門診病歷（一次看診）、出院病摘、檢驗報告、影像報告 */
export type CopyItemKind = 'opd' | 'discharge' | 'lab' | 'imaging'

/**
 * 病歷影本申請（櫃台受理、當場收費、列印）：本人或代理人（登錄關係、勾委託書已核對）。
 * 收費開一張收據（Charge.copyRequestId），進日結；當天可作廢（收據一起作廢）
 */
export interface RecordCopyRequest {
  id: string
  /** 申請單號（印在每一頁） */
  no: string
  patientId: string
  applicant: { kind: 'self' | 'agent'; name: string; idNo: string; relation?: string; authorizationChecked?: boolean }
  purpose: string
  items: { kind: CopyItemKind; refId: string; label: string; pages: number }[]
  pages: number
  chargeId: string
  createdAt: string
  createdBy: string
  /** 每次列印（第一次＋補印）都記下 */
  printed: { at: string; by: string }[]
  voided?: { at: string; by: string; reason: string }
}

// ---------- 輸血備血 ----------

/** 血品：紅血球濃厚液、新鮮冷凍血漿、血小板（分離術） */
export type BloodProduct = 'rbc' | 'ffp' | 'plt'
export type Abo = 'A' | 'B' | 'O' | 'AB'
export type Rh = '+' | '-'

/** 本院血庫驗的血型（每張備血單重新抽血驗一次；和上次不同＝可能抽錯人的血，擋下來重抽） */
export interface BloodTyping {
  abo: Abo
  rh: Rh
  by: string
  at: string
  requestId: string
}

/** 血袋（血庫自己的存量，不進藥品庫存帳）：入庫時給血袋號，條碼＝血袋號 */
export interface BloodUnit {
  id: string
  unitNo: string
  product: BloodProduct
  abo: Abo
  rh: Rh
  /** ml */
  volume: number
  /** 效期（這天以後不能用） */
  expiresOn: string
  receivedAt: string
  receivedBy: string
  /** available 可用、reserved 已配給某張備血單、issued 已發出（輸血中或待輸）、transfused 輸完（含因反應停止）、scrapped 報廢 */
  status: 'available' | 'reserved' | 'issued' | 'transfused' | 'scrapped'
  requestId?: string
  scrapped?: { at: string; by: string; reason: string }
}

/** 輸血時的生命徵象：輸血前、開始後 15 分鐘、結束 */
export interface TransfusionVitals {
  at: string
  kind: 'pre' | '15min' | 'end'
  temp: number
  pulse: number
  sbp: number
  dbp: number
  by: string
}

/** 輸血反應（護理師通報，立刻停止輸血）：主治（或開立醫師）要按已知悉並寫處置 */
export interface TransfusionReaction {
  at: string
  by: string
  symptoms: string[]
  note: string
  ackBy?: string
  ackAt?: string
  ackNote?: string
}

/** 一次發血（同一袋 30 分鐘內退回血庫，再發是新的一筆）＋床邊輸血紀錄 */
export interface BloodIssue {
  unitId: string
  issuedAt: string
  issuedBy: string
  returned?: { at: string; by: string; reason: string }
  transfusion?: {
    startAt: string
    nurseId: string
    /** 床邊雙人核對的第二人 */
    witnessId: string
    scan?: MarRecord['scan']
    vitals: TransfusionVitals[]
    endAt?: string
    /** 實際輸入的量（ml） */
    volume?: number
    reaction?: TransfusionReaction
  }
}

/**
 * 備血單（醫師開立）→ 血庫驗血型、交叉試驗配血 → 發血 → 床邊雙人核對輸血。
 * 狀態大多由內容推算（blood-rules.requestStatus）；只有取消是存下來的
 */
export interface BloodRequest {
  id: string
  /** 備血單號 */
  no: string
  admissionId: string
  patientId: string
  doctorId: string
  product: BloodProduct
  units: number
  indication: string
  urgent: boolean
  /** 開立時參考的檢驗值（紅血球看 Hb、血小板看 PLT）：最近一次、有就存下來 */
  lab?: { code: string; value: string; at: string }
  /** 高於輸血門檻（或沒有近期檢驗）時要寫的理由 */
  overReason?: string
  orderedAt: string
  typing?: { abo: Abo; rh: Rh; by: string; at: string }
  /** 交叉試驗配好的血袋（釋出的留著：交叉試驗做過了，照樣計費） */
  crossmatch: { unitId: string; by: string; at: string; released?: { at: string; by: string; reason: string } }[]
  issues: BloodIssue[]
  cancelled?: { at: string; by: string; reason: string }
}

/** 隔離類別：接觸、飛沫、空氣（空氣隔離只能住單人房） */
export type IsolationKind = 'contact' | 'droplet' | 'airborne'

/**
 * 隔離（掛在病人身上，跨住院）：醫師或護理師開、醫師解除（要原因）。MRSA、CRE 這類帶菌者出院不自動解除，
 * 下次住院要確認是否延續；開了 14 天沒檢討，護理站待辦提醒
 */
export interface Isolation {
  id: string
  patientId: string
  kind: IsolationKind
  /** 原因或菌種（例：MRSA、疑似肺結核、流感） */
  organism: string
  note?: string
  startedAt: string
  startedBy: string
  /** 開的時候在哪一次住院（門診開的沒有） */
  admissionId?: string
  /** 最近一次檢討（確認延續） */
  reviewedAt?: string
  reviewedBy?: string
  /** 解除：exception＝沒達到解除條件，醫師寫原因例外解除 */
  ended?: { at: string; by: string; reason: string; exception?: boolean }
}

/** DNR 文件：本人意願書、最近親屬同意書、預立醫療決定書（病人自主權利法） */
export type DnrDoc = 'self' | 'family' | 'ad'
/** 不施行的項目（安寧緩和醫療條例的心肺復甦術內容；預立醫療決定可再加人工營養及流體餵養） */
export type DnrItem = 'compress' | 'intubation' | 'defib' | 'drugs' | 'pacing' | 'ventilation' | 'feeding'

/** DNR／預立醫療決定（醫師登錄）：同一時間只有一份有效；登新的就取代舊的，撤回要原因，紀錄都留著 */
export interface DnrRecord {
  id: string
  patientId: string
  doc: DnrDoc
  /** 簽署日期 */
  signedAt: string
  /** 家屬同意書：簽署人與關係 */
  signerName?: string
  relation?: string
  /** 見證人（本人意願書、預立醫療決定書：2 位） */
  witnesses?: string[]
  /** 家屬同意書：兩位專科醫師確認為末期病人 */
  doctorIds?: string[]
  /** 預立醫療決定：預立醫療照護諮商日期 */
  acpDate?: string
  withhold: DnrItem[]
  /** 已註記健保卡（示範只是勾選） */
  nhiCard: boolean
  recordedBy: string
  recordedAt: string
  revoked?: { at: string; by: string; reason: string }
}

export interface NursingNote {
  id: string
  admissionId: string
  at: string
  /** Focus DAR 格式：焦點、資料、措施、反應 */
  focus: string
  data: string
  action: string
  response: string
  /** 反應（R）常在措施後一段時間才觀察到，補記的時間另外記錄 */
  respondedAt?: string
  nurseId: string
}

/** 住院病程紀錄 */
export interface ProgressNote {
  id: string
  admissionId: string
  at: string
  doctorId: string
  /**
   * 特殊紀錄（系統依動作寫入，內容在 items）：轉出摘要、接收評估、會診申請、會診回覆。
   * 沒有 kind 的是一般 SOAP 病程紀錄
   */
  kind?: 'transferOut' | 'transferIn' | 'consult' | 'consultReply' | 'icuOut'
  items?: { label: string; text: string }[]
  subjective: string
  objective: string
  assessment: string
  plan: string
}

/** 交班紀錄 */
/** 壓傷分級：1–4 級、無法分級、深部組織損傷 */
export type PressureStage = '1' | '2' | '3' | '4' | 'unstageable' | 'dti'

/** 換藥紀錄（第一筆是發現時的評估）：敷料、滲液、大小 cm（壓傷可以改分級） */
export interface WoundCare {
  at: string
  by: string
  dressing: string
  exudate: 'none' | 'small' | 'moderate' | 'large'
  lengthCm: number
  widthCm: number
  depthCm: number
  stage?: PressureStage
  note?: string
}

/**
 * 傷口（護理師登錄）：壓傷、手術傷口、其他；入院 24 小時後才發現的壓傷算「院內壓傷」（品質指標）。
 * 每次換藥記大小，連續 2 週沒變小提醒主治；癒合結案
 */
export interface Wound {
  id: string
  admissionId: string
  kind: 'pressure' | 'surgical' | 'other'
  site: string
  foundAt: string
  /** 院內發生（入院 24 小時後才發現的壓傷） */
  hospitalAcquired: boolean
  recordedBy: string
  cares: WoundCare[]
  closedAt?: string
  closedBy?: string
  closeReason?: string
}

/**
 * 點滴的一瓶（護理師接上 → 換瓶或停止）：接上時確認留置針通暢、扣一瓶（加藥一起扣）；
 * 流速調整留紀錄（原因）；輸入量依流速與時間算，結束時可以修正為實際量
 */
export interface InfusionRun {
  id: string
  orderId: string
  admissionId: string
  bagNo: number
  startAt: string
  startBy: string
  rateMlH: number
  rateChanges: { at: string; by: string; from: number; to: number; reason: string }[]
  endAt?: string
  endBy?: string
  endReason?: string
  /** 結束時護理師確認的實際輸入量（沒填用流速算） */
  infusedMl?: number
  txnIds: string[]
}

/** 院內感染種類：導尿管相關泌尿道感染、中心靜脈導管相關血流感染、手術部位感染、其他 */
export type InfectionKind = 'cauti' | 'clabsi' | 'vap' | 'ssi' | 'other'

/**
 * 院內感染個案：醫師或護理師通報（症狀、培養）→ 感染管制（權限「感染管制」）判定成立或不成立。
 * 管路相關的要選當時在身上的那條管路（放超過 2 天才算）；手術部位感染選那次手術
 */
export interface InfectionCase {
  id: string
  admissionId: string
  kind: InfectionKind
  lineId?: string
  surgeryId?: string
  onsetAt: string
  symptoms: string
  culture: string
  reportedBy: string
  reportedAt: string
  status: 'reported' | 'confirmed' | 'rejected'
  decision?: { by: string; at: string; reason: string }
}

/** PCA 每 4 小時的紀錄（護理師）：按壓次數、實際給藥次數、累計用量 ml、疼痛、鎮靜（POSS 1–4）、呼吸；鎮靜 ≥3 或呼吸 <10 是警示 */
export interface PcaRecord {
  at: string
  by: string
  demands: number
  delivered: number
  usedMl: number
  pain: number
  sedation: 1 | 2 | 3 | 4
  resp: number
  note?: string
  alert: boolean
}

/**
 * 病人自控止痛（PCA）：醫師開（藥袋、單次劑量、鎖定時間、每小時上限、基礎速率；要有管制藥執照）→ 護理師雙人核對架設（扣住院藥局一袋）
 * → 每 4 小時紀錄 → 結束時剩餘量雙人銷毀（記進管制藥簿冊殘餘量）。警示（鎮靜 ≥3、呼吸 <10）主治要處理（alertAck）
 */
export interface PcaOrder {
  id: string
  admissionId: string
  drugId: string
  bolusMg: number
  lockoutMin: number
  hourLimitMg: number
  basalMgH: number
  orderedBy: string
  orderedAt: string
  status: 'ordered' | 'running' | 'ended' | 'cancelled'
  setup?: { at: string; by: string; witnessBy: string; txnId: string }
  records: PcaRecord[]
  alertAck?: { at: string; by: string; note: string }
  end?: { at: string; by: string; witnessBy: string; reason: string; residualMl: number }
  cancelled?: { at: string; by: string; reason: string }
}

/** 出院準備的轉介：長照 2.0、居家護理、呼吸照護、輔具、喘息服務 */
export type DischargeReferralKind = 'ltc' | 'homecare' | 'respiratory' | 'aids' | 'respite'

export interface DischargeReferral {
  id: string
  kind: DischargeReferralKind
  agency: string
  note?: string
  createdAt: string
  createdBy: string
  /** 送出（列印、傳真給對方）的日期 */
  sentAt?: string
  sentBy?: string
  /** 對方回覆：核定、未核定 */
  reply?: { status: 'approved' | 'denied'; note?: string; at: string; by: string }
}

/**
 * 出院準備（一次住院一份）：入院 72 小時內篩選（符合兩項以上收案）→ 需求評估 → 轉介（列印送出、記回覆）→
 * 出院後 7 天內電話追蹤。auto 是系統依資料自動勾的條件（年齡、管路、30 天內再住院）
 */
export interface DischargePlan {
  id: string
  admissionId: string
  screenedAt: string
  screenedBy: string
  criteria: string[]
  auto: string[]
  enrolled: boolean
  needs: string[]
  assessment?: string
  referrals: DischargeReferral[]
  followUp?: { at: string; by: string; reached: boolean; result: string }
}

/** 護理排班：某病房某天某一班排了哪位護理師（一人一筆） */
export interface NurseShift {
  id: string
  ward: string
  date: string
  shift: '白班' | '小夜' | '大夜'
  nurseId: string
}

/** 責任分床：某一班某位病人由哪位護理師照顧（一位病人一筆；重分就改） */
export interface NurseAssignment {
  id: string
  ward: string
  date: string
  shift: '白班' | '小夜' | '大夜'
  admissionId: string
  nurseId: string
  by: string
  at: string
}

/**
 * 換班、請假申請：
 *   請假 leave：護理師申請自己已排的一班（假別、原因）→ 護理長核准 → 從班表拿掉
 *   換班 swap：我的一班（shiftId）和別人的一班（targetShiftId）互換 → 對方同意（pending-peer → pending）→ 護理長核准 → 交換
 */
export interface ShiftRequest {
  id: string
  kind: 'leave' | 'swap'
  requesterId: string
  /** 申請的那一班（申請當下的快照：ward、date、shift） */
  shiftId: string
  ward: string
  date: string
  shift: '白班' | '小夜' | '大夜'
  leaveType?: string
  reason: string
  /** 換班：對方與對方的那一班 */
  targetId?: string
  targetShiftId?: string
  target?: { ward: string; date: string; shift: '白班' | '小夜' | '大夜' }
  status: 'pending-peer' | 'pending' | 'approved' | 'rejected' | 'declined' | 'cancelled'
  createdAt: string
  peer?: { at: string; accept: boolean; note?: string }
  decidedBy?: string
  decidedAt?: string
  decideNote?: string
}

/** 護病比上限（一位護理師最多照顧幾位病人）：區域醫院標準 白班 7、小夜 11、大夜 15 */
export interface StaffingSettings {
  ratio: Record<'白班' | '小夜' | '大夜', number>
  /** 加護病房護病比上限（三班同一個；預設 1:2） */
  icuRatio?: number
}

export interface HandoverNote {
  id: string
  ward: string
  shift: '白班' | '小夜' | '大夜'
  date: string
  admissionId: string
  content: string
  nurseId: string
  createdAt: string
}

/** 預防保健服務項目定義 */
export interface PreventItem {
  code: string
  name: string
  /** 健保／國健署案件代碼（展示） */
  caseCode: string
  /** 資格說明文字 */
  ruleText: string
  /** 停用後不再提供服務（歷史紀錄照常顯示）；未設定視為啟用 */
  active?: boolean
  /** 間隔年數（同一人兩次服務最短間隔），0 表示終身一次 */
  intervalYears: number
  /** 登錄時要填的檢查數值欄位 */
  fields: string[]
  /** 檢體送驗、報告晚幾天才出來的項目，登錄時預設「待報告」 */
  needsReport: boolean
}

export interface PreventRecord {
  id: string
  patientId: string
  itemCode: string
  date: string
  visitId?: string
  doctorId: string
  /** 結果：正常 / 異常需追蹤 / 待報告 */
  result: '正常' | '異常需追蹤' | '待報告'
  /** 報告補登時間（結果原為「待報告」） */
  reportedAt?: string
  /** 檢查數值或備註，自由格式 key-value */
  data: Record<string, string>
  /**
   * 作廢（登錄錯誤時）：紀錄保留、標示作廢原因與作廢人，不刪除也不改寫——日後查得到「原本記了什麼、為什麼作廢」。
   * 作廢的紀錄不佔資格、不計統計、不能補登報告。選用欄位：舊資料沒有它就是未作廢。
   */
  voided?: { reason: string; at: string; by: string }
}

export interface AuditLog {
  id: string
  at: string
  userId: string
  /** 當時用的作業角色（一個帳號可能有多個角色）；登入前、系統動作沒有 */
  role?: Role
  action: string
  detail: string
}

/** 藥品批號：同一種藥分批進貨，各批效期不同；發藥時先發最早到期的（FEFO） */
export interface DrugLot {
  id: string
  drugId: string
  /** 存放地點（同一批號撥到別的地點，是另一筆 DrugLot、批號效期相同） */
  locationId: string
  lotNo: string
  /** 效期 YYYY-MM-DD */
  expiry: string
  /** 此批剩餘數量（調劑單位） */
  qty: number
  receivedAt: string
}

export type StockTxnType = 'opening' | 'receive' | 'dispense' | 'adjust' | 'transfer-out' | 'transfer-in' | 'return'

/**
 * 醫院規模（重建展示資料時選，不隨時切換）：
 *   small 小型：只有一個藥局，藥庫＝藥局（進貨、發藥都在這裡）
 *   large 大型：一個藥庫（進貨）＋多個藥局（門診藥局發藥、住院藥局），藥局向藥庫請領撥補
 */
export type HospitalScale = 'small' | 'large'

/** 庫存地點：每個批號、每筆異動都屬於某個地點 */
export interface StockLocation {
  id: string
  name: string
  /**
   * quarantine＝待報廢區：藥庫底下獨立的一區（退回的過期、破損品）。另開地點是因為同一個批號可能一半可用、一半是退回的破損品——
   * 在批號上標記會把好的那一半也鎖住。FEFO、開藥可用量、撥補、盤點都不會用到它；只能報廢或放回可用
   */
  kind: 'warehouse' | 'pharmacy' | 'quarantine' | 'ward'
  /** 待報廢區屬於哪個藥庫 */
  parentId?: string
  /** 病房常備（kind = ward）：哪個病房（病床的 ward） */
  ward?: string
  /** 採購到貨入庫的地點（大型＝藥庫；小型＝唯一的藥局） */
  receivesPurchase: boolean
  /** 門診發藥從這裡扣（醫師開藥看的「可用量」也是這裡的） */
  dispensesOpd: boolean
  /** 住院調劑（UD）與病房常備（PRN、STAT 給藥）從這裡扣（大型＝住院藥局；小型＝唯一的藥局） */
  dispensesIpd: boolean
  active: boolean
}

/**
 * 盤點單：某個地點、某個範圍（全部／劑型／指定藥品），建立時展開成「每個批號一列」。
 * 清點中 → 送出（待覆核）→ 另一人覆核過帳；任何時候可取消（要寫原因）。
 * 清點中與待覆核時，範圍內藥品在這個地點的帳上數量不給看（盲盤），由服務層遮掉。
 */
export type StocktakeStatus = 'counting' | 'submitted' | 'posted' | 'cancelled'

export interface StocktakeLine {
  id: string
  drugId: string
  /** 帳上的批號（清點時才發現、帳上沒有的批號為空，過帳時新建） */
  lotId?: string
  lotNo: string
  expiry: string
  counted?: number
  countedBy?: string
  countedAt?: string
  /** 清點那一刻的帳上數量（服務層記下；清點中不給看）。差異＝counted − systemQty */
  systemQty?: number
  /** 覆核時寫的差異原因 */
  reason?: string
  /** 過帳產生的調整異動 */
  txnId?: string
}

export interface StocktakeSheet {
  id: string
  /** 單號：PD20261112-01 */
  no: string
  locationId: string
  scope: { kind: 'all' } | { kind: 'category'; category: string } | { kind: 'drugs'; drugIds: string[] }
  status: StocktakeStatus
  lines: StocktakeLine[]
  createdBy: string
  createdAt: string
  submittedBy?: string
  submittedAt?: string
  reviewedBy?: string
  reviewedAt?: string
  /** 退回重盤的紀錄（覆核者、時間、原因） */
  returns?: { by: string; at: string; reason: string }[]
  cancelledBy?: string
  cancelledAt?: string
  cancelReason?: string
}

/**
 * 採購單：藥師開單（草稿）→ 送出 → 管理員核准（或退回草稿、寫原因）→ 已訂購 → 分批到貨（對品項入批號效期）
 * → 全部到齊自動「已到齊」；短交可手動結案（寫原因）；還沒到貨前可取消（寫原因）。
 * 到貨進「採購入庫」的地點（小型＝藥局、大型＝藥庫）。進價只記在採購單上（顯示採購金額），不做庫存成本計價。
 */
export type PurchaseStatus = 'draft' | 'pending' | 'ordered' | 'received' | 'closed' | 'cancelled'

export interface PurchaseLine {
  id: string
  drugId: string
  qty: number
  /** 進價（每調劑單位，元） */
  unitCost: number
  /** 由哪一張補貨申請帶入（追溯「為什麼買」；到貨時照常沖銷那張申請） */
  restockId?: string
  receivedQty: number
  /** 這一行到貨入庫的庫存異動 */
  txnIds: string[]
}

/**
 * 供應商主檔：採購單只能選這裡有的、啟用中的。以前供應商是文字欄位，同一家打成兩種寫法就分成兩家，
 * 也查不出「這家以前賣多少」。只能停用、不能刪除（舊採購單指向它）
 */
export interface Supplier {
  id: string
  name: string
  /** 統一編號（8 碼，有檢查碼；選填——個人藥商可能沒有） */
  taxId?: string
  contact?: string
  phone?: string
  note?: string
  active: boolean
  createdAt: string
  updatedAt?: string
}

export interface PurchaseOrder {
  id: string
  /** 單號：PO20261112-01 */
  no: string
  supplierId: string
  /** 開單（存草稿）當時的供應商名稱：單據是文件，供應商之後改名，舊單仍印當時的名稱 */
  supplier: string
  expectedDate?: string
  note?: string
  status: PurchaseStatus
  /** 入庫地點（核准時決定＝採購入庫的地點） */
  locationId: string
  lines: PurchaseLine[]
  createdBy: string
  createdAt: string
  submittedAt?: string
  approvedBy?: string
  approvedAt?: string
  /** 被退回的紀錄（管理員、時間、原因） */
  rejections?: { by: string; at: string; reason: string }[]
  closedBy?: string
  closedAt?: string
  /** 短交結案或取消的原因 */
  closeReason?: string
}

/**
 * 撥補單（大型醫院）：藥局向藥庫請領 → 藥庫依 FEFO 撥發（運送中，藥庫已扣、藥局還沒入）→ 藥局逐批簽收才入帳。
 * 簽收數量可以少於撥發（短少要寫原因：破損、遺失…）；運送中的藥不屬於任何地點。
 */
/** approved 只有退回藥庫有：藥庫同意了、藥局還沒送出 */
export type TransferStatus = 'requested' | 'approved' | 'issued' | 'received' | 'cancelled'

export interface TransferLine {
  id: string
  drugId: string
  /** 請領數量 */
  qty: number
  /** 由哪一張補貨申請帶入（門診藥局缺藥、病人在等）；簽收時沖銷 */
  restockId?: string
  /** 實際撥發的數量（藥庫不夠可以少撥；0＝這次沒撥） */
  issuedQty?: number
  /**
   * 撥發的批號（批號、效期跟著藥走）；簽收時逐批填實收。
   * 退回藥庫簽收時逐批決定 disposition：stock 入可用庫存、quarantine 放待報廢區、rejected 拒收退回原藥局
   */
  lots?: {
    lotNo: string
    expiry: string
    /** 撥發（送出）的量；退回申請中＝申請退的量 */
    qty: number
    receivedQty?: number
    disposition?: ReturnDisposition
    /** 退回藥庫：申請退多少、藥庫同意收多少（送出後 qty 是實際送的） */
    requestedQty?: number
    approvedQty?: number
  }[]
  /** 簽收短少的原因 */
  shortReason?: string
  /** 退回藥庫：拒收的原因（這一行有拒收的批號時） */
  rejectReason?: string
  /** 退回藥庫：審核時少收、不收的原因 */
  declineReason?: string
  /** 退回藥庫：送出時批號已經用掉（照少的送）的說明 */
  shipNote?: string
}

export type ReturnDisposition = 'stock' | 'quarantine' | 'rejected'

export interface TransferOrder {
  id: string
  /** 單號：TR20261112-01 */
  no: string
  /**
   * return＝藥局退回藥庫（近效期、請領過多、停用…）：藥局逐批申請（不扣帳）→ 藥庫審核（逐批同意、少收、不收）→
   * 藥局送出才扣（運送中）→ 藥庫簽收才入（仍可逐批入庫、待報廢、拒收）。
   * 沒有＝一般撥補（藥局請領 → 藥庫撥發 → 藥局簽收）
   */
  kind?: 'return'
  /** 退回原因（退回藥庫必填） */
  returnReason?: string
  fromLocationId: string
  toLocationId: string
  status: TransferStatus
  lines: TransferLine[]
  note?: string
  requestedBy: string
  requestedAt: string
  /** 退回藥庫：藥庫審核同意 */
  approvedBy?: string
  approvedAt?: string
  issuedBy?: string
  issuedAt?: string
  receivedBy?: string
  receivedAt?: string
  cancelledBy?: string
  cancelledAt?: string
  cancelReason?: string
}

/** 某地點對某藥的安全庫存（沒設定就用藥品主檔的 safetyStock） */
export interface SafetyStock {
  locationId: string
  drugId: string
  qty: number
}

export type RestockStatus = 'open' | 'fulfilled' | 'cancelled'

/**
 * 補貨申請（U25）：調劑窗口缺藥時，藥師提出申請；貨到了在藥品庫存頁「到貨入庫」（要有批號、效期）。
 * 以前窗口的「補貨」直接開進貨單——病人在窗口等，藥師卻要憑空打一個批號和效期。
 * 同一種藥同時只有一張「待到貨」的申請：再缺貨就把數量、等待的領藥單加上去，不另開一張。
 */
export interface RestockRequest {
  id: string
  drugId: string
  /** 申請數量（追加時累加） */
  qty: number
  /** 已到貨數量（可分批到貨） */
  receivedQty: number
  /** 為了哪些調劑單（等著領藥的病人） */
  dispenseIds: string[]
  note?: string
  requestedBy: string
  requestedAt: string
  status: RestockStatus
  /** 到貨入庫的庫存異動 id */
  txnIds: string[]
  closedAt?: string
  closedBy?: string
  cancelReason?: string
}

/**
 * 庫存異動（帳本）：庫存只能透過異動改變，每一筆增減都留下紀錄，像記帳一樣只增不改。
 * 目前庫存 = 所有異動的總和；drug.stock 只是方便查詢的快取。
 */
export interface StockTxn {
  id: string
  drugId: string
  /** 發生在哪個地點；balance 是這個地點異動後的結存 */
  locationId: string
  at: string
  type: StockTxnType
  /** 增減數量：進貨為正、發藥為負 */
  qty: number
  /** 異動後結存 */
  balance: number
  /** 這筆異動動到哪些批號 */
  lots: { lotNo: string; qty: number }[]
  /** 來源單據，例：領藥號 */
  ref?: string
  /** 盤點調整原因 */
  reason?: string
  userId: string
  /** 給藥、發藥到哪位病人、哪位醫師開的（管制藥簿冊要列；舊資料沒有，簿冊從調劑單回推） */
  patientId?: string
  doctorId?: string
  /** 見證、覆核的人（點班、報廢、管制藥殘餘量銷毀） */
  witnessBy?: string
}

/**
 * 診斷證明書（醫師開立）：門診（encounterId）或住院（admissionId）。費用＝主檔「診斷證明書」自費價 × 份數，
 * 跟著那次的帳單收（門診批價、住院結帳）；收費後才能列印。收費前可改、可作廢；收費後內容鎖定，
 * 寫錯只能「作廢重開」（replaces：重開的不另收費）
 */
export interface MedicalCertificate {
  id: string
  /** 證明書字號：115 診字第 000123 號 */
  no: string
  patientId: string
  encounterId?: string
  admissionId?: string
  deptId: string
  doctorId: string
  /** 門診：應診日期；住院：住院期間（stayTo 是出院日，還沒出院就是開立日） */
  visitDate?: string
  stayFrom?: string
  stayTo?: string
  /** 病名（預設帶這次的診斷，可改；多行） */
  diagnoses: string
  /** 醫師囑言（例：宜休養三日） */
  advice: string
  /** 用途：請假、保險、其他 */
  purpose: string
  copies: number
  issuedAt: string
  updatedAt?: string
  /** 作廢重開的新證明書：原本那張的 id（不另收費） */
  replaces?: string
  voided?: { at: string; by: string; reason: string; replacedBy?: string }
  /** 列印紀錄（誰、何時） */
  printed?: { at: string; by: string }[]
}

/** 交互作用、重複用藥提醒的嚴重度：嚴重＝要寫原因才能開；注意＝確認即可（規則見 services/interaction-rules.ts） */
export type RxAlertLevel = 'severe' | 'caution'

/** 醫師確認過的交互作用、重複用藥提醒（存在病歷／住院醫囑上，藥師看得到） */
export interface RxAlertRecord {
  key: string
  level: RxAlertLevel
  title: string
  text: string
  /** 另一個藥是病人還在吃的：哪裡開的、還有幾天 */
  other?: string
  /** 嚴重的必填；注意的可空白 */
  reason: string
}
