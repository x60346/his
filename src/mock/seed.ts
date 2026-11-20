// 產生展示資料：以「今天」為基準，讓任何時候開啟都有今日門診、住院中病人等情境。
// 使用固定種子的亂數，每次重置結果相同。所有人名、證號皆為虛構。
import type {
  SerumIndices, RoomDowntime, ScanMismatch, FollowUpAdvice, Incident, DispenseMismatch, AbxIntervention, CultureSpecimen, CultureIsolate, SirResult, AdrReport, HomeMed, DischargeSummary, PharmCareNote, Specimen, QcRun, ImagingExam, LabCheckin, AnalyzerResult,
  DnrRecord, Isolation, BloodUnit, BloodRequest, Abo, BloodProduct, Surgery, SurgeryPrepMark, SterileBatch, InstrumentPack, PackSet, ImplantLot, LabWindowSession, ClaimSubmission, ClaimExclusion, ClaimCut, ClaimItem, PreAuth, ImplantCardPrint, PreAnesthesia, AnesEntry, PacuScore, TeamShift, PostopSet, PadssScore, LineDevice, NutritionScreen, NutritionAssessment, DeliriumAssessment, Restraint, NurseShift, NurseAssignment, DischargePlan, ShiftRequest, PcaOrder, PcaRecord, InfectionCase, InfusionRun, Wound, WoundCare, WeanTrial, IcuRequest, RrtCall, CodeBlue, PalliativeCase, PressureLog, ClusterDecision, NotifiableReport,
  RiskAssessment, RiskReason, RiskScale,
  Room,
  Admission,
  Bed,
  Charge,
  ClinicSession,
  Dispense,
  DrugLot,
  Encounter,
  HandoverNote,
  IpdOrder,
  MarRecord,
  MedicationOrder,
  NursingNote,
  OrderSet,
  Drug,
  DrugTiming,
  Phrase,
  TransferOrder,
  UdDispense,
  UdLine,
  PurchaseOrder,
  Supplier,
  SafetyStock,
  StockLocation,
  HospitalScale,
  PriceChange,
  Patient,
  Period,
  PreventRecord,
  ProcedureOrder,
  ProgressNote,
  StockTxn,
  RestockRequest,
  User,
  Visit,
  VitalRecord,
  WeeklySlot,
  Consult,
  WardStockItem,
  WardCount,
  Gender,
  LabItemDef,
  LabReport,
  ImagingReport,
  MedicalCertificate,
} from '@/types'
import { addDays, addMinutes, ageOf, diffDays, now, parseDate, toDateStr, today } from '@/utils/date'
import { autoQty, calcChargeLines, calcIpdChargeLines, ipdDays, IPD_COPAY_DEFAULT, summarize } from '@/services/billing'
import { checkAllergies } from '@/services/allergy'
import { checkEligibility, withDerivedFields } from '@/services/prevent-rules'
import { ventText } from '@/services/vent-rules'
import { allocateFefo, suggestRestockQty, usableQty } from '@/services/stock-rules'
import { udPerDose } from '@/services/ud-rules'
import { effectiveTiming, marTimes, timingApplies } from '@/services/drug-rules'
import { makeIdNo } from '@/utils/validators'
import { buildLabValues } from '@/services/lab-rules'
import { SELF_COLLECT_TUBES } from '@/services/specimen-rules'
import { laneOf, priorityOf } from '@/services/lab-queue-rules'
import { riskLevel, riskScore } from '@/services/risk-rules'
import { dietKindOfText, nutritionScore } from '@/services/nutrition-rules'
import { ABX_REASON_LABEL } from '@/services/abx-rules'
import { shiftPlan } from '@/services/or-shift-rules'
import { ipdCategories, ipdClaimPoints, linePoints } from '@/services/claim-rules'
import { drgProcsOf, drgExempt, groupDrg, historyFrom, mainDiagnosisFrom, secondaryFrom } from '@/services/drg-rules'
import { biDueAt, expiresOnOf, PACK_CONTENTS, PACK_SETS } from '@/services/sterile-rules'
import { homeMedsFromOpd } from '@/services/medrec-rules'
import { QC_ANALYTES } from '@/services/qc-rules'
import { autoVerify, qcFailedCodes } from '@/services/analyzer-rules'
import * as codes from './codes'
import type { Database } from './db'

// ---------- 亂數 ----------
function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------- 臨床情境範本 ----------
interface Scenario {
  dept: string
  icd: string[]
  s: string
  o: string
  a: string
  p: string
  /** 第 5 欄：醫師為這張處方指定的服用時機（示範用，沒有＝照主檔） */
  meds: [drugId: string, dose: number, freq: string, days: number, timing?: DrugTiming][]
  procs?: string[]
  caseType?: string
}

const scenarios: Scenario[] = [
  {
    dept: 'D01', icd: ['J06.9'], s: '喉嚨痛、流鼻水 3 天，輕微咳嗽，無發燒。', o: '咽部輕度紅腫，肺音清。', a: '急性上呼吸道感染', p: '症狀治療，多喝水，3 天未改善回診。',
    meds: [['M001', 1, 'TID', 3], ['M007', 1, 'HS', 3], ['M010', 1, 'TID', 3]],
  },
  {
    dept: 'D01', icd: ['J20.9', 'R05.9'], s: '咳嗽一週，有痰，夜間咳嗽加劇。', o: '兩側肺部少許囉音，無喘鳴。', a: '急性支氣管炎', p: '化痰止咳，安排胸部 X 光。',
    meds: [['M009', 1, 'TID', 5], ['M010', 1, 'TID', 5]], procs: ['P013'],
  },
  {
    dept: 'D02', icd: ['I10', 'E78.5'], s: '定期追蹤血壓，自述在家量 135/85 左右，無頭暈胸悶。', o: 'BP 138/86，心律規則。', a: '高血壓、高血脂控制尚可', p: '續用原藥，三個月後抽血追蹤血脂。',
    meds: [['M012', 1, 'QD', 28], ['M018', 1, 'HS', 28]], caseType: '04',
  },
  {
    dept: 'D02', icd: ['E11.9', 'I10'], s: '糖尿病追蹤，飲食控制中，偶有口渴。', o: 'AC sugar 142 mg/dL。', a: '第二型糖尿病，血糖控制略高', p: '調整 Metformin：隨餐服用仍胃脹，改飯後。衛教飲食，追蹤 HbA1c。',
    meds: [['M015', 1, 'BID', 28, 'PC'], ['M016', 1, 'QD', 28], ['M013', 1, 'QD', 28]], procs: ['P004', 'P005'], caseType: '04',
  },
  {
    dept: 'D02', icd: ['K21.9'], s: '胸口灼熱感、飯後胃酸逆流兩週。', o: '上腹部輕壓痛。', a: '胃食道逆流', p: '制酸劑治療，避免睡前進食。',
    meds: [['M022', 1, 'QD', 14], ['M025', 1, 'TID', 7]],
  },
  {
    dept: 'D04', icd: ['J00', 'R50.9'], s: '發燒 38.5 度一天，流鼻水，食慾稍差。', o: '咽部紅，耳膜正常，肺音清。', a: '感冒併發燒', p: '退燒、症狀治療，觀察精神食慾。',
    meds: [['M001', 0.5, 'Q6H', 3], ['M007', 0.5, 'HS', 3]],
  },
  {
    dept: 'D06', icd: ['M17.11'], s: '右膝疼痛半年，上下樓梯加劇。', o: '右膝活動角度受限，關節摩擦音(+)。', a: '右膝退化性關節炎', p: '止痛消炎，安排膝關節 X 光與物理治療。',
    meds: [['M030', 1, 'BID', 14], ['M032', 1, 'TID', 14]], procs: ['P014', 'P025'],
  },
  {
    dept: 'D06', icd: ['M54.5'], s: '搬重物後下背痛 2 天，無下肢麻木。', o: '腰椎旁肌肉壓痛，直腿抬高測試(-)。', a: '急性下背痛', p: '止痛、肌肉放鬆，熱敷，避免提重物。',
    meds: [['M002', 1, 'TID', 5], ['M024', 1, 'TID', 5]], procs: ['P025'],
  },
  {
    dept: 'D07', icd: ['J30.9', 'J01.90'], s: '鼻塞、黃鼻涕、臉頰脹痛一週。', o: '鼻黏膜腫脹，膿性分泌物。', a: '急性鼻竇炎', p: '抗生素治療 7 天，鼻腔局部治療。',
    meds: [['M004', 1, 'BID', 7], ['M011', 1, 'TID', 7]], procs: ['P024'],
  },
  {
    dept: 'D03', icd: ['S61.411A'], s: '切菜不慎割傷右手掌。', o: '右手掌 2 cm 撕裂傷，無肌腱外露。', a: '右手撕裂傷', p: '清創縫合，三天後換藥，7 天拆線。',
    meds: [['M005', 1, 'QID', 3], ['M001', 1, 'TID', 3]], procs: ['P019'],
  },
  {
    dept: 'D05', icd: ['N94.6'], s: '經痛，月經第一天腹部絞痛。', o: '下腹輕壓痛，無反彈痛。', a: '原發性經痛', p: '止痛藥，熱敷。',
    meds: [['M002', 1, 'TID', 3]],
  },
  {
    dept: 'D08', icd: ['M75.100'], s: '右肩舉手疼痛一個月。', o: '右肩外展 90 度疼痛。', a: '右肩旋轉肌袖症候群', p: '物理治療每週三次。',
    meds: [['M032', 1, 'TID', 14]], procs: ['P026'],
  },
]

// ---------- 病患 ----------
// [姓名, 性別, 年齡, 身分, 過敏, 家族史, 吸菸, 檳榔]
type PatientRow = [string, 'M' | 'F', number, string, string[], string[], boolean, boolean]
const patientRows: PatientRow[] = [
  ['王志明', 'M', 58, '01', [], ['高血壓'], true, false],
  ['李美玲', 'F', 47, '01', ['Penicillin'], ['乳癌'], false, false],
  ['張家豪', 'M', 35, '01', [], [], true, true],
  ['陳淑芬', 'F', 66, '01', [], ['糖尿病', '心臟病'], false, false],
  ['林俊傑', 'M', 72, '02', ['Aspirin'], ['中風'], true, false],
  ['黃雅琪', 'F', 31, '01', [], [], false, false],
  ['吳宗翰', 'M', 5, '01', [], [], false, false],
  ['劉怡君', 'F', 52, '01', [], ['大腸癌'], false, false],
  ['蔡明哲', 'M', 63, '04', [], ['肺癌'], true, false],
  ['楊佩珊', 'F', 41, '01', ['NSAIDs'], ['乳癌'], false, false],
  ['許文彬', 'M', 49, '01', [], ['高血壓'], false, true],
  ['鄭惠如', 'F', 78, '03', [], ['高血壓', '糖尿病'], false, false],
  ['謝承翰', 'M', 2, '06', [], [], false, false],
  ['郭欣怡', 'F', 28, '01', [], [], false, false],
  ['洪志強', 'M', 55, '05', ['Sulfa'], ['腎臟病'], true, false],
  ['曾秀英', 'F', 69, '01', [], ['肺癌'], false, false],
  ['邱冠宇', 'M', 44, '01', [], [], true, false],
  ['廖思妤', 'F', 8, '01', [], [], false, false],
  ['賴建宏', 'M', 61, '01', [], ['糖尿病'], false, false],
  ['周婉婷', 'F', 36, '01', ['海鮮'], [], false, false],
  ['葉國華', 'M', 81, '02', [], ['心臟病'], false, false],
  ['蘇雅文', 'F', 57, '01', [], ['大腸癌', '高血壓'], false, false],
  ['莊凱文', 'M', 24, '09', [], [], false, false],
  ['呂玉珍', 'F', 74, '04', ['Cephalosporin'], ['中風'], false, false],
  ['江柏諺', 'M', 0, '06', [], [], false, false],
  ['何麗華', 'F', 63, '01', [], ['肝癌'], false, false],
  ['羅志偉', 'M', 50, '01', [], ['肺癌'], true, false],
  ['高靜宜', 'F', 45, '01', [], [], false, false],
  ['潘家銘', 'M', 67, '01', [], ['高血壓'], true, true],
  ['簡淑惠', 'F', 39, '01', [], [], false, false],
  ['朱信宏', 'M', 53, '01', ['顯影劑'], [], false, false],
  ['彭美華', 'F', 85, '03', [], ['糖尿病'], false, false],
  ['范子軒', 'M', 12, '01', [], [], false, false],
  ['董雅惠', 'F', 60, '01', [], ['乳癌'], false, false],
  ['沈俊宏', 'M', 46, '01', [], [], false, true],
  ['田佳蓉', 'F', 33, '01', [], [], false, false],
]

const areaLetters = ['D', 'R', 'E', 'S', 'B', 'A']
const streets = ['中山路', '民生路', '府前路', '東門路', '健康路', '永華路', '大同路', '北門路']
const relatives = ['配偶', '兒子', '女兒', '父親', '母親']

export function buildSeed(opts: { scale?: HospitalScale } = {}): Database {
  const scale: HospitalScale = opts.scale ?? 'small'
  const rand = mulberry32(20240501)
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]
  const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1))

  const T = today()
  const nowStr = now()
  /**
   * 展示資料不能出現「未來」的事：早上 8 點打開系統，不該已經有 10:30 的發藥紀錄。
   * 超過現在的時間，往回推到「現在 − back 分鐘」；back 依流程先後遞減，保持 掛號 < 看診 < 批價 < 發藥 的順序。
   */
  const notFuture = (at: string, back: number) => (at > nowStr ? addMinutes(nowStr, -back) : at)
  const pad2 = (n: number) => String(n).padStart(2, '0')
  /**
   * 一次就醫的流程時間：掛號 → 叫號 → 完成看診 → 批價 → 發藥，依序往後排（間隔是門診常見的分鐘數）。
   * 以前批價固定寫「掛號那個小時＋1 的 10 分」，看診完成卻可能在掛號後 40 分鐘——會出現「還沒看完就先付錢」
   */
  const flowFrom = (reg: string, wait: number) => {
    const call = addMinutes(reg, wait)
    const done = addMinutes(call, int(8, 15))
    const paid = addMinutes(done, int(3, 10))
    const disp = addMinutes(paid, int(5, 15))
    return { reg, call, done, paid, disp }
  }
  type Flow = ReturnType<typeof flowFrom>
  /** 預約掛號的建立時間：前幾天的白天（不是今天、更不是未來） */
  const pastBooking = () => `${addDays(T, -int(1, 6))} ${pad2(int(9, 17))}:${pad2(int(0, 59))}`
  const counters: Record<string, number> = {}
  const next = (key: string) => (counters[key] = (counters[key] ?? 0) + 1)
  let idn = 0
  const id = (prefix: string) => `${prefix}${String(++idn).padStart(5, '0')}`

  // ---------- 使用者 ----------
  const users: User[] = [
    { id: 'U001', username: 'admin', password: '1234', name: '系統管理員', roles: ['admin'], active: true },
    ...codes.doctors.map((d, i): User => ({
      id: `U1${String(i + 1).padStart(2, '0')}`, username: `dr${String(i + 1).padStart(2, '0')}`, password: '1234',
      name: d.name, roles: ['doctor'], doctorId: d.id, active: true,
      // dr01：被指定維護全院（醫師）片語（示範：醫療部主任）、安寧共同照護（家醫科）
      ...(i === 0 ? { grants: ['phrase.hospital', 'palliative'] } : {}),
      // dr11（感染科）：被指定「感染管制」，判定院內感染個案
      ...(d.id === 'DR11' ? { grants: ['infection.control'] } : {}),
      // dr03（內科）：被指定「加護病房主治」，同意轉入、排加護病房的床
      ...(d.id === 'DR03' ? { grants: ['icu.attending', 'rrt', 'anesthesia'] } : {}),
      // dr02（內科主任）：被指定「死亡病例審查」
      ...(d.id === 'DR02' ? { grants: ['mortality.review'] } : {}),
      // dr10（放射科）：沒有病理科，被指定「病理」代表病理醫師發報告
      ...(d.id === 'DR10' ? { grants: ['pathology'] } : {}),
    })),
    { id: 'U201', username: 'nurse01', password: '1234', name: '周怡萱', roles: ['nurse'], active: true },
    // nurse02：被指定維護全院（護理）片語（示範：護理部督導）
    { id: 'U202', username: 'nurse02', password: '1234', name: '孫佩君', roles: ['nurse'], active: true, grants: ['phrase.hospital', 'surgery.schedule', 'nursing.schedule', 'incident.review'] },
    // 排班用的護理師（nurse03–nurse12）：不參與舊的示範資料
    ...['林佳穎', '陳怡君', '黃詩涵', '張雅婷', '吳欣怡', '劉靜宜', '蔡佩珊', '楊淑芬', '許雅雯', '鄭宜蓁'].map((name, i): User => ({ id: `U${203 + i}`, username: `nurse${String(3 + i).padStart(2, '0')}`, password: '1234', name, roles: ['nurse'], active: true, ...(i === 0 ? { grants: ['discharge.plan'] } : {}) })),
    // 加護病房的護理師（nurse13–nurse16）：只排加護病房
    ...['謝宛庭', '洪郁婷', '曾雅琪', '賴思妤'].map((name, i): User => ({ id: `U${213 + i}`, username: `nurse${13 + i}`, password: '1234', name, roles: ['nurse'], active: true })),
    { id: 'U301', username: 'ph01', password: '1234', name: '方建志', roles: ['pharmacist'], active: true },
    // 第二位藥師：盤點單「清點的人不能自己覆核」，要有另一位藥師可以覆核（小診所沒有的話由管理員覆核）
    { id: 'U302', username: 'ph02', password: '1234', name: '林雅婷', roles: ['pharmacist'], active: true },
    { id: 'U401', username: 'clerk01', password: '1234', name: '馬文琪', roles: ['clerk'], active: true, grants: ['coding'] },
    // 櫃台組長：可核准優免（「專案減免」要主管核准：clerk01 結帳時請 clerk02 輸入帳密）
    { id: 'U402', username: 'clerk02', password: '1234', name: '鄭淑芬', roles: ['clerk'], active: true, grants: ['charge.approveDiscount', 'nhi.claim'] },
    // 小診所常見：跟診護理兼櫃台掛號批價（多角色，登入時選、右上角切換）
    { id: 'U501', username: 'staff01', password: '1234', name: '陳小芬', roles: ['nurse', 'clerk'], active: true },
    // 長期沒登入的櫃台（示範「密碼過期太久鎖帳號」：130 天前設定的密碼，90 天到期、過期 40 天 > 寬限 30 天）
    { id: 'U403', username: 'clerk03', password: '1234', name: '呂佳蓉', roles: ['clerk'], active: true },
    // 醫檢師：登打檢驗結果、發報告
    { id: 'U601', username: 'lab01', password: '1234', name: '何宜蓁', roles: ['lab'], active: true, grants: ['lab.limits', 'pathology'] },
    { id: 'U602', username: 'lab02', password: '1234', name: '鄭宇翔', roles: ['lab'], active: true },
    { id: 'U701', username: 'diet01', password: '1234', name: '溫若瑜', roles: ['diet'], active: true },
    { id: 'U801', username: 'rt01', password: '1234', name: '鍾承翰', roles: ['radtech'], active: true },
  ]
  // 密碼設定日：展示帳號都是今天（一開就要求改密碼會干擾展示）；nurse02 示範「快到期」——80 天前設定，90 天期限還剩 10 天，
  // 系統管理把期限改成 60 天就會變成「已過期」，登入後要先改密碼
  for (const u of users) u.passwordSetOn = u.username === 'nurse02' ? addDays(T, -80) : u.username === 'clerk03' ? addDays(T, -130) : T
  const doctorUser = (doctorId: string) => users.find((u) => u.doctorId === doctorId)!.id

  // ---------- 每週門診表 ----------
  // 家醫、內科、小兒科週日也有上午診，確保任何一天都有門診可展示
  const weeklySlots: WeeklySlot[] = []
  const room = (deptIdx: number, k: number) => `${deptIdx + 1}0${k + 1}`
  // 診間主檔：門診表用到的每一間。診間號第一碼就是樓層（201 在 2 樓），位置照這個寫，病人才不會被號碼和樓層搞混
  const rooms: Room[] = []
  const addRoom = (deptIdx: number, k: number) => {
    const roomNo = room(deptIdx, k)
    if (!rooms.some((x) => x.roomNo === roomNo)) rooms.push({ roomNo, location: `${roomNo[0]} 樓 ${codes.departments[deptIdx].name}區`, active: true })
  }
  codes.doctors.forEach((d) => {
    // 放射科不看門診（判讀影像）：不排門診表，也不影響其他醫師的排班與種子
    if (['RAD', 'INF', 'ER'].includes(codes.departments.find((x) => x.id === d.deptId)?.code ?? '')) return
    const deptIdx = codes.departments.findIndex((x) => x.id === d.deptId)
    const sameDept = codes.doctors.filter((x) => x.deptId === d.deptId)
    const k = sameDept.indexOf(d)
    for (let wd = 0; wd <= 6; wd++) {
      const sundayOk = ['D01', 'D02', 'D04'].includes(d.deptId)
      if (wd === 0 && !sundayOk) continue
      const periods: Period[] = ['AM', 'PM']
      if ((wd === 2 || wd === 4) && k === 0) periods.push('NIGHT')
      for (const p of periods) {
        // 同科多位醫師時錯開時段
        if (sameDept.length > 1 && ((k === 0 && p === 'PM' && wd % 2 === 1) || (k === 1 && p === 'AM' && wd % 2 === 0))) continue
        addRoom(deptIdx, k)
        weeklySlots.push({ id: id('WS'), doctorId: d.id, weekday: wd, period: p, roomNo: room(deptIdx, k), limit: p === 'NIGHT' ? 30 : 50 })
      }
    }
  })

  const sessions: ClinicSession[] = []
  const sessionKey = (date: string, slotId: string) => `${date}#${slotId}`
  const sessionMap = new Map<string, ClinicSession>()
  const sessionsOn = (date: string): ClinicSession[] => {
    const wd = parseDate(date).getDay()
    return weeklySlots
      .filter((s) => s.weekday === wd)
      .map((slot) => {
        const key = sessionKey(date, slot.id)
        let s = sessionMap.get(key)
        if (!s) {
          const doc = codes.doctors.find((d) => d.id === slot.doctorId)!
          s = { id: `S${date.replace(/-/g, '')}${slot.id}`, date, period: slot.period, deptId: doc.deptId, doctorId: doc.id, roomNo: slot.roomNo, limit: slot.limit }
          sessionMap.set(key, s)
          sessions.push(s)
        }
        return s
      })
  }
  for (let i = -7; i <= 21; i++) sessionsOn(addDays(T, i))

  // ---------- 病患 ----------
  const thisYear = new Date().getFullYear()
  const patients: Patient[] = patientRows.map((r, i) => {
    const [name, gender, age, identity, allergies, family, smoking, betel] = r
    const birth = toDateStr(new Date(thisYear - age, int(0, 11), int(1, 28)))
    // 確保年齡與設定一致（生日尚未到則多減一年會使年齡偏小，這裡把生日放在今天之前）
    const b = parseDate(birth)
    const bd = new Date(thisYear - age, b.getMonth(), b.getDate())
    const birthDate = bd > new Date() ? toDateStr(new Date(thisYear - age - 1, b.getMonth(), b.getDate())) : toDateStr(bd)
    return {
      id: `PT${String(i + 1).padStart(4, '0')}`,
      chartNo: String(100001 + i),
      name, gender, birthDate,
      idNo: makeIdNo(pick(areaLetters), gender, int(0, 9999999)),
      phone: `09${int(10, 89)}-${int(100, 999)}-${int(100, 999)}`,
      address: `臺南市${pick(['中西區', '東區', '北區', '安平區', '永康區'])}${pick(streets)}${int(1, 300)}號`,
      bloodType: pick(['A', 'B', 'O', 'O', 'AB']) as Patient['bloodType'],
      allergies, familyHistory: family, smoking, betelNut: betel,
      defaultIdentity: identity,
      emergencyContact: `${name[0]}${pick(['小姐', '先生'])}（${pick(relatives)}）`,
      emergencyPhone: `09${int(10, 89)}-${int(100, 999)}-${int(100, 999)}`,
      note: '',
      createdAt: `${addDays(T, -int(200, 1500))} 09:00`,
    }
  })
  counters.chartNo = 100000 + patients.length

  // ---------- 門診就醫 ----------
  const visits: Visit[] = []
  const encounters: Encounter[] = []
  const charges: Charge[] = []
  const dispenses: Dispense[] = []
  const preventRecords: PreventRecord[] = []
  // 藥價調整示範（固定值、不抽亂數）：
  //   Amlodipine 3 天前起健保價 3.6 → 3.2：更早看診的收據是舊價、之後的是新價（批價依看診日）
  //   Metformin 下個月 1 日起 2 → 2.2：已排定、還沒生效，主檔清單會提示
  // 收據在下面用 drugMap 算，所以調價紀錄要在這裡就掛上去，和最後存進資料庫的藥品主檔同一份
  const nextMonthFirst = `${addDays(`${T.slice(0, 8)}01`, 32).slice(0, 8)}01`
  const priceDemo: Record<string, PriceChange[]> = {
    M012: [{ from: addDays(T, -3), nhiPrice: 3.2, selfPrice: 8, by: 'U001', at: `${addDays(T, -10)} 10:00` }],
    M015: [{ from: nextMonthFirst, nhiPrice: 2.2, selfPrice: 5, by: 'U001', at: `${addDays(T, -1)} 15:00` }],
  }
  const withPrices = (d: Drug): Drug => (priceDemo[d.id] ? { ...d, priceChanges: structuredClone(priceDemo[d.id]) } : d)
  const drugMap = new Map(codes.drugs.map((d) => [d.id, withPrices(d)]))
  const procMap = new Map(codes.procedures.map((p) => [p.id, p]))
  const identityMap = new Map(codes.identities.map((x) => [x.code, x]))
  const freqTimes = (f: string) => codes.frequencies.find((x) => x.code === f)?.timesPerDay ?? 1

  const makeVisit = (patient: Patient, session: ClinicSession, status: Visit['status'], createdAt: string, caseType = '01'): Visit => {
    const seqKey = `seq:${session.id}`
    const v: Visit = {
      id: id('V'), date: session.date, sessionId: session.id, deptId: session.deptId, doctorId: session.doctorId,
      patientId: patient.id, seqNo: next(seqKey), identityCode: patient.defaultIdentity, caseType,
      cardSeq: String(next(`cardseq:${patient.id}`)).padStart(4, '0'), status, firstVisit: false, preventItems: [],
      createdAt,
    }
    visits.push(v)
    return v
  }

  const makeEncounter = (v: Visit, sc: Scenario, flow?: Pick<Flow, 'call' | 'done'>): Encounter => {
    const completed = !!flow
    const pt = patients.find((p) => p.id === v.patientId)!
    // 展示資料也要遵守用藥安全：避開病人過敏的藥（與看診畫面使用同一個 checkAllergies 規則）
    const conflicts = new Set(checkAllergies(pt.allergies, sc.meds.map(([id]) => drugMap.get(id)!)).map((w) => w.drugId))
    const safeMeds = sc.meds.filter(([id]) => !conflicts.has(id))
    if (conflicts.size && !safeMeds.some(([id]) => id === 'M001')) safeMeds.push(['M001', 1, 'TID', sc.meds[0][3]])
    const meds: MedicationOrder[] = safeMeds.map(([drugId, dose, freq, days, timing]) => {
      const d = drugMap.get(drugId)!
      return { drugId, dose, freq, route: d.defaultRoute, days, qty: autoQty(d, dose, freqTimes(freq), days) ?? 1, selfPay: false, ...(timing ? { timing } : {}) }
    })
    const procs: ProcedureOrder[] = (sc.procs ?? []).map((procId) => ({ procId, qty: 1, selfPay: false }))
    const adult = pt.birthDate < addDays(T, -365 * 12)
    const completedAt = flow?.done
    // 有病歷就是叫過號：叫號時間在掛號之後、完成看診之前（以前沒填，掛號頁的「目前看到幾號」算不出來）
    const calledAfterReg = addMinutes(v.createdAt, 5)
    v.calledAt = flow ? flow.call : calledAfterReg > nowStr ? nowStr : calledAfterReg
    const e: Encounter = {
      id: id('E'), visitId: v.id, patientId: v.patientId, doctorId: v.doctorId, deptId: v.deptId, date: v.date,
      subjective: sc.s, objective: sc.o, assessment: sc.a, plan: sc.p,
      vitals: adult
        ? { height: int(150, 180), weight: int(48, 88), temp: 36 + int(2, 9) / 10, pulse: int(64, 96), sbp: int(112, 148), dbp: int(68, 92), spo2: int(95, 99) }
        : { height: int(80, 130), weight: int(10, 30), temp: 37 + int(0, 15) / 10, pulse: int(90, 120), spo2: int(96, 99) },
      diagnoses: sc.icd.map((code, i) => ({ icd: code, name: codes.icdCodes.find((c) => c.code === code)?.name ?? code, primary: i === 0 })),
      medications: meds, procedures: procs,
      refillTimes: sc.caseType === '04' ? 2 : 0, admissionRequested: false,
      status: completed ? 'completed' : 'draft',
      completedAt,
    }
    encounters.push(e)
    return e
  }

  const makeCharge = (v: Visit, e: Encounter, at: string): Charge => {
    const lines = calcChargeLines(v, e, {
      identity: identityMap.get(v.identityCode)!,
      settings: codes.billingSettings,
      drug: (x) => drugMap.get(x),
      procedure: (x) => procMap.get(x),
    })
    const sum = summarize(lines)
    const received = Math.ceil(sum.patientTotal / 100) * 100
    const c: Charge = {
      id: id('C'), visitId: v.id, patientId: v.patientId, lines, nhiPoints: sum.nhiPoints, patientTotal: sum.patientTotal,
      payMethod: 'cash', received, change: received - sum.patientTotal,
      receiptNo: `R${v.date.replace(/-/g, '')}${String(next(`receipt:${v.date}`)).padStart(4, '0')}`,
      cashierId: 'U401', paidAt: at, voided: false,
    }
    charges.push(c)
    return c
  }

  /** 調劑單在批價時建立（createdAt＝批價時間），核對、發藥在之後（doneAt） */
  const makeDispense = (v: Visit, e: Encounter, status: Dispense['status'], createdAt: string, doneAt = createdAt) => {
    const d: Dispense = {
      id: id('DP'), visitId: v.id, encounterId: e.id, patientId: v.patientId,
      pickupNo: next(`pickup:${v.date}`), status, createdAt,
      ...(status !== 'pending' ? { verifiedBy: 'U301', verifiedAt: doneAt } : {}),
      ...(status === 'dispensed' ? { dispensedBy: 'U301', dispensedAt: doneAt } : {}),
    }
    dispenses.push(d)
  }

  const scenarioFor = (deptId: string) => {
    const list = scenarios.filter((s) => s.dept === deptId)
    return list.length ? pick(list) : pick(scenarios.filter((s) => s.dept === 'D01'))
  }

  // 病患 0–23 參與門診；24 之後保留給住院
  const opdPatients = patients.slice(0, 24)

  /**
   * 科別要符合臨床常識：13 歲以下看小兒科、18 歲以上不掛小兒科、婦產科只給 12 歲以上女性。
   * 驗收時發現 63 歲男性預約了小兒科——隨機挑診次時沒有考慮病人是誰。
   */
  const ageAt = (pt: Patient, date: string) => ageOf(pt.birthDate, date)
  const deptFits = (pt: Patient, deptId: string, date: string) => {
    const age = ageAt(pt, date)
    if (age < 13) return deptId === 'D04'
    if (deptId === 'D04') return age < 18
    if (deptId === 'D05') return pt.gender === 'F'
    return true
  }
  /** 從當天的診次中，挑一個適合這位病人的；沒有就回傳 undefined（這天不排） */
  const sessionFor = (pt: Patient, list: ClinicSession[], prefer?: string) => {
    const ok = list.filter((s) => deptFits(pt, s.deptId, s.date))
    return ok.find((s) => s.deptId === prefer) ?? (ok.length ? pick(ok) : undefined)
  }

  // 歷史就醫（過去 180 天）
  opdPatients.forEach((pt) => {
    const times = int(1, 4)
    for (let k = 0; k < times; k++) {
      const date = addDays(T, -int(8, 180))
      const daySessions = sessionsOn(date)
      if (!daySessions.length) continue
      const session = sessionFor(pt, daySessions, pick(['D01', 'D02', 'D02', 'D06', 'D07', 'D03']))
      if (!session) continue
      const sc = scenarioFor(session.deptId)
      const flow = flowFrom(`${date} ${pad2(session.period === 'AM' ? int(8, 11) : int(13, 16))}:${pad2(int(0, 59))}`, int(5, 40))
      const v = makeVisit(pt, session, 'dispensed', flow.reg, sc.caseType)
      const e = makeEncounter(v, sc, flow)
      makeCharge(v, e, flow.paid)
      makeDispense(v, e, 'dispensed', flow.paid, flow.disp)
    }
  })

  // 近 6 天：每天 8–16 人次，讓首頁「近 7 日趨勢」有內容（每天每位病人最多一次）
  for (let k = 6; k >= 1; k--) {
    const date = addDays(T, -k)
    const daySessions = sessionsOn(date).filter((s) => s.period !== 'NIGHT')
    if (!daySessions.length) continue
    const pool = [...opdPatients].sort(() => rand() - 0.5).slice(0, int(8, 16))
    for (const pt of pool) {
      const session = sessionFor(pt, daySessions)
      if (!session) continue
      const sc = scenarioFor(session.deptId)
      const flow = flowFrom(`${date} ${pad2(session.period === 'AM' ? int(8, 11) : int(13, 16))}:${pad2(int(0, 59))}`, int(5, 40))
      const v = makeVisit(pt, session, 'dispensed', flow.reg, sc.caseType)
      const e = makeEncounter(v, sc, flow)
      makeCharge(v, e, flow.paid)
      makeDispense(v, e, 'dispensed', flow.paid, flow.disp)
    }
  }

  // 今日門診：分配到今天上午、下午診，各種狀態
  const todaySessions = sessionsOn(T).filter((s) => s.period !== 'NIGHT')
  const am = todaySessions.filter((s) => s.period === 'AM')
  const pm = todaySessions.filter((s) => s.period === 'PM')
  const amFirst = (deptId: string) => am.find((s) => s.deptId === deptId) ?? am[0]
  const pmFirst = (deptId: string) => pm.find((s) => s.deptId === deptId) ?? pm[0] ?? am[0]
  const todayPlan: [number, 'AM' | 'PM', string, Visit['status']][] = [
    [0, 'AM', 'D02', 'dispensed'],
    [1, 'AM', 'D01', 'dispensed'],
    [2, 'AM', 'D01', 'charged'],
    [3, 'AM', 'D02', 'charged'],
    [4, 'AM', 'D02', 'consulted'],
    [5, 'AM', 'D01', 'consulted'],
    [6, 'AM', 'D04', 'registered'],
    [7, 'AM', 'D01', 'registered'],
    [8, 'AM', 'D02', 'registered'],
    [9, 'AM', 'D01', 'registered'],
    [10, 'PM', 'D01', 'registered'],
    [11, 'PM', 'D02', 'registered'],
    [12, 'PM', 'D04', 'registered'],
    [13, 'PM', 'D01', 'registered'],
    [14, 'PM', 'D02', 'registered'],
    [15, 'PM', 'D01', 'registered'],
    [16, 'AM', 'D01', 'cancelled'],
  ]
  /**
   * 時間軸（B11）：每個診次依序排——上午 07:30 起掛號、08:30 起叫號，下午 13:00 起掛號、13:30 起叫號，每位約 12 分鐘。
   * 時間還沒到的步驟就還沒發生：清晨重建時沒有人看過診；九點時前幾位看完了但還沒批價。
   * 掛號時間還沒到的，是「之前就預約好的」（建立時間在前幾天）——以前一律拉回「現在−120 分」，整排同一個時間、下午診也在清晨掛號。
   */
  const opening = { AM: { reg: '07:30', call: '08:30' }, PM: { reg: '13:00', call: '13:30' } } as const
  const slotIndex = new Map<string, number>()
  const reached = (t: string) => t <= nowStr
  for (const [pi, period, dept, planned] of todayPlan) {
    const pt = opdPatients[pi]
    const session = period === 'AM' ? amFirst(dept) : pmFirst(dept)
    if (!session) continue
    const sc = scenarioFor(session.deptId)
    const j = slotIndex.get(session.id) ?? 0
    slotIndex.set(session.id, j + 1)
    const open = opening[session.period === 'PM' ? 'PM' : 'AM']
    const reg = addMinutes(`${T} ${open.reg}`, j * 6 + int(0, 4))
    const call = addMinutes(`${T} ${open.call}`, j * 12)
    const flow: Flow = { reg, call, done: addMinutes(call, 10), paid: addMinutes(call, 15), disp: addMinutes(call, 25) }
    let status = planned
    if (status === 'dispensed' && !reached(flow.disp)) status = 'charged'
    if (status === 'charged' && !reached(flow.paid)) status = 'consulted'
    if (status === 'consulted' && !reached(flow.done)) status = 'registered'
    // 下午家醫科有一位前兩天預約、還沒到的病人（報到示範：醫師的「下一位」先跳過他）。
    // 不另外抽亂數：時間沒到的照舊走 pastBooking()，抽的次數和以前一樣，後面的資料才不會全部改變
    const noShow = pi === 15 && period === 'PM' && dept === 'D01'
    const createdAt = reached(reg) ? (noShow ? `${addDays(T, -2)} 10:15` : reg) : pastBooking()
    const v = makeVisit(pt, session, status, createdAt, sc.caseType ?? '01')
    if (status === 'consulted' || status === 'charged' || status === 'dispensed') {
      const e = makeEncounter(v, sc, flow)
      if (status !== 'consulted') {
        makeCharge(v, e, flow.paid)
        makeDispense(v, e, status === 'dispensed' ? 'dispensed' : 'pending', flow.paid, status === 'dispensed' ? flow.disp : undefined)
      }
    }
  }

  // 慢箋（連續處方箋）示範：一位今天可以來領第 2 次（約 20 天前領的 28 天藥），一位還沒到時間（5 天前才領）
  {
    const sc = scenarios.find((x) => x.caseType === '04' && x.dept === 'D02')!
    // 挑最近 60 天沒有慢箋的病人：之後若有同科的新慢箋，示範的這張會被取代（不再列出）
    const free = [...opdPatients.slice(17), ...opdPatients.slice(6, 17)].filter((pt) => deptFits(pt, 'D02', T) && !encounters.some((e) => e.patientId === pt.id && e.refillTimes >= 2 && e.date > addDays(T, -60)))
    const demo: [Patient, number, number][] = [[free[0], 20, 3], [free[1], 5, 2]].filter(([pt]) => pt) as [Patient, number, number][]
    for (const [pt, ago, times] of demo) {
      // 往前找最近一個有內科門診、這位病人適合的日子（週末沒有門診）
      let session: ClinicSession | undefined
      for (let k = ago; k < ago + 7 && !session; k++) session = sessionsOn(addDays(T, -k)).find((x) => x.deptId === 'D02' && x.period === 'AM' && deptFits(pt, 'D02', x.date))
      if (!session) continue
      const flow = flowFrom(`${session.date} 09:${pad2(int(0, 30))}`, int(5, 30))
      const v = makeVisit(pt, session, 'dispensed', flow.reg, '04')
      const e = makeEncounter(v, sc, flow)
      e.refillTimes = times
      makeCharge(v, e, flow.paid)
      makeDispense(v, e, 'dispensed', flow.paid, flow.disp)
    }
  }

  // 一筆舊欠款（U10）：今天看完診、等批價的那位病人，上次來忘了帶錢。批價、掛號頁都會提醒收回
  {
    const debtor = opdPatients[todayPlan.find(([, , , st]) => st === 'consulted')![0]]
    const last = charges.filter((c) => c.patientId === debtor.id && !c.paidAt.startsWith(T)).sort((a, b) => b.paidAt.localeCompare(a.paidAt))[0]
    if (last && last.patientTotal > 0) {
      const owed = Math.min(last.patientTotal, 200)
      Object.assign(last, { received: last.patientTotal - owed, change: 0, owed, oweReason: '忘了帶錢', repayments: [] })
    }
  }

  // 未來預約掛號
  for (let k = 0; k < 8; k++) {
    const date = addDays(T, int(1, 10))
    const pt = opdPatients[int(0, 23)]
    const session = sessionFor(pt, sessionsOn(date))
    // 同一位病人同一診次不重複掛號
    if (!session || visits.some((v) => v.sessionId === session.id && v.patientId === pt.id)) continue
    makeVisit(pt, session, 'registered', pastBooking())
  }

  // 預防保健紀錄
  const prevent = (pt: Patient, itemCode: string, daysAgo: number, result: PreventRecord['result'], data: Record<string, string>) => {
    preventRecords.push({ id: id('PR'), patientId: pt.id, itemCode, date: addDays(T, -daysAgo), doctorId: 'DR01', result, data: withDerivedFields(data) })
  }
  prevent(patients[0], 'ADULT', 420, '異常需追蹤', { 血壓: '146/92', 空腹血糖: '108', 總膽固醇: '232', 身高: '168', 體重: '74' })
  prevent(patients[1], 'BREAST', 900, '正常', { 報告: 'BI-RADS 1' })
  prevent(patients[3], 'ADULT', 300, '正常', { 血壓: '128/80', 空腹血糖: '96', 總膽固醇: '188', 身高: '160', 體重: '60' })
  prevent(patients[7], 'COLON', 500, '正常', { 糞便潛血: '陰性' })
  prevent(patients[8], 'LUNG', 400, '異常需追蹤', { 報告: 'Lung-RADS 3，6 個月後追蹤' })
  prevent(patients[5], 'CERVIX', 200, '正常', { 報告: 'NILM' })
  prevent(patients[21], 'BCLIVER', 700, '正常', { HBsAg: '陰性', 'Anti-HCV': '陰性' })

  // 近半年的服務紀錄（統計用）：每一筆都先經過 checkEligibility，展示資料不能出現「不符資格卻做了」的紀錄
  const sampleData: Record<string, () => [PreventRecord['result'], Record<string, string>]> = {
    // 身高體重依目標 BMI 推算（異常組約 27–30、正常組約 19–24），BMI 本身由 withDerivedFields 算出
    ADULT: () => {
      const h = int(150, 182)
      const w = (bmi: number) => String(Math.round(bmi * (h / 100) ** 2))
      return rand() < 0.3
        ? ['異常需追蹤', { 血壓: `${int(140, 160)}/${int(88, 98)}`, 空腹血糖: String(int(100, 130)), 總膽固醇: String(int(210, 260)), 身高: String(h), 體重: w(int(27, 30)) }]
        : ['正常', { 血壓: `${int(110, 135)}/${int(70, 85)}`, 空腹血糖: String(int(80, 99)), 總膽固醇: String(int(150, 199)), 身高: String(h), 體重: w(int(19, 24)) }]
    },
    CERVIX: () => ['正常', { 報告: 'NILM' }],
    BREAST: () => (rand() < 0.15 ? ['異常需追蹤', { 報告: 'BI-RADS 0，需進一步檢查' }] : ['正常', { 報告: 'BI-RADS 1' }]),
    COLON: () => (rand() < 0.1 ? ['異常需追蹤', { 糞便潛血: '陽性，轉介大腸鏡' }] : ['正常', { 糞便潛血: '陰性' }]),
    ORAL: () => ['正常', { 檢查結果: '未見異常' }],
    LUNG: () => (rand() < 0.2 ? ['異常需追蹤', { 報告: 'Lung-RADS 3' }] : ['正常', { 報告: 'Lung-RADS 1' }]),
    BCLIVER: () => ['正常', { HBsAg: '陰性', 'Anti-HCV': '陰性' }],
    // 兒童：體重由身高與合理 BMI（14–17）推算——兩者各自亂數會出現 115 cm、12 kg（BMI 9.1）這種不可能的組合
    CHILD: () => {
      const h = int(85, 120)
      return ['正常', { 身高: String(h), 體重: String(Math.round(int(14, 17) * (h / 100) ** 2)), 發展評估: '正常' }]
    },
  }
  // 依時間先後產生：資格判斷只看「當時以前」的紀錄，若先產生較晚的紀錄，較早那筆就看不到它，間隔規則會被破壞
  const historyDays = Array.from({ length: 60 }, () => int(1, 180)).sort((a, b) => b - a)
  for (const daysAgo of historyDays) {
    const date = addDays(T, -daysAgo)
    const pt = pick(patients)
    const ok = codes.preventItems.filter((i) => checkEligibility(pt, i, preventRecords, date).eligible)
    if (!ok.length) continue
    const item = pick(ok)
    const [result, data] = sampleData[item.code]()
    // 抹片、肺癌篩檢兩週內的報告通常還沒出來
    const pendingReport = daysAgo <= 14 && (item.code === 'CERVIX' || item.code === 'LUNG')
    preventRecords.push({ id: id('PR'), patientId: pt.id, itemCode: item.code, date, doctorId: pick(['DR01', 'DR02', 'DR03']), result: pendingReport ? '待報告' : result, data: pendingReport ? {} : withDerivedFields(data) })
  }
  // 「補登報告」要有東西可示範：上面是亂數，前面的種子一改（多抽幾次亂數）就可能一筆待報告都沒有。沒有就補一筆一週前的抹片
  if (!preventRecords.some((r) => r.result === '待報告')) {
    const date = addDays(T, -7)
    const cervix = codes.preventItems.find((i) => i.code === 'CERVIX')!
    const pt = patients.find((x) => checkEligibility(x, cervix, preventRecords, date).eligible)
    if (pt) preventRecords.push({ id: id('PR'), patientId: pt.id, itemCode: 'CERVIX', date, doctorId: 'DR01', result: '待報告', data: {} })
  }

  // 今天的掛號：部分病人在掛號時勾了預防保健（預防保健頁的「今日待執行」）
  const eligibleCodes = (pt: Patient) => codes.preventItems.filter((i) => checkEligibility(pt, i, preventRecords, T).eligible).map((i) => i.code)
  const todayVisits = visits.filter((v) => v.date === T)
  let planned = 0
  for (const v of todayVisits.filter((x) => x.status === 'registered')) {
    const codesOk = eligibleCodes(patients.find((p) => p.id === v.patientId)!)
    if (!codesOk.length || planned >= 4) continue
    v.preventItems = codesOk.slice(0, 2)
    planned++
  }
  // 一位已看完診、預防保健也已執行
  const doneVisit = todayVisits.find((v) => v.status === 'consulted' && eligibleCodes(patients.find((p) => p.id === v.patientId)!).length)
  if (doneVisit) {
    const code = eligibleCodes(patients.find((p) => p.id === doneVisit.patientId)!)[0]
    doneVisit.preventItems = [code]
    const [result, data] = sampleData[code]()
    preventRecords.push({ id: id('PR'), patientId: doneVisit.patientId, itemCode: code, date: T, visitId: doneVisit.id, doctorId: doneVisit.doctorId, result, data: withDerivedFields(data) })
  }

  // ---------- 病床與住院 ----------
  const beds: Bed[] = []
  codes.wards.forEach((ward, wi) => {
    for (let r = 1; r <= 5; r++) {
      const roomNo = `${wi + 5}${String(r).padStart(2, '0')}`
      const cls: Bed['bedClass'] = r === 5 ? '單人房' : r === 4 ? '雙人房' : '健保床'
      const count = cls === '單人房' ? 1 : 2
      for (let b = 1; b <= count; b++) {
        beds.push({
          id: `B${roomNo}${b}`, ward, roomNo, bedNo: `${roomNo}-${b}`, bedClass: cls,
          extraFee: cls === '單人房' ? 2500 : cls === '雙人房' ? 1200 : 0, status: 'empty',
        })
      }
    }
  })
  // 急診留觀區 OB1–OB6（健保床、每床一間：同房隔離規則不會互相牽連；放在最後，舊的「找一張空床」不會挑到它）
  for (let n = 1; n <= codes.OBS_BEDS; n++) beds.push({ id: `BOB${n}`, ward: codes.obsWard, roomNo: `OB${n}`, bedNo: `OB${n}`, bedClass: '健保床', extraFee: 0, status: 'empty' })
  // 加護病房 ICU1–ICU8（每床一間、健保床；加護病房的病房費、護理費另計）
  for (let n = 1; n <= codes.ICU_BEDS; n++) beds.push({ id: `BICU${n}`, ward: codes.icuWard, roomNo: `ICU${n}`, bedNo: `ICU${n}`, bedClass: '健保床', extraFee: 0, status: 'empty' })
  // 負壓隔離室：綜合病房 705（那間單人房改成負壓）、加護病房多一床 ICU9（負壓床，放在最後：以前「找一張空的加護病房床」不會挑到它）
  for (const b of beds) if (b.ward === codes.wards[2] && b.bedClass === '單人房') b.negativePressure = true
  beds.push({ id: 'BICU9', ward: codes.icuWard, roomNo: 'ICU9', bedNo: 'ICU9', bedClass: '健保床', extraFee: 0, status: 'empty', negativePressure: true })

  const admissions: Admission[] = []
  const ipdOrders: IpdOrder[] = []
  const mar: MarRecord[] = []
  const vitals: VitalRecord[] = []
  const nursingNotes: NursingNote[] = []
  const progressNotes: ProgressNote[] = []

  interface IpdScenario {
    dept: string; doctor: string; dx: string; reason: string; diet: string
    meds: [drugId: string, dose: number, freq: string, route: string, timing?: DrugTiming][]
    prn?: [drugId: string, dose: number, route: string][]
    nursing: string[]
  }
  const ipdScenarios: IpdScenario[] = [
    { dept: 'D02', doctor: 'DR02', dx: 'J18.9 肺炎', reason: '發燒咳嗽、血氧偏低', diet: '普通飲食', meds: [['M036', 1, 'Q12H', 'IV'], ['M037', 1, 'QD', 'IV'], ['M010', 1, 'TID', 'PO']], prn: [['M001', 1, 'PO']], nursing: ['Vital signs Q4H', '監測血氧，SpO2 < 92% 給予氧氣'] },
    { dept: 'D02', doctor: 'DR03', dx: 'E11.65 糖尿病伴高血糖', reason: '血糖控制不佳', diet: '糖尿病飲食 1800 kcal', meds: [['M015', 1, 'BID', 'PO', 'PC'], ['M038', 10, 'HS', 'SC']], nursing: ['AC/HS 血糖監測', '糖尿病衛教'] },
    { dept: 'D03', doctor: 'DR04', dx: 'K35.80 急性闌尾炎', reason: '右下腹痛，安排手術', diet: '禁食', meds: [['M036', 1, 'Q12H', 'IV'], ['M037', 1, 'QD', 'IV']], prn: [['M039', 1, 'IM']], nursing: ['術後傷口護理', 'Vital signs Q4H'] },
    { dept: 'D06', doctor: 'DR07', dx: 'S52.501A 右橈骨遠端骨折', reason: '跌倒骨折，安排復位固定', diet: '普通飲食', meds: [['M030', 1, 'BID', 'PO'], ['M022', 1, 'QD', 'PO']], prn: [['M031', 1, 'PO']], nursing: ['患肢抬高、觀察末梢循環'] },
    { dept: 'D02', doctor: 'DR02', dx: 'I63.9 腦梗塞', reason: '右側肢體無力', diet: '吞嚥困難軟質飲食', meds: [['M019', 1, 'QD', 'PO'], ['M018', 1, 'HS', 'PO'], ['M012', 1, 'QD', 'PO']], nursing: ['神經學評估 Q4H', '預防跌倒', '翻身 Q2H'] },
    { dept: 'D01', doctor: 'DR01', dx: 'L03.115 右下肢蜂窩性組織炎', reason: '右小腿紅腫熱痛', diet: '普通飲食', meds: [['M036', 1, 'Q12H', 'IV'], ['M001', 1, 'TID', 'PO']], nursing: ['患肢抬高', '每日標記紅腫範圍'] },
    { dept: 'D02', doctor: 'DR03', dx: 'N39.0 泌尿道感染', reason: '發燒、解尿疼痛', diet: '普通飲食，鼓勵多喝水', meds: [['M036', 1, 'Q12H', 'IV'], ['M037', 1, 'QD', 'IV']], prn: [['M001', 1, 'PO']], nursing: ['記錄輸入輸出量'] },
    { dept: 'D02', doctor: 'DR02', dx: 'A41.9 敗血症', reason: '發燒、血壓偏低', diet: '流質飲食', meds: [['M036', 1, 'Q12H', 'IV'], ['M037', 1, 'Q8H', 'IV'], ['M040', 1, 'QD', 'IV']], nursing: ['Vital signs Q2H', '記錄輸入輸出量', '高警訊藥品雙人核對'] },
  ]

  // 住院情境（肺炎、闌尾炎、敗血症…，成人劑量）只分配給成人；兒童需要小兒病房與兒童劑量，展示資料不能違反臨床常識
  const adultAt = (i: number) => patientRows[i][2] >= 18
  const ipdPatients = [...patients.slice(24).filter((_, k) => adultAt(24 + k)), patients[4], patients[11], patients[20]]
  const nurseIds = ['U201', 'U202']
  const bedsByClass = (cls: Bed['bedClass']) => beds.filter((b) => b.bedClass === cls && b.status === 'empty' && b.ward !== codes.obsWard && b.ward !== codes.icuWard)

  const recentCut = addMinutes(nowStr, -90)
  const handovers: HandoverNote[] = []
  const genMar = (order: IpdOrder, date: string) => {
    const f = codes.frequencies.find((x) => x.code === order.freq)
    if (!f) return
    for (const t of marTimes(f.code, f.times, order.timing, order.route)) {
      const scheduledAt = `${date} ${t}`
      if (scheduledAt < order.startAt) continue
      // 最近 90 分鐘內到期的保留未執行：真實病房總有幾筆「正要給、還沒給」，護理站才看得到逾時提醒
      const past = scheduledAt < recentCut
      mar.push({
        id: id('MAR'), orderId: order.id, admissionId: order.admissionId, scheduledAt,
        status: past ? 'given' : 'pending',
        ...(past ? { executedAt: scheduledAt, nurseId: pick(nurseIds) } : {}),
      })
    }
  }

  ipdScenarios.forEach((sc, i) => {
    const pt = ipdPatients[i]
    // 腦梗塞（雙人房）住比較久：示範住院中費用查詢、期中繳款提醒（滿 30 天、部分負擔進第二段）、健保期中申報（上個月底已住滿 30 天：
    // 入院日依今天是幾號往前推，最多 60 天，部分負擔仍在第二段）。亂數照樣抽，其他人的資料不變
    const rolled = int(1, 6)
    // 蜂窩性組織炎住 9 天：示範抗生素每日審視「Vancomycin 超過 7 天」
    const daysIn = i === 4 ? Math.min(60, Math.max(32, 31 + Number(T.slice(8, 10)))) : i === 5 ? 9 : rolled
    const admitDate = addDays(T, -daysIn)
    // 隔離示範（不抽亂數）：肺炎（疑似肺結核、空氣隔離）住綜合病房的單人房；蜂窩性組織炎（MRSA、接觸隔離）住綜合病房健保床，同房另一床空著
    const cls: Bed['bedClass'] = i === 0 || i === 2 ? '單人房' : i === 4 ? '雙人房' : '健保床'
    const isoBed = i === 0 ? beds.find((b) => b.ward === codes.wards[2] && b.bedClass === '單人房' && b.status === 'empty') : i === 5 ? beds.find((b) => b.ward === codes.wards[2] && b.bedClass === '健保床' && b.status === 'empty') : undefined
    // 敗血症（血壓偏低、中心靜脈導管）：從急診直接住加護病房
    const icuBed = sc.dx.startsWith('A41') ? beds.find((b) => b.ward === codes.icuWard && b.status === 'empty') : undefined
    const bed = icuBed ?? isoBed ?? bedsByClass(cls)[0] ?? bedsByClass('健保床')[0]
    const adm: Admission = {
      id: id('A'), admitNo: `I${admitDate.replace(/-/g, '').slice(2)}${String(next('admitNo')).padStart(3, '0')}`,
      patientId: pt.id, deptId: sc.dept, doctorId: sc.doctor, bedId: bed.id, preferBedClass: cls,
      reason: sc.reason, diagnosis: sc.dx, status: 'admitted',
      reservedAt: `${addDays(admitDate, -1)} 15:00`, expectedDate: admitDate, admittedAt: `${admitDate} 14:${String(int(0, 59)).padStart(2, '0')}`,
    }
    admissions.push(adm)
    bed.status = 'occupied'
    bed.admissionId = adm.id

    const startAt = adm.admittedAt!
    const docUser = sc.doctor
    sc.meds.forEach(([drugId, dose, freq, route, rxTiming]) => {
      const d = drugMap.get(drugId)!
      const o: IpdOrder = {
        id: id('IO'), admissionId: adm.id, type: 'long', category: 'medication', drugId, content: d.name, dose, freq, route,
        // 和 ipd.addOrder 一樣：開立時把有效時機存在醫囑上
        ...(timingApplies(freq, route) ? { timing: effectiveTiming(d.timing, rxTiming), ...(rxTiming ? { timingSet: true } : {}) } : {}),
        startAt, status: 'active', doctorId: docUser, createdAt: startAt,
      }
      ipdOrders.push(o)
      for (let k = daysIn; k >= 0; k--) genMar(o, addDays(T, -k))
    })
    ;(sc.prn ?? []).forEach(([drugId, dose, route]) => {
      const d = drugMap.get(drugId)!
      ipdOrders.push({ id: id('IO'), admissionId: adm.id, type: 'long', category: 'medication', drugId, content: d.name, dose, freq: 'PRN', route, startAt, status: 'active', doctorId: docUser, createdAt: startAt })
    })
    ipdOrders.push({ id: id('IO'), admissionId: adm.id, type: 'long', category: 'diet', diet: { kind: dietKindOfText(sc.diet) }, content: sc.diet, startAt, status: 'active', doctorId: docUser, createdAt: startAt })
    sc.nursing.forEach((n) => ipdOrders.push({ id: id('IO'), admissionId: adm.id, type: 'long', category: 'nursing', content: n, startAt, status: 'active', doctorId: docUser, createdAt: startAt }))
    // 入院時的檢查：入院後一小時內完成。完成時間記在 stopAt（與服務層一致），護理站才看得出何時完成
    const statDoneAt = notFuture(addMinutes(startAt, 60), 30)
    ipdOrders.push({ id: id('IO'), admissionId: adm.id, type: 'stat', category: 'procedure', procId: 'P003', content: '全套血液檢查 CBC', startAt, stopAt: statDoneAt, status: 'done', doctorId: docUser, createdAt: startAt })
    ipdOrders.push({ id: id('IO'), admissionId: adm.id, type: 'stat', category: 'procedure', procId: 'P013', content: '胸部 X 光', startAt, stopAt: statDoneAt, status: 'done', doctorId: docUser, createdAt: startAt })

    // 生命徵象：每天 08、14、20 點；發燒情境前兩天體溫偏高並逐日下降
    const febrile = [0, 2, 5, 6, 7].includes(i)
    for (let k = daysIn; k >= 0; k--) {
      for (const h of ['08:00', '14:00', '20:00']) {
        const at = `${addDays(T, -k)} ${h}`
        if (at < startAt || at > nowStr) continue
        const fever = febrile ? Math.max(0, k - 1) * 0.5 + rand() * 0.6 : rand() * 0.4
        vitals.push({
          id: id('VS'), admissionId: adm.id, at,
          temp: Math.round((36.5 + fever) * 10) / 10, pulse: int(72, 96) + Math.round(fever * 8), resp: int(14, 20),
          sbp: int(110, 140), dbp: int(65, 88), spo2: Math.min(99, int(94, 99) - (i === 0 && k > 1 ? 3 : 0)), pain: int(0, 3), // 0–3：≥4 要處置與重評，亂數的不放（示範另外放一位）
          intake: int(800, 1600), output: int(700, 1500), nurseId: pick(nurseIds),
        })
      }
    }

    nursingNotes.push({
      id: id('NN'), admissionId: adm.id, at: `${admitDate} 15:30`, focus: '入院護理評估',
      data: `病人因${sc.reason}入院，意識清楚，生命徵象穩定。`, action: '完成入院護理評估、環境介紹與跌倒預防衛教。', response: '病人及家屬表示了解。', nurseId: 'U201',
    })
    if (daysIn > 1) {
      nursingNotes.push({
        id: id('NN'), admissionId: adm.id, at: `${addDays(T, -1)} 10:00`, focus: febrile ? '體溫過高' : '舒適狀態改變',
        data: febrile ? '病人體溫 38.2°C，主訴畏寒。' : '病人主訴傷口/患處疼痛，疼痛分數 4 分。',
        action: febrile ? '依醫囑給予退燒藥，冰枕使用，鼓勵多喝水。' : '依醫囑給予止痛藥，協助舒適臥位。',
        response: febrile ? '一小時後複測體溫 37.4°C。' : '半小時後疼痛分數降為 2 分。', nurseId: 'U202',
      })
    }
    // 前一個大夜班（今天 07:30）的交班
    if (`${T} 07:30` > startAt && `${T} 07:30` < nowStr) {
      handovers.push({
        id: id('HO'), ward: bed.ward, shift: '大夜', date: T, admissionId: adm.id, nurseId: 'U202', createdAt: `${T} 07:30`,
        content: febrile ? '夜間體溫最高 38.1°C，已依醫囑給予退燒藥，晨間複測 37.3°C。請持續監測體溫。' : `夜間睡眠尚可，生命徵象穩定。${sc.nursing[0]}持續執行。`,
      })
    }
    for (let k = daysIn - 1; k >= 0; k--) {
      // 今天的查房紀錄在 08:30 之後才存在（清晨開啟展示時不能出現未來的紀錄）
      if (`${addDays(T, -k)} 08:30` >= nowStr) continue
      progressNotes.push({
        id: id('PN'), admissionId: adm.id, at: `${addDays(T, -k)} 08:30`, doctorId: sc.doctor,
        subjective: k === 0 ? '病人自覺症狀改善，食慾恢復中。' : '病人仍有不適，夜間睡眠普通。',
        objective: febrile && k > 1 ? '體溫 38.0°C，心跳 98。' : '生命徵象穩定。',
        assessment: sc.dx,
        plan: k === 0 ? '續目前治療，評估出院時程。' : '續目前治療，追蹤檢驗數據。',
      })
    }
  })

  // 醫師已准予出院、等住院中心辦理（泌尿道感染那位）：住院中心的床位圖與護理站會標「准出院」
  {
    const ready = admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('N39.0'))
    if (ready) {
      const at = notFuture(`${T} 09:30`, 5)
      ready.dischargeSummary = {
        diagnosis: ready.diagnosis, dischargeType: '改善出院', doctorId: ready.doctorId, writtenAt: at, signedAt: at,
        course: '入院後給予靜脈抗生素治療，第二天起退燒，尿液培養為大腸桿菌，對目前抗生素敏感。',
        condition: '體溫正常 48 小時，解尿疼痛改善，進食正常，可自行下床活動。',
        followUp: '口服抗生素再服用 5 天；一週後泌尿科門診追蹤尿液檢查。如再發燒或腰痛請立即回診。',
        // 出院帶藥（住院藥局還沒調劑：藥局首頁「出院帶藥待調劑」、櫃台要等調好才能結帳）
        meds: [
          { drugId: 'M004', dose: 1, freq: 'TID', route: 'PO', days: 5, qty: 15, selfPay: false },
          { drugId: 'M001', dose: 1, freq: 'TID', route: 'PO', days: 3, qty: 9, selfPay: false },
        ],
      }
    }
  }

  // 轉科申請中（腦梗塞那位，內科 → 復健科）：急性期穩定，昨天主治申請轉復健科；
  // 復健科醫師（dr09）首頁待辦「轉入申請」、住院醫囑頁上方就有東西可以接受或婉拒。不抽亂數
  {
    const stroke = admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('I63.9'))
    if (stroke) {
      stroke.deptTransfers = [{
        id: 'DT-SEED-1', fromDeptId: stroke.deptId, fromDoctorId: stroke.doctorId, toDeptId: 'D08',
        reason: '急性期已穩定，右側肢體無力，轉復健科接續住院復健', requestedBy: doctorUser(stroke.doctorId),
        requestedAt: `${addDays(T, -1)} 16:20`, status: 'pending',
        summary: {
          course: '入院時右側肢體無力、言語不清，MRI 證實左側內囊梗塞；給予抗血小板與降血脂治療，生命徵象穩定、未再惡化。',
          problems: '右側肢體肌力 3 分，需協助轉位；吞嚥評估可進食軟質飲食；血壓控制中。',
          pending: '一週後追蹤血脂；持續監測血壓，目標 < 140/90。',
        },
      }]
      progressNotes.push({
        id: 'PN-SEED-DT1', admissionId: stroke.id, at: `${addDays(T, -1)} 16:20`, doctorId: stroke.doctorId, subjective: '', objective: '', assessment: '', plan: '', kind: 'transferOut',
        items: [
          { label: '轉入', text: '復健科' },
          { label: '原因', text: '急性期已穩定，右側肢體無力，轉復健科接續住院復健' },
          { label: '住院經過', text: stroke.deptTransfers[0].summary!.course },
          { label: '目前問題', text: stroke.deptTransfers[0].summary!.problems },
          { label: '待追蹤', text: stroke.deptTransfers[0].summary!.pending! },
        ],
      })
    }
  }

  // 住院會診（不抽亂數）：糖尿病那位今天早上會診外科（待回覆——外科 dr04 首頁待辦「待回覆會診」就有一張）；
  // 肺炎那位昨天會診耳鼻喉科，dr08 已回覆（主治 dr02 在醫囑頁看得到回覆）
  const consults: Consult[] = []
  {
    const dm = admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('E11.65'))
    if (dm) {
      const at = notFuture(`${T} 09:10`, 10)
      consults.push({ id: 'CS-SEED-1', admissionId: dm.id, fromDeptId: dm.deptId, fromDoctorId: dm.doctorId, toDeptId: 'D03', question: '左足大拇趾傷口紅腫滲液三天，請評估是否需要清創', urgent: false, requestedAt: at, status: 'pending' })
      progressNotes.push({ id: 'PN-SEED-CS1', admissionId: dm.id, at, doctorId: dm.doctorId, subjective: '', objective: '', assessment: '', plan: '', kind: 'consult', items: [{ label: '會診', text: '外科' }, { label: '目的', text: consults[0].question }] })
    }
    const pn = admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('J18.9'))
    if (pn) {
      const at = `${addDays(T, -1)} 10:00`
      const ans = `${addDays(T, -1)} 15:30`
      const c: Consult = {
        id: 'CS-SEED-2', admissionId: pn.id, fromDeptId: pn.deptId, fromDoctorId: pn.doctorId, toDeptId: 'D07', question: '咽喉疼痛、吞嚥時加劇，請評估有無扁桃腺周圍膿瘍', urgent: false, requestedAt: at,
        status: 'answered', answeredBy: 'DR08', answeredAt: ans, findings: '雙側扁桃腺輕度紅腫、無膿點，懸雍垂居中，無膿瘍跡象。', recommendation: '續用目前抗生素；溫鹽水漱口；若三天後吞嚥仍困難請再會診。',
      }
      consults.push(c)
      progressNotes.push({ id: 'PN-SEED-CS2', admissionId: pn.id, at, doctorId: pn.doctorId, subjective: '', objective: '', assessment: '', plan: '', kind: 'consult', items: [{ label: '會診', text: '耳鼻喉科' }, { label: '目的', text: c.question }] })
      progressNotes.push({ id: 'PN-SEED-CS2R', admissionId: pn.id, at: ans, doctorId: 'DR08', subjective: '', objective: '', assessment: '', plan: '', kind: 'consultReply', items: [{ label: '會診回覆', text: `耳鼻喉科（申請：${at.slice(5)}，${c.question}）` }, { label: '評估', text: c.findings! }, { label: '建議', text: c.recommendation! }] })
    }
  }

  // 已出院（歷史）
  for (let k = 0; k < 4; k++) {
    const pt = patients[int(0, 23)]
    const admitDate = addDays(T, -int(20, 90))
    const dischargeDate = addDays(admitDate, int(3, 8))
    admissions.push({
      id: id('A'), admitNo: `I${admitDate.replace(/-/g, '').slice(2)}${String(next('admitNo')).padStart(3, '0')}`,
      patientId: pt.id, deptId: 'D02', doctorId: 'DR02', preferBedClass: '健保床', reason: '肺炎', diagnosis: 'J18.9 肺炎',
      status: 'discharged', reservedAt: `${admitDate} 09:00`, expectedDate: admitDate, admittedAt: `${admitDate} 14:00`,
      dischargedAt: `${dischargeDate} 11:00`, dischargeType: '治癒出院',
      // 出院病摘由主治醫師在出院當天早上簽署（簽署＝准予出院，住院中心才辦理）
      dischargeSummary: {
        diagnosis: 'J18.9 肺炎', dischargeType: '治癒出院', doctorId: 'DR02', writtenAt: `${dischargeDate} 09:00`, signedAt: `${dischargeDate} 09:00`,
        course: '住院期間給予靜脈抗生素治療，第三天起退燒，胸部 X 光浸潤改善。',
        condition: '生命徵象穩定，未再發燒，咳嗽減輕，血氧正常。',
        followUp: '一週後胸腔內科門診追蹤，複查胸部 X 光。',
      },
    })
  }

  // 預約未到與出院後回診（示範，不抽亂數）：
  //   - 9 天前出院的肺炎病人，主治出院前約了 2 天前的內科回診，沒來（未到追蹤最優先）
  //   - 醫師看診時約的回診沒來（櫃台已打過一次電話、聯絡不到）、慢性病回診沒來、自己掛的沒來
  //   - 准出院的泌尿道感染病人：主治已約好一週後的出院回診（辦出院、護理站看得到）
  {
    /** 從 T+start 往 step 方向找 4 天內這一科（指定醫師優先）的日間診次，病人沒掛過那一診 */
    const near = (pt: Patient, start: number, step: 1 | -1, deptId: string, doctorId?: string) => {
      for (let k = 0; k < 4; k++) {
        const list = sessionsOn(addDays(T, start + k * step)).filter((s) => s.deptId === deptId && deptFits(pt, deptId, s.date) && s.period !== 'NIGHT' && !visits.some((v) => v.sessionId === s.id && v.patientId === pt.id))
        const s = list.find((x) => x.doctorId === doctorId) ?? list[0]
        if (s) return s
      }
      return undefined
    }
    // 出院回診沒來的那位：出院後都沒再來看過內科（不然就不像「沒來」）
    const pAd = [15, 19, 21, 23, 10, 0].map((i) => patients[i]).find((p) => ageAt(p, T) >= 18 && !visits.some((v) => v.patientId === p.id && v.deptId === 'D02' && v.date >= addDays(T, -9))) ?? patients[15]
    const disOn = addDays(T, -9)
    const ad: Admission = {
      id: id('A'), admitNo: `I${addDays(disOn, -5).replace(/-/g, '').slice(2)}${String(next('admitNo')).padStart(3, '0')}`,
      patientId: pAd.id, deptId: 'D02', doctorId: 'DR02', preferBedClass: '健保床', reason: '發燒咳嗽', diagnosis: 'J18.9 肺炎',
      status: 'discharged', reservedAt: `${addDays(disOn, -5)} 09:00`, expectedDate: addDays(disOn, -5), admittedAt: `${addDays(disOn, -5)} 14:00`,
      dischargedAt: `${disOn} 11:00`, dischargeType: '治癒出院',
      dischargeSummary: {
        diagnosis: 'J18.9 肺炎', dischargeType: '治癒出院', doctorId: 'DR02', writtenAt: `${disOn} 09:00`, signedAt: `${disOn} 09:00`,
        course: '住院期間給予靜脈抗生素治療，第二天起退燒。', condition: '生命徵象穩定，咳嗽減輕。', followUp: '一週後內科門診追蹤（已預約），複查胸部 X 光。',
      },
    }
    admissions.push(ad)
    const sAd = near(pAd, -2, -1, 'D02', 'DR02')
    if (sAd) makeVisit(pAd, sAd, 'registered', `${disOn} 09:10`).afterDischarge = { admissionId: ad.id, doctorId: 'DR02', at: `${disOn} 09:10` }
    // 醫師約的回診沒來：原本那次看診的醫師約的；櫃台昨天打過電話，沒人接
    const pFu = patients[2]
    const src = visits.filter((v) => v.patientId === pFu.id && v.status === 'dispensed' && v.date < addDays(T, -10)).sort((a, b) => b.date.localeCompare(a.date))[0]
    const sFu = src && near(pFu, -3, -1, src.deptId, src.doctorId)
    if (src && sFu) {
      const v = makeVisit(pFu, sFu, 'registered', `${src.date} 10:30`, src.caseType)
      v.followUpOf = { visitId: src.id, doctorId: src.doctorId, at: `${src.date} 10:30` }
      v.noShow = { contacts: [{ at: notFuture(`${addDays(T, -1)} 15:20`, 5), by: 'U401', result: 'unreachable', note: '電話沒人接' }] }
    }
    const pCh = patients[3]
    const sCh = near(pCh, -5, -1, 'D02')
    if (sCh) makeVisit(pCh, sCh, 'registered', `${addDays(T, -20)} 11:00`, '04')
    const pNo = patients[13]
    const sNo = near(pNo, -1, -1, 'D01')
    if (sNo) makeVisit(pNo, sNo, 'registered', `${addDays(T, -4)} 16:00`)
    // 准出院的病人：主治簽准出院時一併約好一週後的門診
    const ready = admissions.find((a) => a.status === 'admitted' && a.dischargeSummary?.signedAt)
    const pR = ready && patients.find((p) => p.id === ready.patientId)
    const sR = ready && pR && near(pR, 7, 1, ready.deptId, ready.doctorId)
    if (ready && pR && sR) makeVisit(pR, sR, 'registered', ready.dischargeSummary!.signedAt!).afterDischarge = { admissionId: ready.id, doctorId: ready.doctorId, at: ready.dischargeSummary!.signedAt! }
  }

  // 外院轉診（示範，不抽亂數）：家醫科 dr01 今天還沒看的第一位掛號，持康健診所 3 天前開的轉診單（櫃台掛號時登錄）
  const refVisit = visits.filter((v) => v.date === T && v.doctorId === 'DR01' && v.status === 'registered' && !v.refillOf).sort((a, b) => a.sessionId.localeCompare(b.sessionId) || a.seqNo - b.seqNo)[0]
  if (refVisit) refVisit.referralIn = { fromHospital: '康健診所', issuedOn: addDays(T, -3), diagnosis: 'J20.9 急性支氣管炎（反覆發作）', purpose: '進一步檢查', recordedBy: 'U401', recordedAt: refVisit.createdAt }

  // 診斷證明書（示範）：第一位已出院的病人，出院當天主治開了 2 份（請假用），費用在住院收據裡、可以列印
  const certificates: MedicalCertificate[] = []
  const certProc = codes.procedures.find((x) => x.id === 'P027')!
  // 已出院的住院結帳（不抽亂數）：出院當天 10:30 櫃台結帳。歷史住院沒有醫囑資料，帳單只有每日計費與部分負擔
  for (const a of admissions.filter((x) => x.status === 'discharged')) {
    const pt = patients.find((x) => x.id === a.patientId)!
    const identity = identityMap.get(pt.defaultIdentity) ?? codes.identities[0]
    const days = ipdDays(a.admittedAt!, a.dischargedAt!)
    const { lines, meta } = calcIpdChargeLines({
      identity, from: a.admittedAt!, to: a.dischargedAt!, beds: [{ bedNo: '—', bedClass: '健保床', days, extraFee: 0 }],
      daily: codes.procedures.filter((x) => x.dailyFee), drugs: [], procedures: [], copay: codes.billingSettings.ipdCopay ?? IPD_COPAY_DEFAULT,
    })
    const day = a.dischargedAt!.slice(0, 10)
    if (!certificates.length) {
      const roc = Number(day.slice(0, 4)) - 1911
      const no = `${roc} 診字第 ${String(next(`cert:${roc}`)).padStart(6, '0')} 號`
      certificates.push({
        id: 'MC-SEED-1', no, patientId: a.patientId, admissionId: a.id, deptId: a.deptId, doctorId: a.doctorId,
        stayFrom: a.admittedAt!.slice(0, 10), stayTo: day, diagnoses: a.dischargeSummary?.diagnosis ?? a.diagnosis,
        advice: `病人因上述疾病於 ${a.admittedAt!.slice(0, 10)} 住院治療，${day} 出院，宜休養一週，一週後門診追蹤。`,
        purpose: '請假', copies: 2, issuedAt: `${day} 09:30`,
      })
      lines.push({ kind: 'self', name: `${certProc.name}（自費，${no}）`, qty: 2, unitPrice: certProc.selfPrice, amount: certProc.selfPrice * 2, patientPay: true })
    }
    const sum = summarize(lines)
    charges.push({
      id: `C-IPD-${a.admitNo}`, visitId: '', admissionId: a.id, ipd: meta, patientId: a.patientId, lines, nhiPoints: sum.nhiPoints, patientTotal: sum.patientTotal,
      payMethod: 'card', received: sum.patientTotal, change: 0, receiptNo: `R${day.replace(/-/g, '')}${String(next(`receipt:${day}`)).padStart(4, '0')}`,
      cashierId: 'U401', paidAt: `${day} 10:30`, voided: false,
    })
  }

  // 住院預約（待報到）：其中一筆由今日門診看診轉來
  const reserveRows: [Patient, string, string, string, Bed['bedClass'], number][] = [
    [patients[9], 'D05', 'DR06', 'N94.6 經痛，安排腹腔鏡檢查', '雙人房', 0],
    [patients[18], 'D02', 'DR03', 'E11.65 糖尿病血糖控制調整', '健保床', 0],
    [patients[15], 'D06', 'DR07', 'M17.11 右膝退化性關節炎，安排人工膝關節置換', '單人房', 1],
  ]
  reserveRows.forEach(([pt, dept, doc, dx, cls, inDays]) => {
    admissions.push({
      id: id('A'), admitNo: '', patientId: pt.id, deptId: dept, doctorId: doc, preferBedClass: cls,
      reason: dx.split(' ').slice(1).join(' '), diagnosis: dx, status: 'reserved',
      reservedAt: `${addDays(T, -2)} 10:00`, expectedDate: addDays(T, inDays),
    })
  })

  // 隔離與 DNR（示範，不抽亂數）：
  //   - 肺炎：疑似肺結核，入院就空氣隔離（單人房，差額免收）
  //   - 蜂窩性組織炎：入院 3 小時後傷口培養 MRSA，接觸隔離（同房另一床空著，沒隔離的病人排不進來）
  //   - 待報到的膝關節置換病人：40 天前門診驗出 CRE 帶菌，接觸隔離沒解除——報到時排床照隔離規則，住進來後待辦要確認是否延續
  //   - 敗血症：家屬簽的部分 DNR（不按壓、不插管、不電擊；急救藥物照常）
  const isolations: Isolation[] = []
  const dnrRecords: DnrRecord[] = []
  {
    const inpt = admissions.filter((a) => a.status === 'admitted')
    const pneu = inpt.find((a) => a.diagnosis.startsWith('J18'))
    const cell = inpt.find((a) => a.diagnosis.startsWith('L03'))
    const sepsis = inpt.find((a) => a.diagnosis.startsWith('A41'))
    const carrier = admissions.find((a) => a.status === 'reserved' && a.diagnosis.startsWith('M17'))
    if (pneu) isolations.push({ id: id('ISO'), patientId: pneu.patientId, kind: 'airborne', organism: '疑似肺結核（待痰液抗酸菌報告）', note: '胸部 X 光右上肺葉空洞', startedAt: notFuture(addMinutes(pneu.admittedAt!, 30), 5), startedBy: doctorUser(pneu.doctorId), admissionId: pneu.id })
    if (cell) isolations.push({ id: id('ISO'), patientId: cell.patientId, kind: 'contact', organism: 'MRSA', note: '傷口培養', startedAt: notFuture(addMinutes(cell.admittedAt!, 180), 5), startedBy: 'U201', admissionId: cell.id })
    if (carrier) isolations.push({ id: id('ISO'), patientId: carrier.patientId, kind: 'contact', organism: 'CRE', note: '門診尿液培養', startedAt: `${addDays(T, -40)} 10:20`, startedBy: doctorUser(carrier.doctorId) })
    if (sepsis) {
      const p = patients.find((x) => x.id === sepsis.patientId)!
      dnrRecords.push({
        id: id('DNR'), patientId: p.id, doc: 'family', signedAt: sepsis.admittedAt!.slice(0, 10), signerName: `${p.name[0]}志明`, relation: '成年子女',
        doctorIds: [sepsis.doctorId, sepsis.doctorId === 'DR02' ? 'DR03' : 'DR02'], withhold: ['compress', 'defib'], nhiCard: false,
        recordedBy: doctorUser(sepsis.doctorId), recordedAt: notFuture(addMinutes(sepsis.admittedAt!, 120), 5),
      })
    }
  }

  // 兩床清潔中：MRSA 病人同房的那一床（病人剛轉出、終期消毒中——清潔完成後只有同類隔離的病人能排進來），和第一張空床
  {
    const cellBed = beds.find((b) => b.admissionId && admissions.find((a) => a.id === b.admissionId)?.diagnosis.startsWith('L03'))
    const mate = cellBed && beds.find((b) => b.id !== cellBed.id && b.ward === cellBed.ward && b.roomNo === cellBed.roomNo && b.status === 'empty')
    if (mate) mate.status = 'cleaning'
    beds.filter((b) => b.status === 'empty').slice(0, mate ? 1 : 2).forEach((b) => (b.status = 'cleaning'))
  }

  void doctorUser

  // ---------- 管制性抗生素（示範，不抽亂數）：先用後審，感染科 DR11 審核 ----------
  //   - 敗血症：Meropenem 50 小時前開立（經驗性、血流），還沒審 → 逾時
  //   - 蜂窩性組織炎（MRSA）：Vancomycin 依培養結果 7 天前開立，隔天核准 7 天（今天第 8 天：核准天數已超過、每日審視「超過 7 天」）
  //   - 腦梗塞（導尿管 E. coli 泌尿道感染）：昨天送尿液培養後經驗性用 Augmentin 口服——藥敏 Amoxicillin/Clavulanate 抗藥，每日審視「藥敏無效」
  //   - 肺炎：Piperacillin/Tazobactam 昨天開立，不核准（已有 Ceftriaxone、培養無抗藥菌），等主治處理
  {
    const inpt = admissions.filter((a) => a.status === 'admitted')
    const later = (a: string, b: string) => (a > b ? a : b)
    const idDoc = doctorUser('DR11')
    // 要在昨天 15:00 的每日調劑之前開（今天的劑量才在那次調劑裡）；病人住進來太晚（入院時間隨日期變）就不放這一筆
    const udCut = `${addDays(T, -1)} 14:50`
    const addAbx = (a: Admission | undefined, drugId: string, startAt: string, abx: Omit<NonNullable<IpdOrder['abx']>, 'courseStart' | 'requestedAt' | 'steps' | 'status'>, decide?: { approve: boolean; at: string; text: string; days?: number }) => {
      if (!a || startAt >= udCut) return
      const d = drugMap.get(drugId)!
      const req = `${ABX_REASON_LABEL[abx.reason]}${abx.organism ? `（${abx.organism}）` : ''}・${abx.site}${abx.note ? `：${abx.note}` : ''}`
      const o: IpdOrder = {
        id: id('IO'), admissionId: a.id, type: 'long', category: 'medication', drugId, content: d.name, dose: 1, freq: d.defaultFreq, route: 'IV',
        startAt, status: 'active', doctorId: a.doctorId, createdAt: startAt,
        abx: {
          ...abx, courseStart: startAt, requestedAt: startAt,
          status: decide ? (decide.approve ? 'approved' : 'rejected') : 'pending', ...(decide?.days ? { approvedDays: decide.days } : {}),
          steps: [{ action: 'request', at: startAt, by: doctorUser(a.doctorId), text: req }, ...(decide ? [{ action: decide.approve ? 'approve' as const : 'reject' as const, at: decide.at, by: idDoc, text: decide.text, ...(decide.days ? { days: decide.days } : {}) }] : [])],
        },
      }
      ipdOrders.push(o)
      const f = codes.frequencies.find((x) => x.code === o.freq)!
      for (let day = startAt.slice(0, 10); day <= T; day = addDays(day, 1)) {
        for (const tm of marTimes(f.code, f.times, undefined, 'IV')) {
          const at = `${day} ${tm}`
          if (at < startAt) continue
          const past = at < recentCut
          mar.push({ id: id('MAR'), orderId: o.id, admissionId: a.id, scheduledAt: at, status: past ? 'given' : 'pending', ...(past ? { executedAt: at, nurseId: 'U201' } : {}) })
        }
      }
    }
    const sepsis = inpt.find((a) => a.diagnosis.startsWith('A41'))
    const cell = inpt.find((a) => a.diagnosis.startsWith('L03'))
    const pneu = inpt.find((a) => a.diagnosis.startsWith('J18'))
    if (sepsis) addAbx(sepsis, 'M043', later(addMinutes(nowStr, -50 * 60), addMinutes(sepsis.admittedAt!, 60)), { reason: 'empiric', site: '血流', note: '血壓偏低、乳酸上升，先擴大涵蓋' })
    if (cell) {
      const s = later(`${addDays(T, -7)} 10:00`, addMinutes(cell.admittedAt!, 240))
      addAbx(cell, 'M042', s, { reason: 'culture', site: '皮膚軟組織', organism: 'MRSA', note: '傷口培養 MRSA' }, { approve: true, at: notFuture(addMinutes(s, 20 * 60), 30), text: '同意使用，請監測 Vancomycin 谷濃度與腎功能', days: 7 })
    }
    const stroke = inpt.find((a) => a.diagnosis.startsWith('I63'))
    if (stroke) {
      const d = drugMap.get('M004')!
      const startAt = `${addDays(T, -1)} 10:30`
      const o: IpdOrder = { id: 'IO-ABX-ST', admissionId: stroke.id, type: 'long', category: 'medication', drugId: d.id, content: d.name, dose: 1, freq: 'BID', route: 'PO', ...(timingApplies('BID', 'PO') ? { timing: effectiveTiming(d.timing, undefined) } : {}), startAt, status: 'active', doctorId: stroke.doctorId, createdAt: startAt, ackAt: addMinutes(startAt, 15), ackBy: 'U202' }
      ipdOrders.push(o)
      const f = codes.frequencies.find((x) => x.code === 'BID')!
      for (let day = startAt.slice(0, 10); day <= T; day = addDays(day, 1)) {
        for (const tm of marTimes(f.code, f.times, o.timing, 'PO')) {
          const at = `${day} ${tm}`
          if (at < startAt) continue
          const past = at < recentCut
          mar.push({ id: id('MAR'), orderId: o.id, admissionId: stroke.id, scheduledAt: at, status: past ? 'given' : 'pending', ...(past ? { executedAt: at, nurseId: 'U202' } : {}) })
        }
      }
    }
    // 腦梗塞薦骨壓傷：前天 13:00 清創術（手術在下面「手術」那段），12:30 先給一劑 Vancomycin 當預防（核准 1 天）；
    // 手術結束超過 24 小時還在用 → 預防用藥待停
    if (stroke) {
      const s = `${addDays(T, -2)} 12:30`
      addAbx(stroke, 'M042', s, { reason: 'prophylaxis', site: '手術部位', note: '薦骨壓傷清創術' }, { approve: true, at: `${addDays(T, -2)} 15:00`, text: '手術預防用藥，核准 1 天', days: 1 })
      const vo = ipdOrders.at(-1)!
      mar.push({ id: id('MAR'), orderId: vo.id, admissionId: stroke.id, scheduledAt: s, status: 'given', executedAt: s, nurseId: 'U202' })
    }
    if (pneu) {
      const s = later(`${addDays(T, -1)} 09:00`, addMinutes(pneu.admittedAt!, 60))
      addAbx(pneu, 'M044', s, { reason: 'empiric', site: '肺部', note: '發燒未退' }, { approve: false, at: notFuture(addMinutes(s, 7 * 60), 20), text: '已使用 Ceftriaxone，痰液培養無抗藥菌：建議停用 Piperacillin/Tazobactam，續用 Ceftriaxone' })
    }
  }

  // ---------- 住院調劑（UD）：昨天 15:00 調劑、15:20 另一位藥師核對送出今天整天的劑量（不抽亂數） ----------
  // 今天的排程（已給的、待給的）都由這一次調劑送到病房；明天的還沒調——藥師下午打開「住院藥局」就有每日調劑可做。
  // 核對通過才扣帳：扣庫存的異動在下面重播帳本時一起產生（時間＝核對，和門診發藥同一套 FEFO），txnId 那時才填
  const udAt = `${addDays(T, -1)} 15:00`
  const udVerifiedAt = `${addDays(T, -1)} 15:20`
  const udLines: UdLine[] = []
  for (const o of ipdOrders.filter((x) => x.category === 'medication' && x.type === 'long' && x.status === 'active' && x.freq !== 'PRN' && x.startAt < udAt)) {
    const ms = mar.filter((m) => m.orderId === o.id && m.scheduledAt.startsWith(T))
    if (!ms.length) continue
    const per = udPerDose(drugMap.get(o.drugId!)!, o.dose)
    const line: UdLine = { id: `UDL-SEED-${udLines.length + 1}`, admissionId: o.admissionId, orderId: o.id, drugId: o.drugId!, marIds: ms.map((m) => m.id), qty: per ? per * ms.length : 1, ...(per ? { perDose: per } : {}) }
    for (const m of ms) m.udLineId = line.id
    udLines.push(line)
  }
  const udNo = `UD${addDays(T, -1).replace(/-/g, '')}-01`
  const udDispenses: UdDispense[] = udLines.length ? [{
    id: 'UD-SEED-1', no: udNo, locationId: '', kind: 'daily', dispensedBy: 'U301', dispensedAt: udAt, lines: udLines,
    // 藥車 15:50 到病房，護理師逐盒點收（昨天的藥車早就點收完了；今天新送的才會出現在護理站「藥車待點收」）
    boxes: [...new Set(udLines.map((l) => l.admissionId))].map((admissionId) => {
      const bedId = admissions.find((x) => x.id === admissionId)?.bedId
      const ward = beds.find((b) => b.id === bedId)?.ward
      return { admissionId, status: 'verified' as const, verifiedBy: 'U302', verifiedAt: udVerifiedAt, ...(ward ? { ward } : {}), receivedBy: 'U202', receivedAt: `${addDays(T, -1)} 15:50` }
    }),
  }] : []

  // ---------- 藥品庫存帳 ----------
  // 用「重播」產生：期初 → 進貨 → 每日發藥，依時間順序、用與服務層相同的 FEFO 規則扣批號。
  // 這樣產生的帳，結存、批號、異動一定對得起來；最後的庫存約等於 codes 裡設定的目標值。
  const drugs = structuredClone(codes.drugs).map(withPrices)
  const drugLots: DrugLot[] = []
  const stockTxns: StockTxn[] = []
  // 庫存地點：小型只有一個藥局（進貨、發藥都在這）；大型是藥庫（進貨）＋門診藥局（發藥）＋住院藥局。
  // 兩種規模重播的事件完全相同（亂數抽的次數一樣），差別只在「放在哪」：
  // 大型的門診藥局快不夠發時，先從藥庫撥一批過來（依 FEFO、帶著批號效期）——最後全院總量和小型一模一樣
  const stockLocations: StockLocation[] =
    scale === 'small'
      ? [{ id: 'LOC-PH', name: '藥局', kind: 'pharmacy', receivesPurchase: true, dispensesOpd: true, dispensesIpd: true, active: true }]
      : [
          { id: 'LOC-WH', name: '藥庫', kind: 'warehouse', receivesPurchase: true, dispensesOpd: false, dispensesIpd: false, active: true },
          { id: 'LOC-OPD', name: '門診藥局', kind: 'pharmacy', receivesPurchase: false, dispensesOpd: true, dispensesIpd: false, active: true },
          { id: 'LOC-IPD', name: '住院藥局', kind: 'pharmacy', receivesPurchase: false, dispensesOpd: false, dispensesIpd: true, active: true },
        ]
  // 病房常備（每個病房一個地點）：PRN、STAT 從這裡扣。品項與基準量是藥劑部與護理部協議的清單（各病房相同，固定、不抽亂數）
  codes.wards.forEach((w, i) => stockLocations.push({ id: `LOC-W${i + 1}`, name: `${w.split(' ')[0]} 病房常備`, kind: 'ward', ward: w, receivesPurchase: false, dispensesOpd: false, dispensesIpd: false, active: true }))
  const WARD_PAR: [string, number][] = [['M001', 40], ['M031', 20], ['M039', 5], ['M026', 10]]
  const wardStockItems: WardStockItem[] = codes.wards.flatMap((w) => WARD_PAR.map(([drugId, par]) => ({ ward: w, drugId, par })))
  // 兩天前住院藥局補滿；第一個病房的 Acetaminophen 這兩天用掉 15 顆（示範「低於基準量、待補充」）
  const wardRefillAt = `${addDays(T, -2)} 14:00`
  const wardRefillNo = (i: number) => `WR${addDays(T, -2).replace(/-/g, '')}-0${i + 1}`
  const wardStartQty = (wi: number, drugId: string, par: number) => (wi === 0 && drugId === 'M001' ? par - 15 : par)
  const recvLoc = stockLocations.find((l) => l.receivesPurchase)!.id
  const opdLoc = stockLocations.find((l) => l.dispensesOpd)!.id
  const ipdLoc = stockLocations.find((l) => l.dispensesIpd)!.id
  for (const u of udDispenses) u.locationId = ipdLoc
  const safetyStocks: SafetyStock[] = []
  const realOut = new Map<string, { at: string; qty: number; ref: string; disp?: Dispense }[]>()
  for (const d of dispenses.filter((x) => x.status === 'dispensed')) {
    const e = encounters.find((x) => x.id === d.encounterId)!
    for (const m of e.medications) {
      const list = realOut.get(m.drugId) ?? []
      list.push({ at: d.dispensedAt!, qty: m.qty, ref: `領藥號 ${d.pickupNo}`, disp: d })
      realOut.set(m.drugId, list)
    }
  }
  /** 不走一般庫存帳重播的藥（不抽亂數、不用流水號：加進來不會改變其他藥與後面的種子資料），在迴圈後另外開帳 */
  const FIXED_STOCK = new Set(['M041', 'M042', 'M043', 'M044', 'M045', 'M046', 'M047', 'M048', 'M049', 'M050'])
  drugs.forEach((drug, di) => {
    if (FIXED_STOCK.has(drug.id)) return
    // 展示用：幾種藥庫存偏低、一種缺貨（codes 的安全庫存是依原庫存的 15% 設的，不調低的話永遠不會「偏低」）
    const target = di === 8 ? 0 : di % 9 === 4 ? Math.round(drug.safetyStock * 0.6) : drug.stock
    const busy = target >= 500
    // 第 7 天以前用「每日彙總」補足用量（之前沒有逐筆掛號資料）；最近 6 天用真實發藥紀錄
    const outs = [
      ...Array.from({ length: 24 }, (_, k) => 30 - k)
        .filter(() => rand() < 0.7)
        .map((daysAgo) => ({ at: `${addDays(T, -daysAgo)} 17:30`, qty: int(1, busy ? 30 : 8), ref: '門診調劑（每日彙總）' })),
      // 帳本從期初（31 天前）開始；更早的發藥已經反映在期初數量裡，不能再重播一次
      ...(realOut.get(drug.id) ?? []).filter((o) => o.at >= addDays(T, -30)),
      // 住院調劑：從住院藥局扣（小型就是同一個藥局）
      ...udLines.filter((l) => l.drugId === drug.id && l.qty > 0).map((l) => ({ at: udVerifiedAt, qty: l.qty, ref: udNo, loc: ipdLoc, line: l })),
    ]
    // 病房常備補充（住院藥局 → 病房）：不改變全院總量，只換地點
    const wardMoves = codes.wards.flatMap((w, wi) => wardStockItems.filter((x) => x.ward === w && x.drugId === drug.id).map((x) => ({ kind: 'ward' as const, at: wardRefillAt, qty: wardStartQty(wi, x.drugId, x.par), ref: wardRefillNo(wi), loc: `LOC-W${wi + 1}` })))
    const udNeed = udLines.filter((l) => l.drugId === drug.id).reduce((n, l) => n + l.qty, 0)
    const receiveAt = `${addDays(T, -14)} 10:00`
    const totalOut = outs.reduce((s, o) => s + o.qty, 0)
    const outBefore = outs.filter((o) => o.at < receiveAt).reduce((s, o) => s + o.qty, 0)
    let opening = Math.max(target + totalOut - Math.round(target * 0.5), outBefore + 20)
    let receive = target + totalOut - opening
    if (receive < 0) { opening += receive; receive = 0 }

    const year = Number(T.slice(0, 4))
    // 展示用：每 7 種藥有一種舊批號即將到期；M005 的舊批號已過期（有待報廢品）
    const oldExpiry = drug.id === 'M005' ? addDays(T, -5) : di % 7 === 3 ? addDays(T, int(20, 50)) : `${year + 1}-0${int(1, 9)}-15`
    // 舊批號在帳期內就過期（M005）：過期後的用量只能由新進貨的批號支應，進貨量至少要蓋過它
    const outAfterExpiry = outs.filter((o) => o.at.slice(0, 10) > oldExpiry).reduce((s, o) => s + o.qty, 0)
    if (outAfterExpiry > 0 && receive < outAfterExpiry + 20) {
      receive = outAfterExpiry + 20
      opening = Math.max(target + totalOut - receive, outBefore + 20)
    }
    const events: ({ kind: 'lot'; at: string; lot: Omit<DrugLot, 'locationId'>; type: StockTxn['type']; ref?: string } | { kind: 'out'; at: string; qty: number; ref: string; loc?: string; line?: UdLine; disp?: Dispense } | { kind: 'ward'; at: string; qty: number; ref: string; loc: string })[] = [
      { kind: 'lot' as const, at: `${addDays(T, -31)} 08:00`, type: 'opening' as const, lot: { id: id('LOT'), drugId: drug.id, lotNo: `L${String(year - 1).slice(2)}${String(di).padStart(3, '0')}A`, expiry: oldExpiry, qty: opening, receivedAt: `${addDays(T, -31)} 08:00` } },
      ...(receive > 0 ? [{ kind: 'lot' as const, at: receiveAt, type: 'receive' as const, ref: `PO${T.replace(/-/g, '').slice(2, 6)}${String(di).padStart(3, '0')}`, lot: { id: id('LOT'), drugId: drug.id, lotNo: `L${String(year).slice(2)}${String(di).padStart(3, '0')}B`, expiry: `${year + 2}-0${int(1, 9)}-28`, qty: receive, receivedAt: receiveAt } }] : []),
      // 大型：藥庫的備量比單一藥局多——一般的藥另外進一批（安全庫存 5 倍：撥給藥局後仍高於藥庫自己的 3 倍安全量；固定批號效期、不抽亂數）。
      // 示範用「偏低／缺貨」的藥不加：全院都短缺，門診藥局和藥庫才會一起顯示偏低（不然藥庫一直撥，藥局永遠不缺）
      ...(scale === 'large' && target === drug.stock
        ? [{ kind: 'lot' as const, at: `${addDays(T, -7)} 10:00`, type: 'receive' as const, ref: `PO${T.replace(/-/g, '').slice(2, 6)}${String(di).padStart(3, '0')}W`, lot: { id: id('LOT'), drugId: drug.id, lotNo: `L${String(year).slice(2)}${String(di).padStart(3, '0')}W`, expiry: `${year + 2}-06-30`, qty: drug.safetyStock * 5, receivedAt: `${addDays(T, -7)} 10:00` } }]
        : []),
      ...outs.map((o) => ({ kind: 'out' as const, ...o })),
      ...wardMoves,
    ].sort((a, b) => a.at.localeCompare(b.at))

    // 各地點的批號與結存（小型只有一個地點，recvLoc === opdLoc，行為和以前完全相同）
    const lots: DrugLot[] = []
    const balance: Record<string, number> = {}
    const at = (loc: string) => lots.filter((l) => l.locationId === loc)
    const post = (loc: string, type: StockTxn['type'], when: string, qty: number, moved: { lotNo: string; qty: number }[], ref?: string) => {
      balance[loc] = (balance[loc] ?? 0) + qty
      stockTxns.push({ id: id('ST'), drugId: drug.id, locationId: loc, at: when, type, qty, balance: balance[loc], lots: moved, ref, userId: 'U301' })
    }
    /** 從 from 撥 qty 到 to（FEFO），兩筆異動同一個單號 */
    const move = (from: string, to: string, qty: number, when: string, ref: string) => {
      const takes = allocateFefo(at(from), qty, when)
      if (!takes) throw new Error(`種子資料撥補錯誤：${drug.id} 於 ${when} ${from} 可用量不足（需 ${qty}）`)
      for (const t of takes) lots.find((l) => l.id === t.lotId)!.qty -= t.qty
      post(from, 'transfer-out', when, -qty, takes.map((t) => ({ lotNo: t.lotNo, qty: -t.qty })), ref)
      for (const t of takes) {
        const src = lots.find((l) => l.id === t.lotId)!
        let dst = lots.find((l) => l.locationId === to && l.lotNo === src.lotNo)
        if (!dst) {
          dst = { id: id('LOT'), drugId: drug.id, locationId: to, lotNo: src.lotNo, expiry: src.expiry, qty: 0, receivedAt: when }
          lots.push(dst)
        }
        dst.qty += t.qty
      }
      post(to, 'transfer-in', when, qty, takes.map((t) => ({ lotNo: t.lotNo, qty: t.qty })), ref)
    }
    /** 從藥庫撥 qty 到 to（FEFO） */
    const transfer = (to: string, qty: number, when: string, ref: string) => move(recvLoc, to, qty, when, ref)
    let xfer = 0
    const xferRef = () => `撥補 TR${drug.id}-${String(++xfer).padStart(2, '0')}`
    for (const ev of events) {
      if (ev.kind === 'ward') {
        // 大型：住院藥局不夠補，先向藥庫請領
        if (ipdLoc !== recvLoc) {
          const have = usableQty(at(ipdLoc), ev.at)
          if (have < ev.qty) transfer(ipdLoc, ev.qty - have + 10, ev.at, xferRef())
        }
        move(ipdLoc, ev.loc, ev.qty, ev.at, ev.ref)
        continue
      }
      if (ev.kind === 'lot') {
        lots.push({ ...ev.lot, locationId: recvLoc })
        post(recvLoc, ev.type, ev.at, ev.lot.qty, [{ lotNo: ev.lot.lotNo, qty: ev.lot.qty }], ev.ref)
        // 大型：住院藥局開帳時從藥庫撥一些注射劑，和住院病人在用的藥（夠調劑幾天：UD、病房常備都從這裡扣）
        if (scale === 'large' && ev.type === 'opening' && (drug.category === '注射' || udNeed > 0)) {
          const q = Math.min(Math.floor(ev.lot.qty / 2), Math.max(Math.min(20, Math.floor(ev.lot.qty / 10)), udNeed * 4 + 10))
          if (q > 0) transfer(ipdLoc, q, `${ev.at.slice(0, 10)} 09:00`, xferRef())
        }
        continue
      }
      // 大型：門診藥局發完會低於安全庫存，就先向藥庫請領，補到 3 倍安全庫存（藥庫不夠就撥它有的）——
      // 真實藥局是「低於安全量就請領」，不是等到發不出來才請；以前這樣做，示範時一大半的藥都顯示「偏低」，真正的警示反而被淹沒
      const outLoc = ev.loc ?? opdLoc
      if (opdLoc !== recvLoc && outLoc === opdLoc) {
        const have = usableQty(at(opdLoc), ev.at)
        if (have - ev.qty < drug.safetyStock) {
          const want = drug.safetyStock * 3 + ev.qty - have
          const whHas = usableQty(at(recvLoc), ev.at)
          if (whHas > 0) transfer(opdLoc, Math.min(want, whHas), ev.at, xferRef())
        }
      }
      const takes = allocateFefo(at(outLoc), ev.qty, ev.at)
      // 不足就直接報錯：之前這裡是「默默略過」，結果期初之前的舊發藥被略過卻仍算進總量，期初多出 120 都沒人發現
      if (!takes) throw new Error(`種子資料庫存帳錯誤：${drug.id} 於 ${ev.at} ${outLoc} 可用量不足（需 ${ev.qty}）`)
      for (const t of takes) lots.find((l) => l.id === t.lotId)!.qty -= t.qty
      post(outLoc, 'dispense', ev.at, -ev.qty, takes.map((t) => ({ lotNo: t.lotNo, qty: -t.qty })), ev.ref)
      if (ev.line) ev.line.txnId = stockTxns.at(-1)!.id
      // 門診發藥：調劑單記下扣庫存的異動（退藥時退回同幾個批號）
      if (ev.disp) (ev.disp.txnIds ??= []).push(stockTxns.at(-1)!.id)
    }
    drug.stock = Object.values(balance).reduce((a, b) => a + b, 0)
    drugLots.push(...lots)
    // 大型：藥庫要存得比藥局多（安全庫存 3 倍）；住院藥局只放少量注射劑
    if (scale === 'large') {
      safetyStocks.push({ locationId: 'LOC-WH', drugId: drug.id, qty: drug.safetyStock * 3 })
      if (drug.category === '注射') safetyStocks.push({ locationId: 'LOC-IPD', drugId: drug.id, qty: 5 })
    }
  })

  // 調劑單的 txnIds 要和處方同一個順序（退藥用 idx 對應第幾項）：上面是逐種藥重播，推進去的順序是藥品編號順序，
  // 處方順序不同的那天（例：先開 M022 再開 M009）退藥就會對到別的藥
  const txnById = new Map(stockTxns.map((x) => [x.id, x]))
  for (const d of dispenses) {
    if (!d.txnIds?.length) continue
    const e = encounters.find((x) => x.id === d.encounterId)!
    const pool = d.txnIds.map((tid) => txnById.get(tid)!)
    d.txnIds = e.medications.map((m) => {
      const i = pool.findIndex((x) => x.drugId === m.drugId)
      return i < 0 ? '' : pool.splice(i, 1)[0].id
    }).filter(Boolean)
  }

  // 門診示範用的第二級管制藥（Morphine 錠）：只放門診藥局，期初一批、之後沒有異動。
  // 大型醫院期初一律進藥庫，當天整批撥給門診藥局（和其他藥一樣：藥局的批號都來自藥庫、撥出撥入成對）
  for (const drug of drugs.filter((d) => FIXED_STOCK.has(d.id) && !d.restrictedAbx && !d.pca && !d.crash && !d.vaso)) {
    const year = Number(T.slice(0, 4))
    const at = `${addDays(T, -31)} 08:00`
    const lotNo = `L${String(year).slice(2)}${drug.id.slice(1)}M`
    const lot = (loc: string, qty: number, k: number) => ({ id: `LOT-${drug.id}-${k}`, drugId: drug.id, locationId: loc, lotNo, expiry: `${year + 2}-03-31`, qty, receivedAt: at })
    const txn = (k: number, loc: string, type: StockTxn['type'], when: string, qty: number, balance: number, ref?: string): StockTxn =>
      ({ id: `ST-${drug.id}-${k}`, drugId: drug.id, locationId: loc, at: when, type, qty, balance, lots: [{ lotNo, qty }], ...(ref ? { ref } : {}), userId: 'U301' })
    const n = drug.stock
    stockTxns.push(txn(1, recvLoc, 'opening', at, n, n))
    if (opdLoc === recvLoc) {
      drugLots.push(lot(opdLoc, n, 1))
    } else {
      const when = `${addDays(T, -31)} 09:00`
      const ref = `撥補 TR${drug.id}-01`
      stockTxns.push(txn(2, recvLoc, 'transfer-out', when, -n, 0, ref), txn(3, opdLoc, 'transfer-in', when, n, n, ref))
      drugLots.push(lot(recvLoc, 0, 1), lot(opdLoc, n, 2))
    }
  }

  // 管制性抗生素（M042–M044）：只放住院藥局，期初一批；住院調劑（UD）扣帳在這裡補上（和其他藥一樣在核對時扣、異動記到 UD 明細）。
  // 大型醫院期初進藥庫、當天整批撥給住院藥局
  // PCA 示範（不抽亂數）：闌尾炎病人（入院超過 12 小時）主治 10 小時前開 PCA、10 分鐘後雙人核對架設（住院藥局扣一袋）；
  // 每 4 小時紀錄，最近一次鎮靜 3 分、呼吸 9 次（警示，主治還沒處理）
  const pcas: PcaOrder[] = []
  const pcaAdm = admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('K35') && a.admittedAt && a.admittedAt < addMinutes(nowStr, -12 * 60))
  // PCA 藥袋（M045）也一樣只放住院藥局（大型：藥庫、住院藥局、門診藥局都有一點，照同一套撥補）
  for (const drug of drugs.filter((d) => FIXED_STOCK.has(d.id) && (d.restrictedAbx || d.pca || d.crash || d.vaso))) {
    const year = Number(T.slice(0, 4))
    const at = `${addDays(T, -31)} 08:00`
    const lotNo = `L${String(year).slice(2)}${drug.id.slice(1)}V`
    const n = drug.stock
    let k = 0
    const txn = (loc: string, type: StockTxn['type'], when: string, qty: number, balance: number, ref?: string): StockTxn =>
      ({ id: `ST-${drug.id}-${++k}`, drugId: drug.id, locationId: loc, at: when, type, qty, balance, lots: [{ lotNo, qty }], ...(ref ? { ref } : {}), userId: 'U301' })
    stockTxns.push(txn(recvLoc, 'opening', at, n, n))
    const lots: DrugLot[] = []
    const expiry = `${year + 2}-06-30`
    if (ipdLoc === recvLoc) lots.push({ id: `LOT-${drug.id}-1`, drugId: drug.id, locationId: ipdLoc, lotNo, expiry, qty: n, receivedAt: at })
    else {
      // 大型：藥庫留 1/4、撥一半給住院藥局（調劑用）、1/4 給門診藥局（各地點都高於安全庫存，不會一開就缺貨警示）
      const when = `${addDays(T, -31)} 09:00`
      const toIpd = Math.round(n / 2)
      const toOpd = Math.round(n / 4)
      stockTxns.push(
        txn(recvLoc, 'transfer-out', when, -toIpd, n - toIpd, `撥補 TR${drug.id}-01`), txn(ipdLoc, 'transfer-in', when, toIpd, toIpd, `撥補 TR${drug.id}-01`),
        txn(recvLoc, 'transfer-out', when, -toOpd, n - toIpd - toOpd, `撥補 TR${drug.id}-02`), txn(opdLoc, 'transfer-in', when, toOpd, toOpd, `撥補 TR${drug.id}-02`),
      )
      for (const x of stockTxns.slice(-4)) x.lots = [{ lotNo, qty: x.qty }]
      lots.push(
        { id: `LOT-${drug.id}-1`, drugId: drug.id, locationId: recvLoc, lotNo, expiry, qty: n - toIpd - toOpd, receivedAt: at },
        { id: `LOT-${drug.id}-2`, drugId: drug.id, locationId: ipdLoc, lotNo, expiry, qty: toIpd, receivedAt: when },
        { id: `LOT-${drug.id}-3`, drugId: drug.id, locationId: opdLoc, lotNo, expiry, qty: toOpd, receivedAt: when },
      )
    }
    const home = lots.find((l) => l.locationId === ipdLoc)!
    for (const l of udLines.filter((x) => x.drugId === drug.id && x.qty > 0)) {
      home.qty -= l.qty
      const x = txn(ipdLoc, 'dispense', udVerifiedAt, -l.qty, home.qty, udNo)
      x.lots = [{ lotNo, qty: -l.qty }]
      stockTxns.push(x)
      l.txnId = x.id
    }
    if (drug.pca && pcaAdm) {
      const ordered = addMinutes(nowStr, -10 * 60)
      const setupAt = addMinutes(ordered, 10)
      const doc = users.find((u) => u.doctorId === pcaAdm.doctorId)!.id
      home.qty -= 1
      const x = txn(ipdLoc, 'dispense', setupAt, -1, home.qty, `PCA ${pcaAdm.admitNo}`)
      Object.assign(x, { lots: [{ lotNo, qty: -1 }], userId: 'U201', patientId: pcaAdm.patientId, doctorId: pcaAdm.doctorId, witnessBy: 'U202' })
      stockTxns.push(x)
      const rec = (h: number, r: Omit<PcaRecord, 'at' | 'by' | 'alert'>): PcaRecord => ({ at: addMinutes(setupAt, h * 60), by: h % 8 ? 'U201' : 'U202', ...r, alert: r.sedation >= 3 || r.resp < 10 })
      pcas.push({
        id: 'PCA-SEED-1', admissionId: pcaAdm.id, drugId: drug.id, bolusMg: 1, lockoutMin: 10, hourLimitMg: 6, basalMgH: 0, orderedBy: doc, orderedAt: ordered, status: 'running',
        setup: { at: setupAt, by: 'U201', witnessBy: 'U202', txnId: x.id },
        records: [
          rec(4, { demands: 14, delivered: 9, usedMl: 9, pain: 5, sedation: 2, resp: 16 }),
          rec(8, { demands: 22, delivered: 15, usedMl: 24, pain: 3, sedation: 3, resp: 9, note: '叫醒後回答慢，暫停 PCA、給氧 2 L，已通知醫師' }),
        ],
      })
    }
    drug.stock = lots.reduce((s, l) => s + l.qty, 0)
    drugLots.push(...lots)
  }

  // 展示用（U25）：一張昨天提出、還沒到貨的補貨申請（第一種「偏低」的藥）——
  // 藥品庫存頁「待到貨」卡片與首頁待辦打開就有東西可看。數量用和畫面相同的建議公式；不抽亂數（不影響後面的種子資料）
  const restockRequests: RestockRequest[] = []
  const lowDrug = drugs[4]
  if (lowDrug) {
    const usable = usableQty(drugLots.filter((l) => l.drugId === lowDrug.id && l.locationId === opdLoc && l.qty > 0), T)
    const used30 = -stockTxns.filter((x) => x.drugId === lowDrug.id && x.locationId === opdLoc && x.type === 'dispense' && x.at >= addDays(T, -30)).reduce((n, x) => n + x.qty, 0)
    const { qty } = suggestRestockQty({ usable, need: 0, safetyStock: lowDrug.safetyStock, used30 })
    if (qty > 0) {
      restockRequests.push({
        id: 'RS-SEED-1', drugId: lowDrug.id, qty, receivedQty: 0, dispenseIds: [], note: '低於安全庫存，已向藥商叫貨',
        requestedBy: 'U301', requestedAt: `${addDays(T, -1)} 16:40`, status: 'open', txnIds: [],
      })
    }
  }

  // 採購單（不抽亂數）：
  //   1. 歷史：帳上每一天的「進貨」異動，都屬於那天到齊的一張採購單（異動單號改成採購單號），開單、核准在幾天前
  //   2. 待核准：昨天藥師開的，帶入上面那張補貨申請（管理員打開就有東西可核准）
  //   3. 已訂購：三天前核准、還沒到貨（藥師打開就有東西可入庫）
  const purchaseOrders: PurchaseOrder[] = []
  // 供應商主檔（虛構的公司、統編符合檢查碼、電話是示範號碼）。各家折扣不同，供應商頁的「以前的進價」才有比價可看；
  // 第四家是停用的示範（不再往來，舊資料仍在）
  const suppliers: Supplier[] = [
    { id: 'S001', name: '台灣藥品股份有限公司', taxId: '24536801', contact: '王建民', phone: '02-2345-6789', active: true, createdAt: `${addDays(T, -400)} 10:00` },
    { id: 'S002', name: '永信醫藥科技股份有限公司', taxId: '53716200', contact: '李美玲', phone: '04-2234-5678', active: true, createdAt: `${addDays(T, -400)} 10:05` },
    { id: 'S003', name: '杏林藥業有限公司', taxId: '80421502', contact: '陳志豪', phone: '07-3345-6789', note: '急件可當天送', active: true, createdAt: `${addDays(T, -400)} 10:10` },
    { id: 'S004', name: '安心藥品有限公司', phone: '02-2765-4321', note: '已不再往來', active: false, createdAt: `${addDays(T, -700)} 09:00`, updatedAt: `${addDays(T, -200)} 11:00` },
  ]
  /** 各家的進價折扣（健保價的幾 %） */
  const DISCOUNT = [85, 82, 88]
  const costOf = (drugId: string, k = 0) => Math.round(drugMap.get(drugId)!.nhiPrice * DISCOUNT[k]) / 100
  const supplierOf = (k: number) => ({ supplierId: suppliers[k].id, supplier: suppliers[k].name })
  const recvByDay = new Map<string, StockTxn[]>()
  for (const t of stockTxns.filter((x) => x.type === 'receive')) recvByDay.set(t.at.slice(0, 10), [...(recvByDay.get(t.at.slice(0, 10)) ?? []), t])
  // 同一天到貨的分給三家供應商（依藥品與日期輪替、不抽亂數）：每家都有進貨紀錄，同一種藥不同天向不同家買，才有比價可看
  const drugIdx = new Map(drugs.map((d, i) => [d.id, i]))
  ;[...recvByDay.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([day, txns], k) => {
    const bySupplier = [0, 1, 2].map((sk) => txns.filter((t) => ((drugIdx.get(t.drugId) ?? 0) + k) % 3 === sk))
    let n = 0
    bySupplier.forEach((group, sk) => {
      if (!group.length) return
      n++
      const no = `PO${addDays(day, -5).replace(/-/g, '')}-${String(n).padStart(2, '0')}`
      for (const t of group) t.ref = no
      purchaseOrders.push({
        id: `PO-SEED-H${k + 1}-${n}`, no, ...supplierOf(sk), status: 'received', locationId: recvLoc,
        lines: group.map((t, i) => ({ id: `L${i + 1}`, drugId: t.drugId, qty: t.qty, unitCost: costOf(t.drugId, sk), receivedQty: t.qty, txnIds: [t.id] })),
        createdBy: 'U301', createdAt: `${addDays(day, -5)} 15:0${n}`, submittedAt: `${addDays(day, -5)} 15:1${n}`,
        approvedBy: 'U001', approvedAt: `${addDays(day, -4)} 09:3${n}`, closedBy: 'U301', closedAt: group[group.length - 1].at,
      })
    })
  })
  {
    const req = restockRequests[0]
    const other = drugs.find((d) => d.id !== req?.drugId && d.active && d.category === '口服' && d.id !== 'M009')!
    const lines: PurchaseOrder['lines'] = [
      ...(req ? [{ id: 'L1', drugId: req.drugId, qty: req.qty, unitCost: costOf(req.drugId), ...(scale === 'small' ? { restockId: req.id } : {}), receivedQty: 0, txnIds: [] }] : []),
      { id: req ? 'L2' : 'L1', drugId: other.id, qty: 200, unitCost: costOf(other.id), receivedQty: 0, txnIds: [] },
    ]
    purchaseOrders.push({
      id: 'PO-SEED-P1', no: `PO${addDays(T, -1).replace(/-/g, '')}-01`, ...supplierOf(0), status: 'pending', locationId: recvLoc, lines,
      note: scale === 'small' ? '補貨申請轉採購' : '藥庫備量', createdBy: 'U301', createdAt: `${addDays(T, -1)} 16:50`, submittedAt: `${addDays(T, -1)} 16:55`,
    })
    const o1 = drugs.find((d) => d.id === 'M010')!
    const o2 = drugs.find((d) => d.id === 'M018')!
    purchaseOrders.push({
      id: 'PO-SEED-O1', no: `PO${addDays(T, -3).replace(/-/g, '')}-01`, ...supplierOf(1), status: 'ordered', locationId: recvLoc,
      expectedDate: addDays(T, 1),
      lines: [o1, o2].map((d, i) => ({ id: `L${i + 1}`, drugId: d.id, qty: d.safetyStock * 2, unitCost: costOf(d.id, 1), receivedQty: 0, txnIds: [] })),
      createdBy: 'U301', createdAt: `${addDays(T, -3)} 10:20`, submittedAt: `${addDays(T, -3)} 10:25`, approvedBy: 'U001', approvedAt: `${addDays(T, -3)} 14:00`,
    })
  }

  // 撥補單（大型醫院，不抽亂數）：
  //   1. 歷史：帳上每一組「撥出／撥入」都屬於一張已簽收的撥補單（同一天、同一個藥局合成一張；異動單號改成撥補單號）
  //   2. 請領中：門診藥局為上面那張補貨申請向藥庫請領（藥庫打開就有東西可撥）
  const transfers: TransferOrder[] = []
  if (scale === 'large') {
    // 病房常備補充（WR）不是撥補單：住院藥局 → 病房，另有自己的單號
    const outs = stockTxns.filter((t) => t.type === 'transfer-out' && !t.ref?.startsWith('WR')).sort((x, y) => x.at.localeCompare(y.at))
    // 同一天、同一個藥局合成一張；同一種藥同一天撥兩次就另開一張（一張單裡同一種藥只有一行）
    const groups: { day: string; to: string; list: StockTxn[] }[] = []
    for (const o of outs) {
      const inn = stockTxns.find((t) => t.type === 'transfer-in' && t.ref === o.ref && t.drugId === o.drugId)!
      const day = o.at.slice(0, 10)
      const g = groups.find((x) => x.day === day && x.to === inn.locationId && !x.list.some((y) => y.drugId === o.drugId))
      if (g) g.list.push(o)
      else groups.push({ day, to: inn.locationId, list: [o] })
    }
    const perDay = new Map<string, number>()
    for (const { day, to, list } of groups) {
      const n = (perDay.get(day) ?? 0) + 1
      perDay.set(day, n)
      const no = `TR${day.replace(/-/g, '')}-${String(n).padStart(2, '0')}`
      const lines: TransferOrder['lines'] = []
      for (const o of list) {
        const inn = stockTxns.find((t) => t.type === 'transfer-in' && t.ref === o.ref && t.drugId === o.drugId)!
        o.ref = no
        inn.ref = no
        const lots = o.lots.map((x) => ({ lotNo: x.lotNo, expiry: drugLots.find((l) => l.drugId === o.drugId && l.lotNo === x.lotNo)!.expiry, qty: -x.qty, receivedQty: -x.qty }))
        lines.push({ id: `L${lines.length + 1}`, drugId: o.drugId, qty: -o.qty, issuedQty: -o.qty, lots })
      }
      const first = list.map((o) => o.at).sort()[0]
      const last = list.map((o) => o.at).sort().at(-1)!
      transfers.push({
        id: `TR-SEED-${transfers.length + 1}`, no, fromLocationId: recvLoc, toLocationId: to, status: 'received', lines,
        requestedBy: 'U301', requestedAt: first, issuedBy: 'U302', issuedAt: first, receivedBy: 'U301', receivedAt: last,
      })
    }
    const req = restockRequests[0]
    if (req) {
      transfers.push({
        id: 'TR-SEED-REQ', no: `TR${addDays(T, -1).replace(/-/g, '')}-90`, fromLocationId: recvLoc, toLocationId: opdLoc, status: 'requested',
        // 第二行是藥庫有的藥：示範「藥庫不夠就少撥」——缺貨的那行先撥 0，等採購到貨再請領
        lines: [{ id: 'L1', drugId: req.drugId, qty: req.qty, restockId: req.id }, { id: 'L2', drugId: 'M001', qty: drugs.find((d) => d.id === 'M001')!.safetyStock }],
        note: '窗口缺藥，病人在等', requestedBy: 'U301', requestedAt: `${addDays(T, -1)} 16:45`,
      })
    }
  }

  // 組套：每位門診醫師兩三組個人常用處方；內科的「糖尿病追蹤」是科室共用（陳映如、黃柏翰都看得到、都能改）
  const setMed = (drugId: string, dose: number, freq: string, days: number) => {
    const d = drugMap.get(drugId)!
    return { drugId, dose, freq, route: d.defaultRoute, days, qty: autoQty(d, dose, freqTimes(freq), days) ?? 1, selfPay: false }
  }
  const setDx = (...icds: string[]) => icds.map((code, i) => ({ icd: code, name: codes.icdCodes.find((c) => c.code === code)?.name ?? code, primary: i === 0 }))
  const setAt = `${addDays(T, -30)} 09:00`
  const orderSets: OrderSet[] = [
    { doctorId: 'DR01', name: '上呼吸道感染', diagnoses: setDx('J06.9'), medications: [setMed('M001', 1, 'TID', 3), setMed('M007', 1, 'HS', 3), setMed('M010', 1, 'TID', 3)], procedures: [], subjective: '喉嚨痛、流鼻水', plan: '症狀治療，多喝水休息' },
    { doctorId: 'DR01', name: '高血壓追蹤', diagnoses: setDx('I10'), medications: [setMed('M012', 1, 'QD', 28)], procedures: [], plan: '持續用藥，居家量血壓' },
    { doctorId: 'DR01', name: '腸胃炎', diagnoses: setDx('A09'), medications: [setMed('M025', 1, 'TID', 3), setMed('M026', 1, 'PRN', 3)], procedures: [], plan: '清淡飲食、補充水分' },
    { doctorId: 'DR02', scope: 'dept' as const, deptId: 'D02', name: '糖尿病追蹤', diagnoses: setDx('E11.9'), medications: [setMed('M015', 1, 'BID', 28)], procedures: [{ procId: 'P004', qty: 1, selfPay: false }, { procId: 'P005', qty: 1, selfPay: false }], plan: '飲食控制，三個月後追蹤 HbA1c' },
    { doctorId: 'DR02', name: '高血脂', diagnoses: setDx('E78.5'), medications: [setMed('M018', 1, 'HS', 28)], procedures: [{ procId: 'P006', qty: 1, selfPay: false }] },
    { doctorId: 'DR03', name: '胃食道逆流', diagnoses: setDx('K21.9'), medications: [setMed('M022', 1, 'QD', 14)], procedures: [], plan: '睡前三小時不進食' },
  ].map((s) => ({ scope: 'personal' as const, ...s, id: id('OS'), createdAt: setAt, updatedAt: setAt, updatedBy: s.doctorId }))

  // 片語：個人的常用文字，醫師與護理師各自一份（固定 id、不抽亂數，不影響其他資料）
  const phrases: Phrase[] = (
    [
      ['DR01', 'uri', '喉嚨痛、流鼻水、輕微咳嗽，無發燒，無呼吸困難。'],
      ['DR01', 'wnl', '理學檢查無特殊異常。'],
      ['DR01', 'fu', '一週後回診；若發燒超過三天、呼吸喘或症狀加劇，請立即返診。'],
      ['DR02', 'dm', '第二型糖尿病，規則服藥，飲食控制中。'],
      ['DR02', 'htn', '高血壓，規則服藥，居家血壓大致控制良好。'],
      ['DR03', 'gerd', '胸口灼熱、胃酸逆流，飯後及平躺時加劇。'],
      // 住院用（病程紀錄、出院病摘）
      ['DR02', 'stable', '生命徵象穩定，意識清楚，無新的不適主訴。'],
      ['DR02', 'cont', '續目前治療，追蹤檢驗數據，評估出院時程。'],
      ['DR02', 'opdfu', '一週後內科門診追蹤；如有發燒、呼吸喘、胸痛或意識改變，請立即返診。'],
      // 護理師（護理紀錄、交班）
      ['U201', 'fall', '已執行跌倒風險評估，衛教病人及家屬下床需有人陪同，床欄已拉起，呼叫鈴放在手邊。'],
      ['U201', 'fever', '依醫囑給予退燒藥，冰枕使用，鼓勵多喝水，一小時後複測體溫。'],
      ['U201', 'vs', '生命徵象穩定，持續監測。'],
    ] as const
  ).map(([owner, code, text], i) => ({ id: `PH-SEED-${i + 1}`, userId: owner.startsWith('U') ? owner : doctorUser(owner), code, text, createdAt: setAt, updatedAt: setAt }))
  // 共用片語：內科科室共用（dr02、dr03 都能用；.htn 和 dr02 的個人片語同簡碼，示範「個人的優先」）、5A 內科病房共用（護理師在 5A 寫紀錄時可用）
  const sharedPhrases: Phrase[] = (
    [
      ['DR03', 'dept', 'D02', 'dmedu', '衛教低升糖飲食、規律運動與足部自我檢查，攜帶血糖紀錄回診。'],
      ['DR03', 'dept', 'D02', 'htn', '高血壓，目前藥物治療中；衛教低鈉飲食、每日早晚量血壓並記錄。'],
      ['U202', 'ward', '5A 內科病房', 'turn', '每兩小時協助翻身，皮膚完整，無壓傷。'],
      ['U202', 'ward', '5A 內科病房', 'iv', '周邊靜脈留置針通暢，注射部位無紅腫熱痛。'],
    ] as const
  ).map(([owner, scope, where, code, text], i) => {
    const userId = owner.startsWith('U') ? owner : doctorUser(owner)
    return { id: `PH-SHARED-${i + 1}`, userId, scope, ...(scope === 'dept' ? { deptId: where } : { ward: where }), code, text, createdAt: setAt, updatedAt: setAt, updatedBy: userId }
  })
  phrases.push(...sharedPhrases)
  // 全院共用片語：醫師、護理師各一組（dr01、nurse02 被指定維護）。.fu、.fall 和個人片語同簡碼，示範「個人的優先」
  const hospitalPhrases: Phrase[] = (
    [
      ['U101', 'doctor', 'ama', '病人及家屬經說明病情及繼續住院治療之必要性後，仍要求自動出院，已告知可能之風險並簽署自動出院同意書。'],
      ['U101', 'doctor', 'fu', '請依約回診；若症狀加劇或出現新的不適，請提早就醫或至急診。'],
      ['U202', 'nurse', 'fall', '依全院防跌政策：衛教下床先坐起、站穩再走，夜間開小燈，穿防滑鞋，需要協助時按呼叫鈴。'],
      ['U202', 'nurse', 'pain', '疼痛評估（0–10 分）並記錄；衛教疼痛時主動告知，依醫囑給藥後 30 分鐘再評估。'],
    ] as const
  ).map(([userId, forRole, code, text], i) => ({ id: `PH-HOSP-${i + 1}`, userId, scope: 'hospital' as const, forRole, code, text, createdAt: setAt, updatedAt: setAt, updatedBy: userId }))
  phrases.push(...hospitalPhrases)

  // 展示資料裡的住院醫囑都是「之前開的」：當班護理師早已核對過（開立後 30 分鐘），
  // 不然一打開護理站，每位病人都掛著「新醫囑」，真正新開的反而被淹沒
  // 核對時間＝事件後 30 分鐘，但不晚於現在（也就不會早於事件本身：事件時間一定 ≤ 現在）
  const ackTime = (at: string) => (addMinutes(at, 30) > nowStr ? nowStr : addMinutes(at, 30))
  for (const o of ipdOrders) {
    if (o.status === 'done') continue
    o.ackAt = ackTime(o.startAt)
    o.ackBy = 'U202'
    if (o.status === 'stopped' && o.stopAt) {
      o.stopAckAt = ackTime(o.stopAt)
      o.stopAckBy = 'U202'
    }
  }

  // ---------- 號碼依時間先後重編（B11） ----------
  // 資料是分段產生的（歷史、近幾天、今天、預約各一段），產生順序≠時間順序：以前會出現「R0002 10:37、R0003 10:07」、
  // 第 2 號比第 1 號早掛號。最後統一依時間重編一次；每組的筆數不變，所以計數器（下一個號碼）不用改
  const renumber = <X>(items: X[], groupOf: (x: X) => string, timeOf: (x: X) => string, idOf: (x: X) => string, set: (x: X, n: number) => void) => {
    const groups = new Map<string, X[]>()
    for (const x of items) groups.set(groupOf(x), [...(groups.get(groupOf(x)) ?? []), x])
    for (const list of groups.values()) {
      list.sort((a, b) => timeOf(a).localeCompare(timeOf(b)) || idOf(a).localeCompare(idOf(b)))
      list.forEach((x, i) => set(x, i + 1))
    }
  }
  const visitById = new Map(visits.map((v) => [v.id, v]))
  // 看診號：同一診次依掛號時間
  renumber(visits, (v) => v.sessionId, (v) => v.createdAt, (v) => v.id, (v, n) => (v.seqNo = n))
  // 就醫序號：同一位病人依就醫時間（健保卡每次就醫加一）
  renumber(visits, (v) => v.patientId, (v) => v.createdAt, (v) => v.id, (v, n) => (v.cardSeq = String(n).padStart(4, '0')))
  // 收據號碼：同一天依收費時間
  // 住院收據沒有掛號：依結帳那天
  const receiptDay = (c: Charge) => (c.admissionId ? c.paidAt.slice(0, 10) : visitById.get(c.visitId)!.date)
  renumber(charges, receiptDay, (c) => c.paidAt, (c) => c.id, (c, n) => {
    c.receiptNo = `R${receiptDay(c).replace(/-/g, '')}${String(n).padStart(4, '0')}`
  })
  // 領藥號：同一天依開單（批價）時間
  renumber(dispenses, (d) => visitById.get(d.visitId)!.date, (d) => d.createdAt, (d) => d.id, (d, n) => (d.pickupNo = n))
  // 庫存帳重播時領藥號還沒重編：異動的單號跟著改成最後的領藥號（以前這裡沒改，帳上的「領藥號 N」指到別人的處方）
  {
    const txById = new Map(stockTxns.map((x) => [x.id, x]))
    for (const d of dispenses) for (const id of d.txnIds ?? []) txById.get(id)!.ref = `領藥號 ${d.pickupNo}`
  }

  // 報到時間（不抽亂數）：叫過號的，在叫號前 15 分鐘報到（現場掛號的就是掛號那一刻）；
  // 今天還在候診的：當天現場掛的已報到，事先預約的還沒到（還沒到他的掛號時段，或是上面那位預約未到的）
  for (const v of visits) {
    if (v.refillOf || v.status === 'cancelled') continue
    if (v.calledAt) {
      const before = addMinutes(v.calledAt, -15)
      v.checkedInAt = v.createdAt > before ? v.createdAt : before
    } else if (v.date === T && v.createdAt.startsWith(T)) {
      v.checkedInAt = v.createdAt
    }
  }

  // ---------- 檢驗報告（不抽亂數、不用流水號：數值由 id 雜湊決定，加進來不改變其他種子資料）----------
  // 以前（今天以前）完成、已批價的門診檢驗都已發報告；今天的留在檢驗科待檢驗清單。
  // 示範危急值：dr01 最近一份門診檢驗、和一位住院病人昨天的 CBC，都還沒確認（首頁、看診頁上方會提醒）
  const labReports: LabReport[] = []
  {
    const hash = (s: string) => {
      let h = 2166136261
      for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0
      return h / 4294967296
    }
    const sample = (def: LabItemDef, key: string, gender: Gender): string => {
      const r = hash(key)
      if (def.options) return r < 0.85 ? def.options[0] : def.options[1]
      const f = gender === 'F' && def.lowF !== undefined
      const low = (f ? def.lowF : def.low) ?? 0
      const high = (f ? def.highF : def.high) ?? low * 2
      const dec = /\./.test(String(def.high ?? def.low ?? '')) ? 1 : 0
      // 八成在參考範圍內，其餘略高（展示用的異常）
      const v = r < 0.8 ? low + (high - low) * (0.2 + 0.6 * hash(key + 'v')) : high * (1.05 + 0.3 * hash(key + 'h'))
      return v.toFixed(dec)
    }
    let seq = 0
    const labNo = (at: string) => `L${at.slice(0, 10).replace(/-/g, '')}${String(9000 + ++seq)}`
    const procMap = new Map(codes.procedures.map((x) => [x.id, x]))
    for (const e of encounters) {
      if (e.status !== 'completed' || e.date >= T || !e.completedAt) continue
      const v = visits.find((x) => x.id === e.visitId)
      if (!v || (v.status !== 'charged' && v.status !== 'dispensed')) continue
      const pt = patients.find((x) => x.id === e.patientId)!
      for (const x of e.procedures) {
        const defs = procMap.get(x.procId)?.labItems
        if (!defs?.length || x.notDone) continue
        const input = Object.fromEntries(defs.map((d) => [d.code, sample(d, `${e.id}:${d.code}`, pt.gender)]))
        const at = addMinutes(e.completedAt, 45)
        labReports.push({ id: `LR-SEED-${labReports.length + 1}`, no: labNo(at), patientId: e.patientId, procId: x.procId, encounterId: e.id, doctorId: e.doctorId, orderedAt: e.completedAt, values: buildLabValues(defs, input, pt.gender).values, reportedBy: 'U601', reportedAt: at })
      }
    }
    // 住院：入院時的檢驗（臨時醫囑，護理師已採檢）——今天以前採檢的都已發報告；今天的留在待檢驗
    for (const o of ipdOrders) {
      const defs = o.procId ? procMap.get(o.procId)?.labItems : undefined
      if (!defs?.length || o.type !== 'stat' || o.status !== 'done' || !o.stopAt || o.stopAt.slice(0, 10) >= T) continue
      const a = admissions.find((x) => x.id === o.admissionId)!
      const pt = patients.find((x) => x.id === a.patientId)!
      const input = Object.fromEntries(defs.map((d) => [d.code, sample(d, `${o.id}:${d.code}`, pt.gender)]))
      const at = addMinutes(o.stopAt, 60)
      labReports.push({ id: `LR-SEED-${labReports.length + 1}`, no: labNo(at), patientId: a.patientId, procId: o.procId!, orderId: o.id, admissionId: a.id, doctorId: o.doctorId, orderedAt: o.createdAt, values: buildLabValues(defs, input, pt.gender).values, reportedBy: 'U601', reportedAt: at })
    }
    // 歷史的都當作醫師已看過（只有下面兩份示範危急值待確認）
    // 示範一：最近一份門診血糖或 CBC 改成危急值（血糖 452 或白血球 1.6）；優先挑 dr01 的（第一個醫師帳號），沒有就挑別的醫師
    const crit = [...labReports].reverse().filter((r) => r.encounterId && ['P003', 'P004'].includes(r.procId))
    const dr01 = crit.find((r) => r.doctorId === 'DR01') ?? crit[0]
    if (dr01) {
      const pt = patients.find((x) => x.id === dr01.patientId)!
      const defs = procMap.get(dr01.procId)!.labItems!
      const input = Object.fromEntries(dr01.values.map((v) => [v.code, v.value]))
      if (dr01.procId === 'P004') input['GLU-AC'] = '452'
      else input.WBC = '1.6'
      dr01.values = buildLabValues(defs, input, pt.gender).values
    }
    // 示範二：住院病人昨天早上的 CBC（臨時醫囑，護理師已採檢），血色素 6.8 危急，主治還沒確認
    const adm = admissions.find((a) => a.status === 'admitted')
    if (adm) {
      const pt = patients.find((x) => x.id === adm.patientId)!
      const orderedAt = `${addDays(T, -1)} 06:00`
      ipdOrders.push({ id: 'IO-SEED-LAB1', admissionId: adm.id, type: 'stat', category: 'procedure', procId: 'P003', content: '全套血液檢查 CBC', startAt: orderedAt, stopAt: `${addDays(T, -1)} 06:20`, status: 'done', doctorId: adm.doctorId, createdAt: orderedAt, ackAt: `${addDays(T, -1)} 06:10`, ackBy: 'U201' })
      const at = `${addDays(T, -1)} 07:05`
      labReports.push({ id: 'LR-SEED-IPD1', no: labNo(at), patientId: adm.patientId, procId: 'P003', orderId: 'IO-SEED-LAB1', admissionId: adm.id, doctorId: adm.doctorId, orderedAt, values: buildLabValues(procMap.get('P003')!.labItems!, { WBC: '12.4', Hb: '6.8', HCT: '20.5', PLT: '210' }, pt.gender).values, reportedBy: 'U601', reportedAt: at })
    }
    for (const r of labReports) {
      if (r.values.some((v) => v.critical) && r !== dr01 && r.id !== 'LR-SEED-IPD1') {
        r.ackBy = users.find((u) => u.doctorId === r.doctorId)?.id
        r.ackAt = addMinutes(r.reportedAt, 20)
      }
    }
  }

  // ---------- 血庫與備血（示範，不抽亂數、不用流水號）----------
  // 血袋：三天前入庫（各血品、血型；一袋 A Rh+ 紅血球昨天過期待報廢、一袋 O Rh+ 兩天後到期、血小板效期短）。
  // 示範一：血色素 6.8 的那位住院病人，主治昨天早上開紅血球 2 單位，血庫驗血型、配好 2 袋，
  //   第一袋昨天上午輸完（雙人核對、15 分鐘生命徵象都有），第二袋配好還在血庫（今天血庫按「發血」、護理站床邊核對輸血）。
  // 示範二：敗血症病人今天上午開新鮮冷凍血漿 2 單位（侵入性處置前矯正凝血功能），血庫還沒驗血型
  const bloodUnits: BloodUnit[] = []
  const bloodRequests: BloodRequest[] = []
  {
    const recvDay = addDays(T, -3)
    let seq = 0
    const put = (product: BloodProduct, abo: Abo, rh: '+' | '-', expDays: number[]) => {
      for (const e of expDays) {
        seq++
        bloodUnits.push({
          id: `BU-SEED-${seq}`, unitNo: `TB${recvDay.slice(2).replace(/-/g, '')}${String(seq).padStart(4, '0')}`, product, abo, rh,
          volume: product === 'ffp' ? 200 : 250, expiresOn: addDays(T, e), receivedAt: `${recvDay} 10:00`, receivedBy: 'U601', status: 'available',
        })
      }
    }
    put('rbc', 'O', '+', [2, 9, 12, 15, 18, 21, 24, 27])
    put('rbc', 'A', '+', [-1, 8, 11, 14, 17, 20, 23])
    put('rbc', 'B', '+', [10, 13, 16, 19])
    put('rbc', 'AB', '+', [12, 22])
    put('rbc', 'O', '-', [14, 25])
    put('rbc', 'A', '-', [19])
    put('ffp', 'A', '+', [300, 310, 320, 330])
    put('ffp', 'B', '+', [300, 310, 320])
    put('ffp', 'O', '+', [300, 310, 320, 330])
    put('ffp', 'AB', '+', [300, 330])
    put('plt', 'A', '+', [2])
    put('plt', 'O', '+', [2, 3])
    put('plt', 'B', '+', [3])

    const y = addDays(T, -1)
    const typeOf = (patientId: string): Abo => (patients.find((x) => x.id === patientId)?.bloodType || 'O') as Abo
    const adm = admissions.find((a) => a.status === 'admitted')
    if (adm?.admittedAt && adm.admittedAt <= `${y} 06:00`) {
      const abo = typeOf(adm.patientId)
      const pt = patients.find((x) => x.id === adm.patientId)!
      const units = bloodUnits.filter((u) => u.product === 'rbc' && u.abo === abo && u.rh === '+' && u.expiresOn > T).slice(0, 2)
      const reqId = 'BR-SEED-1'
      for (const u of units) Object.assign(u, { status: 'reserved', requestId: reqId })
      const vit = (at: string, kind: 'pre' | '15min' | 'end', temp: number, pulse: number, sbp: number, dbp: number) => {
        vitals.push({ id: `VS-BLD-${kind}`, admissionId: adm.id, at, temp, pulse, sbp, dbp, nurseId: 'U201' })
        return { at, kind, temp, pulse, sbp, dbp, by: 'U201' }
      }
      const r: BloodRequest = {
        id: reqId, no: `BR${y.replace(/-/g, '')}001`, admissionId: adm.id, patientId: adm.patientId, doctorId: adm.doctorId, product: 'rbc', units: 2,
        indication: '貧血，Hb < 8 g/dL', urgent: false, lab: { code: 'Hb', value: '6.8', at: `${y} 07:05` }, orderedAt: `${y} 08:10`,
        typing: { abo, rh: '+', by: 'U601', at: `${y} 08:40` },
        crossmatch: units.map((u) => ({ unitId: u.id, by: 'U601', at: `${y} 09:10` })),
        issues: [],
      }
      pt.bloodTypings = [{ abo, rh: '+', by: 'U601', at: `${y} 08:40`, requestId: reqId }]
      if (units[0]) {
        units[0].status = 'transfused'
        r.issues.push({
          unitId: units[0].id, issuedAt: `${y} 10:00`, issuedBy: 'U601',
          transfusion: {
            startAt: `${y} 10:15`, nurseId: 'U201', witnessId: 'U202', scan: { mode: 'scanned' }, endAt: `${y} 12:30`, volume: 250,
            vitals: [vit(`${y} 10:15`, 'pre', 36.8, 92, 108, 64), vit(`${y} 10:30`, '15min', 36.9, 90, 110, 66), vit(`${y} 12:30`, 'end', 37.0, 86, 116, 70)],
          },
        })
      }
      bloodRequests.push(r)
      counters[`blood:${y}`] = 1
    }
    const sepsis = admissions.find((a) => a.status === 'admitted' && a !== adm && a.diagnosis.startsWith('A41') && a.admittedAt && a.admittedAt < addMinutes(nowStr, -180))
    if (sepsis) {
      const orderedAt = notFuture(sepsis.admittedAt! > `${T} 07:30` ? addMinutes(sepsis.admittedAt!, 120) : `${T} 09:30`, 30)
      bloodRequests.push({
        id: 'BR-SEED-2', no: `BR${T.replace(/-/g, '')}001`, admissionId: sepsis.id, patientId: sepsis.patientId, doctorId: sepsis.doctorId, product: 'ffp', units: 2,
        indication: '侵入性處置前矯正凝血功能', urgent: false, orderedAt, crossmatch: [], issues: [],
      })
      counters[`blood:${T}`] = 1
    }
  }

  // ---------- 影像報告（同檢驗：不抽亂數、不用流水號；今天以前的都已判讀）----------
  // 放射科 DR10 判讀 X 光、超音波、電腦斷層；心電圖由開立醫師判讀。大多正常，少數有發現（依 id 雜湊決定）。
  // 示範重要發現：第二位住院病人昨天下午的胸部 X 光「左側氣胸」，主治還沒確認
  const imagingReports: ImagingReport[] = []
  {
    const hash = (s: string) => {
      let h = 2166136261
      for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0
      return h / 4294967296
    }
    const ABNORMAL: Record<string, { findings: string; impression: string }> = {
      P013: { findings: '右下肺野可見斑片狀浸潤，其餘肺野清晰；心臟大小正常。', impression: '右下肺浸潤，請配合臨床考慮肺炎。' },
      P014: { findings: '內側關節間隙變窄，股骨與脛骨邊緣可見骨刺。', impression: '退化性膝關節炎。' },
      P015: { findings: 'L4–L5 椎間盤間隙變窄，椎體邊緣骨刺；排列無滑脫。', impression: '腰椎退化性變化。' },
      P016: { findings: '肝臟實質回音增強，無局部病灶；膽囊、胰臟、脾臟、兩側腎臟無明顯異常。', impression: '輕度脂肪肝。' },
      P017: { findings: '竇性心搏過速，心跳 108 次／分；間期正常，無 ST-T 變化。', impression: '竇性心搏過速。' },
    }
    const textOf = (procId: string, key: string) => (ABNORMAL[procId] && hash(key) < 0.25 ? ABNORMAL[procId] : codes.procedures.find((x) => x.id === procId)!.imaging!.normal)
    let seq = 0
    const no = (at: string) => `R${at.slice(0, 10).replace(/-/g, '')}${String(9000 + ++seq)}`
    const procMap = new Map(codes.procedures.map((x) => [x.id, x]))
    for (const e of encounters) {
      if (e.status !== 'completed' || e.date >= T || !e.completedAt) continue
      const v = visits.find((x) => x.id === e.visitId)
      if (!v || (v.status !== 'charged' && v.status !== 'dispensed')) continue
      for (const x of e.procedures) {
        const im = procMap.get(x.procId)?.imaging
        if (!im || x.notDone) continue
        const at = addMinutes(e.completedAt, im.reader === 'orderer' ? 20 : 120)
        imagingReports.push({ id: `IR-SEED-${imagingReports.length + 1}`, no: no(at), patientId: e.patientId, procId: x.procId, encounterId: e.id, doctorId: e.doctorId, orderedAt: e.completedAt, ...textOf(x.procId, e.id), readerId: im.reader === 'orderer' ? e.doctorId : 'DR10', reportedAt: at })
      }
    }
    for (const o of ipdOrders) {
      const im = o.procId ? procMap.get(o.procId)?.imaging : undefined
      if (!im || o.type !== 'stat' || o.status !== 'done' || !o.stopAt || o.stopAt.slice(0, 10) >= T) continue
      const a = admissions.find((x) => x.id === o.admissionId)!
      const at = addMinutes(o.stopAt, 90)
      imagingReports.push({ id: `IR-SEED-${imagingReports.length + 1}`, no: no(at), patientId: a.patientId, procId: o.procId!, orderId: o.id, admissionId: a.id, doctorId: o.doctorId, orderedAt: o.createdAt, ...textOf(o.procId!, o.id), readerId: im.reader === 'orderer' ? o.doctorId : 'DR10', reportedAt: at })
    }
    const adm = admissions.filter((a) => a.status === 'admitted')[1]
    if (adm) {
      const orderedAt = `${addDays(T, -1)} 13:30`
      ipdOrders.push({ id: 'IO-SEED-IMG1', admissionId: adm.id, type: 'stat', category: 'procedure', procId: 'P013', content: '胸部 X 光', startAt: orderedAt, stopAt: `${addDays(T, -1)} 14:00`, status: 'done', doctorId: adm.doctorId, createdAt: orderedAt, ackAt: `${addDays(T, -1)} 13:40`, ackBy: 'U201' })
      const at = `${addDays(T, -1)} 14:40`
      imagingReports.push({
        id: 'IR-SEED-IPD1', no: no(at), patientId: adm.patientId, procId: 'P013', orderId: 'IO-SEED-IMG1', admissionId: adm.id, doctorId: adm.doctorId, orderedAt,
        findings: '左側肺尖可見無肺紋理區，肺邊緣距胸壁約 2 公分，估計氣胸約 20%；縱膈腔無偏移。右肺清晰。', impression: '左側氣胸（約 20%），建議立即處置。',
        significant: true, readerId: 'DR10', reportedAt: at,
      })
    }
  }

  // 跌倒、壓傷風險評估（示範，不抽亂數）：住院中的病人入院後 1.5 小時內都評過；
  //   - 腦梗塞（住 32 天）跌倒、壓傷都高風險，每天重評，最近一次是 23 小時前（快到期，護理站列「待評估」）
  //   - 骨折跌倒中度（之前跌倒過）；敗血症壓傷高風險（6 小時前重評過）、跌倒中度
  //   - 一位入院超過 24 小時的低風險病人漏評壓傷（入院評估逾時）
  const riskAssessments: RiskAssessment[] = []
  {
    const F = (history: number, secondary: number, aid: number, iv: number, gait: number, mental: number) => ({ history, secondary, aid, iv, gait, mental })
    const B = (sensory: number, moisture: number, activity: number, mobility: number, nutrition: number, friction: number) => ({ sensory, moisture, activity, mobility, nutrition, friction })
    const put = (a: Admission, scale: RiskScale, answers: Record<string, number>, at: string, reason: RiskReason, measures?: string[]) => {
      const score = riskScore(scale, answers).score
      riskAssessments.push({ id: id('RA'), admissionId: a.id, scale, at, nurseId: 'U201', answers, score, level: riskLevel(scale, score), reason, ...(measures ? { measures } : {}) })
    }
    const inpt = admissions.filter((a) => a.status === 'admitted' && a.admittedAt)
    const first = (a: Admission) => notFuture(addMinutes(a.admittedAt!, 90), 5)
    const skipPressure = inpt.find((a) => !/^(I63|S52|A41)/.test(a.diagnosis) && a.admittedAt! < addMinutes(nowStr, -26 * 60))
    for (const a of inpt) {
      if (a.diagnosis.startsWith('I63')) {
        const fall = F(0, 15, 0, 20, 20, 15)
        const pres = B(2, 3, 1, 2, 2, 1)
        put(a, 'fall', fall, first(a), 'admission', ['rails', 'bell', 'escort', 'teach'])
        put(a, 'pressure', pres, first(a), 'admission', ['turn', 'mattress', 'offload'])
        for (const back of [8 * 24 * 60, 2 * 24 * 60, 23 * 60]) {
          const at = addMinutes(nowStr, -back)
          put(a, 'fall', fall, at, 'routine', ['rails', 'bell', 'escort', 'sign'])
          put(a, 'pressure', pres, at, 'routine', ['turn', 'mattress', 'offload', 'nutrition'])
        }
      } else if (a.diagnosis.startsWith('S52')) {
        put(a, 'fall', F(25, 0, 0, 0, 10, 0), first(a), 'admission')
        put(a, 'pressure', B(4, 4, 3, 3, 3, 3), first(a), 'admission')
      } else if (a.diagnosis.startsWith('A41')) {
        put(a, 'fall', F(0, 15, 0, 20, 0, 0), first(a), 'admission')
        put(a, 'pressure', B(3, 3, 2, 3, 2, 2), first(a), 'admission', ['turn', 'dry'])
        put(a, 'pressure', B(3, 3, 2, 3, 2, 2), notFuture(addMinutes(nowStr, -6 * 60), 5) > first(a) ? addMinutes(nowStr, -6 * 60) : first(a), 'routine', ['turn', 'dry', 'mattress'])
      } else {
        put(a, 'fall', F(0, 0, 0, 20, 0, 0), first(a), 'admission')
        if (a !== skipPressure) put(a, 'pressure', B(4, 4, 3, 4, 3, 3), first(a), 'admission')
      }
    }
  }

  // ---------- 手術（示範，不抽亂數、固定 id）----------
  // 一：骨折病人明天 09:00 OR1 開放性復位術（右側，全身麻醉），術前準備做一半（同意書、備血不需要；禁食、部位標記、抗生素還沒）
  // 二：闌尾炎病人 OR2 腹腔鏡闌尾切除術（今天 15:00；重建時已過 13:00 改明天 13:00），術前準備都好了——護理站送手術室、手術室走完三段查核
  const surgeries: Surgery[] = []
  const postopSets: PostopSet[] = []
  {
    const tomorrow = addDays(T, 1)
    const later = (a: string, b: string) => (a > b ? a : b)
    const created = (a: Admission) => notFuture(later(addMinutes(a.admittedAt!, 120), `${addDays(T, -1)} 16:00`), 30)
    const mark = (by: string, at: string, extra: Partial<SurgeryPrepMark> = {}): SurgeryPrepMark => ({ by, at, ...extra })
    const frac = admissions.find((a) => a.status === 'admitted' && a.admittedAt && a.diagnosis.startsWith('S52'))
    if (frac) {
      const at = created(frac)
      surgeries.push({
        id: 'SG-SEED-1', no: `OR${T.replace(/-/g, '')}001`, admissionId: frac.id, patientId: frac.patientId, doctorId: frac.doctorId, procId: 'P037', side: 'right', anesthesia: 'general',
        diagnosis: frac.diagnosis, requestedDate: tomorrow, estMinutes: 120, status: 'scheduled', createdAt: at,
        schedule: { room: 'OR1', start: `${tomorrow} 09:00`, by: 'U202', at: notFuture(addMinutes(at, 60), 20) },
        prep: { consent: mark('U201', notFuture(addMinutes(at, 90), 10)), blood: mark('U201', notFuture(addMinutes(at, 90), 10), { notNeeded: '開放性復位術出血少，主刀表示不需備血' }) },
        checks: {},
      })
    }
    const appx = admissions.find((a) => a.status === 'admitted' && a.admittedAt && a.diagnosis.startsWith('K35'))
    if (appx) {
      const at = created(appx)
      const start = nowStr < `${T} 13:00` ? `${T} 15:00` : `${tomorrow} 13:00`
      const prepAt = notFuture(addMinutes(at, 120), 5)
      // 預防性抗生素：術前另開一劑 Ceftriaxone（臨時醫囑），排在劃刀前 40 分鐘給——護理師照時間給了，開始手術時就符合 60 分鐘內
      const cro = codes.drugs.find((d) => d.id === 'M036')!
      const abx: IpdOrder = { id: 'IO-PREOP-1', admissionId: appx.id, type: 'stat', category: 'medication', drugId: 'M036', content: cro.name, dose: 1, freq: 'STAT', route: 'IV', startAt: prepAt, status: 'active', doctorId: appx.doctorId, createdAt: prepAt, ackAt: addMinutes(prepAt, 5), ackBy: 'U201' }
      ipdOrders.push(abx)
      mar.push({ id: 'MAR-PREOP-1', orderId: abx.id, admissionId: appx.id, scheduledAt: addMinutes(start, -40), status: 'pending' })
      surgeries.push({
        id: 'SG-SEED-2', no: `OR${T.replace(/-/g, '')}002`, admissionId: appx.id, patientId: appx.patientId, doctorId: appx.doctorId, procId: 'P038', side: 'na', anesthesia: 'general',
        diagnosis: appx.diagnosis, requestedDate: start.slice(0, 10), estMinutes: 90, status: 'scheduled', createdAt: at,
        schedule: { room: 'OR2', start, by: 'U202', at: notFuture(addMinutes(at, 60), 20) },
        prep: {
          consent: mark('U201', prepAt), npo: mark('U201', prepAt), siteMark: mark('U201', prepAt, { notNeeded: '腹腔鏡手術，不分側' }), blood: mark('U201', prepAt, { notNeeded: '預估失血少' }),
          abx: mark('U201', prepAt, { refId: abx.id }),
        },
        checks: {},
      })
    }
    // 三：腦梗塞病人前天 13:00 在 OR3 做完清創術（局部麻醉）；12:30 給的 Vancomycin＝劃刀前 30 分鐘（符合），但手術結束超過 24 小時還沒停
    const st = admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('I63'))
    const vo = st && ipdOrders.find((o) => o.admissionId === st.id && o.drugId === 'M042' && o.abx?.reason === 'prophylaxis')
    if (st && vo) {
      const d2 = addDays(T, -2)
      const at = `${addDays(T, -3)} 16:00`
      const start = `${d2} 13:00`
      const end = `${d2} 13:45`
      surgeries.push({
        id: 'SG-SEED-3', no: `OR${d2.replace(/-/g, '')}001`, admissionId: st.id, patientId: st.patientId, doctorId: st.doctorId, procId: 'P040', side: 'na', anesthesia: 'local',
        diagnosis: '薦骨壓傷（第 3 級）', requestedDate: d2, estMinutes: 45, status: 'done', createdAt: at,
        schedule: { room: 'OR3', start, by: 'U202', at: addMinutes(at, 60) },
        prep: {
          consent: mark('U201', `${d2} 09:00`), npo: mark('U201', `${d2} 09:00`, { notNeeded: '局部麻醉' }), siteMark: mark('U201', `${d2} 09:00`, { notNeeded: '薦骨單一部位' }),
          blood: mark('U201', `${d2} 09:00`, { notNeeded: '預估失血少' }), abx: mark('U201', `${d2} 09:00`, { refId: vo.id }),
        },
        sentAt: `${d2} 12:40`, sentBy: 'U201',
        checks: { signIn: { by: 'U205', at: `${d2} 12:50` }, timeOut: { by: 'U205', at: `${d2} 12:58` }, signOut: { by: 'U205', at: end } },
        startAt: start, endAt: end, abxTiming: { ok: true, givenAt: `${d2} 12:30`, minutes: 30 },
        counts: { spongeBefore: 10, spongeAfter: 10, instrumentBefore: 20, instrumentAfter: 20 },
        record: { performed: '薦骨壓傷清創術', findings: '壞死組織約 4×3 cm，清除至出血面，無膿瘍', bloodLoss: 20, complications: '無', specimen: '無', by: users.find((u) => u.doctorId === st.doctorId)!.id, at: addMinutes(end, 30) },
      })
    }
    // 四：昨天 21:10 急刀（立即，1 小時內）：疝氣嵌頓，開放時段外排 OR1，45 分鐘入刀房（時效達成）
    const y = addDays(T, -1)
    const used = new Set([frac?.id, appx?.id, st?.id])
    const hx = admissions.find((a) => a.status === 'admitted' && a.admittedAt && a.admittedAt < `${y} 18:00` && !a.obs && !used.has(a.id))
    if (hx) {
      const at = `${y} 21:10`
      const sent = addMinutes(at, 45)
      const start = addMinutes(sent, 20)
      const end = addMinutes(start, 60)
      surgeries.push({
        id: 'SG-SEED-4', no: `OR${y.replace(/-/g, '')}001`, admissionId: hx.id, patientId: hx.patientId, doctorId: hx.doctorId, procId: 'P039', side: 'right', anesthesia: 'general', urgency: 'immediate',
        diagnosis: 'K40.30 右側腹股溝疝氣嵌頓', requestedDate: y, estMinutes: 60, status: 'done', createdAt: at,
        schedule: { room: 'OR1', start, by: 'U202', at: addMinutes(at, 10) },
        prep: {
          consent: mark('U201', addMinutes(at, 20)), npo: mark('U201', addMinutes(at, 20), { notNeeded: '急刀，禁食不足由麻醉評估' }), siteMark: mark('U201', addMinutes(at, 25)),
          blood: mark('U201', addMinutes(at, 25), { notNeeded: '預估失血少' }), abx: mark('U201', addMinutes(at, 30), { notNeeded: '急刀，麻醉誘導時給' }),
        },
        sentAt: sent, sentBy: 'U201',
        checks: { signIn: { by: 'U205', at: addMinutes(sent, 5) }, timeOut: { by: 'U205', at: addMinutes(start, -2) }, signOut: { by: 'U205', at: end } },
        startAt: start, endAt: end,
        counts: { spongeBefore: 10, spongeAfter: 10, instrumentBefore: 20, instrumentAfter: 20 },
        record: { performed: '右側腹股溝疝氣修補術', findings: '小腸嵌頓約 10 cm，復位後顏色恢復，未切除腸段', bloodLoss: 30, complications: '無', specimen: '無', by: users.find((u) => u.doctorId === hx.doctorId)!.id, at: addMinutes(end, 20) },
      })
    }
    // 麻醉前評估（dr03 被指定「麻醉」）：四台都評估過；急診那台急刀（在急診段落）還沒評估
    {
      const an = users.find((u) => u.doctorId === 'DR03')!.id
      const pre = (id: string, at: string, p: Omit<PreAnesthesia, 'by' | 'at' | 'emergency' | 'difficult'>) => {
        const s = surgeries.find((x) => x.id === id)
        if (s) s.preAnes = { ...p, emergency: !!s.urgency, difficult: p.airway.mallampati >= 3 || p.airway.mouth === 'limited' || p.airway.neck === 'limited', by: an, at }
      }
      const s1 = surgeries.find((x) => x.id === 'SG-SEED-1')
      if (s1) {
        const at = notFuture(addMinutes(s1.createdAt, 150), 15)
        pre('SG-SEED-1', at, { asa: 2, airway: { mallampati: 2, mouth: 'ok', neck: 'ok' }, npo: { status: 'not', lastIntake: addMinutes(at, -90) }, history: { items: ['cardiac'], note: '高血壓，藥物控制穩定' }, plan: 'general' })
      }
      const s2 = surgeries.find((x) => x.id === 'SG-SEED-2')
      if (s2) {
        const at = notFuture(addMinutes(s2.createdAt, 100), 10)
        pre('SG-SEED-2', at, { asa: 1, airway: { mallampati: 1, mouth: 'ok', neck: 'ok' }, npo: { status: 'ok', lastIntake: addMinutes(s2.createdAt, -360) }, history: { items: [] }, plan: 'general' })
      }
      const s3 = surgeries.find((x) => x.id === 'SG-SEED-3')
      if (s3) pre('SG-SEED-3', `${s3.requestedDate} 08:30`, { asa: 3, airway: { mallampati: 3, mouth: 'ok', neck: 'limited', note: '臥床，頸部僵硬' }, npo: { status: 'ok', lastIntake: `${addDays(s3.requestedDate, -1)} 22:00` }, history: { items: ['neuro', 'endocrine'], note: '腦梗塞、糖尿病' }, plan: 'local' })
      const s4 = surgeries.find((x) => x.id === 'SG-SEED-4')
      if (s4) pre('SG-SEED-4', addMinutes(s4.createdAt, 15), { asa: 2, airway: { mallampati: 2, mouth: 'ok', neck: 'ok' }, npo: { status: 'not', lastIntake: addMinutes(s4.createdAt, -180) }, history: { items: [] }, plan: 'general' })
      // 麻醉紀錄：昨天那台立即急刀完整紀錄——誘導後一次低血壓（收縮壓 82、86），給 Ephedrine 10 mg 後回穩
      if (s4?.startAt && s4.endAt) {
        const a0 = addMinutes(s4.sentAt!, 8)
        const end = s4.endAt
        let n = 0
        const E = (at: string, x: Partial<AnesEntry> & Pick<AnesEntry, 'type'>): AnesEntry => ({ id: `AE-SEED-${++n}`, at, by: an, ...x })
        const entries: AnesEntry[] = []
        for (let m = 0; addMinutes(a0, m) <= end; m += 5) {
          const low = m === 15 || m === 20
          entries.push(E(addMinutes(a0, m), { type: 'vital', sbp: low ? (m === 15 ? 82 : 86) : m === 0 ? 138 : 118 + (m % 10), dbp: low ? 48 : 70, hr: low ? 58 : m === 0 ? 102 : 84, spo2: m === 0 ? 98 : 99, ...(m >= 5 ? { etco2: 35 } : {}) }))
        }
        entries.push(
          E(a0, { type: 'event', event: 'induction' }), E(a0, { type: 'drug', drug: 'propofol', dose: 150 }), E(a0, { type: 'drug', drug: 'fentanyl', dose: 100 }),
          E(addMinutes(a0, 2), { type: 'drug', drug: 'rocuronium', dose: 50 }), E(addMinutes(a0, 3), { type: 'event', event: 'intubation', note: '7.5 號氣管內管，一次成功' }),
          E(addMinutes(a0, 5), { type: 'fluid', fluid: 'crystalloid', ml: 500 }), E(addMinutes(a0, 17), { type: 'drug', drug: 'ephedrine', dose: 10 }),
          E(addMinutes(end, -15), { type: 'drug', drug: 'ondansetron', dose: 4 }), E(addMinutes(end, -10), { type: 'output', output: 'blood', ml: 30 }),
          E(addMinutes(end, -10), { type: 'fluid', fluid: 'crystalloid', ml: 300 }), E(addMinutes(end, -5), { type: 'drug', drug: 'sugammadex', dose: 200 }),
          E(addMinutes(end, -5), { type: 'output', output: 'urine', ml: 150 }), E(addMinutes(end, -2), { type: 'event', event: 'extubation' }),
        )
        s4.anes = { startAt: a0, endAt: end, entries }
        // 恢復室：進來 Aldrete 7（疼痛 3）→ 15 分鐘後 9 → 轉出 → 病房接回
        const sc = (i: number, at: string, v: [number, number, number, number, number], pain: number): PacuScore => ({ id: `PS-SEED-4-${i}`, at, activity: v[0] as 0 | 1 | 2, respiration: v[1] as 0 | 1 | 2, circulation: v[2] as 0 | 1 | 2, consciousness: v[3] as 0 | 1 | 2, spo2: v[4] as 0 | 1 | 2, pain, ponv: false, by: 'U205' })
        s4.pacu = { inAt: end, scores: [sc(1, end, [1, 2, 2, 1, 1], 3), sc(2, addMinutes(end, 15), [2, 2, 2, 1, 2], 3)], out: { at: addMinutes(end, 20), by: 'U205', aldrete: 9, pain: 3 , ponv: false }, received: { at: addMinutes(end, 35), by: 'U201' } }
      }
      // 五：今天一台擇期疝氣修補，40 分鐘前離開手術室進恢復室：Aldrete 7 → 8 → 8（意識、活動還沒完全恢復，疼痛 5），還不能轉出
      const h5 = admissions.find((a) => a.status === 'admitted' && a.admittedAt && a.admittedAt < addMinutes(nowStr, -24 * 60) && !a.obs && a.doctorId !== 'DR03' && !used.has(a.id) && a.id !== hx?.id && !surgeries.some((s) => s.admissionId === a.id))
      if (h5) {
        const end = addMinutes(nowStr, -40).slice(0, 16)
        const start = addMinutes(end, -60)
        const sent = addMinutes(start, -25)
        const created = addMinutes(sent, -20 * 60)
        const a0 = addMinutes(sent, 10)
        const d = start.slice(0, 10)
        const surgeon = users.find((u) => u.doctorId === h5.doctorId)!.id
        let n = 0
        const E = (at: string, x: Partial<AnesEntry> & Pick<AnesEntry, 'type'>): AnesEntry => ({ id: `AE-SEED5-${++n}`, at, by: an, ...x })
        const entries: AnesEntry[] = [E(a0, { type: 'event', event: 'induction' }), E(a0, { type: 'drug', drug: 'propofol', dose: 120 }), E(a0, { type: 'drug', drug: 'fentanyl', dose: 100 }), E(addMinutes(a0, 2), { type: 'drug', drug: 'rocuronium', dose: 40 }), E(addMinutes(a0, 3), { type: 'event', event: 'intubation' }), E(addMinutes(a0, 5), { type: 'fluid', fluid: 'crystalloid', ml: 600 }), E(addMinutes(end, -5), { type: 'output', output: 'blood', ml: 20 }), E(addMinutes(end, -3), { type: 'event', event: 'extubation' })]
        for (let m = 0; addMinutes(a0, m) <= end; m += 5) entries.push(E(addMinutes(a0, m), { type: 'vital', sbp: 124 + (m % 10), dbp: 74, hr: 78, spo2: 99, ...(m >= 5 ? { etco2: 36 } : {}) }))
        const sc = (i: number, at: string, v: [number, number, number, number, number], pain: number): PacuScore => ({ id: `PS-SEED-5-${i}`, at, activity: v[0] as 0 | 1 | 2, respiration: v[1] as 0 | 1 | 2, circulation: v[2] as 0 | 1 | 2, consciousness: v[3] as 0 | 1 | 2, spo2: v[4] as 0 | 1 | 2, pain, ponv: false, by: 'U205' })
        surgeries.push({
          id: 'SG-SEED-5', no: `OR${d.replace(/-/g, '')}${String(surgeries.filter((x) => x.no.startsWith(`OR${d.replace(/-/g, '')}`)).length + 1).padStart(3, '0')}`,
          admissionId: h5.id, patientId: h5.patientId, doctorId: h5.doctorId, procId: 'P039', side: 'left', anesthesia: 'general',
          diagnosis: 'K40.90 左側腹股溝疝氣', requestedDate: d, estMinutes: 60, status: 'done', createdAt: created,
          schedule: { room: 'OR3', start, by: 'U202', at: addMinutes(created, 60) },
          prep: { consent: mark('U201', addMinutes(created, 120)), npo: mark('U201', addMinutes(sent, -60)), siteMark: mark('U201', addMinutes(sent, -60)), blood: mark('U201', addMinutes(created, 120), { notNeeded: '疝氣修補出血少' }), abx: mark('U201', addMinutes(created, 120), { notNeeded: '乾淨手術不需預防性抗生素' }) },
          preAnes: { asa: 2, emergency: false, airway: { mallampati: 2, mouth: 'ok', neck: 'ok' }, difficult: false, npo: { status: 'ok', lastIntake: addMinutes(sent, -10 * 60) }, history: { items: ['cardiac'], note: '高血壓' }, plan: 'general', by: an, at: addMinutes(sent, -60) },
          sentAt: sent, sentBy: 'U201',
          checks: { signIn: { by: 'U205', at: addMinutes(sent, 5) }, timeOut: { by: 'U205', at: addMinutes(start, -2) }, signOut: { by: 'U205', at: end } },
          startAt: start, endAt: end, counts: { spongeBefore: 10, spongeAfter: 10, instrumentBefore: 20, instrumentAfter: 20 },
          anes: { startAt: a0, endAt: end, entries },
          pacu: { inAt: end, scores: [sc(1, end, [1, 2, 2, 1, 1], 6), sc(2, addMinutes(end, 15), [1, 2, 2, 1, 2], 5), sc(3, addMinutes(end, 30), [1, 2, 2, 1, 2], 5)] },
          record: { performed: '左側腹股溝疝氣修補術（網膜）', findings: '間接型疝氣，疝囊約 4 cm，無嵌頓', bloodLoss: 20, complications: '無', specimen: '無', by: surgeon, at: addMinutes(end, 10) },
        })
      }
    }
    // 手術團隊：流動 nurse05（U205）、刷手 nurse06（U206）、麻醉 dr03；昨晚急刀刷手中途由 nurse07 接手。
    // 明天骨折那台只排了流動和麻醉（刷手還沒排，劃刀前暫停確認前要補）
    {
      const an = users.find((u) => u.doctorId === 'DR03')!.id
      const asst = (s: Surgery) => users.find((u) => u.doctorId && u.doctorId !== s.doctorId && (u.doctorId === 'DR04' || u.doctorId === 'DR07'))!.id
      const one = (userId: string, s: Surgery, extra: Partial<TeamShift> = {}): TeamShift => ({ userId, by: 'U202', at: s.schedule!.at, ...extra })
      for (const s of surgeries) {
        if (!s.schedule) continue
        const anes = s.anesthesia !== 'local' ? { anesthetist: [one(an, s)] } : {}
        if (s.id === 'SG-SEED-1') s.team = { ...anes, circulating: [one('U205', s)] }
        else if (s.id === 'SG-SEED-4') {
          const ho = addMinutes(s.startAt!, 30)
          s.team = { ...anes, circulating: [one('U205', s)], scrub: [one('U206', s, { to: ho }), { userId: 'U207', from: ho, by: 'U205', at: ho }] }
        } else s.team = { ...anes, ...(s.id !== 'SG-SEED-3' ? { assistant: [one(asst(s), s)] } : {}), scrub: [one('U206', s)], circulating: [one('U205', s)] }
      }
    }
    // 術後醫囑：前天清創、昨晚急刀已開（沿用術前醫囑）；今天恢復室那台（SG-SEED-5）還沒開——主刀有個人組套「疝氣修補術後（常用）」，
    // 術前的禁食醫囑還在（要選停或保留）。外科另有科室組套「腹腔鏡闌尾切除術後」
    {
      for (const s of surgeries) {
        if ((s.id === 'SG-SEED-3' || s.id === 'SG-SEED-4') && s.endAt)
          s.postop = { by: users.find((u) => u.doctorId === s.doctorId)!.id, at: addMinutes(s.endAt, 25), orderIds: [], npoStopped: [], npoKept: [], note: s.id === 'SG-SEED-3' ? '局部清創，沿用術前醫囑' : '急刀術後沿用原醫囑，止痛另開' }
      }
      const s5 = surgeries.find((x) => x.id === 'SG-SEED-5')
      if (s5?.sentAt) {
        const npoAt = addMinutes(s5.sentAt, -9 * 60)
        for (const o of ipdOrders.filter((o) => o.admissionId === s5.admissionId && o.category === 'diet' && o.type === 'long' && o.status === 'active')) Object.assign(o, { status: 'stopped', stopAt: npoAt, stopAckAt: addMinutes(npoAt, 10), stopAckBy: 'U201' })
        ipdOrders.push({ id: 'IO-NPO-SG5', admissionId: s5.admissionId, type: 'long', category: 'diet', content: '禁食（術前）', diet: { kind: 'npo', note: '術前' }, startAt: npoAt, status: 'active', doctorId: s5.doctorId, createdAt: npoAt, ackAt: addMinutes(npoAt, 10), ackBy: 'U201' })
        s5.prep.npo = { ...s5.prep.npo!, refId: 'IO-NPO-SG5' }
        const at = addMinutes(s5.createdAt, -30 * 24 * 60)
        postopSets.push({
          id: 'PS-SEED-1', name: '疝氣修補術後（常用）', procId: 'P039', scope: 'personal', doctorId: s5.doctorId,
          items: [
            { type: 'long', category: 'medication', drugId: 'M001', content: 'Acetaminophen 500mg', dose: 1, freq: 'QID', route: 'PO' },
            { type: 'long', category: 'medication', drugId: 'M031', content: 'Tramadol 50mg', dose: 1, freq: 'PRN', route: 'PO' },
            { type: 'long', category: 'diet', content: '流質飲食', diet: { kind: 'liquid', note: '排氣後改軟質' } },
            { type: 'long', category: 'nursing', content: '術後 6 小時可下床活動' },
            { type: 'long', category: 'nursing', content: '傷口冰敷 20 分鐘 Q4H，觀察陰囊腫脹' },
          ],
          createdAt: at, updatedAt: at,
        })
      }
      const at = addMinutes(nowStr, -60 * 24 * 60)
      postopSets.push({
        id: 'PS-SEED-2', name: '腹腔鏡闌尾切除術後', procId: 'P038', scope: 'dept', doctorId: 'DR04', deptId: 'D03', updatedBy: 'DR04',
        items: [
          { type: 'long', category: 'medication', drugId: 'M001', content: 'Acetaminophen 500mg', dose: 1, freq: 'QID', route: 'PO' },
          { type: 'long', category: 'medication', drugId: 'M036', content: 'Ceftriaxone 1g Inj', dose: 1, freq: 'Q12H', route: 'IV' },
          { type: 'long', category: 'diet', content: '流質飲食', diet: { kind: 'liquid', note: '術後當天清流' } },
          { type: 'long', category: 'nursing', content: '術後第一天下床活動、鼓勵深呼吸咳嗽' },
        ],
        createdAt: at, updatedAt: at,
      })
    }
    // 病理檢體：前天清創的壞死組織——病理報告鱗狀細胞癌（慢性傷口惡性變化，和術前診斷不符），主刀還沒確認；
    // 今天恢復室那台疝囊 40 分鐘前送出、病理還沒收件；昨晚急刀本台無檢體。lab01 收件、dr10 代表病理醫師
    {
      const s3 = surgeries.find((x) => x.id === 'SG-SEED-3')
      if (s3?.startAt && s3.endAt) {
        // 術中送冰凍：18 分鐘回報「未見惡性」；永久切片深部是鱗狀細胞癌（和冰凍不一致）
        const fzAt = addMinutes(s3.startAt, 10)
        s3.specimens = [{ id: 'SP-SEED-3A', label: 'A', site: '薦骨壞死組織', container: 'jar', fixative: 'none', by: 'U205', at: fzAt, frozen: { sentAt: fzAt, sentBy: 'U205', result: { text: '表層壞死組織與急性發炎，未見惡性細胞', at: addMinutes(fzAt, 18), by: 'U110', receivedBy: users.find((u) => u.doctorId === s3.doctorId)!.id, readBack: true } } }]
        s3.path = {
          sentAt: s3.endAt, sentBy: 'U205', received: { at: addMinutes(s3.endAt, 50), by: 'U601' },
          report: { diagnosis: '鱗狀細胞癌，高分化（慢性壓傷潰瘍惡性變化）；切緣可見腫瘤', malignant: true, consistent: false, note: '建議擴大切除、轉腫瘤科評估', by: 'U110', at: `${addDays(T, -1)} 15:20`, frozenConcordant: false, frozenNote: '冰凍取樣為表層壞死組織；永久切片深部見鱗狀細胞癌' },
        }
        if (s3.record) s3.record.specimen = 'A 薦骨壞死組織（檢體罐・不加（新鮮））'
      }
      const s4 = surgeries.find((x) => x.id === 'SG-SEED-4')
      if (s4) s4.noSpecimen = true
      const s5 = surgeries.find((x) => x.id === 'SG-SEED-5')
      if (s5?.startAt && s5.endAt) {
        s5.specimens = [{ id: 'SP-SEED-5A', label: 'A', site: '疝囊', container: 'jar', fixative: 'formalin', by: 'U205', at: addMinutes(s5.startAt, 40) }]
        s5.path = { sentAt: s5.endAt, sentBy: 'U205' }
        if (s5.record) s5.record.specimen = 'A 疝囊（檢體罐・福馬林）'
      }
    }
    // 手術室效率：今天 OR1 首台排程 30 分鐘前、病人已送到還沒做麻醉前查核（首台延誤）——前天清創那位病理是鱗狀細胞癌，今天擴大切除；
    // 骨折那位原排今天 16:00 OR2，早上發燒當天取消、改排明天（SG-SEED-1）
    {
      const an = users.find((u) => u.doctorId === 'DR03')!.id
      const mk = (x: Partial<SurgeryPrepMark> & { by: string; at: string }): SurgeryPrepMark => x
      if (nowStr >= `${T} 08:45`) {
        const s3 = surgeries.find((x) => x.id === 'SG-SEED-3')
        const a6 = s3 && admissions.find((a) => a.id === s3.admissionId)
        if (s3?.path?.report && a6) {
          const start = ((t) => addMinutes(t, -(Number(t.slice(15)) % 5)))(addMinutes(nowStr, -30).slice(0, 16))
          const created = addMinutes(s3.path.report.at, 60)
          const n = surgeries.filter((x) => x.no.startsWith(`OR${T.replace(/-/g, '')}`)).length + 1
          surgeries.push({
            id: 'SG-SEED-6', no: `OR${T.replace(/-/g, '')}${String(n).padStart(3, '0')}`, admissionId: a6.id, patientId: a6.patientId, doctorId: a6.doctorId, procId: 'P040', side: 'na', anesthesia: 'spinal',
            diagnosis: '薦骨鱗狀細胞癌（慢性壓傷潰瘍惡性變化），擴大切除', requestedDate: T, estMinutes: 60, status: 'sent', createdAt: created,
            schedule: { room: 'OR1', start, by: 'U202', at: addMinutes(created, 60) },
            prep: { consent: mk({ by: 'U201', at: addMinutes(created, 120) }), npo: mk({ by: 'U201', at: addMinutes(start, -120) }), siteMark: mk({ by: 'U201', at: addMinutes(start, -120) }), blood: mk({ by: 'U201', at: addMinutes(created, 120), notNeeded: '預估失血少' }), abx: mk({ by: 'U201', at: addMinutes(created, 120), notNeeded: '已在使用 Vancomycin' }) },
            preAnes: { asa: 3, emergency: false, airway: { mallampati: 3, mouth: 'ok', neck: 'limited', note: '臥床，頸部僵硬' }, difficult: true, npo: { status: 'ok', lastIntake: addMinutes(start, -12 * 60) }, history: { items: ['neuro', 'endocrine'], note: '腦梗塞、糖尿病' }, plan: 'spinal', by: an, at: addMinutes(start, -90) },
            team: { anesthetist: [{ userId: an, by: 'U202', at: addMinutes(created, 60) }], scrub: [{ userId: 'U208', by: 'U202', at: addMinutes(created, 60) }], circulating: [{ userId: 'U207', by: 'U202', at: addMinutes(created, 60) }] },
            sentAt: addMinutes(start, -10), sentBy: 'U201', checks: {},
          })
        }
      }
      const s1 = surgeries.find((x) => x.id === 'SG-SEED-1')
      const a7 = s1 && admissions.find((a) => a.id === s1.admissionId)
      if (s1 && a7) {
        const created = [s1.createdAt, addMinutes(nowStr, -26 * 60)].sort()[0]
        const n = surgeries.filter((x) => x.no.startsWith(`OR${T.replace(/-/g, '')}`)).length + 1
        surgeries.push({
          id: 'SG-SEED-7', no: `OR${T.replace(/-/g, '')}${String(n).padStart(3, '0')}`, admissionId: a7.id, patientId: a7.patientId, doctorId: a7.doctorId, procId: s1.procId, side: s1.side, anesthesia: s1.anesthesia,
          diagnosis: s1.diagnosis, requestedDate: T, estMinutes: s1.estMinutes, status: 'cancelled', createdAt: created,
          schedule: { room: 'OR2', start: `${T} 16:00`, by: 'U202', at: addMinutes(created, 60) },
          prep: {}, checks: {},
          cancelled: { by: users.find((u) => u.doctorId === a7.doctorId)!.id, at: notFuture(`${T} 09:10`, 5), reason: '病人發燒 38.6°C，延後手術（改排明天）' },
        })
      }
    }
    // 急刀插台順延：糖尿病高血糖那位今天發現足部壞死性筋膜炎，申請次緊急清創（24 小時內），排明天 OR1 08:00（開放前），
    // 同房 09:00 的骨折手術（SG-SEED-1）照規則往後推；主刀、病房都還沒讀。
    // 清晨（09:30 前）重建不放：一小時前申請的次緊急，時限要過明天 08:00 才合理
    if (nowStr >= `${T} 09:30`) {
      const s1 = surgeries.find((x) => x.id === 'SG-SEED-1')
      const dm = admissions.find((a) => a.status === 'admitted' && !a.obs && !a.day && a.diagnosis.startsWith('E11') && !surgeries.some((x) => x.admissionId === a.id))
      if (s1?.schedule && dm) {
        const created = notFuture(addMinutes(nowStr, -60), 10)
        const tomorrow = addDays(T, 1)
        const start = `${tomorrow} 08:00`
        const n = surgeries.filter((x) => x.no.startsWith(`OR${created.slice(0, 10).replace(/-/g, '')}`)).length + 1
        const at = notFuture(addMinutes(created, 30), 5)
        const est = 90
        surgeries.push({
          id: 'SG-SEED-8', no: `OR${created.slice(0, 10).replace(/-/g, '')}${String(n).padStart(3, '0')}`, admissionId: dm.id, patientId: dm.patientId, doctorId: dm.doctorId, procId: 'P040', side: 'left', anesthesia: 'spinal', urgency: 'semi',
          diagnosis: '左足壞死性筋膜炎（糖尿病足）', requestedDate: created.slice(0, 10), estMinutes: est, status: 'scheduled', createdAt: created,
          schedule: { room: s1.schedule.room, start, by: 'U202', at }, prep: {}, checks: {},
          // 麻醉科已評估（不然首頁「麻醉前評估待做」會多一台）：糖尿病 ASA 3
          preAnes: { asa: 3, emergency: false, airway: { mallampati: 2, mouth: 'ok', neck: 'ok' }, difficult: false, npo: { status: 'not', lastIntake: addMinutes(created, -120) }, history: { items: ['endocrine'], note: '糖尿病，血糖控制不佳' }, plan: 'spinal', by: users.find((u) => u.doctorId === 'DR03')!.id, at: notFuture(addMinutes(created, 40), 3) },
        })
        const sg8 = surgeries[surgeries.length - 1]
        for (const m of shiftPlan({ start, est }, surgeries.filter((x) => x.schedule?.room === sg8.schedule!.room && x.status === 'scheduled' && !x.urgency && x.schedule.start.slice(0, 10) === start.slice(0, 10)).map((x) => ({ id: x.id, start: x.schedule!.start, est: x.estMinutes })))) {
          const x = surgeries.find((y) => y.id === m.id)!
          x.schedule = { ...x.schedule!, start: m.to }
          x.delays = [{ id: `DL-SEED-${x.id}`, causeId: sg8.id, causeNo: sg8.no, from: m.from, to: m.to, minutes: m.minutes, by: 'U202', at }]
        }
      }
    }
    // 手術單號流水號：只算今天開的（前天做完的那台用前天的號）
    counters[`surgery:${T}`] = surgeries.filter((x) => x.no.startsWith(`OR${T.replace(/-/g, '')}`)).length
  }

  // ---------- 急診（示範，不抽亂數、固定 id）----------
  // 今天的急診診次（24 小時，DR12）：四位候診中——胸痛 2 級（等 25 分，超過 10 分鐘目標）、腹痛 3 級、撕裂傷 4 級（等 80 分，超過 60 分）、
  // 喉嚨痛 5 級。挑有就醫紀錄、今天沒有掛號、沒有住院的病人；到院時間依「現在」往前推（不跨日）
  {
    const erDoc = codes.doctors.find((d) => codes.departments.find((x) => x.id === d.deptId)?.code === 'ER')
    const later = (a: string, b: string) => (a > b ? a : b)
    if (erDoc) {
      rooms.push({ roomNo: '100', location: '1 樓 急診', active: true })
      const sid = `ER-${T}`
      sessions.push({ id: sid, date: T, period: 'ER', deptId: erDoc.deptId, doctorId: erDoc.id, roomNo: '100', limit: 9999 })
      const busy = new Set([...admissions.filter((a) => a.status === 'admitted' || a.status === 'reserved').map((a) => a.patientId), ...visits.filter((v) => v.date === T).map((v) => v.patientId)])
      const cands = patients.filter((p) => !busy.has(p.id) && visits.some((v) => v.patientId === p.id))
      const demo: { complaint: string; level: 1 | 2 | 3 | 4 | 5; back: number; vitals: Record<string, number> }[] = [
        { complaint: '胸痛', level: 2, back: 25, vitals: { temp: 36.8, pulse: 112, resp: 22, sbp: 158, dbp: 96, spo2: 96 } },
        { complaint: '腹痛', level: 3, back: 15, vitals: { temp: 37.8, pulse: 98, resp: 18, sbp: 128, dbp: 80, spo2: 98 } },
        { complaint: '外傷：撕裂傷', level: 4, back: 80, vitals: { temp: 36.5, pulse: 88, resp: 16, sbp: 132, dbp: 84, spo2: 99 } },
        { complaint: '喉嚨痛、咳嗽', level: 5, back: 30, vitals: { temp: 37.4, pulse: 84, resp: 16, sbp: 118, dbp: 72, spo2: 98 } },
      ]
      // 看診號依到院先後
      demo.sort((a, b) => b.back - a.back).forEach((d, i) => {
        const p = cands[i]
        if (!p) return
        const at = notFuture(later(addMinutes(nowStr, -d.back), `${T} 00:01`), 1)
        visits.push({
          id: `V-ER-${i + 1}`, date: T, sessionId: sid, deptId: erDoc.deptId, doctorId: erDoc.id, patientId: p.id, seqNo: next(`seq:${sid}`), identityCode: p.defaultIdentity,
          caseType: 'E1', cardSeq: String(next(`cardseq:${p.id}`)).padStart(4, '0'), status: 'registered', firstVisit: false, preventItems: [], createdAt: at, checkedInAt: at,
          er: { arrivedAt: at, complaint: d.complaint, vitals: d.vitals, suggested: d.level, level: d.level, triagedBy: 'U201', triagedAt: at },
        })
      })
      // 留觀示範：27 小時前因腹痛到院（3 級），看完診 1 小時後決定留觀、再 10 分鐘排 OB1——已留觀約 26 小時（看板標紅），還沒結束。
      // 留觀住院（急診科、DR12）有護理與飲食醫囑、生命徵象、一筆護理紀錄；費用等結束留觀再算
      // 挑 27 小時前之後沒有就醫的病人：不然就醫序號（卡序）會比後來的門診大、時間卻比較早（隨日期不同才會遇到）
      const obsAt = addMinutes(nowStr, -27 * 60)
      const op = cands.slice(demo.length).find((p) => !visits.some((v) => v.patientId === p.id && v.createdAt > obsAt))
      if (op) {
        const at = obsAt
        const date = at.slice(0, 10)
        const osid = `ER-${date}`
        if (!sessions.some((s) => s.id === osid)) sessions.push({ id: osid, date, period: 'ER', deptId: erDoc.deptId, doctorId: erDoc.id, roomNo: '100', limit: 9999 })
        const decided = addMinutes(at, 90)
        const placed = addMinutes(decided, 10)
        const docUser = doctorUser(erDoc.id)
        const v: Visit = {
          id: 'V-ER-OBS', date, sessionId: osid, deptId: erDoc.deptId, doctorId: erDoc.id, patientId: op.id, seqNo: next(`seq:${osid}`), identityCode: op.defaultIdentity,
          caseType: 'E1', cardSeq: String(next(`cardseq:${op.id}`)).padStart(4, '0'), status: 'consulted', firstVisit: false, preventItems: [], createdAt: at, checkedInAt: at, calledAt: addMinutes(at, 20),
          er: {
            arrivedAt: at, complaint: '腹痛', vitals: { temp: 37.9, pulse: 104, resp: 20, sbp: 126, dbp: 78, spo2: 97 }, suggested: 3, level: 3, triagedBy: 'U201', triagedAt: at,
            disposition: { kind: 'obs', at: decided, by: docUser, admissionId: 'A-ER-OBS', note: '腹痛待觀察，排除闌尾炎' },
          },
        }
        visits.push(v)
        encounters.push({
          id: 'E-ER-OBS', visitId: v.id, patientId: op.id, doctorId: erDoc.id, deptId: erDoc.deptId, date,
          subjective: '上腹痛轉右下腹 6 小時，噁心、食慾差。', objective: '右下腹壓痛，無反彈痛；腸音減弱。', assessment: '腹痛，疑似早期闌尾炎', plan: '留觀，禁食、點滴，追蹤腹部理學檢查與白血球。',
          vitals: { temp: 37.9, pulse: 104, sbp: 126, dbp: 78, spo2: 97 },
          diagnoses: [{ icd: 'R10.9', name: '腹痛', primary: true }],
          medications: [], procedures: [], refillTimes: 0, admissionRequested: false, status: 'completed', completedAt: addMinutes(at, 80),
        })
        const bed = beds.find((b) => b.id === 'BOB1')!
        Object.assign(bed, { status: 'occupied', admissionId: 'A-ER-OBS' })
        admissions.push({
          id: 'A-ER-OBS', admitNo: `I${placed.slice(2, 10).replace(/-/g, '')}${String(next('admitNo')).padStart(3, '0')}`, patientId: op.id, fromVisitId: v.id, deptId: erDoc.deptId, doctorId: erDoc.id,
          bedId: bed.id, bedHistory: [{ bedId: bed.id, from: placed }], preferBedClass: '健保床', reason: '急診留觀：腹痛待觀察，排除闌尾炎', diagnosis: '腹痛，疑似早期闌尾炎',
          status: 'admitted', reservedAt: decided, expectedDate: date, admittedAt: placed, obs: { visitId: v.id },
          wristband: { printedAt: placed, printedBy: 'U201', reprints: [] },
        })
        for (const [k, content, category] of [[1, '禁食', 'diet'], [2, 'Vital signs Q4H', 'nursing'], [3, '每 4 小時腹部理學檢查，疼痛加劇通知醫師', 'nursing']] as const) {
          ipdOrders.push({ id: `IO-ER-OBS-${k}`, admissionId: 'A-ER-OBS', type: 'long', category, content, ...(category === 'diet' ? { diet: { kind: 'npo' as const } } : {}), startAt: placed, status: 'active', doctorId: erDoc.id, createdAt: placed, ackAt: addMinutes(placed, 5), ackBy: 'U201' })
        }
        for (let h = 0; addMinutes(placed, h * 240) <= nowStr; h++) {
          const vt = addMinutes(placed, h * 240)
          vitals.push({ id: `VS-ER-OBS-${h}`, admissionId: 'A-ER-OBS', at: vt, temp: h < 3 ? 37.8 : 37.3, pulse: h < 3 ? 100 : 88, resp: 18, sbp: 124, dbp: 76, spo2: 97, pain: h < 3 ? 5 : 3, ...(h < 3 ? { painAction: '協助舒適臥位，禁食中不給口服止痛，通知醫師' } : {}), nurseId: h % 2 ? 'U202' : 'U201' })
        }
        // 急刀示範：留觀中右下腹痛加劇、白血球升高，4 小時前申請腹腔鏡闌尾切除術（緊急，6 小時內入刀房）——手術室還沒排（首頁、手術室標示等待時間）
        {
          const at = addMinutes(nowStr, -240)
          const d = at.slice(0, 10)
          const no = `OR${d.replace(/-/g, '')}${String(surgeries.filter((x) => x.no.startsWith(`OR${d.replace(/-/g, '')}`)).length + 1).padStart(3, '0')}`
          surgeries.push({
            id: 'SG-SEED-ER', no, admissionId: 'A-ER-OBS', patientId: op.id, doctorId: erDoc.id, procId: 'P038', side: 'na', anesthesia: 'general', urgency: 'urgent',
            diagnosis: 'K35.80 急性闌尾炎', requestedDate: d, estMinutes: 90, status: 'requested', createdAt: at,
            note: '留觀中右下腹痛加劇、反彈痛，白血球 15,800', prep: { npo: { by: 'U201', at: addMinutes(at, 10) } }, checks: {},
          })
          counters[`surgery:${d}`] = Math.max(counters[`surgery:${d}`] ?? 0, Number(no.slice(-3)))
        }
        nursingNotes.push({ id: 'NN-ER-OBS', admissionId: 'A-ER-OBS', at: addMinutes(placed, 30), focus: '急性疼痛', data: '病人右下腹痛，疼痛 5 分，噁心。', action: '協助舒適臥位，依醫囑禁食、觀察腹部變化。', response: '病人表示疼痛可忍受。', nurseId: 'U201' })
        // 留觀也做跌倒、壓傷入院評估（打點滴：跌倒中度）
        for (const [scale, answers] of [['fall', { history: 0, secondary: 15, aid: 0, iv: 20, gait: 0, mental: 0 }], ['pressure', { sensory: 4, moisture: 4, activity: 3, mobility: 4, nutrition: 2, friction: 3 }]] as const) {
          const score = riskScore(scale, answers).score
          riskAssessments.push({ id: `RA-ER-OBS-${scale}`, admissionId: 'A-ER-OBS', scale, at: addMinutes(placed, 40), nurseId: 'U201', answers, score, level: riskLevel(scale, score), reason: 'admission' })
        }
      }
    }
  }

  // 管路與疼痛（示範，不抽亂數）：
  //   - 腦梗塞：導尿管放 9 天（滿 7 天提醒主治；昨天評估還需要、今天還沒評）、鼻胃管
  //   - 敗血症：右內頸 CVC（入院當天放，今天還沒評估）、周邊留置針
  //   - 肺炎：周邊留置針放超過 96 小時（提醒更換；住不夠久就放在入院時）
  //   - 骨折：75 分鐘前疼痛 6 分、給了止痛藥，還沒重評（逾時，本班待辦與首頁）
  const lines: LineDevice[] = []
  {
    const inpt = admissions.filter((a) => a.status === 'admitted' && a.admittedAt && !a.obs)
    const by = (p: string) => inpt.find((a) => a.diagnosis.startsWith(p))
    const later = (a: string, b: string) => (a > b ? a : b)
    const put = (a: Admission | undefined, k: number, l: Omit<LineDevice, 'id' | 'admissionId' | 'recordedBy' | 'recordedAt'>) => {
      if (!a) return
      const at = later(l.insertedAt, a.admittedAt!)
      lines.push({ id: `LN-SEED-${k}`, admissionId: a.id, ...l, insertedAt: at, recordedBy: 'U201', recordedAt: at })
    }
    const stroke = by('I63')
    put(stroke, 1, { kind: 'foley', site: '尿道', size: '16Fr', insertedAt: addMinutes(nowStr, -9 * 24 * 60), placedBy: '周怡萱', needChecks: [{ date: addDays(T, -1), at: `${addDays(T, -1)} 09:00`, by: 'U201', needed: true }] })
    put(stroke, 2, { kind: 'ngt', site: '右鼻孔', size: '16Fr', insertedAt: addMinutes(nowStr, -20 * 24 * 60), placedBy: '周怡萱' })
    const sep = by('A41')
    put(sep, 3, { kind: 'cvc', site: '右內頸靜脈', size: '7Fr 三腔', insertedAt: sep?.admittedAt ?? nowStr, placedBy: '陳映如醫師' })
    put(sep, 4, { kind: 'pivc', site: '左前臂', size: '20G', insertedAt: sep?.admittedAt ?? nowStr, placedBy: '周怡萱' })
    put(by('J18'), 5, { kind: 'pivc', site: '右手背', size: '20G', insertedAt: addMinutes(nowStr, -100 * 60), placedBy: '孫佩君' })
    const frac = by('S52')
    const painAt = addMinutes(nowStr, -75)
    if (frac && frac.admittedAt! < painAt) {
      // 之後的紀錄拿掉（示範：最新一筆就是這次疼痛 6 分）
      for (let k = vitals.length - 1; k >= 0; k--) if (vitals[k].admissionId === frac.id && vitals[k].at > painAt) vitals.splice(k, 1)
      vitals.push({ id: 'VS-PAIN-SEED', admissionId: frac.id, at: painAt, temp: 36.8, pulse: 96, resp: 18, sbp: 132, dbp: 82, spo2: 98, pain: 6, painAction: '依醫囑給予止痛藥、患肢抬高冰敷', nurseId: 'U201' })
    }
  }

  // 營養（示範，不抽亂數）：住院中（不含留觀）入院 3 小時後護理師篩檢，大多 0–2 分。
  //   - 腦梗塞（中風 2 分＋進食差 1 分）：營養師入院隔天評估過，主治已閱；昨天又評一次（建議改管灌），主治還沒閱
  //   - 敗血症：篩 ≥3 分，營養師待評估
  //   - 最近入院、還沒滿 48 小時的那一位不篩（護理站待辦「營養篩檢」）
  const nutritionScreens: NutritionScreen[] = []
  const nutritionAssessments: NutritionAssessment[] = []
  {
    const inpt = admissions.filter((a) => a.status === 'admitted' && a.admittedAt && !a.obs).sort((a, b) => a.admittedAt!.localeCompare(b.admittedAt!))
    const newest = inpt.filter((a) => !/^(I63|A41)/.test(a.diagnosis)).at(-1)
    const ageAt = (pid: string) => { const p = patients.find((x) => x.id === pid)!; return Number(T.slice(0, 4)) - Number(p.birthDate.slice(0, 4)) }
    for (const a of inpt) {
      const at = addMinutes(a.admittedAt!, 180)
      if (at > nowStr || (a === newest && a.admittedAt! > addMinutes(nowStr, -48 * 60))) continue
      const stroke = a.diagnosis.startsWith('I63')
      const sepsis = a.diagnosis.startsWith('A41')
      const impaired = (stroke ? 1 : sepsis ? 2 : 0) as 0 | 1 | 2 | 3
      const severity = (stroke ? 2 : sepsis ? 1 : a.diagnosis.startsWith('E11') ? 1 : 0) as 0 | 1 | 2 | 3
      const age70 = ageAt(a.patientId) >= 70
      nutritionScreens.push({ id: `NS-SEED-${a.admitNo}`, admissionId: a.id, at, by: 'U201', impaired, severity, age70, score: nutritionScore({ impaired, severity, age70 }), heightCm: 160, weightKg: stroke ? 52 : 60 })
      if (stroke) {
        const d1 = addMinutes(a.admittedAt!, 26 * 60)
        nutritionAssessments.push({ id: 'NA-SEED-1', admissionId: a.id, at: d1, by: 'U701', kcal: 1500, protein: 60, assessment: '中風後吞嚥困難，進食量約平常一半，BMI 20.3。', recommendation: '改軟質飲食，三餐間加一份營養補充品；每週量體重。', seenBy: users.find((u) => u.doctorId === a.doctorId)?.id, seenAt: addMinutes(d1, 180) })
        const d2a = addMinutes(nowStr, -20 * 60)
        const d2 = d2a > addMinutes(d1, 60) ? d2a : addMinutes(d1, 60)
        nutritionAssessments.push({ id: 'NA-SEED-2', admissionId: a.id, at: d2, by: 'U701', kcal: 1500, protein: 65, assessment: '吞嚥評估仍有嗆咳，近一週體重少 1.5 公斤。', recommendation: '建議經鼻胃管灌食（均衡配方 1500 kcal/日，分 6 餐），請主治評估是否開立。', tube: { formulaId: 'TF01', totalMl: 1500, mode: 'bolus', feeds: 6 } })
      }
    }
  }

  // 譫妄與約束（示範，不抽亂數）：住院中最年長（65 歲以上）的那位——上一班 CAM 陰性，3 小時前 CAM 陽性（夜間躁動、拉扯點滴，主治還沒確認）；
  // 5 小時前主治開約束醫囑（雙手約束手套），最近一次查核在 2 小時 20 分前（查核逾時，本班待辦）
  const deliriumAssessments: DeliriumAssessment[] = []
  const restraints: Restraint[] = []
  {
    const ageAt = (pid: string) => { const p = patients.find((x) => x.id === pid)!; return Number(T.slice(0, 4)) - Number(p.birthDate.slice(0, 4)) }
    const old = admissions.filter((a) => a.status === 'admitted' && a.admittedAt && !a.obs && ageAt(a.patientId) >= 66 && a.admittedAt < addMinutes(nowStr, -12 * 60)).sort((a, b) => ageAt(b.patientId) - ageAt(a.patientId))[0]
    if (old) {
      const docUser = users.find((u) => u.doctorId === old.doctorId)!.id
      deliriumAssessments.push({ id: 'DL-SEED-1', admissionId: old.id, at: addMinutes(nowStr, -11 * 60), by: 'U202', acute: false, inattention: false, disorganized: false, consciousness: false, positive: false })
      deliriumAssessments.push({ id: 'DL-SEED-2', admissionId: old.id, at: addMinutes(nowStr, -3 * 60), by: 'U201', acute: true, inattention: true, disorganized: true, consciousness: false, positive: true, note: '夜間躁動、拉扯點滴，對時間地點混亂' })
      const st = addMinutes(nowStr, -5 * 60)
      restraints.push({
        id: 'RS-SEED-1', admissionId: old.id, reason: '自拔管路風險', sites: ['左手', '右手'], method: '約束手套', startedAt: st, startedBy: docUser, emergency: false,
        orders: [{ by: docUser, at: st, until: addMinutes(st, 24 * 60) }],
        checks: [{ at: addMinutes(nowStr, -260), by: 'U201', circulationOk: true, skinOk: true, stillNeeded: true }, { at: addMinutes(nowStr, -140), by: 'U201', circulationOk: true, skinOk: true, stillNeeded: true }],
      })
    }
  }

  // 護理排班（示範，不抽亂數）：上個月 1 號到這個月底，3 個一般病房每天 10 個班位（5A 白班 2 人），12 位護理師輪流（每天 2 位休）；
  // 今天 5A 白班是 nurse01、nurse02。明天 6B 小夜故意沒排（班表標紅）。現在這一班 5A 的病人依床號分給上班的護理師
  const nurseShifts: NurseShift[] = []
  const weanTrials: WeanTrial[] = []
  const icuRequests: IcuRequest[] = []
  const rrtCalls: RrtCall[] = []
  const codeBlues: CodeBlue[] = []
  const palliativeCases: PalliativeCase[] = []
  const pressureLogs: PressureLog[] = []
  const clusterDecisions: ClusterDecision[] = []
  const notifiableReports: NotifiableReport[] = []
  const nurseAssignments: NurseAssignment[] = []
  const shiftRequests: ShiftRequest[] = []
  {
    const pool = Array.from({ length: 12 }, (_, i) => `U${201 + i}`)
    const slots: [string, NurseShift['shift']][] = [[codes.wards[0], '白班'], [codes.wards[0], '白班'], [codes.wards[0], '小夜'], [codes.wards[0], '大夜'], [codes.wards[1], '白班'], [codes.wards[1], '小夜'], [codes.wards[1], '大夜'], [codes.wards[2], '白班'], [codes.wards[2], '小夜'], [codes.wards[2], '大夜']]
    const first = `${addDays(`${T.slice(0, 7)}-01`, -1).slice(0, 7)}-01`
    const nextMonth = addDays(`${T.slice(0, 7)}-28`, 7).slice(0, 7)
    let k = 0
    for (let d = first; d < `${nextMonth}-01`; d = addDays(d, 1)) {
      const r = ((diffDays(T, d) % 12) + 12) % 12
      slots.forEach(([ward, shift], i) => {
        if (d === addDays(T, 1) && ward === codes.wards[1] && shift === '小夜') return
        nurseShifts.push({ id: `NSH-SEED-${++k}`, ward, date: d, shift, nurseId: pool[(i + r) % 12] })
      })
    }
    // 換班請假示範：nurse04 想和 nurse01 換 3 天後的班（等 nurse01 同意）；nurse05 申請 5 天後（那天休就再往後）那班特休（等護理長核准）
    const on = (nid: string, d: string) => nurseShifts.find((x) => x.nurseId === nid && x.date === d)
    const d3 = addDays(T, 3)
    const s4 = on('U204', d3)
    const s1 = on('U201', d3)
    if (s4 && s1) shiftRequests.push({ id: 'SRQ-SEED-1', kind: 'swap', requesterId: 'U204', shiftId: s4.id, ward: s4.ward, date: d3, shift: s4.shift, reason: '那天要帶小孩回診', targetId: 'U201', targetShiftId: s1.id, target: { ward: s1.ward, date: d3, shift: s1.shift }, status: 'pending-peer', createdAt: addMinutes(nowStr, -120) })
    const s5 = [5, 6, 7, 8].map((k) => on('U205', addDays(T, k))).find(Boolean)
    if (s5) shiftRequests.push({ id: 'SRQ-SEED-2', kind: 'leave', requesterId: 'U205', shiftId: s5.id, ward: s5.ward, date: s5.date, shift: s5.shift, leaveType: '特休', reason: '家族旅遊', status: 'pending', createdAt: addMinutes(nowStr, -26 * 60) })
    const cur = { date: nowStr.slice(0, 10), shift: (Number(nowStr.slice(11, 13)) >= 16 ? '小夜' : Number(nowStr.slice(11, 13)) >= 8 ? '白班' : '大夜') as NurseShift['shift'] }
    const duty = nurseShifts.filter((x) => x.ward === codes.wards[0] && x.date === cur.date && x.shift === cur.shift).map((x) => x.nurseId)
    const pts = admissions.filter((a) => a.status === 'admitted' && beds.find((b) => b.id === a.bedId)?.ward === codes.wards[0]).sort((a, b) => (beds.find((x) => x.id === a.bedId)!.bedNo).localeCompare(beds.find((x) => x.id === b.bedId)!.bedNo))
    const per = duty.length ? Math.ceil(pts.length / duty.length) : 0
    pts.forEach((a, i) => duty.length && nurseAssignments.push({ id: `NAS-SEED-${i + 1}`, ward: codes.wards[0], date: cur.date, shift: cur.shift, admissionId: a.id, nurseId: duty[Math.min(duty.length - 1, Math.floor(i / per))], by: duty[0], at: `${cur.date} ${cur.shift === '白班' ? '08:10' : cur.shift === '小夜' ? '16:10' : '00:10'}` }))
  }

  // 出院準備（示範，不抽亂數；nurse03 林佳穎是個管師）：
  //   - 住院中入院超過 24 小時的都篩過（65 歲以上自動勾），最近入院的那位還沒篩
  //   - 腦梗塞：帶管路＋日常生活需要協助 → 收案，長照 5 天前送出已核定、居家護理已送出待回覆
  //   - 准出院的那位：65 歲以上＋獨居 → 收案、評估要長照與輔具，還沒轉介（醫師、個管師看得到提醒）
  //   - 最近 10 天內出院的一位病人（9 天前出院的肺炎）：收案、輔具轉介已核定，出院後 7 天內沒電話追蹤（逾時）
  const dischargePlans: DischargePlan[] = []
  {
    const ageAt = (pid: string) => { const p = patients.find((x) => x.id === pid)!; return Number(T.slice(0, 4)) - Number(p.birthDate.slice(0, 4)) }
    const inpt = admissions.filter((a) => a.status === 'admitted' && a.admittedAt && !a.obs).sort((a, b) => a.admittedAt!.localeCompare(b.admittedAt!))
    // 留一位還沒篩的：最近入院、不是准出院或腦梗塞（那兩位是收案示範）
    const newest = inpt.filter((a) => !a.dischargeSummary?.signedAt && !a.diagnosis.startsWith('I63')).at(-1)
    let k = 0
    const mk = (a: Admission, criteria: string[], extra: Partial<DischargePlan> = {}): DischargePlan => {
      const p: DischargePlan = { id: `DPL-SEED-${++k}`, admissionId: a.id, screenedAt: addMinutes(a.admittedAt!, 20 * 60) < nowStr ? addMinutes(a.admittedAt!, 20 * 60) : nowStr, screenedBy: 'U203', criteria, auto: criteria.filter((c) => ['age65', 'lines', 'readmit'].includes(c)), enrolled: criteria.length >= 2, needs: [], referrals: [], ...extra }
      dischargePlans.push(p)
      return p
    }
    for (const a of inpt) {
      if (a === newest || (a.admittedAt! > addMinutes(nowStr, -24 * 60) && !a.dischargeSummary?.signedAt)) continue
      const age = ageAt(a.patientId) >= 65 ? ['age65'] : []
      if (a.diagnosis.startsWith('I63')) {
        mk(a, ['lines', 'adl', ...age], {
          needs: ['ltc', 'homecare', 'teach'], assessment: '中風後右側無力、吞嚥困難帶鼻胃管，配偶白天上班；出院後需要居家照顧與換管。',
          referrals: [
            { id: 'DRF-SEED-1', kind: 'ltc', agency: '市長期照顧管理中心', createdAt: addMinutes(nowStr, -6 * 24 * 60), createdBy: 'U203', sentAt: addMinutes(nowStr, -5 * 24 * 60), sentBy: 'U203', reply: { status: 'approved', note: '核定居家服務每週 10 小時', at: addMinutes(nowStr, -2 * 24 * 60), by: 'U203' } },
            { id: 'DRF-SEED-2', kind: 'homecare', agency: '本院居家護理所', createdAt: addMinutes(nowStr, -2 * 24 * 60), createdBy: 'U203', sentAt: addMinutes(nowStr, -2 * 24 * 60 + 30), sentBy: 'U203' },
          ],
        })
      } else if (a.dischargeSummary?.signedAt) {
        mk(a, ['alone', ...(age.length ? age : ['chronic'])], { needs: ['ltc', 'aids'], assessment: '獨居，子女在外縣市；行動需助行器，浴室沒有扶手。' })
      } else mk(a, age)
    }
    const recent = admissions.filter((a) => a.status === 'discharged' && a.dischargedAt && a.dischargedAt >= addMinutes(nowStr, -10 * 24 * 60)).sort((a, b) => b.dischargedAt!.localeCompare(a.dischargedAt!))[0]
    if (recent && recent.admittedAt) {
      mk(recent, [ageAt(recent.patientId) >= 65 ? 'age65' : 'chronic', 'adl'], {
        needs: ['aids', 'teach'], assessment: '出院後由女兒照顧，需要輪椅與移位指導。',
        referrals: [{ id: 'DRF-SEED-3', kind: 'aids', agency: '市輔具資源中心', createdAt: addMinutes(recent.dischargedAt!, -2 * 24 * 60), createdBy: 'U203', sentAt: addMinutes(recent.dischargedAt!, -2 * 24 * 60 + 20), sentBy: 'U203', reply: { status: 'approved', note: '輪椅出院當天送達', at: addMinutes(recent.dischargedAt!, -24 * 60), by: 'U203' } }],
      })
    }
  }

  // 點滴（示範，不抽亂數）：肺炎病人（有周邊留置針）主治開「Normal Saline 500 ml @ 80 ml/h」，6 小時前接上第 1 瓶——約 15 分鐘後滴完（本班待辦「快滴完：換瓶」）。
  // 種子的這瓶沒有扣帳異動（展示用；之後接的瓶照常扣帳、進帳單）
  const infusions: InfusionRun[] = []
  {
    const pn = admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('J18') && a.admittedAt && a.admittedAt < addMinutes(nowStr, -7 * 60))
    if (pn) {
      const st = addMinutes(nowStr, -6 * 60)
      const ns = codes.drugs.find((d) => d.id === 'M037')!
      ipdOrders.push({ id: 'IO-IV-SEED-1', admissionId: pn.id, type: 'long', category: 'medication', drugId: ns.id, content: `${ns.name} 500 ml @ 80 ml/h`, dose: 1, freq: 'QD', route: 'IV', infusion: { volumeMl: 500, rateMlH: 80 }, startAt: addMinutes(st, -10), status: 'active', doctorId: pn.doctorId, createdAt: addMinutes(st, -10), ackAt: addMinutes(st, -5), ackBy: 'U201' })
      infusions.push({ id: 'INFU-SEED-1', orderId: 'IO-IV-SEED-1', admissionId: pn.id, bagNo: 1, startAt: st, startBy: 'U201', rateMlH: 80, rateChanges: [], txnIds: [] })
    }
  }

  // 加護病房（示範，不抽亂數）：
  //   - 排班：nurse13–16 每天三班各一人（輪流，每天一位休）；現在這一班的病人分給上班的那位
  //   - 重症流程表：敗血症病人最近 24 小時（入院之後）每小時一筆，血壓從偏低（MAP <65）慢慢回升；
  //     最後一筆停在 80 分鐘以前的整點 → 流程表漏記（本班待辦、首頁、看板紅框），記一筆就消失。
  //     那段時間原本的生命徵象（每天 08、14、20 點，亂數）刪掉，免得和流程表重複算輸入輸出
  {
    const pool = ['U213', 'U214', 'U215', 'U216']
    const first = `${addDays(`${T.slice(0, 7)}-01`, -1).slice(0, 7)}-01`
    const nextMonth = addDays(`${T.slice(0, 7)}-28`, 7).slice(0, 7)
    let k = 0
    for (let d = first; d < `${nextMonth}-01`; d = addDays(d, 1)) {
      const r = ((diffDays(T, d) % 4) + 4) % 4
      ;(['大夜', '白班', '小夜'] as const).forEach((shift, i) => nurseShifts.push({ id: `NSH-ICU-${++k}`, ward: codes.icuWard, date: d, shift, nurseId: pool[(i + r) % 4] }))
    }
    const cur = { date: nowStr.slice(0, 10), shift: (Number(nowStr.slice(11, 13)) >= 16 ? '小夜' : Number(nowStr.slice(11, 13)) >= 8 ? '白班' : '大夜') as NurseShift['shift'] }
    const duty = nurseShifts.find((x) => x.ward === codes.icuWard && x.date === cur.date && x.shift === cur.shift)
    const icuPts = admissions.filter((a) => a.status === 'admitted' && beds.find((b) => b.id === a.bedId)?.ward === codes.icuWard)
    icuPts.forEach((a, i) => duty && nurseAssignments.push({ id: `NAS-ICU-${i + 1}`, ward: codes.icuWard, date: cur.date, shift: cur.shift, admissionId: a.id, nurseId: duty.nurseId, by: duty.nurseId, at: `${cur.date} ${cur.shift === '白班' ? '08:10' : cur.shift === '小夜' ? '16:10' : '00:10'}` }))
    const sep = icuPts.find((a) => a.diagnosis.startsWith('A41'))
    if (sep) {
      const later = (a: string, b: string) => (a > b ? a : b)
      const docU = users.find((u) => u.doctorId === sep.doctorId)!.id
      // 住進加護病房 1 小時後插管（經口 7.5），接呼吸器 AC/VC FiO2 60%；昨天（或插管 6 小時後）血氧穩定降到 40%
      const ettAt = addMinutes(sep.admittedAt!, 60)
      lines.push({ id: 'LN-SEED-ETT', admissionId: sep.id, kind: 'ett', site: '經口', size: '7.5', insertedAt: ettAt, placedBy: '陳映如醫師', recordedBy: docU, recordedAt: ettAt })
      const chAt = later(`${addDays(T, -1)} 10:00`, addMinutes(ettAt, 6 * 60))
      const vo = (id: string, at: string, vent: IpdOrder['vent'], stopAt?: string): IpdOrder => ({
        id, admissionId: sep.id, type: 'long', category: 'nursing', content: `呼吸器 ${ventText(vent!)}`, vent, startAt: at, status: stopAt ? 'stopped' : 'active', ...(stopAt ? { stopAt, stopAckAt: addMinutes(stopAt, 20), stopAckBy: 'U213' } : {}),
        doctorId: sep.doctorId, createdAt: at, ackAt: addMinutes(at, 15), ackBy: 'U213',
      })
      ipdOrders.push(vo('IO-VENT-1', ettAt, { mode: 'AC/VC', fio2: 60, peep: 10, vt: 420, rr: 18 }, chAt))
      ipdOrders.push(vo('IO-VENT-2', chAt, { mode: 'AC/VC', fio2: 40, peep: 8, vt: 420, rr: 16, changeReason: '血氧穩定，降氧（脫離）' }))
      // 鎮靜目標 RASS −2～0；最近一次 −3（太深）→ 主治首頁「鎮靜超出目標」
      sep.rassTarget = { min: -2, max: 0, by: docU, at: addMinutes(ettAt, 30) }
      // 昨天的脫離評估：SAT 沒過（停鎮靜後躁動、血氧掉）；今天還沒做 → 主治首頁「今日脫離評估」
      if (addDays(T, -1) >= ettAt.slice(0, 10)) weanTrials.push({ id: 'WN-SEED-1', admissionId: sep.id, date: addDays(T, -1), at: later(`${addDays(T, -1)} 09:30`, addMinutes(ettAt, 30)), by: docU, sat: 'fail', sbt: 'na', note: '停鎮靜 20 分鐘後躁動、拉扯管路，SpO2 掉到 88%，恢復鎮靜' })
      const hourOf = (t: string) => `${t.slice(0, 13)}:00`
      const lastH = hourOf(addMinutes(nowStr, -80))
      const firstH = [addMinutes(hourOf(sep.admittedAt!), 60), addMinutes(hourOf(nowStr), -24 * 60)].sort().pop()!
      const hrs: string[] = []
      for (let h = firstH; h <= lastH; h = addMinutes(h, 60)) hrs.push(h)
      // 刪掉流程表那段時間的一般生命徵象
      for (let j = vitals.length - 1; j >= 0; j--) if (vitals[j].admissionId === sep.id && vitals[j].at >= firstH && vitals[j].at <= addMinutes(lastH, 59)) vitals.splice(j, 1)
      const n = hrs.length
      hrs.forEach((at, j) => {
        const p = n > 1 ? j / (n - 1) : 1 // 0 → 1：從剛住進來到最近
        const sbp = Math.round(86 + 20 * p)
        const dbp = Math.round(48 + 12 * p)
        const nid = nurseShifts.find((x) => x.ward === codes.icuWard && x.date === at.slice(0, 10) && x.shift === (Number(at.slice(11, 13)) >= 16 ? '小夜' : Number(at.slice(11, 13)) >= 8 ? '白班' : '大夜'))?.nurseId ?? 'U213'
        vitals.push({
          id: `VS-ICU-${j + 1}`, admissionId: sep.id, at, hourly: true, nurseId: nid,
          temp: Math.round((38.6 - 0.9 * p) * 10) / 10, pulse: Math.round(118 - 20 * p), resp: Math.round(26 - 6 * p), sbp, dbp, spo2: Math.round(93 + 3 * p),
          // 每 4 小時（從最後一筆往回數）：疼痛、GCS（插管後言語記 T）、瞳孔、RASS、呼吸器實測
          ...((n - 1 - j) % 4 === 0 ? {
            pain: j === 0 ? 3 : 2, pupils: { l: 3, r: 3, lightL: 'brisk' as const, lightR: 'brisk' as const },
            gcs: at >= ettAt ? { e: p < 0.5 ? 2 : 3, v: 1, m: 6, vt: true } : { e: 3, v: 4, m: 6 },
            ...(at >= ettAt ? { rass: p < 0.5 ? -4 : -3, vent: { ppeak: Math.round(30 - 4 * p), vt: 410 + (j % 3) * 10, rr: 18 } } : {}),
          } : {}),
          ...(j % 2 === 0 ? { intake: 100 } : {}), output: Math.round(25 + 25 * p),
        })
      })
    }
    // 敗血症的加護病房檢驗（SOFA、APACHE II 要用；沒有危急值）：轉入 90 分鐘的 ABG、CBC、肌酸酐；昨天早上（或轉入 6 小時後）的 ABG、CBC、膽紅素、肌酸酐
    if (sep) {
      const later = (a: string, b: string) => (a > b ? a : b)
      const pt = patients.find((x) => x.id === sep.patientId)!
      const procMap = new Map(codes.procedures.map((p) => [p.id, p]))
      let k = 0
      const lab = (procId: string, at: string, input: Record<string, string>) => {
        k++
        const o: IpdOrder = { id: `IO-ICU-LAB${k}`, admissionId: sep.id, type: 'stat', category: 'procedure', procId, content: procMap.get(procId)!.name, startAt: addMinutes(at, -40), stopAt: addMinutes(at, -30), status: 'done', doctorId: sep.doctorId, createdAt: addMinutes(at, -40), ackAt: addMinutes(at, -35), ackBy: 'U213' }
        ipdOrders.push(o)
        labReports.push({ id: `LR-ICU-${k}`, no: `L${at.slice(0, 10).replace(/-/g, '')}${9800 + k}`, patientId: sep.patientId, procId, orderId: o.id, admissionId: sep.id, doctorId: sep.doctorId, orderedAt: o.createdAt, values: buildLabValues(procMap.get(procId)!.labItems!, input, pt.gender).values, reportedBy: 'U601', reportedAt: at })
      }
      const a1 = addMinutes(sep.admittedAt!, 90)
      lab('P052', a1, { pH: '7.24', PaCO2: '34', PaO2: '68', HCO3: '15' })
      lab('P003', a1, { WBC: '18.6', Hb: '11.2', HCT: '33.5', PLT: '128' })
      lab('P008', a1, { CRE: '2.1' })
      const a2 = later(`${addDays(T, -1)} 06:00`, addMinutes(sep.admittedAt!, 6 * 60))
      if (a2 < nowStr) {
        lab('P052', a2, { pH: '7.34', PaCO2: '40', PaO2: '82', HCO3: '21' })
        lab('P003', a2, { WBC: '15.2', Hb: '10.6', HCT: '31.8', PLT: '92' })
        lab('P053', a2, { 'T-BIL': '2.4' })
        lab('P008', a2, { CRE: '1.8' })
      }
      // 電解質（APACHE II 的鈉、鉀；血比容在 CBC）：轉入 90 分鐘
      lab('P055', a1, { NA: '132', K: '3.4' })
      // 升壓劑（示範，不抽亂數）：敗血性休克接 norepinephrine（60 kg、上限 0.3、目標 MAP ≥65），起始 0.12（27 ml/h），
      // 4 小時前血壓穩定調降到 0.08（18 ml/h）→ SOFA 心血管 3 分。種子這袋沒有扣帳異動（展示用）
      const st = later(addMinutes(sep.admittedAt!, 60), addMinutes(nowStr, -9 * 60))
      const down = later(addMinutes(st, 60), addMinutes(nowStr, -4 * 60))
      const vaso = { dose: 0.12, max: 0.3, weightKg: 60, target: 'MAP ≥65 mmHg' }
      ipdOrders.push({ id: 'IO-VASO-SEED-1', admissionId: sep.id, type: 'long', category: 'medication', drugId: 'M048', content: 'Norepinephrine 4mg/250ml Premix 0.12 mcg/kg/min（上限 0.3，60 kg）@ 27 ml/h，目標 MAP ≥65 mmHg', dose: 1, freq: 'QD', route: 'IV', startAt: addMinutes(st, -10), status: 'active', doctorId: sep.doctorId, createdAt: addMinutes(st, -10), ackAt: addMinutes(st, -5), ackBy: 'U213', infusion: { volumeMl: 250, rateMlH: 27, vaso } })
      const dropped = down < nowStr
      infusions.push({ id: 'INFU-VASO-SEED-1', orderId: 'IO-VASO-SEED-1', admissionId: sep.id, bagNo: 1, startAt: st, startBy: 'U213', rateMlH: dropped ? 18 : 27, rateChanges: dropped ? [{ at: down, by: 'U213', from: 27, to: 18, reason: 'MAP 高於目標，調降' }] : [], txnIds: [] })
    }
    // 糖尿病酮酸中毒：兩天前（或入院 2 小時後）申請轉入、加護病房主治 dr03 同意轉到 ICU2；現在穩定，等醫師寫轉出摘要再轉回病房
    const dka = admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('E11'))
    const icu2 = beds.find((b) => b.ward === codes.icuWard && b.status === 'empty')
    if (dka && icu2) {
      const dr02 = users.find((u) => u.doctorId === 'DR02')!.id
      const dr03 = users.find((u) => u.doctorId === 'DR03')!.id
      const since = [addMinutes(dka.admittedAt!, 120), `${addMinutes(nowStr, -40 * 60).slice(0, 13)}:20`].sort().pop()!
      const old = beds.find((b) => b.id === dka.bedId)!
      old.status = 'empty'
      delete old.admissionId
      icu2.status = 'occupied'
      icu2.admissionId = dka.id
      dka.bedHistory = [{ bedId: old.id, from: dka.admittedAt! }, { bedId: icu2.id, from: since }]
      dka.bedId = icu2.id
      // 急救（示範）：轉入前 70 分鐘在原病房低血鉀（K 2.6）心室顫動 → CPR、電擊兩次、腎上腺素一劑，10 分鐘恢復自主循環 → 主治申請轉入。
      // 急救藥的醫囑有開（已執行），種子這幾支沒有扣帳異動（展示用；之後的急救照常扣帳）；CPR 處置費照常進帳單
      const cs = addMinutes(since, -70)
      const m = (k: number) => addMinutes(cs, k)
      const cbOrder = (no: number, at: string, x: Partial<IpdOrder> & Pick<IpdOrder, 'category' | 'content'>): IpdOrder => ({ id: `IO-CB-SEED-${no}`, admissionId: dka.id, type: 'stat', startAt: at, stopAt: at, status: 'done', doctorId: 'DR02', createdAt: at, ackAt: at, ackBy: 'U201', codeBlueId: 'CB-SEED-1', ...x })
      ipdOrders.push(
        cbOrder(1, m(4), { category: 'medication', drugId: 'M046', content: 'Epinephrine 1mg/ml Inj 1 mg IV（急救）', dose: 1, freq: 'STAT', route: 'IV' }),
        cbOrder(2, m(10), { category: 'procedure', procId: 'P054', content: '心肺復甦術 CPR（急救）' }),
      )
      codeBlues.push({
        id: 'CB-SEED-1', admissionId: dka.id, startedAt: cs, startedBy: 'U201', leaderId: dr02, status: 'ended', endedAt: m(10), endedBy: dr02, outcome: 'rosc', icuRequestId: 'ICR-SEED-1',
        events: [
          { id: 'CE-SEED-1', at: cs, kind: 'cpr', by: 'U201' },
          { id: 'CE-SEED-2', at: m(1), kind: 'rhythm', rhythm: 'vf', by: 'U201' },
          { id: 'CE-SEED-3', at: m(2), kind: 'shock', joules: 200, by: dr02 },
          { id: 'CE-SEED-4', at: m(4), kind: 'epi', doseMg: 1, orderId: 'IO-CB-SEED-1', by: 'U202' },
          { id: 'CE-SEED-5', at: m(5), kind: 'shock', joules: 200, by: dr02 },
          { id: 'CE-SEED-6', at: m(6), kind: 'note', note: '抽血：K 2.6，給 KCl', by: dr02 },
          { id: 'CE-SEED-7', at: m(8), kind: 'rhythm', rhythm: 'pea', by: 'U201' },
        ],
      })
      icuRequests.push({ id: 'ICR-SEED-1', admissionId: dka.id, category: 'other', reason: '急救後（ROSC）：糖尿病酮酸中毒治療中低血鉀（K 2.6）心室顫動，CPR 10 分鐘、電擊 2 次、腎上腺素 1 劑恢復自主循環；需胰島素點滴、每小時驗血糖與電解質', requestedBy: dr02, requestedAt: addMinutes(since, -50), status: 'placed', decidedBy: dr03, decidedAt: addMinutes(since, -30), placedAt: since, bedId: icu2.id, codeBlueId: 'CB-SEED-1' })
      // 轉入之後還留在原病房的交班（住院時產生的）拿掉：人已經在加護病房
      for (let j = handovers.length - 1; j >= 0; j--) if (handovers[j].admissionId === dka.id && handovers[j].createdAt >= since) handovers.splice(j, 1)
      // 分床：從 5A 的分床拿掉、分給加護病房這一班的護理師
      for (let j = nurseAssignments.length - 1; j >= 0; j--) if (nurseAssignments[j].admissionId === dka.id) nurseAssignments.splice(j, 1)
      if (duty) nurseAssignments.push({ id: 'NAS-ICU-DKA', ward: codes.icuWard, date: cur.date, shift: cur.shift, admissionId: dka.id, nurseId: duty.nurseId, by: duty.nurseId, at: `${cur.date} ${cur.shift === '白班' ? '08:10' : cur.shift === '小夜' ? '16:10' : '00:10'}` })
      // 流程表：轉入後每小時一筆，最後一筆在 15 分鐘以前的整點（還沒漏記）；那段時間原本的生命徵象刪掉
      const hourOf = (t: string) => `${t.slice(0, 13)}:00`
      const firstH = addMinutes(hourOf(since), 60)
      const lastH = hourOf(addMinutes(nowStr, -15))
      for (let j = vitals.length - 1; j >= 0; j--) if (vitals[j].admissionId === dka.id && vitals[j].at >= firstH && vitals[j].at <= addMinutes(lastH, 59)) vitals.splice(j, 1)
      const hrs: string[] = []
      for (let h = firstH; h <= lastH; h = addMinutes(h, 60)) hrs.push(h)
      const n = hrs.length
      hrs.forEach((at, j) => {
        const nid = nurseShifts.find((x) => x.ward === codes.icuWard && x.date === at.slice(0, 10) && x.shift === (Number(at.slice(11, 13)) >= 16 ? '小夜' : Number(at.slice(11, 13)) >= 8 ? '白班' : '大夜'))?.nurseId ?? 'U214'
        vitals.push({
          id: `VS-DKA-${j + 1}`, admissionId: dka.id, at, hourly: true, nurseId: nid,
          temp: 36.8, pulse: 92 - (j % 3), resp: 18, sbp: 126 + (j % 4), dbp: 74, spo2: 98, intake: 150, output: 110,
          ...((n - 1 - j) % 4 === 0 ? { pain: 0, rass: 0, gcs: { e: 4, v: 5, m: 6 }, pupils: { l: 3, r: 3, lightL: 'brisk' as const, lightR: 'brisk' as const } } : {}),
        })
      })
    }
    // 腦梗塞（臥床）吸入性肺炎併敗血性休克：65 分鐘前 NEWS2 11 分自動呼叫快速反應小組 → dr03 20 分鐘後到場評估、申請轉入（休克），
    // 等加護病房主治同意；
    // 20 分鐘前再量仍 11 分（已有轉入申請在走，不重複呼叫），再量時間還沒到
    // （以前放在泌尿道感染那位，但他是「准出院」的示範：同一個人又休克、又准出院說不通）
    const shock = admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('I63'))
    if (shock) {
      const dr03u = users.find((u) => u.doctorId === 'DR03')!.id
      const t1 = addMinutes(nowStr, -65)
      const t2 = addMinutes(nowStr, -20)
      for (let j = vitals.length - 1; j >= 0; j--) if (vitals[j].admissionId === shock.id && vitals[j].at >= t1 && !vitals[j].id.startsWith('VS-BLD')) vitals.splice(j, 1)
      vitals.push({ id: 'VS-NEWS-SHOCK-1', admissionId: shock.id, at: t1, temp: 38.8, pulse: 124, resp: 26, sbp: 84, dbp: 46, spo2: 92, o2: 0, avpu: 'A', pain: 0, nurseId: 'U202' })
      vitals.push({ id: 'VS-NEWS-SHOCK-2', admissionId: shock.id, at: t2, temp: 38.3, pulse: 112, resp: 23, sbp: 86, dbp: 48, spo2: 95, o2: 4, avpu: 'A', pain: 0, nurseId: 'U202' })
      rrtCalls.push({ id: 'RRT-SEED-1', admissionId: shock.id, trigger: 'auto', vitalId: 'VS-NEWS-SHOCK-1', score: 11, calledBy: 'U202', calledAt: t1, status: 'done', assessedBy: dr03u, assessedAt: addMinutes(t1, 20), findings: '發燒、呼吸喘、右下肺囉音，四肢冰冷，血壓 84/46、心跳 124，尿量少（疑吸入性肺炎）', actions: '輸液 1.5 L、血液培養與乳酸、氧氣鼻導管 4 L', disposition: 'icu', icuRequestId: 'ICR-SEED-2' })
      icuRequests.push({ id: 'ICR-SEED-2', admissionId: shock.id, category: 'shock', reason: '吸入性肺炎併敗血性休克：血壓 86/48，輸液 1.5 L 後仍低，乳酸 3.8，尿量 0.3 ml/kg/h', requestedBy: dr03u, requestedAt: addMinutes(t1, 20), status: 'pending', rrtCallId: 'RRT-SEED-1' })
    }
  }

  // 早期預警（示範，不抽亂數）：肺炎病人 NEWS2 逐漸升高 2 → 4 → 6（40 分鐘前，中：通知主治、1 小時內再量，還沒到）
  {
    const pn = admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('J18'))
    if (pn?.admittedAt) {
      const from = addMinutes(nowStr, -9 * 60)
      for (let j = vitals.length - 1; j >= 0; j--) if (vitals[j].admissionId === pn.id && vitals[j].at >= from && !vitals[j].id.startsWith('VS-BLD')) vitals.splice(j, 1)
      const rows: [number, Partial<VitalRecord>][] = [
        [9 * 60, { temp: 38.2, pulse: 92, resp: 18, sbp: 124, dbp: 76, spo2: 96, o2: 0, avpu: 'A', pain: 2 }],
        [4 * 60, { temp: 37.6, pulse: 98, resp: 21, sbp: 118, dbp: 72, spo2: 95, o2: 0, avpu: 'A', pain: 2 }],
        [40, { temp: 37.9, pulse: 104, resp: 22, sbp: 112, dbp: 70, spo2: 94, o2: 2, avpu: 'A', pain: 1 }],
      ]
      rows.forEach(([m, x], j) => {
        const at = addMinutes(nowStr, -m)
        if (at >= pn.admittedAt!) vitals.push({ id: `VS-NEWS-PN-${j + 1}`, admissionId: pn.id, at, nurseId: j % 2 ? 'U202' : 'U201', ...x })
      })
    }
  }

  // 傷口（示範，不抽亂數）：腦梗塞病人（住院超過 20 天）16 天前發現薦骨第 2 級壓傷（院內壓傷），換藥三次，大小沒有變小
  // → 主治首頁「傷口 2 週沒變小」、護理站待辦；登錄後還沒做壓傷「病情變化加評」
  const wounds: Wound[] = []
  {
    const sk = admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('I63') && a.admittedAt && a.admittedAt < addMinutes(nowStr, -20 * 24 * 60))
    if (sk) {
      const at = (d: number) => `${addDays(T, -d)} 10:00`
      const c = (d: number, l: number, w: number, dressing: string, exudate: WoundCare['exudate']): WoundCare => ({ at: at(d), by: d % 2 ? 'U201' : 'U202', dressing, exudate, lengthCm: l, widthCm: w, depthCm: 0.1, stage: '2' })
      wounds.push({
        id: 'WD-SEED-1', admissionId: sk.id, kind: 'pressure', site: '薦骨', foundAt: at(16), hospitalAcquired: true, recordedBy: 'U201',
        cares: [c(16, 3, 2, '人工皮（親水性敷料）', 'small'), c(9, 3, 2.5, '人工皮（親水性敷料）', 'small'), c(2, 3.2, 2.5, '泡棉敷料', 'moderate')],
      })
    }
  }

  // 院內感染（示範，不抽亂數）：腦梗塞病人的導尿管（放 9 天）昨天發燒、尿液培養 E. coli ≥10⁵，護理師今天早上通報，等感染管制（dr11）判定
  const infectionCases: InfectionCase[] = []
  {
    const foley = lines.find((l) => l.id === 'LN-SEED-1')
    if (foley) infectionCases.push({
      id: 'INF-SEED-1', admissionId: foley.admissionId, kind: 'cauti', lineId: foley.id, onsetAt: addDays(T, -1),
      symptoms: '發燒 38.6°C、恥骨上壓痛，尿液混濁', culture: 'E. coli ≥10⁵ CFU/ml（尿液，昨天送檢，今天初步報告）',
      reportedBy: 'U201', reportedAt: `${T} ${nowStr.slice(11) < '08:30' ? nowStr.slice(11) : '08:30'}`, status: 'reported',
    })
  }

  // 初診（示範，不抽亂數）：亂數產生的病人都是幾年前建檔的舊病人，月報、看診清單、掛號單的「初診」都是 0。
  // 挑「第一次掛號在最近 60 天內」、之前沒住過院的病人，第一次掛號標初診（今天最多 3 位、之前每週最多 2 位），
  // 建檔日改成那天（有更早的預防保健紀錄就改成那天：預防保健不用掛號）。和櫃台掛號時 booking.register 的判斷一樣（之前沒有任何掛號＝初診）
  {
    const firstOf = new Map<string, Visit>()
    for (const v of [...visits].filter((x) => x.status !== 'cancelled').sort((a, b) => a.createdAt.localeCompare(b.createdAt))) if (!firstOf.has(v.patientId)) firstOf.set(v.patientId, v)
    const earlier = (pid: string, v: Visit) => admissions.some((a) => a.patientId === pid && (a.admittedAt ?? a.reservedAt) < v.createdAt)
    const picked = new Map<string, number>()
    for (const [pid, v] of [...firstOf.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (earlier(pid, v) || v.date < addDays(T, -60) || v.date > T) continue
      const week = v.date === T ? 'today' : `w${Math.floor(diffDays(v.date, T) / 7)}`
      const n = picked.get(week) ?? 0
      if (n >= (week === 'today' ? 3 : 2)) continue
      picked.set(week, n + 1)
      v.firstVisit = true
      const p = patients.find((x) => x.id === pid)!
      const pv = preventRecords.filter((r) => r.patientId === pid).map((r) => r.date).sort()[0]
      p.createdAt = pv && pv < v.date ? `${pv} 08:00` : `${v.date} ${v.createdAt.slice(11, 16) < '07:30' ? v.createdAt.slice(11, 16) : '07:30'}`
    }
  }

  // 腕帶與給藥掃描（示範，不抽亂數）：住院中的病人報到時都印了腕帶；已給的藥都掃描核對過，
  // 只有第一個病房今天的第 2、第 5 筆略過（掃描器故障、腕帶弄濕），護理站「掃描統計」才有內容
  for (const a of admissions.filter((x) => x.status === 'admitted')) a.wristband = { printedAt: a.admittedAt!, printedBy: 'U401', reprints: [] }
  {
    const ward0 = codes.wards[0]
    const inWard0 = new Set(admissions.filter((a) => a.status === 'admitted' && beds.find((b) => b.id === a.bedId)?.ward === ward0).map((a) => a.id))
    const given = mar.filter((m) => m.status === 'given').sort((x, y) => (x.executedAt ?? '').localeCompare(y.executedAt ?? ''))
    for (const m of given) m.scan = { mode: 'scanned' }
    const todays = given.filter((m) => m.executedAt?.startsWith(T) && inWard0.has(m.admissionId))
    if (todays[1]) todays[1].scan = { mode: 'skipped', reason: 'scanner', note: '掃描器沒電，充電中' }
    if (todays[4]) todays[4].scan = { mode: 'skipped', reason: 'wristband', note: '腕帶弄濕讀不到，已請櫃台重印' }
  }

  // 死亡出院（示範，不抽亂數）：肺癌末期、家屬簽 DNR（預期死亡），9 小時前宣告死亡 → 遺體護理、死亡證明書（已印一次）→ 送太平間；
  // 帳單還沒結，等家屬到櫃台（住院結帳清單「死亡出院」）。病人挑沒住過院、之後沒有掛號的（死亡後不能掛號）裡最年長的
  {
    const busy = new Set([...admissions.map((a) => a.patientId), ...visits.filter((v) => v.date >= T).map((v) => v.patientId)])
    const pt = (() => { const free = patients.filter((p) => !busy.has(p.id)).sort((x, y) => x.birthDate.localeCompare(y.birthDate)); return free.find((p) => p.defaultIdentity !== '01') ?? free[0] })() // 健保一般身分的留給其他示範與測試（急診檢傷要三位） // 最年長的
    const bed = beds.find((b) => b.ward === codes.wards[0] && b.status !== 'occupied')
    if (pt && bed) {
      const doc = users.find((u) => u.doctorId === 'DR03')!.id
      const adAt = `${addDays(T, -5)} 10:30`
      const died = addMinutes(nowStr, -9 * 60)
      const m = (k: number) => addMinutes(died, k)
      const id = 'A-DEATH-1'
      const causes = ['呼吸衰竭', '肺癌末期併肺轉移']
      dnrRecords.push({ id: 'DNR-DEATH-1', patientId: pt.id, doc: 'family', signedAt: addDays(T, -4), signerName: '林志明', relation: '成年子女', doctorIds: ['DR03', 'DR02'], withhold: ['compress', 'intubation', 'defib', 'drugs', 'ventilation'], nhiCard: true, recordedBy: doc, recordedAt: `${addDays(T, -4)} 15:00` })
      ipdOrders.push(
        { id: 'IO-DEATH-1', admissionId: id, type: 'long', category: 'nursing', content: 'Vital signs Q8H；呼吸困難時抬高床頭、給氧', startAt: adAt, stopAt: died, status: 'stopped', doctorId: 'DR03', createdAt: adAt, ackAt: addMinutes(adAt, 10), ackBy: 'U201', stopAckAt: m(5), stopAckBy: 'U201' },
      )
      vitals.push({ id: 'VS-DEATH-1', admissionId: id, at: addMinutes(died, -6 * 60), temp: 37.4, pulse: 118, resp: 28, sbp: 92, dbp: 58, spo2: 86, o2: 6, avpu: 'V', pain: 3, nurseId: 'U202' })
      const roc = Number(T.slice(0, 4)) - 1911
      admissions.push({
        id, admitNo: `I${adAt.slice(2, 10).replace(/-/g, '')}${String(next('admitNo')).padStart(3, '0')}`, patientId: pt.id, deptId: 'D02', doctorId: 'DR03',
        bedId: bed.id, bedHistory: [{ bedId: bed.id, from: adAt }], preferBedClass: '健保床', reason: '呼吸困難加劇', diagnosis: 'C34.90 肺癌末期',
        status: 'discharged', reservedAt: `${addDays(T, -6)} 16:00`, expectedDate: addDays(T, -5), admittedAt: adAt, dischargedAt: m(110), dischargeType: '死亡',
        wristband: { printedAt: adAt, printedBy: 'U201', reprints: [] },
        dischargeSummary: { diagnosis: `${causes[0]}（原始死因：${causes[1]}）`, course: '肺癌末期，入院後呼吸困難逐漸加重；家屬簽署 DNR，給予氧氣與症狀緩解，家屬陪伴下心跳停止。', condition: `${died} 宣告死亡（病死或自然死）`, followUp: '', dischargeType: '死亡', doctorId: 'DR03', writtenAt: m(15), signedAt: m(15) },
        death: {
          declaredAt: died, declaredBy: doc, expected: true, causes, manner: 'natural', course: '肺癌末期，入院後呼吸困難逐漸加重；家屬簽署 DNR，給予氧氣與症狀緩解，家屬陪伴下心跳停止。',
          care: { items: ['lines', 'clean', 'family', 'valuables', 'tag'], valuables: '手機、眼鏡、現金 860 元，交長子林志明', by: 'U201', at: m(50) },
          cert: { no: `${roc} 死字第 ${String(next(`death:${roc}`)).padStart(6, '0')} 號`, copies: 3, issuedAt: m(70), by: doc, printed: [{ at: m(75), by: 'U201' }] },
          morgueAt: m(110), morgueBy: 'U201',
        },
      })
      pt.deceasedAt = died
    }
  }

  // 安寧（示範，不抽亂數）：
  //   - 大腸癌末期住院 10 天（家屬簽 DNR），9 天前 dr01 收案；最近一次訪視 6 天半前（疼痛 6、呼吸困難 5）→ 每週訪視快到期；
  //     30 分鐘前 NEWS2 很高，但安寧收案不自動呼叫快速反應小組
  //   - 敗血症（加護病房、部分 DNR）：主治 2 小時前提出安寧照會，待收案
  {
    const busy = new Set([...admissions.map((x) => x.patientId), ...visits.filter((v) => v.date >= T).map((v) => v.patientId)])
    const pt = (() => { const free = patients.filter((p) => !busy.has(p.id)).sort((x, y) => x.birthDate.localeCompare(y.birthDate)); const adult = free.filter((p) => ageOf(p.birthDate, T) >= 18); return adult.find((p) => p.defaultIdentity !== '01') ?? adult[0] })() // 健保一般身分的留給其他示範與測試（急診檢傷要三位）；要成人（當天的掛號不同，空閒的非一般身分可能只剩幼兒）
    const used = new Set(admissions.flatMap((x) => (x.bedHistory ?? []).map((h) => h.bedId)))
    const bed = beds.find((b) => b.ward === codes.wards[0] && b.status === 'empty' && !used.has(b.id))
    const dr01 = users.find((u) => u.doctorId === 'DR01')!.id
    const dr02 = users.find((u) => u.doctorId === 'DR02')!.id
    if (pt && bed) {
      const id = 'A-PAL-1'
      const adAt = addMinutes(nowStr, -10 * 24 * 60)
      const d = (h: number) => addMinutes(nowStr, -h * 60)
      Object.assign(bed, { status: 'occupied', admissionId: id })
      admissions.push({
        id, admitNo: `I${adAt.slice(2, 10).replace(/-/g, '')}${String(next('admitNo')).padStart(3, '0')}`, patientId: pt.id, deptId: 'D02', doctorId: 'DR02',
        bedId: bed.id, bedHistory: [{ bedId: bed.id, from: adAt }], preferBedClass: '健保床', reason: '腹痛、進食差、喘', diagnosis: 'C18.9 大腸癌末期併肝、肺轉移',
        status: 'admitted', reservedAt: addMinutes(adAt, -20 * 60), expectedDate: adAt.slice(0, 10), admittedAt: adAt,
        wristband: { printedAt: adAt, printedBy: 'U201', reprints: [] },
      })
      ipdOrders.push(
        { id: 'IO-PAL-1', admissionId: id, type: 'long', category: 'diet', diet: { kind: 'soft' }, content: '軟質飲食', startAt: adAt, status: 'active', doctorId: 'DR02', createdAt: adAt, ackAt: addMinutes(adAt, 10), ackBy: 'U201' },
        { id: 'IO-PAL-2', admissionId: id, type: 'long', category: 'nursing', content: 'Vital signs Q8H；呼吸困難時抬高床頭、給氧；以舒適為主', startAt: adAt, status: 'active', doctorId: 'DR02', createdAt: adAt, ackAt: addMinutes(adAt, 10), ackBy: 'U201' },
      )
      // 分床：5A 已經分好的每一班，都分給那一班的第一位護理師
      const shifts = new Map(nurseAssignments.filter((x) => x.ward === bed.ward).map((x) => [`${x.date}|${x.shift}`, x]))
      for (const x of shifts.values()) nurseAssignments.push({ ...x, id: `NAS-PAL-${x.date}-${x.shift}`, admissionId: id })
      for (const [scale, answers] of [['fall', { history: 0, secondary: 15, aid: 0, iv: 0, gait: 10, mental: 0 }], ['pressure', { sensory: 3, moisture: 3, activity: 2, mobility: 2, nutrition: 2, friction: 2 }]] as const) {
        const score = riskScore(scale, answers).score
        riskAssessments.push({ id: `RA-PAL-${scale}`, admissionId: id, scale, at: d(20), nurseId: 'U201', answers, score, level: riskLevel(scale, score), reason: 'routine' })
      }
      dnrRecords.push({ id: 'DNR-PAL-1', patientId: pt.id, doc: 'family', signedAt: d(5 * 24).slice(0, 10), signerName: '陳美玲', relation: '配偶', doctorIds: ['DR02', 'DR01'], withhold: ['compress', 'intubation', 'defib', 'ventilation'], nhiCard: true, recordedBy: dr02, recordedAt: d(5 * 24) })
      vitals.push(
        { id: 'VS-PAL-1', admissionId: id, at: d(8), temp: 37.6, pulse: 104, resp: 22, sbp: 104, dbp: 64, spo2: 93, o2: 2, avpu: 'A', pain: 5, painAction: '嗎啡口服液 5 mg', nurseId: 'U202' },
        { id: 'VS-PAL-2', admissionId: id, at: d(0.5), temp: 37.8, pulse: 112, resp: 26, sbp: 98, dbp: 60, spo2: 90, o2: 3, avpu: 'A', pain: 3, nurseId: 'U201' },
      )
      const v1 = addMinutes(d(9 * 24), 120)
      const v2 = d(6.5 * 24)
      const fee = (no: number, at: string) => ({ id: `IO-PAL-FEE-${no}`, admissionId: id, type: 'stat' as const, category: 'procedure' as const, procId: 'P056', content: '安寧共同照護費', startAt: at, stopAt: at, status: 'done' as const, doctorId: 'DR01', createdAt: at, ackAt: at, ackBy: dr01 })
      ipdOrders.push(fee(1, v1), fee(2, v2))
      palliativeCases.push({
        id: 'PAL-SEED-1', admissionId: id, status: 'enrolled', requestedBy: dr02, requestedAt: d(9.5 * 24), reason: '大腸癌末期併肝、肺轉移，不再化療；疼痛與呼吸困難，家屬希望以舒適為主',
        decidedBy: dr01, decidedAt: d(9 * 24), terminal: { disease: '癌症', doctorIds: ['DR02', 'DR01'], note: '多處轉移，體能狀態 ECOG 4' }, goals: '控制疼痛與呼吸困難，讓病人在家屬陪伴下舒適；評估返家安寧',
        visits: [
          { id: 'PV-SEED-1', at: v1, by: dr01, symptoms: { pain: 7, dyspnea: 6, nausea: 3, anxiety: 5, delirium: 0 }, note: '疼痛 7：嗎啡口服液 5 mg Q4H、突發痛加 2.5 mg；呼吸困難：床頭抬高、電風扇、低劑量嗎啡', spiritual: '病人擔心拖累家人', social: '配偶照顧，兒子在外地工作', orderId: 'IO-PAL-FEE-1' },
          { id: 'PV-SEED-2', at: v2, by: dr01, symptoms: { pain: 6, dyspnea: 5, nausea: 2, anxiety: 4, delirium: 0 }, note: '疼痛稍改善；噁心減少；家屬會議後焦慮下降', orderId: 'IO-PAL-FEE-2' },
        ],
        meetings: [{ id: 'FM-SEED-1', date: d(5 * 24).slice(0, 10), participants: '病人、配偶、長子、主治陳映如、安寧醫師林子謙、社工', conclusion: '家屬同意以舒適照護為主、簽署 DNR；症狀穩定後評估返家安寧', by: dr01, at: d(5 * 24) }],
      })
    }
    const sep = admissions.find((x) => x.status === 'admitted' && x.diagnosis.startsWith('A41'))
    if (sep) palliativeCases.push({ id: 'PAL-SEED-2', admissionId: sep.id, status: 'requested', requestedBy: dr02, requestedAt: addMinutes(nowStr, -120), reason: '敗血性休克插管、升壓劑中，家屬已簽部分 DNR，詢問安寧與撤除維生醫療', visits: [], meetings: [] })
  }

  // 非預期死亡（示範，不抽亂數）：急性心肌梗塞入院 28 小時心室顫動，急救 25 分鐘無效 → 宣告死亡（急救後、入院 48 小時內、沒有 DNR）；
  // 已送太平間、帳單待家屬結；死亡病例待 dr02 審查。急救藥有開醫囑（已執行），種子沒有扣帳異動（展示用）
  {
    const busy = new Set([...admissions.map((x) => x.patientId), ...visits.filter((v) => v.date >= T).map((v) => v.patientId)])
    // 要成人（當天的掛號不同，空閒的非一般身分可能只剩幼兒）
    const free = patients.filter((p) => !busy.has(p.id) && !p.deceasedAt && ageOf(p.birthDate, T) >= 18).sort((x, y) => x.birthDate.localeCompare(y.birthDate))
    const pt = free.find((p) => p.defaultIdentity !== '01') ?? free[0]
    const used = new Set(admissions.flatMap((x) => (x.bedHistory ?? []).map((h) => h.bedId)))
    const bed = beds.find((b) => b.ward === codes.wards[0] && b.status === 'empty' && !used.has(b.id)) ?? beds.find((b) => b.ward === codes.wards[1] && b.status === 'empty' && !used.has(b.id))
    if (pt && bed) {
      const dr03 = users.find((u) => u.doctorId === 'DR03')!.id
      const id = 'A-DEATH-2'
      const adAt = addMinutes(nowStr, -40 * 60)
      const cs = addMinutes(nowStr, -(12 * 60 + 25))
      const m = (k: number) => addMinutes(cs, k)
      const died = m(25)
      const order = (no: number, at: string, x: Partial<IpdOrder> & Pick<IpdOrder, 'category' | 'content'>): IpdOrder => ({ id: `IO-CB2-${no}`, admissionId: id, type: 'stat', startAt: at, stopAt: at, status: 'done', doctorId: 'DR03', createdAt: at, ackAt: at, ackBy: 'U202', codeBlueId: 'CB-SEED-2', ...x })
      ipdOrders.push(
        { id: 'IO-DEATH2-1', admissionId: id, type: 'long', category: 'nursing', content: '心電圖監視、Vital signs Q4H', startAt: adAt, stopAt: died, status: 'stopped', doctorId: 'DR03', createdAt: adAt, ackAt: addMinutes(adAt, 10), ackBy: 'U201', stopAckAt: addMinutes(died, 5), stopAckBy: 'U202' },
        order(1, m(4), { category: 'medication', drugId: 'M046', content: 'Epinephrine 1mg/ml Inj 1 mg IV（急救）', dose: 1, freq: 'STAT', route: 'IV' }),
        order(2, m(7), { category: 'medication', drugId: 'M047', content: 'Amiodarone 150mg/3ml Inj 300 mg IV（急救）', dose: 2, freq: 'STAT', route: 'IV' }),
        order(3, m(9), { category: 'medication', drugId: 'M046', content: 'Epinephrine 1mg/ml Inj 1 mg IV（急救）', dose: 1, freq: 'STAT', route: 'IV' }),
        order(4, m(14), { category: 'medication', drugId: 'M046', content: 'Epinephrine 1mg/ml Inj 1 mg IV（急救）', dose: 1, freq: 'STAT', route: 'IV' }),
        order(5, died, { category: 'procedure', procId: 'P054', content: '心肺復甦術 CPR（急救）' }),
      )
      codeBlues.push({
        id: 'CB-SEED-2', admissionId: id, startedAt: cs, startedBy: 'U202', leaderId: dr03, status: 'ended', endedAt: died, endedBy: dr03, outcome: 'death',
        events: [
          { id: 'CE2-1', at: cs, kind: 'cpr', by: 'U202' },
          { id: 'CE2-2', at: m(1), kind: 'rhythm', rhythm: 'vf', by: 'U202' },
          { id: 'CE2-3', at: m(2), kind: 'shock', joules: 200, by: dr03 },
          { id: 'CE2-4', at: m(4), kind: 'epi', doseMg: 1, orderId: 'IO-CB2-1', by: 'U202' },
          { id: 'CE2-5', at: m(5), kind: 'shock', joules: 200, by: dr03 },
          { id: 'CE2-6', at: m(7), kind: 'amio', doseMg: 300, orderId: 'IO-CB2-2', by: 'U202' },
          { id: 'CE2-7', at: m(8), kind: 'intubate', by: dr03 },
          { id: 'CE2-8', at: m(9), kind: 'epi', doseMg: 1, orderId: 'IO-CB2-3', by: 'U202' },
          { id: 'CE2-9', at: m(12), kind: 'rhythm', rhythm: 'asystole', by: 'U202' },
          { id: 'CE2-10', at: m(14), kind: 'epi', doseMg: 1, orderId: 'IO-CB2-4', by: 'U202' },
        ],
      })
      const roc = Number(T.slice(0, 4)) - 1911
      const causes = ['心室顫動', '急性心肌梗塞']
      const course = '急性下壁心肌梗塞入院，心導管排程中；入院 28 小時突發心室顫動，急救 25 分鐘無效。'
      admissions.push({
        id, admitNo: `I${adAt.slice(2, 10).replace(/-/g, '')}${String(next('admitNo')).padStart(3, '0')}`, patientId: pt.id, deptId: 'D02', doctorId: 'DR03',
        bedId: bed.id, bedHistory: [{ bedId: bed.id, from: adAt }], preferBedClass: '健保床', reason: '胸痛、心電圖 ST 上升', diagnosis: 'I21.9 急性心肌梗塞',
        status: 'discharged', reservedAt: addMinutes(adAt, -60), expectedDate: adAt.slice(0, 10), admittedAt: adAt, dischargedAt: addMinutes(died, 120), dischargeType: '死亡',
        wristband: { printedAt: adAt, printedBy: 'U201', reprints: [] },
        dischargeSummary: { diagnosis: `${causes[0]}（原始死因：${causes[1]}）`, course, condition: `${died} 宣告死亡（病死或自然死）`, followUp: '', dischargeType: '死亡', doctorId: 'DR03', writtenAt: addMinutes(died, 10), signedAt: addMinutes(died, 10) },
        death: {
          declaredAt: died, declaredBy: dr03, codeBlueId: 'CB-SEED-2', expected: false, causes, manner: 'natural', course,
          care: { items: ['lines', 'clean', 'family', 'valuables', 'tag'], valuables: '手錶、手機，交妻子', by: 'U202', at: addMinutes(died, 60) },
          cert: { no: `${roc} 死字第 ${String(next(`death:${roc}`)).padStart(6, '0')} 號`, copies: 3, issuedAt: addMinutes(died, 80), by: dr03, printed: [{ at: addMinutes(died, 85), by: 'U202' }] },
          morgueAt: addMinutes(died, 120), morgueBy: 'U202',
        },
      })
      pt.deceasedAt = died
    }
  }

  // 隔離連動（示範，不抽亂數）：
  //   - 肺炎（疑似肺結核、空氣隔離）：主治開了抗酸菌塗片三套＋N95 護理醫囑；兩套陰性、第三套還沒採檢 → 還不能解除
  //   - 蜂窩性組織炎（MRSA、接觸隔離）：開了培養＋手套隔離衣；一套無菌生長 → 還要一套
  {
    const procMap = new Map(codes.procedures.map((p) => [p.id, p]))
    const later = (x: string, y: string) => (x > y ? x : y)
    let k = 0
    const report = (a: Admission, o: IpdOrder, procId: string, at: string, input: Record<string, string>, culture?: LabReport['culture']) => {
      const pt = patients.find((x) => x.id === a.patientId)!
      labReports.push({ id: `LR-ISO-${++k}`, no: `L${at.slice(0, 10).replace(/-/g, '')}${9700 + k}`, patientId: a.patientId, procId, orderId: o.id, admissionId: a.id, doctorId: o.doctorId, orderedAt: o.createdAt, values: buildLabValues(procMap.get(procId)!.labItems!, input, pt.gender).values, ...(culture ? { culture } : {}), reportedBy: 'U601', reportedAt: at })
    }
    const pn = admissions.find((x) => x.status === 'admitted' && x.diagnosis.startsWith('J18'))
    const pnIso = pn && isolations.find((i) => i.patientId === pn.patientId && i.kind === 'airborne' && !i.ended)
    if (pn && pnIso) {
      const ordAt = addMinutes(pnIso.startedAt, 30)
      const mk = (n: number, done?: string): IpdOrder => ({ id: `IO-AFB-${n}`, admissionId: pn.id, type: 'stat', category: 'procedure', procId: 'P057', content: `痰液抗酸菌塗片 AFB（第 ${n} 套）`, startAt: ordAt, ...(done ? { stopAt: done, status: 'done' as const } : { status: 'active' as const }), doctorId: pn.doctorId, createdAt: ordAt, ackAt: addMinutes(ordAt, 10), ackBy: 'U201', isolationId: pnIso.id, isoKey: 'afb' })
      // 依隔離開始的時間往後排（不寫死日期）：採檢後 3 小時出報告，兩套間隔 8 小時
      const c1 = addMinutes(ordAt, 30)
      const c2 = addMinutes(c1, 8 * 60)
      const o1 = mk(1, c1 < nowStr ? c1 : undefined)
      const o2 = mk(2, c2 < nowStr ? c2 : undefined)
      ipdOrders.push(o1, o2, mk(3))
      ipdOrders.push({ id: 'IO-AFB-N95', admissionId: pn.id, type: 'long', category: 'nursing', content: '空氣隔離：進出戴 N95 口罩；負壓室門保持關閉；病人離開病室戴外科口罩', startAt: ordAt, status: 'active', doctorId: pn.doctorId, createdAt: ordAt, ackAt: addMinutes(ordAt, 10), ackBy: 'U201', isolationId: pnIso.id, isoKey: 'n95' })
      if (addMinutes(c1, 180) < nowStr) report(pn, o1, 'P057', addMinutes(c1, 180), { AFB: '陰性' })
      if (addMinutes(c2, 180) < nowStr) report(pn, o2, 'P057', addMinutes(c2, 180), { AFB: '陰性' })
    }
    const cell = admissions.find((x) => x.status === 'admitted' && x.diagnosis.startsWith('L03'))
    const cellIso = cell && isolations.find((i) => i.patientId === cell.patientId && i.kind === 'contact' && !i.ended)
    if (cell && cellIso) {
      const ordAt = addMinutes(cellIso.startedAt, 20)
      const done = addMinutes(ordAt, 60)
      const o: IpdOrder = { id: 'IO-CULT-1', admissionId: cell.id, type: 'stat', category: 'procedure', procId: 'P059', content: '細菌培養（傷口、尿液）', startAt: ordAt, stopAt: done, status: 'done', doctorId: cell.doctorId, createdAt: ordAt, ackAt: addMinutes(ordAt, 10), ackBy: 'U201', isolationId: cellIso.id, isoKey: 'culture' }
      ipdOrders.push(o, { id: 'IO-CULT-GOWN', admissionId: cell.id, type: 'long', category: 'nursing', content: '接觸隔離：接觸病人與環境戴手套、穿隔離衣；聽診器、血壓計專用；出病室前脫除並洗手', startAt: ordAt, status: 'active', doctorId: cell.doctorId, createdAt: ordAt, ackAt: addMinutes(ordAt, 10), ackBy: 'U201', isolationId: cellIso.id, isoKey: 'gown' })
      if (addMinutes(done, 18 * 60) < nowStr) report(cell, o, 'P059', addMinutes(done, 18 * 60), { CULT: '無菌生長' }, { specimen: 'wound', isolates: [] })
      // 入院時的傷口培養（開接觸隔離的依據）：MRSA，Oxacillin 抗藥、Vancomycin 敏感
      const o0At = later(addMinutes(cell.admittedAt!, 30), addMinutes(cellIso.startedAt, -24 * 60))
      const o0: IpdOrder = { id: 'IO-CULT-0', admissionId: cell.id, type: 'stat', category: 'procedure', procId: 'P059', content: '細菌培養（傷口、尿液）', startAt: o0At, stopAt: addMinutes(o0At, 30), status: 'done', doctorId: cell.doctorId, createdAt: o0At, ackAt: addMinutes(o0At, 5), ackBy: 'U201' }
      ipdOrders.push(o0)
      report(cell, o0, 'P059', addMinutes(cellIso.startedAt, -10), { CULT: 'MRSA' }, { specimen: 'wound', isolates: [{ organism: 'MRSA', ast: { OXA: 'R', CEX: 'R', AMC: 'R', VAN: 'S' } }] })
    }
    // 腦梗塞病人導尿管的尿液培養（院內感染那例）：E. coli，Amoxicillin/Clavulanate 抗藥、Ceftriaxone 敏感
    const st = admissions.find((x) => x.status === 'admitted' && x.diagnosis.startsWith('I63'))
    if (st) {
      const oAt = later(`${addDays(T, -1)} 10:00`, addMinutes(st.admittedAt!, 60))
      if (oAt < addMinutes(nowStr, -60)) {
        const o: IpdOrder = { id: 'IO-CULT-ST', admissionId: st.id, type: 'stat', category: 'procedure', procId: 'P059', content: '細菌培養（傷口、尿液）', startAt: oAt, stopAt: addMinutes(oAt, 20), status: 'done', doctorId: st.doctorId, createdAt: oAt, ackAt: addMinutes(oAt, 5), ackBy: 'U202' }
        ipdOrders.push(o)
        report(st, o, 'P059', [addMinutes(oAt, 18 * 60), addMinutes(nowStr, -30)].sort()[0], { CULT: '其他細菌' }, { specimen: 'urine', isolates: [{ organism: 'ECO', ast: { AMP: 'R', AMC: 'R', CEX: 'S', CRO: 'S', TZP: 'S', MEM: 'S' } }] })
      }
    }
  }

  // 群聚（示範，不抽亂數）：5A 安寧收案的大腸癌病人導尿管（已移除）三天前也發生 E. coli 泌尿道感染，dr11 已判定成立；
  // 加上腦梗塞那例（待判定）＝ 5A 14 天內兩例同菌種 → 疑似群聚待確認
  {
    const ap = admissions.find((x) => x.id === 'A-PAL-1')
    const dr11 = users.find((u) => u.doctorId === 'DR11')!.id
    if (ap?.admittedAt) {
      const ins = addMinutes(ap.admittedAt, 60)
      const onset = [addDays(ap.admittedAt.slice(0, 10), 3), addDays(T, -3)].sort().pop()!
      if (onset < T) {
        lines.push({ id: 'LN-SEED-PALFOLEY', admissionId: ap.id, kind: 'foley', site: '尿道', size: '14Fr', insertedAt: ins, placedBy: '孫佩君', recordedBy: 'U201', recordedAt: ins, removedAt: `${onset} 10:00`, removedBy: 'U202', removeReason: '感染：移除' })
        infectionCases.push({ id: 'INF-SEED-2', admissionId: ap.id, kind: 'cauti', lineId: 'LN-SEED-PALFOLEY', onsetAt: onset, symptoms: '發燒 38.4°C、尿液混濁、恥骨上不適', culture: 'E. coli ≥10⁵ CFU/ml（尿液）', reportedBy: 'U202', reportedAt: `${onset} 09:30`, status: 'confirmed', decision: { by: dr11, at: `${onset} 15:00`, reason: '導尿管放置第 3 天以上、尿液培養 ≥10⁵、有發燒：成立' } })
      }
    }
  }

  // 負壓壓差紀錄（示範，不抽亂數）：過去兩天每班一筆（班開始後 30 分鐘）；705 都正常；ICU9 這一班 −1.8（負壓不足、已通知工務）
  {
    const shiftStarts = ['00:00', '08:00', '16:00']
    let k = 0
    for (const b of beds.filter((x) => x.negativePressure)) {
      for (let day = -2; day <= 0; day++) {
        for (const [si, hh] of shiftStarts.entries()) {
          const at = addMinutes(`${addDays(T, day)} ${hh}`, 30)
          if (at > nowStr) continue
          const nextStart = si < 2 ? `${addDays(T, day)} ${shiftStarts[si + 1]}` : `${addDays(T, day + 1)} 00:00`
          const current = nextStart > nowStr
          const bad = b.id === 'BICU9' && current
          pressureLogs.push({ id: `NP-SEED-${++k}`, bedId: b.id, at, pa: bad ? -1.8 : b.id === 'BICU9' ? -9.5 : -11 + (k % 3), by: b.id === 'BICU9' ? 'U213' : 'U205', ...(bad ? { note: '前室門關不緊，已通知工務維修' } : {}) })
        }
      }
    }
  }

  // 抗生素管理介入（示範，不抽亂數）：蜂窩性組織炎的 MRSA 對 Ceftriaxone 天生抗藥，感染科兩小時前發出建議「停用、單用 Vancomycin」，等主治回覆
  const abxInterventions: AbxIntervention[] = []
  {
    const cell = admissions.find((x) => x.status === 'admitted' && x.diagnosis.startsWith('L03'))
    const cro = cell && ipdOrders.find((o) => o.admissionId === cell.id && o.drugId === 'M036' && o.status === 'active')
    if (cell && cro) {
      abxInterventions.push({
        id: 'ABXI-SEED-1', admissionId: cell.id, orderId: cro.id, drugId: 'M036', kind: 'ineffective', finding: '抗藥性金黃色葡萄球菌 MRSA 對 Ceftriaxone 抗藥；藥敏敏感：Vancomycin',
        status: 'sent', by: users.find((u) => u.doctorId === 'DR11')!.id, at: addMinutes(nowStr, -120), note: 'MRSA 對 Ceftriaxone 無效，已有 Vancomycin：建議停用 Ceftriaxone',
      })
    }
  }

  // 已出院的肺炎（最近 30 天內出院、住 4 天以上的那一位）：Ceftriaxone 靜脈注射滿 72 小時，感染科建議改口服，
  // 主治隔天早上停 Ceftriaxone、改 Augmentin 口服＝接受（抗生素指標的接受率、用量有歷史資料）
  {
    const dr11 = users.find((u) => u.doctorId === 'DR11')!.id
    const pn = admissions.find((a) => a.status === 'discharged' && a.diagnosis.startsWith('J18') && a.dischargedAt! >= `${addDays(T, -28)} 00:00` && a.dischargedAt! > addMinutes(a.admittedAt!, 4 * 24 * 60))
    if (pn) {
      const start = addMinutes(pn.admittedAt!, 60)
      const sentAt = addMinutes(start, 73 * 60)
      const stopAt = addMinutes(sentAt, 17 * 60) < addMinutes(pn.dischargedAt!, -120) ? addMinutes(sentAt, 17 * 60) : addMinutes(pn.dischargedAt!, -120)
      const doc = doctorUser(pn.doctorId)
      const give = (o: IpdOrder, from: string, to: string) => {
        const fq = codes.frequencies.find((x) => x.code === o.freq)!
        for (let day = from.slice(0, 10); day <= to.slice(0, 10); day = addDays(day, 1)) {
          for (const tm of marTimes(fq.code, fq.times, o.timing, o.route)) {
            const at = `${day} ${tm}`
            if (at >= from && at < to) mar.push({ id: id('MAR'), orderId: o.id, admissionId: pn.id, scheduledAt: at, status: 'given', executedAt: at, nurseId: 'U201', scan: { mode: 'scanned' } })
          }
        }
      }
      const cro: IpdOrder = { id: 'IO-HX-ABX-1', admissionId: pn.id, type: 'long', category: 'medication', drugId: 'M036', content: drugMap.get('M036')!.name, dose: 1, freq: 'Q12H', route: 'IV', startAt: start, stopAt, status: 'stopped', doctorId: pn.doctorId, createdAt: start, ackAt: addMinutes(start, 10), ackBy: 'U201', stopAckAt: addMinutes(stopAt, 10), stopAckBy: 'U201' }
      const augD = drugMap.get('M004')!
      const augAt = addMinutes(stopAt, 30)
      const aug: IpdOrder = { id: 'IO-HX-ABX-2', admissionId: pn.id, type: 'long', category: 'medication', drugId: 'M004', content: augD.name, dose: 1, freq: 'BID', route: 'PO', timing: effectiveTiming(augD.timing, undefined), startAt: augAt, stopAt: pn.dischargedAt, status: 'stopped', doctorId: pn.doctorId, createdAt: augAt, ackAt: addMinutes(augAt, 10), ackBy: 'U201', stopAckAt: pn.dischargedAt, stopAckBy: 'U201' }
      ipdOrders.push(cro, aug)
      give(cro, start, stopAt)
      give(aug, augAt, pn.dischargedAt!)
      abxInterventions.push({
        id: 'ABXI-SEED-HX1', admissionId: pn.id, orderId: cro.id, drugId: 'M036', kind: 'ivpo', finding: '靜脈注射已 3 天、可以進食：評估改口服 Amoxicillin/Clavulanate、Cephalexin',
        status: 'accepted', by: dr11, at: sentAt, note: '退燒 48 小時、可進食：建議改 Augmentin 625mg BID 口服', reply: { by: doc, at: stopAt, text: '停止醫囑' },
      })
    }
  }

  // Vancomycin 谷濃度（示範，不抽亂數）：蜂窩性組織炎的 Vancomycin 今天清晨第 4 劑前抽血、4 小時前報告 22（> 20 過高）→
  // 主治首頁「Vancomycin 谷濃度異常」、住院醫囑紅條，等主治改劑量
  {
    const cell = admissions.find((x) => x.status === 'admitted' && x.diagnosis.startsWith('L03'))
    const van = cell && ipdOrders.find((o) => o.admissionId === cell.id && o.drugId === 'M042' && o.status === 'active')
    if (cell && van) {
      const pt = patients.find((p) => p.id === cell.patientId)!
      const repAt = addMinutes(nowStr, -4 * 60)
      const ordAt = addMinutes(repAt, -150)
      const o: IpdOrder = { id: 'IO-TDM-1', admissionId: cell.id, type: 'stat', category: 'procedure', procId: 'P060', content: procMap.get('P060')!.name, startAt: ordAt, stopAt: addMinutes(ordAt, 30), status: 'done', doctorId: cell.doctorId, createdAt: ordAt, ackAt: addMinutes(ordAt, 5), ackBy: 'U201' }
      ipdOrders.push(o)
      labReports.push({ id: 'LR-TDM-1', no: `L${repAt.slice(0, 10).replace(/-/g, '')}9790`, patientId: pt.id, procId: 'P060', orderId: o.id, admissionId: cell.id, doctorId: cell.doctorId, orderedAt: ordAt, values: buildLabValues(procMap.get('P060')!.labItems!, { VANT: '22' }, pt.gender).values, reportedBy: 'U601', reportedAt: repAt })
    }
  }

  // 藥師住院醫囑審核（示範，不抽亂數）：功能上線前的醫囑沒有 pharm（視同已審）；今天新開的三筆——
  //   - 敗血症（CrCl 約 31）Famotidine 每日兩次：待審，系統列「腎功能：建議每日一次」
  //   - 骨折（已在吃 Celecoxib）加開 Ibuprofen：待審，系統列「同類重複（NSAIDs）」
  //   - 腦梗塞（已在吃 Aspirin）加開 Warfarin：藥師 3 小時前提出疑義，等主治回覆（回覆前暫停給藥）
  {
    const by = (dx: string) => admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith(dx))
    const ph = 'U301'
    const mk = (idx: number, a: Admission | undefined, drugId: string, freq: string, minsAgo: number, extra: Partial<IpdOrder> = {}) => {
      if (!a) return
      const d = drugMap.get(drugId)!
      const at = addMinutes(nowStr, -minsAgo)
      ipdOrders.push({
        id: `IO-PH-${idx}`, admissionId: a.id, type: 'long', category: 'medication', drugId, content: d.name, dose: 1, freq, route: d.defaultRoute,
        ...(timingApplies(freq, d.defaultRoute) ? { timing: effectiveTiming(d.timing, undefined) } : {}),
        startAt: at, status: 'active', doctorId: a.doctorId, createdAt: at, ackAt: addMinutes(at, 10), ackBy: 'U201', pharm: { status: 'pending', at }, ...extra,
      })
    }
    mk(1, by('A41'), 'M023', 'BID', 40)
    mk(2, by('S52'), 'M002', 'TID', 120)
    const st = by('I63')
    const qAt = addMinutes(nowStr, -180)
    mk(3, st, 'M021', 'QD', 300, { pharm: { status: 'query', at: addMinutes(nowStr, -300), queries: [{ by: ph, at: qAt, text: '病人已在使用 Aspirin，併用 Warfarin 出血風險大增；且無 INR 紀錄，請確認適應症與是否需併用' }] } })
  }

  // 藥物不良反應（示範，不抽亂數）：
  //   - 肺炎病人打 Ceftriaxone 後全身紅疹（中度），護理師 2 小時前通報、等藥師評估
  //   - 已出院的肺炎病人（11 月初那位）出院前一天吃 Augmentin 後起紅疹，藥師評估 Naranjo 6 分（很可能），加入 Penicillin 過敏
  const adrReports: AdrReport[] = []
  {
    const pn = admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('J18'))
    if (pn && ipdOrders.some((o) => o.admissionId === pn.id && o.drugId === 'M036')) {
      adrReports.push({ id: 'ADR-SEED-1', admissionId: pn.id, patientId: pn.patientId, drugId: 'M036', onsetAt: addMinutes(nowStr, -180), symptoms: '前胸、背部紅疹伴搔癢，無呼吸困難、血壓穩定', severity: 'moderate', action: '暫停下一劑 Ceftriaxone、給抗組織胺，已通知主治', reportedBy: 'U201', reportedAt: addMinutes(nowStr, -120) })
    }
    const hx = ipdOrders.find((o) => o.id === 'IO-HX-ABX-2')
    const hxa = hx && admissions.find((a) => a.id === hx.admissionId)
    if (hx && hxa) {
      const on = addMinutes(hx.startAt, 20 * 60)
      const pt = patients.find((p) => p.id === hxa.patientId)!
      adrReports.push({
        id: 'ADR-SEED-2', admissionId: hxa.id, patientId: hxa.patientId, drugId: 'M004', onsetAt: on, symptoms: '四肢蕁麻疹、搔癢', severity: 'mild', action: '停用 Augmentin、給抗組織胺', reportedBy: 'U201', reportedAt: addMinutes(on, 30),
        assessment: { by: 'U301', at: addMinutes(on, 5 * 60), answers: ['unknown', 'yes', 'yes', 'unknown', 'no', 'unknown', 'unknown', 'unknown', 'unknown', 'yes'], score: 6, causality: 'probable', note: '給藥後 20 小時出現、停藥後改善，無其他可解釋原因', allergyAdded: 'Penicillin' },
      })
      if (!pt.allergies.includes('Penicillin')) pt.allergies.push('Penicillin')
    }
  }

  // 入院用藥整合（示範，不抽亂數）：
  //   - 糖尿病病人：護理師入院 1 小時建了清單（門診 Metformin、Glimepiride，院外銀杏），主治還沒決定 → 用藥整合待決定
  //   - 腦梗塞病人：已完成，其中門診的 Losartan 暫停（急性中風容許較高血壓；住院續用的是 Amlodipine）
  //   - 其他住院中的病人：入院時已依門診處方整合完成（同一個藥有住院醫囑＝續用，沒有＝暫停）；首頁不會整排逾時
  {
    const docUser = (doctorId: string) => users.find((u) => u.doctorId === doctorId)!.id
    let k = 0
    const hm = (x: Omit<HomeMed, 'id'>): HomeMed => ({ id: `HM-SEED-${++k}`, ...x })
    for (const a of admissions.filter((x) => x.status === 'admitted' && x.admittedAt && !x.obs)) {
      const builtAt = notFuture(addMinutes(a.admittedAt!, 60), 30)
      const decidedAt = notFuture(addMinutes(a.admittedAt!, 5 * 60), 20)
      if (a.diagnosis.startsWith('E11')) {
        a.medRec = { builtBy: 'U201', builtAt, items: [
          hm({ drugId: 'M015', name: drugMap.get('M015')!.name, dose: 1, freq: 'BID', route: 'PO', source: 'opd', lastDate: addDays(T, -30) }),
          hm({ drugId: 'M016', name: drugMap.get('M016')!.name, dose: 1, freq: 'QD', route: 'PO', source: 'opd', lastDate: addDays(T, -30) }),
          hm({ name: '銀杏萃取物 40mg（院外，保健食品）', dose: 1, freq: 'BID', source: 'outside' }),
        ] }
        continue
      }
      const opd = homeMedsFromOpd(encounters.filter((e) => e.patientId === a.patientId), a.admittedAt!)
      const active = (drugId: string) => ipdOrders.find((o) => o.admissionId === a.id && o.drugId === drugId && o.status === 'active' && o.category === 'medication')
      const items = opd.map((m) => {
        const o = active(m.drugId)
        return hm({ drugId: m.drugId, name: drugMap.get(m.drugId)!.name, dose: m.dose, freq: m.freq, route: m.route, source: 'opd', lastDate: m.lastDate, decidedBy: docUser(a.doctorId), decidedAt, ...(o ? { decision: 'continue', orderId: o.id } : { decision: 'hold', reason: '住院期間暫停，出院時再評估' }) })
      })
      if (a.diagnosis.startsWith('I63') && !items.some((x) => x.drugId === 'M013')) {
        items.push(hm({ drugId: 'M013', name: drugMap.get('M013')!.name, dose: 1, freq: 'QD', route: 'PO', source: 'opd', lastDate: addDays(a.admittedAt!.slice(0, 10), -14), decidedBy: docUser(a.doctorId), decidedAt, decision: 'hold', reason: '急性腦梗塞，容許較高血壓，降壓藥暫停' }))
      }
      a.medRec = { builtBy: 'U201', builtAt, items, completedAt: items.length ? decidedAt : builtAt, completedBy: items.length ? docUser(a.doctorId) : 'U201' }
    }
  }

  // 出院用藥整合（示範，不抽亂數）：腦梗塞病人主治寫了出院病摘草稿，居家用藥大多決定了，Losartan 還沒決定恢復或停用 → 簽署會擋
  {
    const st = admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('I63'))
    if (st?.medRec && !st.dischargeSummary) {
      const plan: NonNullable<DischargeSummary['homeMedPlan']> = {}
      for (const x of st.medRec.items) if (x.drugId !== 'M013') plan[x.id] = x.decision === 'continue' ? { resume: true } : { resume: false, reason: x.reason ?? '住院期間已停用' }
      st.dischargeSummary = {
        diagnosis: st.diagnosis, course: '入院後給予抗血小板、復健；住院中導尿管相關泌尿道感染，依培養調整抗生素。', condition: '右側肢體肌力 4 分，可助行器行走', followUp: '兩週後神經內科門診、持續復健',
        dischargeType: '治癒出院', doctorId: st.doctorId, writtenAt: addMinutes(nowStr, -60), ...(Object.keys(plan).length ? { homeMedPlan: plan } : {}),
      }
    }
  }

  // 藥事照護紀錄（示範，不抽亂數）：敗血症建議監測腎功能（主治已接受）；骨折建議停用一種 NSAID（等主治回覆）
  const pharmCareNotes: PharmCareNote[] = []
  {
    const by = (dx: string) => admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith(dx))
    const sep = by('A41')
    const fr = by('S52')
    if (sep) {
      const at = notFuture(addMinutes(sep.admittedAt!, 8 * 60), 300)
      pharmCareNotes.push({ id: 'PC-SEED-1', admissionId: sep.id, patientId: sep.patientId, kind: 'monitor', text: '敗血性休克合併急性腎損傷（肌酸酐 2.1），抗生素依腎功能調整：建議每 48 小時追蹤肌酸酐，Meropenem 劑量隨 CrCl 調整', by: 'U301', at, status: 'accepted', reply: { by: users.find((u) => u.doctorId === sep.doctorId)!.id, at: addMinutes(at, 90), text: '已開每 48 小時肌酸酐' } })
    }
    if (fr) pharmCareNotes.push({ id: 'PC-SEED-2', admissionId: fr.id, patientId: fr.patientId, kind: 'deprescribe', text: '病人已有 Celecoxib，又加開 Ibuprofen：兩種 NSAID 併用增加腸胃出血與腎損傷風險，建議擇一（保留 Celecoxib）', by: 'U301', at: addMinutes(nowStr, -90), status: 'sent' })
  }

  // 住院檢體與條碼（示範，不抽亂數）：
  //   - 腦梗塞 CBC：90 分鐘前採檢，檢驗科還沒收件（逾時）
  //   - 敗血症電解質：2 小時前被退件（溶血），醫囑回到待採檢 → 護理站重新採檢
  //   - 骨折 CRP：20 分鐘前印了條碼，還沒採檢
  // 功能上線前已完成的檢驗醫囑沒有檢體，視同已收件
  const specimens: Specimen[] = []
  {
    const by = (dx: string) => admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith(dx))
    const day = T.replace(/-/g, '')
    let n = 0
    const sp = (a: Admission, tube: Specimen['tube'], orderId: string, x: Partial<Specimen>) =>
      specimens.push({ id: `SP-SEED-${++n}`, barcode: `S${day}${String(n).padStart(4, '0')}`, admissionId: a.id, patientId: a.patientId, tube, orderIds: [orderId], createdAt: x.printedAt!, ...x })
    const lab = (id: string, a: Admission, procId: string, at: string, done?: string): IpdOrder => {
      const o: IpdOrder = { id, admissionId: a.id, type: 'stat', category: 'procedure', procId, content: procMap.get(procId)!.name, startAt: at, status: done ? 'done' : 'active', ...(done ? { stopAt: done } : {}), doctorId: a.doctorId, createdAt: at, ackAt: addMinutes(at, 5), ackBy: 'U201' }
      ipdOrders.push(o)
      return o
    }
    const st = by('I63')
    if (st) {
      const c = addMinutes(nowStr, -90)
      const o = lab('IO-SP-1', st, 'P003', addMinutes(nowStr, -120), c)
      sp(st, 'purple', o.id, { printedAt: addMinutes(c, -10), printedBy: 'U202', collectedAt: c, collectedBy: 'U202' })
    }
    const sep = by('A41')
    if (sep) {
      const o = lab('IO-SP-2', sep, 'P055', addMinutes(nowStr, -180))
      sp(sep, 'red', o.id, { printedAt: addMinutes(nowStr, -160), printedBy: 'U213', collectedAt: addMinutes(nowStr, -150), collectedBy: 'U213', receivedAt: addMinutes(nowStr, -130), receivedBy: 'U601', rejected: { at: addMinutes(nowStr, -120), by: 'U601', reason: '溶血' } })
    }
    const fr = by('S52')
    if (fr) {
      const o = lab('IO-SP-3', fr, 'P011', addMinutes(nowStr, -40))
      sp(fr, 'red', o.id, { printedAt: addMinutes(nowStr, -20), printedBy: 'U201' })
    }
    counters[`specimen:${day}`] = n
  }

  // 長期檢驗（示範，不抽亂數）：糖尿病病人「飯前血糖 每日 06:00」，最近幾天每天一份報告（採檢、收件都記錄），今天 06:00 這一次待採檢
  {
    const dm = admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('E11'))
    if (dm) {
      const later = (a: string, b: string) => (a > b ? a : b)
      const start = later(`${addDays(T, -3)} 05:30`, addMinutes(dm.admittedAt!, 30))
      const pt = patients.find((p) => p.id === dm.patientId)!
      const parent: IpdOrder = { id: 'IO-LAB-L1', admissionId: dm.id, type: 'long', category: 'procedure', procId: 'P004', content: `${procMap.get('P004')!.name}（每日 06:00）`, labSchedule: { every: 'daily', time: '06:00' }, startAt: start, status: 'active', doctorId: dm.doctorId, createdAt: start, ackAt: addMinutes(start, 10), ackBy: 'U201' }
      ipdOrders.push(parent)
      const glu = ['168', '152', '139']
      let k = 0
      for (let d = start.slice(0, 10); d <= T; d = addDays(d, 1)) {
        const at = `${d} 06:00`
        if (at < start) continue
        const id = `IO-LAB-L1-${d.slice(5).replace('-', '')}`
        const past = d < T
        ipdOrders.push({ id, admissionId: dm.id, type: 'stat', category: 'procedure', procId: 'P004', content: `${procMap.get('P004')!.name}（每日 06:00）`, startAt: at, status: past ? 'done' : 'active', ...(past ? { stopAt: at } : {}), doctorId: dm.doctorId, createdAt: at, ackAt: at, ackBy: 'U201', parentOrderId: parent.id })
        if (!past) continue
        const day = d.replace(/-/g, '')
        specimens.push({ id: `SP-LAB-${++k}`, barcode: `S${day}9${String(k).padStart(3, '0')}`, admissionId: dm.id, patientId: dm.patientId, tube: 'red', orderIds: [id], createdAt: addMinutes(at, -20), printedAt: addMinutes(at, -20), printedBy: 'U201', collectedAt: at, collectedBy: 'U201', receivedAt: addMinutes(at, 25), receivedBy: 'U601' })
        const rep = addMinutes(at, 70)
        labReports.push({ id: `LR-LAB-${k}`, no: `L${day}96${String(k).padStart(2, '0')}`, patientId: dm.patientId, procId: 'P004', orderId: id, admissionId: dm.id, doctorId: dm.doctorId, orderedAt: at, values: buildLabValues(procMap.get('P004')!.labItems!, { 'GLU-AC': glu[(k - 1) % glu.length] }, pt.gender).values, reportedBy: 'U601', reportedAt: rep })
      }
    }
  }

  // 檢驗品管（示範，不抽亂數）：五個品管項目近 20 天每天 07:30 一次（z 值照固定的小波動），都通過；
  // 今天鉀兩個濃度都偏高超過 2SD（2-2s）→ 拒絕，鉀（電解質）報告擋住、待矯正重做
  const qcRuns: QcRun[] = []
  {
    const wave = [0.3, -0.6, 1.1, -0.2, 0.8, -1.3, 0.4, 0.1, -0.9, 1.4, -0.4, 0.6, -1.0, 0.2, 1.2, -0.7, 0.5, -0.1, 0.9, -0.5]
    let k = 0
    for (const a of QC_ANALYTES) {
      for (let i = 19; i >= 0; i--) {
        const date = addDays(T, -i)
        // 今天還不到 07:30 就記在 00:00（今天一定有一次：品管通過才能發報告、鉀的示範也在）
        const at = i === 0 && nowStr < `${T} 07:30` ? `${T} 00:00` : `${date} 07:30`
        const bad = a.code === 'K' && i === 0
        const z: [number, number] = bad ? [2.4, 2.25] : [wave[(i + k) % 20], wave[(i + k + 7) % 20] * 0.8]
        const values: [number, number] = [0, 1].map((l) => Math.round((a.levels[l].mean + z[l] * a.levels[l].sd) * 100) / 100) as [number, number]
        qcRuns.push({ id: `QC-SEED-${a.code}-${i}`, analyte: a.code, date, at, by: 'U601', values, z, result: bad ? 'reject' : Math.abs(z[0]) > 2 || Math.abs(z[1]) > 2 ? 'warn' : 'accept', rules: bad ? ['2-2s'] : [] })
      }
      k += 3
    }
  }

  // 影像檢查排程（示範，不抽亂數）：
  //   - 功能上線前就在等判讀的門診影像：補一筆「已完成」的檢查紀錄（開立後 30 分鐘做完），判讀清單照舊
  //   - 今天 X 光室：腦梗塞胸部 X 光 2 小時前做完（待判讀）、肺炎胸部 X 光已報到、蜂窩性組織炎胸部 X 光 1 小時後；
  //     闌尾炎腹部超音波還沒排（待排程）
  const imagingExams: ImagingExam[] = []
  const roomDowntimes: RoomDowntime[] = []
  {
    const room = (procId: string) => (procMap.get(procId)?.imaging?.room ?? 'XR') as ImagingExam['room']
    const mins = (procId: string) => procMap.get(procId)?.imaging?.minutes ?? 10
    let k = 0
    for (const e of encounters.filter((x) => x.status === 'completed')) {
      const v = visits.find((x) => x.id === e.visitId)
      if (!v || (v.status !== 'charged' && v.status !== 'dispensed')) continue
      for (const x of e.procedures) {
        if (!procMap.get(x.procId)?.imaging || x.notDone || imagingReports.some((r) => r.encounterId === e.id && r.procId === x.procId)) continue
        const at = addMinutes(e.completedAt ?? `${e.date} 09:00`, 30)
        imagingExams.push({ id: `EX-OLD-${++k}`, key: `E:${e.id}:${x.procId}`, patientId: e.patientId, procId: x.procId, room: room(x.procId), start: at, minutes: mins(x.procId), scheduledBy: 'U101', scheduledAt: at, arrivedAt: at, arrivedBy: 'U101', doneAt: addMinutes(at, mins(x.procId)), doneBy: 'U101' })
      }
    }
    const by = (dx: string) => admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith(dx))
    const later = (a: string, b: string) => (a > b ? a : b)
    const order = (id: string, a: Admission, procId: string, at: string, done?: string): IpdOrder => {
      const o: IpdOrder = { id, admissionId: a.id, type: 'stat', category: 'procedure', procId, content: procMap.get(procId)!.name, startAt: at, status: done ? 'done' : 'active', ...(done ? { stopAt: done } : {}), doctorId: a.doctorId, createdAt: at, ackAt: addMinutes(at, 5), ackBy: 'U201' }
      ipdOrders.push(o)
      return o
    }
    const ex = (o: IpdOrder, start: string, x: Partial<ImagingExam> = {}) =>
      imagingExams.push({ id: `EX-SEED-${o.id.slice(-1)}`, key: `O:${o.id}`, patientId: admissions.find((a) => a.id === o.admissionId)!.patientId, procId: o.procId!, admissionId: o.admissionId, orderId: o.id, room: room(o.procId!), start, minutes: mins(o.procId!), scheduledBy: 'U101', scheduledAt: addMinutes(o.createdAt, 10), ...x })
    const day0 = `${T} 00:00`
    const st = by('I63')
    if (st) {
      const s0 = later(addMinutes(nowStr, -120), day0)
      const o = order('IO-EX-1', st, 'P013', later(addMinutes(s0, -60), day0), addMinutes(s0, 10))
      ex(o, s0, { arrivedAt: addMinutes(s0, -5), arrivedBy: 'U101', doneAt: addMinutes(s0, 10), doneBy: 'U101' })
    }
    const pn = by('J18')
    if (pn) {
      const s1 = later(addMinutes(nowStr, -15), day0)
      const o = order('IO-EX-2', pn, 'P013', later(addMinutes(s1, -90), day0))
      ex(o, s1, { arrivedAt: later(addMinutes(nowStr, -5), s1), arrivedBy: 'U101' })
    }
    const cell = by('L03')
    if (cell) {
      const s2 = [addMinutes(nowStr, 60), `${T} 23:40`].sort()[0]
      const o = order('IO-EX-3', cell, 'P013', addMinutes(nowStr, -60))
      ex(o, s2)
    }
    const ap = by('K35')
    if (ap) order('IO-EX-4', ap, 'P016', addMinutes(nowStr, -45))
    // 放射師：闌尾炎病人今天早上做完含顯影劑腹部 CT（放射師完成、顯影劑 80 mL），檢查後前胸幾顆蕁麻疹（輕度，觀察後消退，不用通報）——待判讀
    if (ap) {
      const s9 = later(addMinutes(nowStr, -150), day0)
      const done = addMinutes(s9, mins('P061'))
      const o = order('IO-EX-9', ap, 'P061', later(addMinutes(s9, -120), day0), done)
      const ok = (at: string) => ({ ok: true, at, by: 'U801' })
      ex(o, s9, {
        arrivedAt: s9, arrivedBy: 'U101', prep: { npo6: ok(s9), consent: ok(s9), renal: { ...ok(s9), note: '腎功能已另行確認' } }, doneAt: done, doneBy: 'U801', contrastMl: 80,
        contrastReaction: { severity: 'mild', symptoms: '前胸幾顆蕁麻疹、輕微癢', action: '觀察 30 分鐘後消退，未給藥', at: done, by: 'U801' },
      })
    }
    // 檢查前準備與未到：泌尿道感染腹部超音波已報到、但早上吃過早餐（未禁食，不能做）；敗血症含顯影劑腹部 CT 今天稍晚（CrCl 偏低要水化）；
    // 門診一位今天的腰椎 X 光排在 1 小時前、人沒來（未到，開立醫師首頁看得到）
    const uti = by('N39')
    if (uti) {
      const s3 = later(addMinutes(nowStr, -20), day0)
      const o = order('IO-EX-5', uti, 'P016', later(addMinutes(s3, -120), day0))
      const arr = later(addMinutes(nowStr, -10), s3)
      ex(o, s3, { arrivedAt: arr, arrivedBy: 'U101', prep: { npo6: { ok: false, at: arr, by: 'U101', note: '早上 8 點吃過早餐' } } })
    }
    const sep = by('A41')
    // 顯影劑安全：蜂窩性組織炎病人（過敏紀錄有顯影劑）的含顯影劑 CT 排在敗血症那筆後面、還沒放行；
    // 糖尿病病人（Metformin 執行中、CrCl 算不出）的含顯影劑 CT 待排程
    const s4 = [addMinutes(nowStr, 90), `${T} 16:00`].sort()[0]
    if (sep) ex(order('IO-EX-6', sep, 'P061', addMinutes(nowStr, -90)), s4)
    if (cell) ex(order('IO-EX-7', cell, 'P061', addMinutes(nowStr, -80)), addMinutes(s4, 30))
    const dmx = by('E11')
    if (dmx) order('IO-EX-8', dmx, 'P061', addMinutes(nowStr, -30))
    const busy = new Set(admissions.filter((x) => x.status === 'admitted').map((x) => x.patientId))
    const opd = visits
      .filter((v) => v.date === T && (v.status === 'charged' || v.status === 'dispensed') && !busy.has(v.patientId))
      .map((v) => ({ v, e: encounters.find((x) => x.visitId === v.id && x.status === 'completed'), c: charges.find((x) => x.visitId === v.id && !x.voided) }))
      .filter((x): x is { v: Visit; e: Encounter; c: Charge } => !!x.e && !!x.c && !x.e.procedures.some((p) => procMap.get(p.procId)?.imaging || procMap.get(p.procId)?.labItems))
      .at(-1)
    if (opd) {
      opd.e.procedures.push({ procId: 'P015', qty: 1, selfPay: false })
      const lines = calcChargeLines(opd.v, opd.e, { identity: codes.identities.find((d) => d.code === opd.v.identityCode)!, settings: codes.billingSettings, drug: (id) => drugMap.get(id), procedure: (id) => procMap.get(id) })
      const sum = summarize(lines)
      const received = Math.ceil(sum.patientTotal / 100) * 100
      Object.assign(opd.c, { lines, nhiPoints: sum.nhiPoints, patientTotal: sum.patientTotal, received, change: received - sum.patientTotal })
      const s5 = addMinutes(nowStr, -60)
      imagingExams.push({ id: 'EX-SEED-NS', key: `E:${opd.e.id}:P015`, patientId: opd.e.patientId, procId: 'P015', room: 'XR', start: s5, minutes: 10, scheduledBy: 'U101', scheduledAt: later(opd.c.paidAt, addMinutes(s5, -40)) })
    }
    // 檢查室停機（示範）：X 光機 2 小時後保養 2 小時（放射師上午登記）；骨折病人的膝關節 X 光剛好排在這段，列「需改期」
    const fx = by('S52')
    if (fx) {
      const d0 = [addMinutes(nowStr, 120), `${T} 21:00`].sort()[0]
      roomDowntimes.push({ id: 'DT-SEED-1', room: 'XR', from: d0, to: addMinutes(d0, 120), reason: 'maintenance', note: '球管年度保養', by: 'U801', at: [addMinutes(nowStr, -180), day0].sort().at(-1)! })
      ex(order('IO-EX-0', fx, 'P014', addMinutes(nowStr, -100)), addMinutes(d0, 30))
    }
  }

  // 門診抽血櫃台（示範，不抽亂數）：今天三位已批價的門診病人加開檢驗（重算收據，日結照樣對得起來）——
  //   第 1 位 CBC：最後報到、優先等候中、還沒印條碼；第 2 位飯前血糖＋肌酸酐（同是紅頭一支）：已採檢、待檢驗科收件；
  //   第 3 位尿液常規：容器已發，等病人交回
  const labCheckins: LabCheckin[] = []
  {
    const busy = new Set(admissions.filter((a) => a.status === 'admitted').map((a) => a.patientId))
    const paid = visits
      .filter((v) => v.date === T && (v.status === 'charged' || v.status === 'dispensed') && !busy.has(v.patientId))
      .map((v) => ({ v, e: encounters.find((x) => x.visitId === v.id && x.status === 'completed'), c: charges.find((x) => x.visitId === v.id && !x.voided) }))
      .filter((x): x is { v: Visit; e: Encounter; c: Charge } => !!x.e && !!x.c && !x.e.procedures.some((p) => procMap.get(p.procId)?.labItems))
      .filter((x, i, arr) => arr.findIndex((y) => y.v.patientId === x.v.patientId) === i)
      .slice(0, 3)
    const plan = [['P003'], ['P004', 'P008'], ['P010']]
    const day = T.replace(/-/g, '')
    let n = 0
    paid.forEach((x, i) => {
      x.e.procedures.push(...plan[i].map((procId) => ({ procId, qty: 1, selfPay: false })))
      const lines = calcChargeLines(x.v, x.e, { identity: codes.identities.find((d) => d.code === x.v.identityCode)!, settings: codes.billingSettings, drug: (id) => drugMap.get(id), procedure: (id) => procMap.get(id) })
      const sum = summarize(lines)
      const received = Math.ceil(sum.patientTotal / 100) * 100
      Object.assign(x.c, { lines, nhiPoints: sum.nhiPoints, patientTotal: sum.patientTotal, received, change: received - sum.patientTotal })
      // 叫號：CBC 那位最後報到、優先等候中（75 歲以上自動；不到的當作行動不便、坐輪椅）；另外兩位叫到後已開始採檢
      const t0 = addMinutes(nowStr, -60 + [4, 0, 1][i] * 10), at = x.c.paidAt > t0 ? x.c.paidAt : t0
      const clamp = (t: string) => (t > nowStr ? nowStr : t)
      const pt = patients.find((p) => p.id === x.v.patientId)!
      labCheckins.push({
        // 第 3 位只有尿液（自行收集容器）：分流到檢體窗口
        id: `LC-SEED-${i + 1}`, no: i + 1, patientId: x.v.patientId, date: T, at, by: 'U601', ...(laneOf(plan[i].map((p) => procMap.get(p)?.tube ?? 'red'), SELF_COLLECT_TUBES) === 'drop' ? { lane: 'drop' as const } : {}),
        ...(i ? { calls: [clamp(addMinutes(at, 1))], servedAt: clamp(addMinutes(at, i === 1 ? 3 : 2)) } : { priority: priorityOf(ageOf(pt.birthDate, T), 'mobility') }),
      })
      const keys = plan[i].map((p) => `E:${x.e.id}:${p}`)
      if (i === 1) specimens.push({ id: 'SP-OPD-2', barcode: `S${day}8${String(++n).padStart(3, '0')}`, patientId: x.v.patientId, tube: 'red', orderIds: [], opdKeys: keys, createdAt: addMinutes(at, 3), printedAt: addMinutes(at, 3), printedBy: 'U601', collectedAt: addMinutes(at, 5), collectedBy: 'U601', receivedAt: clamp(addMinutes(at, 15)), receivedBy: 'U601' })
      // 門診加做（示範）：第 2 位的紅頭收件後，醫師補開 GPT（自費），用同一支檢體、不用再抽——待批價補繳（收據不動）
      if (i === 1) {
        const doc = users.find((u) => u.doctorId === x.e.doctorId)
        const p009 = procMap.get('P009')!
        x.e.procedures.push({ procId: 'P009', qty: 1, selfPay: true, addon: { specimenId: 'SP-OPD-2', at: clamp(addMinutes(at, 25)), by: doc?.id ?? 'U001', selfPay: true, amount: p009.selfPrice } })
        specimens.find((s) => s.id === 'SP-OPD-2')!.opdKeys!.push(`E:${x.e.id}:P009`)
      }
      if (i === 2) specimens.push({ id: 'SP-OPD-3', barcode: `S${day}8${String(++n).padStart(3, '0')}`, patientId: x.v.patientId, tube: 'urine', orderIds: [], opdKeys: keys, selfCollect: true, createdAt: addMinutes(at, 2), printedAt: addMinutes(at, 2), printedBy: 'U601' })
    })
    // 今天已批價、本來就有開檢驗的門診病人（隨日期不同，有時有、有時沒有）：批價後就來報到，已抽血、檢驗科已收件（留在待檢驗）。
    // 沒有這段的話，這些人會留在「已批價、待報到」，示範的櫃台每天不一樣
    const upTo = (t: string) => (t > nowStr ? nowStr : t)
    visits
      .filter((v) => v.date === T && (v.status === 'charged' || v.status === 'dispensed') && !busy.has(v.patientId) && !paid.some((x) => x.v.patientId === v.patientId))
      .forEach((v) => {
        const e = encounters.find((x) => x.visitId === v.id && x.status === 'completed')
        const c = charges.find((x) => x.visitId === v.id && !x.voided)
        const labs = (e?.procedures ?? []).filter((p) => procMap.get(p.procId)?.labItems && !p.notDone)
        if (!e || !c || !labs.length || labCheckins.some((x) => x.patientId === v.patientId)) return
        const at = upTo(addMinutes(c.paidAt, 5))
        labCheckins.push({ id: `LC-SEED-N${labCheckins.length + 1}`, no: 0, patientId: v.patientId, date: T, at, by: 'U601', calls: [upTo(addMinutes(at, 1))], servedAt: upTo(addMinutes(at, 2)), ...(laneOf(labs.map((p) => procMap.get(p.procId)!.tube ?? 'red'), SELF_COLLECT_TUBES) === 'drop' ? { lane: 'drop' as const } : {}) })
        for (const tube of [...new Set(labs.map((p) => procMap.get(p.procId)!.tube ?? 'red'))]) {
          const self = SELF_COLLECT_TUBES.includes(tube)
          const rcv = upTo(addMinutes(at, 20))
          specimens.push({
            id: `SP-OPD-N${++n}`, barcode: `S${day}8${String(n).padStart(3, '0')}`, patientId: v.patientId, tube, orderIds: [], opdKeys: labs.filter((p) => (procMap.get(p.procId)!.tube ?? 'red') === tube).map((p) => `E:${e.id}:${p.procId}`), ...(self ? { selfCollect: true } : {}),
            createdAt: upTo(addMinutes(at, 2)), printedAt: upTo(addMinutes(at, 2)), printedBy: 'U601', collectedAt: upTo(addMinutes(at, 4)), collectedBy: 'U601', receivedAt: rcv, receivedBy: 'U601',
          })
        }
      })
    // 號碼依報到時間
    labCheckins.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)).forEach((x, i) => (x.no = i + 1))
    counters[`labdesk:${T}`] = labCheckins.length
  }

  // 過去一年的門診細菌培養（院內藥敏統計用，不抽亂數）：大腸桿菌 32 株（每位病人一株，夠 30 株才算得出可信的敏感率）、
  // 克雷伯氏菌 8 株、金黃色葡萄球菌（MSSA）6 株、綠膿桿菌 3 株（株數不足）。都在 40 天以前，不影響住院中病人的培養；沒有多重抗藥菌
  {
    const p059 = procMap.get('P059')!
    let k = 0
    const add = (pt: Patient, at: string, specimen: CultureSpecimen, iso: CultureIsolate) => {
      k++
      labReports.push({ id: `LR-HX-CULT-${k}`, no: `L${at.slice(0, 10).replace(/-/g, '')}${9800 + k}`, patientId: pt.id, procId: 'P059', doctorId: 'DR01', orderedAt: addMinutes(at, -26 * 60), values: buildLabValues(p059.labItems!, { CULT: '其他細菌' }, pt.gender).values, culture: { specimen, isolates: [iso] }, reportedBy: 'U601', reportedAt: at })
    }
    const R = (b: boolean): SirResult => (b ? 'R' : 'S')
    patients.slice(0, 32).forEach((pt, i) => {
      // 約：Ampicillin 抗藥 60%、Augmentin 30%、Cephalexin 40%、Ceftriaxone 20%（ESBL）、Pip/Tazo 6%、Meropenem 都敏感
      add(pt, `${addDays(T, -(40 + i * 10))} 10:30`, 'urine', { organism: 'ECO', ast: { AMP: R(i % 5 < 3), AMC: R(i % 10 === 0 || i % 10 === 3 || i % 10 === 6), CEX: R(i % 4 === 0 || i % 5 === 0), CRO: R(i % 5 === 0), TZP: R(i % 16 === 7), MEM: 'S' } })
    })
    patients.slice(0, 8).forEach((pt, i) => add(pt, `${addDays(T, -(45 + i * 37))} 11:00`, i % 2 ? 'sputum' : 'urine', { organism: 'KPN', ast: { AMC: R(i % 4 === 1), CEX: R(i % 3 === 0), CRO: R(i === 3), TZP: 'S', MEM: 'S' } }))
    patients.slice(10, 16).forEach((pt, i) => add(pt, `${addDays(T, -(50 + i * 50))} 09:40`, 'wound', { organism: 'SAU', ast: { OXA: 'S', CEX: 'S', AMC: 'S', VAN: 'S' } }))
    patients.slice(20, 23).forEach((pt, i) => add(pt, `${addDays(T, -(60 + i * 90))} 14:20`, 'sputum', { organism: 'PAE', ast: { TZP: R(i === 1), MEM: 'S' } }))
  }

  // 檢驗儀器自動傳輸與自動審核（示範，不抽亂數）：今天五位住院病人的臨時檢驗都已採檢、收件、上機——
  //   自動審核發出三份：骨折 CBC（和上次差不多）、腦梗塞肌酸酐、蜂窩性組織炎 CRP；
  //   待審核兩份：闌尾炎 CBC 血色素比昨天掉 2.5（差異檢查）、泌尿道感染電解質（今天鉀品管被拒絕）；
  //   檢體品質（溶血）：肺炎病人電解質鉀 5.9 看起來像高血鉀，其實檢體嚴重溶血（H 260）→ 不能發，要退件重抽。
  //   紅頭檢體都量品質指數（其他的都正常）
  const analyzerResults: AnalyzerResult[] = []
  {
    const day = T.replace(/-/g, '')
    const at = (min: number) => { const t = addMinutes(nowStr, -min); return t < `${T} 00:00` ? `${T} 00:00` : t }
    const okIx: SerumIndices = { H: 12, I: 1, L: 25 }
    const plan: [string, string, Record<string, string>, boolean, SerumIndices?][] = [
      ['S52', 'P003', { WBC: '7.6', Hb: '14.9', HCT: '45', PLT: '241' }, true],
      ['I63', 'P008', { CRE: '1.0' }, true],
      ['L03', 'P011', { CRP: '3.20' }, true],
      ['K35', 'P003', { WBC: '12.8', Hb: '10.6', HCT: '32', PLT: '330' }, false],
      ['N39', 'P055', { NA: '138', K: '4.4' }, false],
      ['J18', 'P055', { NA: '137', K: '5.9' }, false, { H: 260, I: 1, L: 30 }],
    ]
    let k = 0
    for (const [dx, procId, vals, auto, ix0] of plan) {
      const a = admissions.find((x) => x.status === 'admitted' && x.diagnosis.startsWith(dx))
      if (!a) continue
      k++
      const pt = patients.find((p) => p.id === a.patientId)!
      const proc = procMap.get(procId)!
      const id = `IO-AN-${k}`
      const t0 = at(150 - k * 8)
      ipdOrders.push({ id, admissionId: a.id, type: 'stat', category: 'procedure', procId, content: proc.name, startAt: t0, status: 'done', stopAt: at(140 - k * 8), doctorId: a.doctorId, createdAt: t0, ackAt: t0, ackBy: 'U201' })
      const barcode = `S${day}7${String(k).padStart(3, '0')}`
      specimens.push({ id: `SP-AN-${k}`, barcode, admissionId: a.id, patientId: a.patientId, tube: proc.tube ?? 'red', orderIds: [id], createdAt: t0, printedAt: t0, printedBy: 'U201', collectedAt: at(140 - k * 8), collectedBy: 'U201', receivedAt: at(120 - k * 8), receivedBy: 'U601' })
      const loadedAt = at(90 - k * 8)
      const ix = (proc.tube ?? 'red') === 'red' ? ix0 ?? okIx : undefined
      const x: AnalyzerResult = { id: `AR-SEED-${k}`, key: `O:${id}`, barcode, patientId: a.patientId, procId, values: vals, holds: [], status: auto ? 'auto' : 'held', ...(ix ? { indices: ix } : {}), loadedAt, loadedBy: 'U601' }
      if (auto) {
        const r: LabReport = { id: `LR-AN-${k}`, no: `L${day}95${String(k).padStart(2, '0')}`, patientId: a.patientId, procId, orderId: id, admissionId: a.id, doctorId: a.doctorId, orderedAt: t0, values: buildLabValues(proc.labItems!, vals, pt.gender).values, reportedBy: 'U601', reportedAt: loadedAt, autoVerified: true }
        labReports.push(r)
        x.reportId = r.id
      } else {
        // 待審核的規則用同一個自動審核（analyzer-rules.autoVerify）算：上一次的值、今天的品管
        const prev: Record<string, string> = {}
        for (const r of labReports.filter((r) => r.patientId === a.patientId).sort((p, q) => p.reportedAt.localeCompare(q.reportedAt))) for (const v of r.values) prev[v.code] = v.value
        const qcFailed = qcFailedCodes(qcRuns, proc.labItems!.map((d) => d.code), T)
        x.holds = autoVerify({ defs: proc.labItems!, values: vals, gender: pt.gender, prev, qcFailed, ...(ix ? { indices: ix } : {}) })
      }
      analyzerResults.push(x)
    }
  }

  // 檢驗加做（示範）：腦梗塞病人今天上機過的紅頭（肌酸酐）20 分鐘前加做 GPT，不用再抽血，待檢驗
  {
    const sp = specimens.find((x) => x.id === 'SP-AN-2')
    const a = sp && admissions.find((x) => x.id === sp.admissionId)
    if (sp && a) {
      const t0 = [addMinutes(nowStr, -20), sp.receivedAt!].sort().at(-1)!
      ipdOrders.push({ id: 'IO-ADD-1', admissionId: a.id, type: 'stat', category: 'procedure', procId: 'P009', content: procMap.get('P009')!.name, startAt: t0, status: 'done', stopAt: t0, doctorId: a.doctorId, createdAt: t0, ackAt: t0, ackBy: 'U201', addonOf: sp.id })
      sp.orderIds.push('IO-ADD-1')
    }
  }

  // 急診檢驗（示範，不抽亂數）：胸悶（2 級）看診中——醫師 73 分鐘前送出 CBC＋肌酸酐，急診護理師床邊採檢：
  //   CBC（紫頭）已收件、10 分鐘前報告出來（白血球偏高），醫師還沒看（看板「新報告」）；肌酸酐（紅頭）20 分鐘前才採到，等檢驗科收件
  {
    const erDoc = codes.doctors.find((d) => codes.departments.find((x) => x.id === d.deptId)?.code === 'ER')
    const sid = `ER-${T}`
    const busy = new Set([...admissions.filter((a) => a.status === 'admitted' || a.status === 'reserved').map((a) => a.patientId), ...visits.filter((v) => v.date === T).map((v) => v.patientId)])
    const p = patients.find((x) => !busy.has(x.id) && visits.some((v) => v.patientId === x.id))
    const day0 = `${T} 00:00`
    const at = (m: number) => [addMinutes(nowStr, -m), day0].sort().at(-1)!
    const day = T.replace(/-/g, '')
    if (erDoc && p && sessions.some((x) => x.id === sid)) {
      const vitals = { temp: 36.6, pulse: 108, resp: 22, sbp: 152, dbp: 94, spo2: 95 }
      const ord = at(73)
      const v: Visit = {
        id: 'V-ER-LAB-1', date: T, sessionId: sid, deptId: erDoc.deptId, doctorId: erDoc.id, patientId: p.id, seqNo: next(`seq:${sid}`), identityCode: p.defaultIdentity,
        caseType: 'E1', cardSeq: String(next(`cardseq:${p.id}`)).padStart(4, '0'), status: 'in-consult', firstVisit: false, preventItems: [], createdAt: at(90), checkedInAt: at(90), calledAt: at(75),
        er: { arrivedAt: at(90), complaint: '胸悶、冒冷汗', vitals, suggested: 2, level: 2, triagedBy: 'U201', triagedAt: at(90) },
      }
      visits.push(v)
      const eid = 'E-ER-LAB-1'
      encounters.push({
        id: eid, visitId: v.id, patientId: p.id, doctorId: erDoc.id, deptId: erDoc.deptId, date: T, subjective: '胸悶、冒冷汗 1 小時', objective: '', assessment: '胸痛', plan: '抽血檢驗，等報告',
        vitals: { temp: 36.6, pulse: 108, sbp: 152, dbp: 94, spo2: 95 }, diagnoses: [{ icd: 'R07.9', name: '胸痛', primary: true }], medications: [],
        procedures: ['P003', 'P008'].map((procId) => ({ procId, qty: 1, selfPay: false, orderedAt: ord })), refillTimes: 0, admissionRequested: false, status: 'draft',
      })
      specimens.push(
        { id: 'SP-ER-1', barcode: `S${day}4101`, patientId: p.id, tube: 'purple', orderIds: [], opdKeys: [`E:${eid}:P003`], er: true, createdAt: at(68), printedAt: at(68), printedBy: 'U201', collectedAt: at(60), collectedBy: 'U201', receivedAt: at(50), receivedBy: 'U601' },
        { id: 'SP-ER-2', barcode: `S${day}4102`, patientId: p.id, tube: 'red', orderIds: [], opdKeys: [`E:${eid}:P008`], er: true, createdAt: at(68), printedAt: at(68), printedBy: 'U201', collectedAt: at(20), collectedBy: 'U201' },
      )
      labReports.push({ id: 'LR-ER-1', no: `L${day}9301`, patientId: p.id, procId: 'P003', encounterId: eid, doctorId: erDoc.id, orderedAt: ord, values: buildLabValues(procMap.get('P003')!.labItems!, { WBC: '13.5', Hb: '13.8', HCT: '41', PLT: '265' }, p.gender).values, reportedBy: 'U601', reportedAt: at(10) })
      // 看診號依到院先後（這位比候診的早到）
      visits.filter((x) => x.sessionId === sid).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.seqNo - b.seqNo).forEach((x, i) => (x.seqNo = i + 1))
    }
  }

  // 醫師建議回診（示範，不抽亂數）：今天看完診的三位——一位櫃台已依建議掛好（病人本來就有之後的掛號）、一位待預約（追蹤血壓）、
  // 一位建議看別科（指定醫師）；另外兩、三週前看診的一位建議一週後回診，到現在還沒掛（過期）
  const followUpAdvices: FollowUpAdvice[] = []
  {
    const done = visits.filter((v) => v.date === T && !v.er && ['charged', 'dispensed'].includes(v.status)).map((v) => ({ v, e: encounters.find((x) => x.visitId === v.id && x.status === 'completed') })).filter((x) => x.e)
    const future = (pid: string, dept: string) => visits.find((x) => x.patientId === pid && x.deptId === dept && x.date > T && x.status === 'registered')
    const booked = done.find((x) => future(x.v.patientId, x.v.deptId))
    const rest = done.filter((x) => x !== booked)
    const at = (v: Visit) => encounters.find((x) => x.visitId === v.id)?.completedAt ?? nowStr
    const mk = (id: string, v: Visit, x: Partial<FollowUpAdvice> & { weeks: number; reason: string }): FollowUpAdvice => ({ id, visitId: v.id, patientId: v.patientId, doctorOf: v.doctorId, deptId: v.deptId, targetDate: addDays(v.date, x.weeks * 7), at: at(v), status: 'pending', ...x })
    if (booked) {
      const fv = future(booked.v.patientId, booked.v.deptId)!
      followUpAdvices.push(mk('FA-SEED-1', booked.v, { weeks: 2, reason: '看檢驗報告', status: 'booked', bookedVisitId: fv.id, closedAt: at(booked.v), closedBy: 'U101' }))
    }
    if (rest[0]) followUpAdvices.push(mk('FA-SEED-2', rest[0].v, { weeks: 2, reason: '追蹤血壓' }))
    const other = rest[1] && codes.departments.find((d) => d.id !== rest[1].v.deptId && d.code !== 'ER' && codes.doctors.some((x) => x.deptId === d.id))
    if (rest[1] && other) followUpAdvices.push(mk('FA-SEED-3', rest[1].v, { weeks: 4, reason: '心臟功能評估', deptId: other.id, doctorId: codes.doctors.find((x) => x.deptId === other.id)!.id }))
    const old = visits.filter((v) => v.date >= addDays(T, -20) && v.date <= addDays(T, -15)).sort((a, b) => b.date.localeCompare(a.date)).find((v) => !v.er && ['charged', 'dispensed'].includes(v.status) && !visits.some((x) => x.patientId === v.patientId && x.deptId === v.deptId && x.date > v.date && x.status !== 'cancelled'))
    if (old) followUpAdvices.push(mk('FA-SEED-4', old, { weeks: 1, reason: '藥物調整後複診' }))
  }

  // 病安異常事件（示範，不抽亂數）：腦梗塞病人前天夜裡跌倒（輕度擦傷，護理長審查已結案）；今天早上給藥前發現 Heparin 抽成 10 倍
  // （跡近錯失，匿名通報，待審查）；腦梗塞病人鼻胃管自拔（無傷害，審查中：原因寫了、改善措施還沒寫）
  const incidents: Incident[] = []
  {
    const st = admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('I63'))
    const bedText = (a?: Admission) => { const b = a && beds.find((x) => x.id === a.bedId); return b ? `${b.ward} ${b.bedNo}` : '病房' }
    const day = (d: string) => d.replace(/-/g, '')
    const d2 = addDays(T, -2), d1 = addDays(T, -1)
    const early = [addMinutes(nowStr, -120), `${T} 00:30`].sort().at(-1)!
    if (st) {
      incidents.push({
        id: 'IN-SEED-1', no: `INC${day(d2)}001`, category: 'fall', occurredAt: `${d2} 02:30`, location: bedText(st), patientId: st.patientId,
        description: '夜間病人自行下床如廁，沒有按叫人鈴，在床邊滑倒，左前臂擦傷約 2 公分。', harm: 'mild', immediateAction: '傷口清潔、通知值班醫師評估，無頭部撞擊',
        reportedBy: 'U201', reportedAt: `${d2} 03:10`, anonymous: false, status: 'closed',
        review: { by: 'U202', at: `${d1} 10:00`, sac: 3, cause: '病人跌倒高風險（Morse 55），夜間床欄未拉起、叫人鈴放在病人搆不到的地方', actions: '高風險病人夜間床欄拉起、叫人鈴固定在床欄；每 2 小時巡視提醒如廁', closedAt: `${d1} 10:00` },
      })
      incidents.push({
        id: 'IN-SEED-3', no: `INC${day(T)}002`, category: 'line', occurredAt: [addMinutes(nowStr, -90), `${T} 00:10`].sort().at(-1)!, location: bedText(st), patientId: st.patientId,
        description: '病人躁動，趁護理師離開床邊時自行拔除鼻胃管，管路完整拔出。', harm: 'none', immediateAction: '通知醫師，評估後重新放置鼻胃管、確認位置',
        reportedBy: 'U201', reportedAt: [addMinutes(nowStr, -80), `${T} 00:20`].sort().at(-1)!, anonymous: false, status: 'reviewing',
        review: { by: 'U202', at: [addMinutes(nowStr, -30), `${T} 00:30`].sort().at(-1)!, sac: 4, cause: '病人譫妄躁動，沒有評估是否需要約束或手套', actions: '' },
      })
    }
    const anyAdm = admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('A41')) ?? admissions.find((a) => a.status === 'admitted')
    if (anyAdm) incidents.push({
      id: 'IN-SEED-2', no: `INC${day(T)}001`, category: 'medication', occurredAt: early, location: bedText(anyAdm),
      description: '準備皮下注射 Heparin 時，抽藥量是醫囑的 10 倍（看錯單位），給藥前雙人核對時發現，沒有給到病人。', harm: 'near-miss', immediateAction: '重新抽藥、雙人核對後給藥',
      reportedBy: 'U201', reportedAt: early, anonymous: true, status: 'reported',
    })
    // RCA（示範）：三天前泌尿道感染病人被給了隔壁床的降血壓藥（中度：血壓降到 88/52，觀察後回穩）——SAC 2，RCA 進行中：
    // 時間序列、原因（人員、流程）、根本原因已寫；兩項行動計畫，一項完成、一項後天到期
    const uti = admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('N39'))
    if (uti) {
      const d3 = addDays(T, -3)
      incidents.push({
        id: 'IN-SEED-4', no: `INC${day(d3)}001`, category: 'medication', occurredAt: `${d3} 09:05`, location: bedText(uti), patientId: uti.patientId,
        description: '早上給藥時拿了隔壁床的藥盒，病人服下 Amlodipine 10mg（不是他的藥），半小時後血壓 88/52。', harm: 'moderate', immediateAction: '通知醫師、每 15 分鐘量血壓、平躺觀察，2 小時後回穩',
        reportedBy: 'U201', reportedAt: `${d3} 10:00`, anonymous: false, status: 'reviewing',
        review: { by: 'U202', at: `${d3} 15:00`, sac: 2, cause: '藥盒拿錯床', actions: '' },
        rca: {
          timeline: [{ at: `${d3} 08:50`, event: '交班延誤，給藥時間壓縮' }, { at: `${d3} 09:00`, event: '同時推兩床的藥，藥盒沒有逐床分開' }, { at: `${d3} 09:05`, event: '沒有掃腕帶就給藥（掃描器沒電，選了略過）' }, { at: `${d3} 09:35`, event: '病人頭暈，量血壓 88/52 才發現' }],
          causes: ['staff', 'process', 'equipment'], rootCause: '給藥車一次放兩床藥盒、掃描器沒有備用電池，略過掃描後只靠口頭核對姓名',
          plans: [
            { id: 'RP-SEED-1', action: '每台給藥車配備用電池，交班時檢查電量', owner: '護理長 孫佩君', due: addDays(T, -1), status: 'done', doneAt: `${addDays(T, -1)} 16:00`, doneBy: 'U202' },
            { id: 'RP-SEED-2', action: '給藥車改成一次只放一床藥盒，全病房教育訓練', owner: '護理部 督導', due: addDays(T, 2), status: 'open' },
          ],
          by: 'U202', at: `${addDays(T, -2)} 14:00`,
        },
      })
    }
    counters[`incident:${T}`] = incidents.filter((x) => x.no.includes(day(T))).length
  }

  // 門診發藥掃描（示範，不抽亂數）：今天發出的都有掃描紀錄，其中一張藥品條碼破損略過；另有一次拿錯規格被擋下（差點發錯）
  const dispenseMismatches: DispenseMismatch[] = []
  {
    const todays = dispenses.filter((d) => d.dispensedAt?.startsWith(T)).sort((a, b) => a.dispensedAt!.localeCompare(b.dispensedAt!))
    todays.forEach((d, i) => (d.scan = i === 1 ? { mode: 'skipped', reason: 'barcode', note: '藥品條碼破損，人工核對藥名與劑量' } : { mode: 'scanned' }))
    const d0 = todays[0]
    const e0 = d0 && encounters.find((e) => e.id === d0.encounterId)
    const dr = e0?.medications[0] && drugMap.get(e0.medications[0].drugId)
    const wrong = dr && (codes.drugs.find((x) => x.id !== dr.id && x.generic === dr.generic) ?? codes.drugs.find((x) => x.id !== dr.id && x.category === dr.category))
    if (d0 && dr && wrong) {
      const same = wrong.generic === dr.generic
      dispenseMismatches.push({ id: 'DM-SEED-1', at: addMinutes(d0.dispensedAt!, -1), pharmacistId: d0.dispensedBy ?? 'U301', dispenseId: d0.id, code: wrong.nhiCode, message: same ? `規格不對！掃到的是 ${wrong.name}，處方是 ${dr.name}` : `藥品不對！掃到的是 ${wrong.name}，這張處方沒有這個藥` })
    }
  }

  // 檢驗時效（示範）：骨折病人 85 分鐘前開的急件 CRP，護理師 70 分鐘前就採檢了，檢體一直沒送到檢驗科（急件 60 分已逾時，卡在送檢）
  {
    const fx = admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('S52'))
    if (fx) {
      const day0 = `${T} 00:00`
      const t0 = [addMinutes(nowStr, -85), day0].sort().at(-1)!
      const col = [addMinutes(nowStr, -70), t0].sort().at(-1)!
      ipdOrders.push({ id: 'IO-TAT-1', admissionId: fx.id, type: 'stat', category: 'procedure', procId: 'P011', content: procMap.get('P011')!.name, startAt: t0, status: 'done', stopAt: col, doctorId: fx.doctorId, createdAt: t0, ackAt: t0, ackBy: 'U201' })
      // 採檢病人辨識：腕帶浸濕破損，略過掃描（人工核對）
      specimens.push({ id: 'SP-TAT-1', barcode: `S${T.replace(/-/g, '')}5001`, admissionId: fx.id, patientId: fx.patientId, tube: 'red', orderIds: ['IO-TAT-1'], createdAt: t0, printedAt: t0, printedBy: 'U201', collectedAt: col, collectedBy: 'U201', scan: { mode: 'skipped', reason: 'wristband', note: '腕帶浸濕破損，人工核對姓名與出生日期' } })
    }
  }

  // 危急值通報（示範，不抽亂數）：過去的危急值報告都通報過（住院給護理師、門診給開立醫師；一筆門診 45 分鐘才通報＝逾時）；
  // 今天糖尿病病人臨時血糖 32（低血糖危急值）50 分鐘前發出，還沒通報（逾時，檢驗科首頁紅色）；8 分鐘後打給病房護理師沒人接（沒聯絡上一次）
  {
    const nurse = users.find((u) => u.roles.includes('nurse'))!
    const docName = (id: string) => codes.doctors.find((d) => d.id === id)?.name ?? ''
    const delays = [12, 20, 45]
    labReports
      .filter((r) => r.values.some((v) => v.critical) && r.reportedAt < `${T} 00:00`)
      .sort((a, b) => a.reportedAt.localeCompare(b.reportedAt))
      .forEach((r, i) => {
        const ipd = !!r.admissionId
        r.callout = { at: addMinutes(r.reportedAt, delays[i % delays.length]), by: 'U601', to: ipd ? nurse.name : docName(r.doctorId), toRole: ipd ? 'nurse' : 'doctor', readBack: true }
      })
    const dm = admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('E11'))
    if (dm) {
      const pt = patients.find((p) => p.id === dm.patientId)!
      const day0 = `${T} 00:00`
      const rep = addMinutes(nowStr, -50) < day0 ? day0 : addMinutes(nowStr, -50)
      const t0 = addMinutes(rep, -40) < day0 ? day0 : addMinutes(rep, -40)
      ipdOrders.push({ id: 'IO-CR-1', admissionId: dm.id, type: 'stat', category: 'procedure', procId: 'P004', content: `${procMap.get('P004')!.name}（意識變差）`, startAt: t0, status: 'done', stopAt: t0, doctorId: dm.doctorId, createdAt: t0, ackAt: t0, ackBy: 'U201' })
      specimens.push({ id: 'SP-CR-1', barcode: `S${T.replace(/-/g, '')}6001`, admissionId: dm.id, patientId: dm.patientId, tube: 'red', orderIds: ['IO-CR-1'], createdAt: t0, printedAt: t0, printedBy: 'U201', collectedAt: t0, collectedBy: 'U201', receivedAt: t0, receivedBy: 'U601',
        // 空腹確認：早上吃過早餐（臨時抽的，不是空腹）——報告附註非空腹採檢
        fasting: { ok: false, note: '早上吃過早餐', at: t0, by: 'U201' } })
      labReports.push({ id: 'LR-CR-1', no: `L${T.replace(/-/g, '')}9401`, patientId: dm.patientId, procId: 'P004', orderId: 'IO-CR-1', admissionId: dm.id, doctorId: dm.doctorId, orderedAt: t0, values: buildLabValues(procMap.get('P004')!.labItems!, { 'GLU-AC': '32' }, pt.gender).values, reportedBy: 'U601', reportedAt: rep, qualityNote: '非空腹採檢（早上吃過早餐）',
        // 沒聯絡上一次：發出 8 分鐘後打給病房護理師，電話沒人接（再一次沒聯絡上就要改通報主治）
        calloutAttempts: [{ at: [addMinutes(rep, 8), nowStr].sort()[0], by: 'U601', to: nurse.name, toRole: 'nurse', note: '電話沒人接' }] })
    }
  }

  // 日間手術（示範，不抽亂數）：局部麻醉疝氣修補——
  //   一：昨天做完、PADSS 10 分由兒子陪同回家，今天待電話追蹤；帳單還沒結（住院結帳清單）
  //   二：今天 40 分鐘前做完，PADSS 8 分（疼痛、活動各 1），還不能回家
  //   三：今天稍後排在 OR2，麻醉前評估 ASA 2，待報到
  // 放在種子最後：其他示範先挑病人。挑現在沒住院、沒預約、今天沒掛急診的成年人（18 歲以上）：今天以後沒有掛號的、沒住過院的優先，再依年輕
  {
    const ever = new Set(admissions.map((x) => x.patientId))
    const busy = new Set([...admissions.filter((x) => x.status === 'reserved' || x.status === 'admitted').map((x) => x.patientId), ...visits.filter((v) => v.date >= T && v.er).map((v) => v.patientId)])
    const booked = new Set(visits.filter((v) => v.date >= T).map((v) => v.patientId))
    const free = patients.filter((p) => !busy.has(p.id) && !p.deceasedAt && Number(T.slice(0, 4)) - Number(p.birthDate.slice(0, 4)) >= 18)
      .sort((x, y) => Number(booked.has(x.id)) - Number(booked.has(y.id)) || Number(ever.has(x.id)) - Number(ever.has(y.id)) || y.birthDate.localeCompare(x.birthDate))
    const doc = codes.doctors.find((d) => d.id === 'DR04')!
    const docUser = users.find((u) => u.doctorId === doc.id)!.id
    const an = users.find((u) => u.doctorId === 'DR03')!.id
    const mk = (by: string, at: string, extra: Partial<SurgeryPrepMark> = {}): SurgeryPrepMark => ({ by, at, ...extra })
    const sno = (d: string) => { const n = (counters[`surgery:${d}`] ?? surgeries.filter((x) => x.no.startsWith(`OR${d.replace(/-/g, '')}`)).length) + 1; counters[`surgery:${d}`] = n; return `OR${d.replace(/-/g, '')}${String(n).padStart(3, '0')}` }
    const make = (k: number, pt: Patient, start: string, stage: 'out' | 'phase2' | 'reserved') => {
      const created = addMinutes(start, -7 * 24 * 60)
      const end = addMinutes(start, 50)
      const aid = `A-DAY-${k}`
      const sid = `SG-DAY-${k}`
      const done = stage !== 'reserved'
      const sch = { room: 'OR2', start, by: 'U202', at: addMinutes(created, 60) }
      const sg: Surgery = {
        id: sid, no: sno(created.slice(0, 10)), admissionId: aid, patientId: pt.id, doctorId: doc.id, procId: 'P039', side: k === 2 ? 'left' : 'right', anesthesia: 'local',
        diagnosis: `K40.90 ${k === 2 ? '左' : '右'}側腹股溝疝氣`, requestedDate: start.slice(0, 10), estMinutes: 60, status: done ? 'done' : 'scheduled', createdAt: created, schedule: sch,
        preAnes: { asa: 2, emergency: false, airway: { mallampati: 2, mouth: 'ok', neck: 'ok' }, difficult: false, npo: { status: 'unknown' }, history: { items: [] }, plan: 'local', by: an, at: addMinutes(created, 24 * 60) },
        team: { scrub: [{ userId: 'U210', by: 'U202', at: sch.at }], circulating: [{ userId: 'U212', by: 'U202', at: sch.at }] },
        prep: done ? { consent: mk('U212', addMinutes(start, -60)), npo: mk('U212', addMinutes(start, -60), { notNeeded: '局部麻醉' }), siteMark: mk('U212', addMinutes(start, -60)), blood: mk('U212', addMinutes(start, -60), { notNeeded: '日間手術，預估失血少' }), abx: mk('U212', addMinutes(start, -60), { notNeeded: '乾淨手術不需預防性抗生素' }) } : {},
        checks: done ? { signIn: { by: 'U212', at: addMinutes(start, -10) }, timeOut: { by: 'U212', at: addMinutes(start, -2) }, signOut: { by: 'U212', at: end } } : {},
        ...(done ? { sentAt: addMinutes(start, -20), sentBy: 'U212', startAt: start, endAt: end, counts: { spongeBefore: 10, spongeAfter: 10, instrumentBefore: 20, instrumentAfter: 20 }, noSpecimen: true,
          record: { performed: '腹股溝疝氣修補術（局部麻醉，網膜）', findings: '間接型疝氣，疝囊約 3 cm', bloodLoss: 10, complications: '無', specimen: '無', by: docUser, at: addMinutes(end, 10) } } : {}),
      }
      surgeries.push(sg)
      const admitted = addMinutes(start, -90)
      const pd = (i: number, at: string, v: [number, number, number, number, number]): PadssScore => ({ id: `PD-SEED-${k}-${i}`, at, vitals: v[0] as 0 | 1 | 2, activity: v[1] as 0 | 1 | 2, ponv: v[2] as 0 | 1 | 2, pain: v[3] as 0 | 1 | 2, bleeding: v[4] as 0 | 1 | 2, by: 'U212' })
      const day: Admission['day'] = { surgeryId: sid,
        ...(stage === 'out' ? { padss: [pd(1, addMinutes(end, 30), [2, 1, 2, 1, 2]), pd(2, addMinutes(end, 60), [2, 2, 2, 2, 2])], out: { at: addMinutes(end, 70), by: 'U212', padss: 10, escort: '兒子（陪同回家）' } } : {}),
        ...(stage === 'phase2' ? { padss: [pd(1, addMinutes(end, 20), [2, 1, 2, 1, 2])] } : {}) }
      admissions.push({
        id: aid, admitNo: done ? `I${admitted.slice(2, 10).replace(/-/g, '')}${String(next('admitNo')).padStart(3, '0')}` : '', patientId: pt.id, deptId: doc.deptId, doctorId: doc.id, preferBedClass: '健保床',
        reason: '日間手術', diagnosis: sg.diagnosis, status: stage === 'out' ? 'discharged' : stage === 'phase2' ? 'admitted' : 'reserved', reservedAt: created, expectedDate: start.slice(0, 10),
        ...(done ? { admittedAt: admitted, wristband: { printedAt: admitted, printedBy: 'U212', reprints: [] } } : {}), ...(stage === 'out' ? { dischargedAt: day.out!.at, dischargeType: '日間手術出院' } : {}), day,
      })
    }
    const y = addDays(T, -1)
    if (free[0]) make(1, free[0], `${y} 10:00`, 'out')
    const s2 = ((t) => addMinutes(t, -(Number(t.slice(15)) % 5)))(addMinutes(nowStr, -90).slice(0, 16))
    if (free[1]) make(2, free[1], s2, 'phase2')
    const s3 = ((t) => addMinutes(t, 5 - (Number(t.slice(15)) % 5)))(addMinutes(nowStr, 90).slice(0, 16))
    if (free[2]) make(3, free[2], s3, 'reserved')
  }

  // ---------- 器械包與滅菌（示範，不抽亂數）----------
  // 近 7 天每天兩鍋（S1 早上 06:30、S2 下午 16:00；今天只有早上那鍋），每鍋基本 3、腹腔鏡 1、骨科 1、小手術 2；
  // 24 小時後判讀生物指示劑：前天前一天下午那鍋（T-3 S2）陽性召回——前天的清創（SG-SEED-3）用了那鍋的小手術包、還沒通知；
  // 昨天下午與今天早上那鍋還在培養（會放植入物的手術不能用）；一包 35 天前滅菌的基本包過期還在架上。
  // 已完成的手術（這個功能之後的，有逐件登記或確認無檢體的）照先進先出綁上器械包
  const sterileBatches: SterileBatch[] = []
  const instrumentPacks: InstrumentPack[] = []
  {
    const cssd = 'U214'
    const content: Record<PackSet, number> = { basic: 3, lap: 1, ortho: 1, minor: 2 }
    const mkBatch = (st: string, at: string, packs: Partial<Record<PackSet, number>>, bi?: 'negative' | 'positive') => {
      const ymd = at.slice(0, 10).replace(/-/g, '')
      const n = (counters[`sterile:${st}:${ymd}`] ?? 0) + 1
      counters[`sterile:${st}:${ymd}`] = n
      const b: SterileBatch = { id: `SB-SEED-${st}-${ymd}-${n}`, no: `${st}-${ymd}-${n}`, sterilizer: st, at, by: cssd }
      const due = biDueAt(b)
      if (due <= nowStr) {
        const r = bi ?? 'negative'
        const rat = notFuture(addMinutes(due, 30), 5)
        b.bi = { result: r, at: rat, by: cssd }
        if (r === 'positive') b.recall = { at: rat, by: cssd, notified: [] }
      }
      sterileBatches.push(b)
      for (const set of PACK_SETS) for (let i = 0; i < (packs[set] ?? 0); i++) {
        const k = (counters.pack ?? 0) + 1
        counters.pack = k
        instrumentPacks.push({ id: `PK-SEED-${k}`, no: `PK${String(k).padStart(5, '0')}`, set, batchId: b.id, expiresOn: expiresOnOf(at) })
      }
      return b
    }
    mkBatch('S1', `${addDays(T, -35)} 06:30`, { basic: 1 })
    let positive: SterileBatch | undefined
    for (let k = 6; k >= 0; k--) {
      const d = addDays(T, -k)
      if (`${d} 06:30` <= nowStr) mkBatch('S1', `${d} 06:30`, content)
      if (k >= 1) {
        const b = mkBatch('S2', `${d} 16:00`, content, k === 3 ? 'positive' : undefined)
        if (k === 3) positive = b
      }
    }
    const setOf: Record<string, PackSet> = { P037: 'ortho', P038: 'lap', P039: 'basic', P040: 'minor' }
    const procs = new Map(codes.procedures.map((p) => [p.id, p]))
    const bOf = (id: string) => sterileBatches.find((b) => b.id === id)!
    const done = surgeries.filter((x) => x.status === 'done' && x.startAt && (x.specimens || x.noSpecimen) && setOf[x.procId]).sort((a, b) => a.startAt!.localeCompare(b.startAt!))
    for (const sg of done) {
      const at = addMinutes(sg.startAt!, -10)
      const implant = !!procs.get(sg.procId)?.surgery?.implant
      const ok = (p: InstrumentPack) => {
        const b = bOf(p.batchId)
        if (p.used || p.set !== setOf[sg.procId] || b.at > addMinutes(at, -30) || p.expiresOn < at.slice(0, 10)) return false
        if (b.bi?.result === 'positive' && b.bi.at <= at) return false
        return !implant || (b.bi?.result === 'negative' && b.bi.at <= at)
      }
      const pick = (sg.id === 'SG-SEED-3' && positive ? instrumentPacks.filter((p) => p.batchId === positive!.id) : instrumentPacks).filter(ok).sort((a, b) => bOf(a.batchId).at.localeCompare(bOf(b.batchId).at))[0]
      if (pick) {
        pick.used = { surgeryId: sg.id, at, by: sg.team?.circulating?.[0]?.userId ?? 'U205' }
        // 逐件清點：照包的清單，全部相符
        if (sg.counts) {
          const items = PACK_CONTENTS[pick.set].map((x) => ({ name: x.name, before: x.qty, after: x.qty }))
          const n = items.reduce((a, x) => a + x.before, 0)
          sg.counts = { ...sg.counts, instrumentBefore: n, instrumentAfter: n, items }
        }
      }
    }
  }

  // ---------- 植入物批號（示範，不抽亂數）----------
  // 骨板、骨釘、自費骨板、網膜（兩批）、自費網膜；一批骨釘已過期還在架上。
  // 做完的疝氣修補都登記了網膜：昨天兩台用 BS-M2607、今天兩台用 BS-M2610；BS-M2607 今天廠商召回（包裝密封不良），還沒通知主刀
  const implantLots: ImplantLot[] = []
  {
    const lot = (id: string, procId: string, no: string, expiresOn: string, qty: number, rec: number): ImplantLot => {
      const l: ImplantLot = { id: `IL-SEED-${id}`, procId, lot: no, expiresOn, qty, receivedAt: `${addDays(T, -rec)} 10:00`, receivedBy: 'U214' }
      implantLots.push(l)
      return l
    }
    lot('1', 'P062', 'KH-2611A', addDays(T, 400), 4, 20)
    lot('2', 'P063', 'KH-S2609', addDays(T, 600), 40, 20)
    lot('3', 'P063', 'KH-S2405', addDays(T, -10), 6, 200)
    lot('4', 'P064', 'KH-T2610', addDays(T, 500), 2, 15)
    const m1 = lot('5', 'P065', 'BS-M2607', addDays(T, 300), 6, 30)
    const m2 = lot('6', 'P065', 'BS-M2610', addDays(T, 420), 10, 7)
    lot('7', 'P066', 'BS-L2609', addDays(T, 380), 3, 25)
    const side: Record<string, string> = { left: '左側', right: '右側', bilateral: '兩側', na: '' }
    const hernias = surgeries.filter((x) => x.status === 'done' && x.procId === 'P039' && x.startAt && (x.specimens || x.noSpecimen)).sort((a, b) => a.startAt!.localeCompare(b.startAt!))
    for (const sg of hernias) {
      const l = sg.startAt! < `${T} 00:00` ? m1 : m2
      sg.implants = [{ id: `IU-SEED-${sg.id}`, lotId: l.id, qty: 1, site: `${side[sg.side]}腹股溝`, at: [addMinutes(sg.startAt!, 30), sg.endAt ?? nowStr].sort()[0], by: sg.team?.circulating?.[0]?.userId ?? 'U205' }]
    }
    if (hernias.some((x) => x.implants?.[0].lotId === m1.id)) m1.recall = { at: notFuture(`${T} 08:00`, 5), by: 'U214', reason: '廠商通知：該批包裝密封不良，可能影響無菌', notified: [] }
  }

  // ---------- 疾病分類編碼審查（示範）----------
  // 上個月以前出院的、和這個月出院超過 7 天的都審查過（病歷管理師 clerk01，出院後 3 天內，照病摘確認）；最近出院的待審查
  {
    const codeOf = (text: string) => text.trim().match(/^[A-Z][0-9][0-9A-Z.]*/)?.[0] ?? ''
    for (const a of admissions.filter((x) => x.status === 'discharged' && x.dischargedAt && (x.dischargedAt.slice(0, 7) < T.slice(0, 7) || x.dischargedAt.slice(0, 10) < addDays(T, -7)))) {
      const main = mainDiagnosisFrom(a)
      const ic = codes.icdCodes.find((c) => c.code === codeOf(main))
      a.coding = { at: notFuture(addMinutes(a.dischargedAt!, 3 * 24 * 60), 30), by: 'U401', mainDiagnosis: ic ? `${ic.code} ${ic.name}` : main, ...(a.dischargeSummary?.secondaryDiagnoses ? { secondary: a.dischargeSummary.secondaryDiagnoses } : {}), changed: false }
    }
  }

  // ---------- 健保申報（示範）----------
  // 前前個月以前的門診都已送出（櫃台組長 clerk02 兼申報，次月 5 日）；之後那個月最後一位的病人回來加做 GPT（次月 8 日補收）→ 上個月的申報出現一筆「補報」。
  // 上個月還沒送：第一位就醫的病歷沒有主診斷（送件前檢核要處理）。住院、核減見後面
  const claimSubmissions: ClaimSubmission[] = []
  const claimExclusions: ClaimExclusion[] = []
  const claimCuts: ClaimCut[] = []
  const cm0 = T.slice(0, 7)
  const cm1 = addDays(`${cm0}-01`, -1).slice(0, 7)
  const cm2 = addDays(`${cm1}-01`, -1).slice(0, 7)
  {
    const selfPay = new Set(codes.identities.filter((i) => i.selfPay).map((i) => i.code))
    const opdItem = (v: Visit): ClaimItem | undefined => {
      const cs = charges.filter((c) => c.visitId === v.id && !c.voided && !c.admissionId && !c.copyRequestId)
      if (!cs.length || selfPay.has(v.identityCode)) return undefined
      const e = v.refillOf ? encounters.find((x) => x.id === v.refillOf) : encounters.find((x) => x.visitId === v.id)
      const d = e?.diagnoses.find((x) => x.primary) ?? e?.diagnoses[0]
      return { refId: v.id, patientId: v.patientId, doctorId: v.doctorId, deptId: v.deptId, date: v.date, caseType: v.caseType, diagnosis: d ? `${d.icd} ${d.name}` : '', ...linePoints(cs.flatMap((c) => c.lines)) }
    }
    const byDate = (a: Visit, b: Visit) => a.date.localeCompare(b.date) || a.seqNo - b.seqNo
    // 前前個月以前的都送過（每月 5 日）
    for (const m of [...new Set(visits.map((v) => v.date.slice(0, 7)))].filter((m) => m <= cm2).sort()) {
      const nm = addDays(`${m}-28`, 8).slice(0, 7)
      claimSubmissions.push({ id: `CS-SEED-OPD-${m}`, kind: 'opd', month: m, submittedAt: `${nm}-05 09:00`, submittedBy: 'U402', items: visits.filter((v) => v.date.startsWith(m) && opdItem(v)).sort(byDate).map((v) => opdItem(v)!), excluded: [] })
    }
    const m2v = visits.filter((v) => v.date.startsWith(cm2) && opdItem(v)).sort(byDate)
    if (m2v.length) {
      const v = m2v.at(-1)!
      const main = charges.find((c) => c.visitId === v.id && !c.voided)!
      const gpt = procMap.get('P009')!
      const at = `${cm1}-08 10:30`
      charges.push({
        id: 'CH-SEED-SUP', visitId: v.id, supplementOf: main.id, patientId: v.patientId, lines: [{ kind: 'procedure', name: gpt.name, qty: 1, unitPrice: gpt.points, amount: gpt.points, patientPay: false }],
        nhiPoints: gpt.points, patientTotal: 0, payMethod: 'cash', received: 0, change: 0, receiptNo: `R${at.slice(0, 10).replace(/-/g, '')}${String(next(`receipt:${at.slice(0, 10)}`)).padStart(4, '0')}`, cashierId: 'U401', paidAt: at, voided: false,
      })
    }
    const m1v = visits.filter((v) => v.date.startsWith(cm1) && opdItem(v) && !v.refillOf).sort(byDate)[0]
    const e1 = m1v && encounters.find((x) => x.visitId === m1v.id)
    if (e1) e1.diagnoses = []
    // 住院：前前個月以前出院的都送過；上個月的還沒送（沒有檢核問題，可以直接送）
    const ipdItem = (a: Admission): ClaimItem | undefined => {
      const c = charges.find((x) => x.admissionId === a.id && !x.voided)
      if (!c || a.status !== 'discharged' || !a.dischargedAt) return undefined
      if (selfPay.has(patients.find((p) => p.id === a.patientId)?.defaultIdentity ?? '')) return undefined
      const day = !!a.day && !a.day.converted
      return {
        refId: a.id, patientId: a.patientId, doctorId: a.doctorId, deptId: a.deptId, date: a.dischargedAt.slice(0, 10), caseType: day ? 'DAY' : 'IPD', diagnosis: ((a.coding?.mainDiagnosis ?? (day ? a.diagnosis : a.dischargeSummary?.diagnosis)) ?? '').trim(),
        ...((lp) => {
          const pt = patients.find((p) => p.id === a.patientId)
          const g = groupDrg({ mainDiagnosis: mainDiagnosisFrom(a), doneProcs: drgProcsOf(a, surgeries, (id) => procMap.get(id)?.name ?? id), history: historyFrom(encounters, admissions, a.patientId, a.id), secondary: secondaryFrom(a), age: pt ? ageOf(pt.birthDate, (a.admittedAt ?? a.reservedAt).slice(0, 10)) : 0 })
          const ex = drgExempt({ day, days: ipdDays(a.admittedAt ?? a.reservedAt, a.dischargedAt!), dischargeType: a.dischargeType ?? a.dischargeSummary?.dischargeType })
          return { ...lp, ...ipdClaimPoints(lp, g, ex) }
        })(linePoints(c.lines)), categories: ipdCategories(c.lines, (n) => procedureBy(n)), days: c.ipd?.days ?? ipdDays(a.admittedAt ?? a.dischargedAt, a.dischargedAt),
      }
    }
    const procedureBy = (n: string) => [...procMap.values()].find((p) => p.name === n)
    const disc = admissions.filter((a) => a.status === 'discharged' && a.dischargedAt && ipdItem(a))
    for (const m of [...new Set(disc.map((a) => a.dischargedAt!.slice(0, 7)))].filter((m) => m <= cm2).sort()) {
      const nm = addDays(`${m}-28`, 8).slice(0, 7)
      claimSubmissions.push({ id: `CS-SEED-IPD-${m}`, kind: 'ipd', month: m, submittedAt: `${nm}-05 09:30`, submittedBy: 'U402', items: disc.filter((a) => a.dischargedAt!.startsWith(m)).sort((x, y) => x.dischargedAt!.localeCompare(y.dischargedAt!)).map((a) => ipdItem(a)!), excluded: [] })
    }
    // 核減：上上個月門診一筆檢查被核減、主治還沒回覆；最近送出的住院一筆住院日數被核減、主治已申復、等結果；更早一筆門診已接受
    const docUser = (doctorId: string) => users.find((u) => u.doctorId === doctorId)?.id ?? 'U001'
    const subs = (k: string) => claimSubmissions.filter((x) => x.kind === k).sort((a, b) => b.month.localeCompare(a.month))
    const cut = (sub: ClaimSubmission, it: ClaimItem, n: number, item: string, points: number, code: string, reason: string, at: string, extra: Partial<ClaimCut> = {}) =>
      claimCuts.push({ id: `CC-SEED-${n}`, submissionId: sub.id, kind: sub.kind, month: sub.month, refId: it.refId, patientId: it.patientId, doctorId: it.doctorId, item, points, code, reason, at, by: 'U402', ...extra })
    const lineOf = (it: ClaimItem) => charges.filter((c) => c.visitId === it.refId && !c.voided && !c.supplementOf).flatMap((c) => c.lines).find((l) => l.kind === 'procedure' && !l.patientPay && l.amount > 0 && l.amount <= it.claim)
    const [o1, o2] = subs('opd')
    const oi = o1?.items.find((x) => !x.supplementOf && lineOf(x))
    if (o1 && oi) cut(o1, oi, 1, lineOf(oi)!.name, lineOf(oi)!.amount, '0213', '30 天內重複檢查，病歷沒有新的臨床理由', notFuture(`${cm1}-25 10:00`, 60))
    const oj = o2?.items.find((x) => !x.supplementOf && x.claim > 100)
    if (o2 && oj) cut(o2, oj, 2, '一般門診診察費（部分）', 100, '0501', '病歷記載不完整', `${o1?.month ?? cm1}-20 10:00`, { reply: { action: 'accept', text: '', by: docUser(oj.doctorId), at: `${o1?.month ?? cm1}-22 15:00` } })
    // 申復後仍維持核減（12 天前結果回來）：還在 60 天內，申報組可以申請爭議審議
    const ok4 = o2?.items.find((x) => !x.supplementOf && x !== oj && lineOf(x))
    if (o2 && ok4) {
      const m = o1?.month ?? cm1
      cut(o2, ok4, 4, lineOf(ok4)!.name, lineOf(ok4)!.amount, '0101', '病歷看不出這項處置的必要', `${m}-18 10:00`, {
        reply: { action: 'appeal', text: '門診病歷有記載當時的症狀與理學檢查，這項處置是依病情需要做的', by: docUser(ok4.doctorId), at: `${m}-19 15:00` },
        result: { outcome: 'upheld', points: 0, by: 'U402', at: `${addDays(T, -12)} 10:00` },
      })
    }
    const [i1] = subs('ipd')
    const ii = i1?.items.find((x) => (x.days ?? 0) >= 3)
    if (i1 && ii) {
      const fee = procMap.get('P002')!.points * 2
      if (fee <= ii.claim) cut(i1, ii, 3, '住院診察費（每日）2 天', fee, '0601', '住院日數過長，後 2 天可門診追蹤', notFuture(`${cm1}-26 10:00`, 60), { reply: { action: 'appeal', text: '肺炎合併低血氧，出院前 2 天仍需氧氣治療，病歷有記載', by: docUser(ii.doctorId), at: notFuture(`${cm1}-27 16:00`, 30) } })
    }
  }

  // ---------- 事前審查（示範）----------
  // 泌尿道感染那位（重症、免疫低下）今天開 IVIG：主治已填好、待申報組送審（核准前護理站不能給）；
  // 明天骨折那台的鎖定骨板：主刀申請、已核准
  const preAuths: PreAuth[] = []
  {
    const pa = (id: string, p: Omit<PreAuth, 'id' | 'no' | 'notes'> & { notes?: PreAuth['notes'] }) => {
      const d = p.createdAt.slice(0, 10).replace(/-/g, '')
      const n = (counters[`preauth:${d}`] = (counters[`preauth:${d}`] ?? 0) + 1)
      preAuths.push({ id, no: `PA${d}${String(n).padStart(3, '0')}`, notes: [], ...p })
    }
    const uti = admissions.find((a) => a.status === 'admitted' && !a.obs && !a.day && a.diagnosis.startsWith('N39'))
    if (uti) {
      const at = notFuture(addMinutes(nowStr, -90), 30)
      const doc = users.find((u) => u.doctorId === uti.doctorId)!.id
      ipdOrders.push({ id: 'IO-IVIG-1', admissionId: uti.id, type: 'long', category: 'medication', drugId: 'M051', content: 'IVIG 2.5g/50ml Inj', dose: 1, freq: 'QD', route: 'IV', startAt: at, status: 'active', doctorId: uti.doctorId, createdAt: at, ackAt: addMinutes(at, 10), ackBy: 'U201' })
      pa('PA-SEED-1', { kind: 'drug', itemId: 'M051', itemName: 'IVIG 2.5g/50ml Inj', patientId: uti.patientId, admissionId: uti.id, doctorId: uti.doctorId, orderId: 'IO-IVIG-1', status: 'ready', createdAt: at,
        summary: '泌尿道感染併敗血性休克，IgG 低（350 mg/dL），抗生素治療 72 小時反應不佳', reason: '低丙種球蛋白血症合併重症感染，依給付規定申請 IVIG 0.4 g/kg × 5 天',
        notes: [{ at: addMinutes(at, 20), by: doc, text: '填寫送審資料' }] })
    }
    const s1 = surgeries.find((x) => x.id === 'SG-SEED-1')
    if (s1) {
      const doc = users.find((u) => u.doctorId === s1.doctorId)!.id
      const at = s1.createdAt
      pa('PA-SEED-2', { kind: 'implant', itemId: 'P062', itemName: '鎖定骨板（橈骨遠端）', patientId: s1.patientId, admissionId: s1.admissionId, doctorId: s1.doctorId, surgeryId: s1.id, status: 'approved', createdAt: at,
        summary: '右橈骨遠端粉碎性骨折（AO C2），關節面移位 3 mm', reason: '關節內粉碎性骨折，一般骨板無法固定，需鎖定骨板', notes: [{ at: addMinutes(at, 10), by: doc, text: '填寫送審資料' }],
        submittedAt: addMinutes(at, 30), submittedBy: 'U402', result: { outcome: 'approved', note: '', at: notFuture(addMinutes(at, 20 * 60), 10), by: 'U402', until: addDays(T, 30) } })
    }
  }

  // 門診事前審查（示範）：今天還沒看的一位（骨科 dr07 有門診就挑骨科，沒有就家醫科 dr01；已報到的、50 歲以上女性優先、年紀大的優先），
  // 之前在同一位醫師看診時（有的話連到那次看診）申請骨鬆注射筆、20 天前核准（效期 180 天）→ 今天開 Teriparatide 可以健保開；別的病人開會被擋（要自費或先申請）
  {
    const pt = (id: string) => patients.find((p) => p.id === id)!
    const fit = (id: string) => Number(pt(id).gender === 'F' && pt(id).birthDate <= addDays(T, -50 * 365))
    const wait = (d: string) => visits.filter((x) => x.date === T && x.doctorId === d && x.status === 'registered' && !x.refillOf && !x.er).sort((a, b) => Number(!!b.checkedInAt) - Number(!!a.checkedInAt) || fit(b.patientId) - fit(a.patientId) || pt(a.patientId).birthDate.localeCompare(pt(b.patientId).birthDate))
    const v = wait('DR07')[0] ?? wait('DR01')[0]
    const prev = v && encounters.filter((e) => e.patientId === v.patientId && e.doctorId === v.doctorId && e.date < T && e.status === 'completed').sort((a, b) => b.date.localeCompare(a.date))[0]
    if (v) {
      const d0 = prev?.date ?? addDays(T, -30)
      const at = `${d0} 11:00`
      const ok = `${addDays(T, -20)} 15:00`
      const doc = users.find((u) => u.doctorId === v.doctorId)!.id
      preAuths.push({ id: 'PA-SEED-3', no: `PA${d0.replace(/-/g, '')}${String((counters[`preauth:${d0.replace(/-/g, '')}`] = (counters[`preauth:${d0.replace(/-/g, '')}`] ?? 0) + 1)).padStart(3, '0')}`,
        kind: 'drug', itemId: 'M052', itemName: 'Teriparatide 20mcg Pen', patientId: v.patientId, ...(prev ? { encounterId: prev.id } : {}), doctorId: v.doctorId, status: 'approved', createdAt: at,
        summary: '停經後骨質疏鬆，骨密度 T 值 −3.3，已有兩處脊椎壓迫性骨折', reason: '使用雙磷酸鹽一年以上仍新發骨折，符合給付規定',
        notes: [{ at: `${d0} 11:10`, by: doc, text: '填寫送審資料' }], submittedAt: addDays(d0, 1) < ok.slice(0, 10) ? `${addDays(d0, 1)} 10:00` : `${d0} 14:00`, submittedBy: 'U402',
        result: { outcome: 'approved', note: '核准 18 個月療程，先給 6 個月', at: ok < `${d0} 16:00` ? `${d0} 16:00` : ok, by: 'U402', until: addDays(T, 160), qty: 6, times: 6, interval: 28, monthlyQty: 2 } })
    }
  }

  // ---------- 病人植入物與 MRI（示範）----------
  // 腦梗塞那位（長期住院）外院裝過舊型心律調節器（MRI 不安全，病人帶外院植入物卡）；主治今天開頭部磁振造影、待排程——
  // 櫃台排不進去，要放射科醫師確認。做完的疝氣修補都還沒印植入物卡
  const implantCardPrints: ImplantCardPrint[] = []
  {
    const st = admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('I63'))
    const pt = st && patients.find((p) => p.id === st.patientId)
    if (st && pt) {
      const at = notFuture(addMinutes(nowStr, -60), 30)
      pt.externalImplants = [{ id: 'XI-SEED-1', name: '心律調節器（舊型，非 MRI 相容）', mri: 'unsafe', implantedOn: '2015-06-10', hospital: '外院（中部某醫學中心）', note: '病人持外院植入物卡', by: 'U201', at: st.admittedAt ?? at }]
      ipdOrders.push({ id: 'IO-MRI-1', admissionId: st.id, type: 'stat', category: 'procedure', procId: 'P067', content: '磁振造影（頭部）', startAt: at, status: 'active', doctorId: st.doctorId, createdAt: at, ackAt: addMinutes(at, 10), ackBy: 'U201' })
    }
  }

  // ---------- 抽血窗口（示範）：今天 lab01 開 1 號、lab02 開 2 號；已採檢的照報到順序分給兩個窗口 ----------
  const labWindows: LabWindowSession[] = []
  {
    const open = notFuture(`${T} 07:30`, 30)
    labWindows.push({ id: 'LW-SEED-1', date: T, window: 1, userId: 'U601', openedAt: open }, { id: 'LW-SEED-2', date: T, window: 2, userId: 'U602', openedAt: open })
    labCheckins.filter((c) => c.date === T && c.calls?.length).sort((a, b) => a.at.localeCompare(b.at)).forEach((c, i) => (c.window = (i % 2) + 1))
  }

  return {
    schema: 0, // 由 db.ts 填入目前的 SCHEMA_VERSION，版本號只定義在一個地方
    seededAt: T,
    users,
    departments: structuredClone(codes.departments),
    doctors: structuredClone(codes.doctors).map((d) => (d.controlledLicense ? { ...d, controlledLicense: { ...d.controlledLicense, validUntil: d.controlledLicense.validUntil === 'expired' ? addDays(T, -140) : `${Number(T.slice(0, 4)) + 3}-12-31` } } : d)),
    identities: structuredClone(codes.identities),
    billingSettings: structuredClone(codes.billingSettings),
    discounts: structuredClone(codes.discounts),
    rooms: rooms.sort((a, b) => a.roomNo.localeCompare(b.roomNo)),
    weeklySlots,
    sessions,
    patients,
    visits,
    encounters,
    charges,
    dispenses,
    drugs,
    drugLots,
    stockTxns,
    restockRequests,
    orderSets,
    postopSets,
    phrases,
    hospitalScale: scale,
    stockLocations,
    safetyStocks,
    stocktakes: [],
    suppliers,
    purchaseOrders,
    transfers,
    udDispenses,
    procedures: structuredClone(codes.procedures),
    icdCodes: structuredClone(codes.icdCodes),
    frequencies: structuredClone(codes.frequencies),
    beds,
    admissions,
    ipdOrders,
    mar,
    // 採檢掃錯病人（示範）：加護病房血糖那支採檢前，先掃到隔壁床的腕帶，當場擋下；改掃本人後採檢（檢體記已掃描）
    scanMismatches: ((): ScanMismatch[] => {
      const sp = specimens.find((s) => s.id === 'SP-CR-1')
      const a = sp && admissions.find((x) => x.id === sp.admissionId)
      const other = a && admissions.find((x) => x.status === 'admitted' && x.id !== a.id && beds.find((b) => b.id === x.bedId)?.ward === beds.find((b) => b.id === a.bedId)?.ward)
      if (!sp || !a || !other) return []
      sp.scan = { mode: 'scanned' }
      const ob = beds.find((b) => b.id === other.bedId)?.bedNo ?? ''
      const ab = beds.find((b) => b.id === a.bedId)?.bedNo ?? ''
      const nm = (pid: string) => patients.find((p) => p.id === pid)?.name ?? ''
      return [{ id: 'SM-SEED-1', at: sp.collectedAt!, nurseId: 'U201', admissionId: a.id, orderId: sp.orderIds[0], specimenId: sp.id, kind: 'patient', code: other.admitNo, message: `病人不對！這是 ${ob} ${nm(other.patientId)} 的腕帶，不是 ${ab} ${nm(a.patientId)}` }]
    })(),
    riskAssessments,
    isolations,
    dnrRecords,
    bloodUnits,
    bloodRequests,
    recordCopies: [],
    surgeries,
    sterileBatches,
    instrumentPacks,
    implantLots,
    lines,
    nutritionScreens,
    nutritionAssessments,
    tubeFormulas: structuredClone(codes.tubeFormulas),
    tubeFeeds: [],
    deliriumAssessments,
    restraints,
    nurseShifts,
    nurseAssignments,
    shiftRequests,
    pcas,
    infectionCases,
    infusions,
    wounds,
    weanTrials,
    icuRequests,
    rrtCalls,
    codeBlues,
    palliativeCases,
    pressureLogs,
    clusterDecisions,
    notifiableReports,
    abxInterventions,
    adrReports,
    pharmCareNotes,
    specimens,
    qcRuns,
    imagingExams,
    labCheckins,
    labWindows,
    claimSubmissions,
    claimExclusions,
    claimCuts,
    preAuths,
    implantCardPrints,
    analyzerResults,
    contrastClearances: [],
    roomDowntimes,
    // 檢查室開放時段（示範）：電腦斷層週六只開上午、週日不開；其他照預設 08:00–17:00。10 天後全院影像休診一天（消防演練）
    examHours: [{ room: 'CT', weekday: 6, start: '08:00', end: '12:00' }, { room: 'CT', weekday: 0, closed: true }],
    followUpAdvices,
    incidents,
    dispenseMismatches,
    examClosures: [{ id: 'XC-SEED-1', date: addDays(T, 10), reason: '院內消防演練', by: 'U001', at: nowStr }],
    dischargePlans,
    vitals,
    nursingNotes,
    progressNotes,
    consults,
    wardStockItems,
    discountRequests: [],
    wardCounts: codes.wards.map((w, wi): WardCount => ({
      id: `WC-SEED-${wi + 1}`, ward: w, shift: '小夜', date: addDays(T, -1), countedBy: 'U202', at: `${addDays(T, -1)} 23:30`,
      lines: wardStockItems.filter((x) => x.ward === w).map((x) => ({ drugId: x.drugId, book: wardStartQty(wi, x.drugId, x.par), counted: wardStartQty(wi, x.drugId, x.par) })),
    })),
    handovers,
    preventItems: structuredClone(codes.preventItems),
    preventRecords,
    labReports,
    imagingReports,
    certificates,
    referrals: [],
    auditLogs: [],
    counters,
  }
}
