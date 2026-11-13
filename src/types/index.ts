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
export type Period = 'AM' | 'PM' | 'NIGHT'
export type Role = 'admin' | 'doctor' | 'nurse' | 'pharmacist' | 'clerk'

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
export interface CopayValues {
  /** 門診基本部分負擔（元） */
  basicCopay: number
  drugCopayFreeUpTo: number
  drugCopayStep: number
  drugCopayPerStep: number
  drugCopayMax: number
}

/** 部分負擔參數：欄位是最早的值；之後的調整在 changes（某天起整組參數），某天的值用 billing.copayOn(設定, 日期) 查 */
export interface BillingSettings extends CopayValues {
  changes?: (DatedChange & CopayValues)[]
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
export interface Visit {
  id: string
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
}

export interface ChargeLine {
  /** discount：優免（負數，病人自付欄） */
  kind: 'reg' | 'copay-basic' | 'copay-drug' | 'drug' | 'procedure' | 'consult' | 'self' | 'discount'
  name: string
  qty: number
  /** 單價（元或點） */
  unitPrice: number
  amount: number
  /** 是否由病患自付（否則為健保申報點數） */
  patientPay: boolean
}

export type PayMethod = 'cash' | 'card' | 'mobile'

/** 門診批價結帳紀錄 */
export interface Charge {
  id: string
  visitId: string
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
  /** 這張收據扣抵了多少掛號預收款（批價時「本次應收」＝ patientTotal − 這個） */
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
  pickupCheck?: { method: 'birth' | 'proxy'; proxyName?: string; relation?: string }
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
  active: boolean
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
}

export type AdmissionStatus = 'reserved' | 'admitted' | 'discharged' | 'cancelled'

export interface Admission {
  id: string
  /** 住院號 */
  admitNo: string
  patientId: string
  fromVisitId?: string
  deptId: string
  doctorId: string
  bedId?: string
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
  /** 出院轉歸：辦理出院時從醫師簽署的病摘帶入 */
  dischargeType?: string
  /**
   * 主治醫師變更紀錄（只增不改）：醫師離職、休假交班時由住院中心變更。
   * 選用欄位：舊資料沒有它表示從未變更。已開立的醫囑不受影響——醫囑記的是「當時誰開的」。
   */
  attendingHistory?: { from: string; to: string; at: string; by: string; reason: string }[]
  /** 轉科紀錄（只增不改）：原科申請 → 新科接受／婉拒，或原科撤回。同一時間最多一筆 pending */
  deptTransfers?: DeptTransfer[]
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
  admissionId: string
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
  /** 會診醫師建議轉入本科 */
  suggestTransfer?: boolean
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
}

export type IpdOrderCategory = 'medication' | 'nursing' | 'diet' | 'procedure'

/** 住院醫囑 */
export interface IpdOrder {
  id: string
  admissionId: string
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
  /** 會診醫師開的（哪一張會診單）：主治要按「已閱」 */
  consultId?: string
  consultSeenAt?: string
  consultSeenBy?: string
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
  /** 疼痛分數 0-10 */
  pain?: number
  /** 輸入 / 輸出量 ml */
  intake?: number
  output?: number
  nurseId: string
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
  kind?: 'transferOut' | 'transferIn' | 'consult' | 'consultReply'
  items?: { label: string; text: string }[]
  subjective: string
  objective: string
  assessment: string
  plan: string
}

/** 交班紀錄 */
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
