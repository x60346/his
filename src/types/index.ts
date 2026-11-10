// HIS 展示系統的領域型別。所有 mock 資料表與服務層都以此為契約。

export type Gender = 'M' | 'F'
export type Period = 'AM' | 'PM' | 'NIGHT'
export type Role = 'admin' | 'doctor' | 'nurse' | 'pharmacist' | 'clerk'

/** 系統使用者（展示用帳號，密碼明文存於 mock） */
export interface User {
  id: string
  username: string
  password: string
  name: string
  role: Role
  /** 角色為醫師時對應的醫師 id */
  doctorId?: string
  active: boolean
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
  /** 掛號費（元） */
  regFee: number
  /** 是否免除基本與藥品部分負擔 */
  copayExempt: boolean
  /** 是否為自費身分（不走健保） */
  selfPay: boolean
}

/**
 * 收費參數：規則（怎麼算）寫在 billing.ts 的純函式，參數（算多少）放在這裡由管理員維護。
 * 藥品部分負擔：健保藥費 ≤ drugCopayFreeUpTo 免收；超過後每 drugCopayStep 元加收 drugCopayPerStep 元，上限 drugCopayMax。
 */
export interface BillingSettings {
  /** 門診基本部分負擔（元） */
  basicCopay: number
  drugCopayFreeUpTo: number
  drugCopayStep: number
  drugCopayPerStep: number
  drugCopayMax: number
  updatedAt?: string
  updatedBy?: string
}

/** 醫師每週固定門診表（產生每日診次的範本） */
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
  calledAt?: string
  /** 退掛原因（病人自行退掛時為空；停診時系統填入） */
  cancelReason?: string
  /** 停診退掛後，已電話通知病人的時間 */
  notifiedAt?: string
  /** 記錄「已通知」的人（使用者 id）；撤銷時與 notifiedAt 一起清掉，撤銷經過留在稽核紀錄 */
  notifiedBy?: string
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
}

/** 處置 / 檢驗 / 影像醫令 */
export interface ProcedureOrder {
  procId: string
  qty: number
  selfPay: boolean
  note?: string
}

export type EncounterStatus = 'draft' | 'completed'

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
  kind: 'reg' | 'copay-basic' | 'copay-drug' | 'drug' | 'procedure' | 'consult' | 'self'
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
}

export type DispenseStatus = 'pending' | 'verified' | 'dispensed'

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
  createdAt: string
}

export type DrugCategory = '口服' | '外用' | '注射' | '吸入' | '眼用'

export interface Drug {
  id: string
  /** 健保藥品代碼 */
  nhiCode: string
  name: string
  generic: string
  spec: string
  unit: string
  category: DrugCategory
  /** 健保單價（點） */
  nhiPrice: number
  /** 自費單價（元） */
  selfPrice: number
  stock: number
  safetyStock: number
  defaultDose: number
  defaultFreq: string
  defaultRoute: string
  /** 是否為高警訊藥品 */
  highAlert: boolean
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
  /** 健保點數 */
  points: number
  /** 自費價（元） */
  selfPrice: number
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
  dischargeSummary?: string
  /** 出院轉歸：治癒出院、轉院、自動出院… */
  dischargeType?: string
  /**
   * 主治醫師變更紀錄（只增不改）：醫師離職、休假交班時由住院中心變更。
   * 選用欄位：舊資料沒有它表示從未變更。已開立的醫囑不受影響——醫囑記的是「當時誰開的」。
   */
  attendingHistory?: { from: string; to: string; at: string; by: string; reason: string }[]
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
  startAt: string
  stopAt?: string
  status: 'active' | 'stopped' | 'done'
  doctorId: string
  createdAt: string
}

/** 給藥紀錄（MAR） */
export interface MarRecord {
  id: string
  orderId: string
  admissionId: string
  /** 預計給藥時間 YYYY-MM-DD HH:mm */
  scheduledAt: string
  status: 'pending' | 'given' | 'held' | 'refused'
  executedAt?: string
  nurseId?: string
  note?: string
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
  action: string
  detail: string
}

/** 藥品批號：同一種藥分批進貨，各批效期不同；發藥時先發最早到期的（FEFO） */
export interface DrugLot {
  id: string
  drugId: string
  lotNo: string
  /** 效期 YYYY-MM-DD */
  expiry: string
  /** 此批剩餘數量（調劑單位） */
  qty: number
  receivedAt: string
}

export type StockTxnType = 'opening' | 'receive' | 'dispense' | 'adjust'

/**
 * 庫存異動（帳本）：庫存只能透過異動改變，每一筆增減都留下紀錄，像記帳一樣只增不改。
 * 目前庫存 = 所有異動的總和；drug.stock 只是方便查詢的快取。
 */
export interface StockTxn {
  id: string
  drugId: string
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
}
