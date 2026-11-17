// 產生展示資料：以「今天」為基準，讓任何時候開啟都有今日門診、住院中病人等情境。
// 使用固定種子的亂數，每次重置結果相同。所有人名、證號皆為虛構。
import type {
  DnrRecord, Isolation, BloodUnit, BloodRequest, Abo, BloodProduct, Surgery, SurgeryPrepMark, LineDevice, NutritionScreen, NutritionAssessment, DeliriumAssessment, Restraint,
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
import { allocateFefo, suggestRestockQty, usableQty } from '@/services/stock-rules'
import { udPerDose } from '@/services/ud-rules'
import { effectiveTiming, marTimes, timingApplies } from '@/services/drug-rules'
import { makeIdNo } from '@/utils/validators'
import { buildLabValues } from '@/services/lab-rules'
import { riskLevel, riskScore } from '@/services/risk-rules'
import { dietKindOfText, nutritionScore } from '@/services/nutrition-rules'
import { ABX_REASON_LABEL } from '@/services/abx-rules'
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
      // dr01：被指定維護全院（醫師）片語（示範：醫療部主任）
      ...(i === 0 ? { grants: ['phrase.hospital'] } : {}),
    })),
    { id: 'U201', username: 'nurse01', password: '1234', name: '周怡萱', roles: ['nurse'], active: true },
    // nurse02：被指定維護全院（護理）片語（示範：護理部督導）
    { id: 'U202', username: 'nurse02', password: '1234', name: '孫佩君', roles: ['nurse'], active: true, grants: ['phrase.hospital', 'surgery.schedule'] },
    { id: 'U301', username: 'ph01', password: '1234', name: '方建志', roles: ['pharmacist'], active: true },
    // 第二位藥師：盤點單「清點的人不能自己覆核」，要有另一位藥師可以覆核（小診所沒有的話由管理員覆核）
    { id: 'U302', username: 'ph02', password: '1234', name: '林雅婷', roles: ['pharmacist'], active: true },
    { id: 'U401', username: 'clerk01', password: '1234', name: '馬文琪', roles: ['clerk'], active: true },
    // 櫃台組長：可核准優免（「專案減免」要主管核准：clerk01 結帳時請 clerk02 輸入帳密）
    { id: 'U402', username: 'clerk02', password: '1234', name: '鄭淑芬', roles: ['clerk'], active: true, grants: ['charge.approveDiscount'] },
    // 小診所常見：跟診護理兼櫃台掛號批價（多角色，登入時選、右上角切換）
    { id: 'U501', username: 'staff01', password: '1234', name: '陳小芬', roles: ['nurse', 'clerk'], active: true },
    // 長期沒登入的櫃台（示範「密碼過期太久鎖帳號」：130 天前設定的密碼，90 天到期、過期 40 天 > 寬限 30 天）
    { id: 'U403', username: 'clerk03', password: '1234', name: '呂佳蓉', roles: ['clerk'], active: true },
    // 醫檢師：登打檢驗結果、發報告
    { id: 'U601', username: 'lab01', password: '1234', name: '何宜蓁', roles: ['lab'], active: true },
    { id: 'U701', username: 'diet01', password: '1234', name: '溫若瑜', roles: ['diet'], active: true },
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
  const bedsByClass = (cls: Bed['bedClass']) => beds.filter((b) => b.bedClass === cls && b.status === 'empty' && b.ward !== codes.obsWard)

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
    // 腦梗塞（雙人房）住比較久：示範住院中費用查詢、期中繳款提醒（滿 30 天、部分負擔進第二段）。亂數照樣抽，其他人的資料不變
    const rolled = int(1, 6)
    const daysIn = i === 4 ? 32 : rolled
    const admitDate = addDays(T, -daysIn)
    // 隔離示範（不抽亂數）：肺炎（疑似肺結核、空氣隔離）住綜合病房的單人房；蜂窩性組織炎（MRSA、接觸隔離）住綜合病房健保床，同房另一床空著
    const cls: Bed['bedClass'] = i === 0 || i === 2 ? '單人房' : i === 4 ? '雙人房' : '健保床'
    const isoBed = i === 0 ? beds.find((b) => b.ward === codes.wards[2] && b.bedClass === '單人房' && b.status === 'empty') : i === 5 ? beds.find((b) => b.ward === codes.wards[2] && b.bedClass === '健保床' && b.status === 'empty') : undefined
    const bed = isoBed ?? bedsByClass(cls)[0] ?? bedsByClass('健保床')[0]
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
        doctorIds: [sepsis.doctorId, sepsis.doctorId === 'DR02' ? 'DR03' : 'DR02'], withhold: ['compress', 'intubation', 'defib'], nhiCard: false,
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
  //   - 蜂窩性組織炎（MRSA）：Vancomycin 依培養結果開立，隔天核准 7 天（今天約第 3 天）
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
      const s = later(`${addDays(T, -2)} 10:00`, addMinutes(cell.admittedAt!, 240))
      addAbx(cell, 'M042', s, { reason: 'culture', site: '皮膚軟組織', organism: 'MRSA', note: '傷口培養 MRSA' }, { approve: true, at: notFuture(addMinutes(s, 20 * 60), 30), text: '同意使用，請監測 Vancomycin 谷濃度與腎功能', days: 7 })
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
  const FIXED_STOCK = new Set(['M041', 'M042', 'M043', 'M044'])
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
  for (const drug of drugs.filter((d) => FIXED_STOCK.has(d.id) && !d.restrictedAbx)) {
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
  for (const drug of drugs.filter((d) => FIXED_STOCK.has(d.id) && d.restrictedAbx)) {
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
      labReports.push({ id: 'LR-SEED-IPD1', no: labNo(at), patientId: adm.patientId, procId: 'P003', orderId: 'IO-SEED-LAB1', admissionId: adm.id, doctorId: adm.doctorId, orderedAt, values: buildLabValues(procMap.get('P003')!.labItems!, { WBC: '12.4', Hb: '6.8', PLT: '210' }, pt.gender).values, reportedBy: 'U601', reportedAt: at })
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
      const abx = ipdOrders.find((o) => o.admissionId === appx.id && o.category === 'medication' && o.status === 'active' && (codes.drugs.find((d) => d.id === o.drugId)?.indication.includes('抗生素') || codes.drugs.find((d) => d.id === o.drugId)?.restrictedAbx))
      surgeries.push({
        id: 'SG-SEED-2', no: `OR${T.replace(/-/g, '')}002`, admissionId: appx.id, patientId: appx.patientId, doctorId: appx.doctorId, procId: 'P038', side: 'na', anesthesia: 'general',
        diagnosis: appx.diagnosis, requestedDate: start.slice(0, 10), estMinutes: 90, status: 'scheduled', createdAt: at,
        schedule: { room: 'OR2', start, by: 'U202', at: notFuture(addMinutes(at, 60), 20) },
        prep: {
          consent: mark('U201', prepAt), npo: mark('U201', prepAt), siteMark: mark('U201', prepAt, { notNeeded: '腹腔鏡手術，不分側' }), blood: mark('U201', prepAt, { notNeeded: '預估失血少' }),
          abx: abx ? mark('U201', prepAt, { refId: abx.id }) : mark('U201', prepAt, { notNeeded: '手術室劃刀前給 Cefazolin（麻醉科醫囑）' }),
        },
        checks: {},
      })
    }
    counters[`surgery:${T}`] = surgeries.length
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
      const op = cands[4]
      if (op) {
        const at = addMinutes(nowStr, -27 * 60)
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
          ipdOrders.push({ id: `IO-ER-OBS-${k}`, admissionId: 'A-ER-OBS', type: 'long', category, content, ...(category === 'diet' ? { diet: { kind: 'npo' as const } } : {}), startAt: placed, status: 'active', doctorId: docUser, createdAt: placed, ackAt: addMinutes(placed, 5), ackBy: 'U201' })
        }
        for (let h = 0; addMinutes(placed, h * 240) <= nowStr; h++) {
          const vt = addMinutes(placed, h * 240)
          vitals.push({ id: `VS-ER-OBS-${h}`, admissionId: 'A-ER-OBS', at: vt, temp: h < 3 ? 37.8 : 37.3, pulse: h < 3 ? 100 : 88, resp: 18, sbp: 124, dbp: 76, spo2: 97, pain: h < 3 ? 5 : 3, ...(h < 3 ? { painAction: '協助舒適臥位，禁食中不給口服止痛，通知醫師' } : {}), nurseId: h % 2 ? 'U202' : 'U201' })
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
    scanMismatches: [],
    riskAssessments,
    isolations,
    dnrRecords,
    bloodUnits,
    bloodRequests,
    recordCopies: [],
    surgeries,
    lines,
    nutritionScreens,
    nutritionAssessments,
    tubeFormulas: structuredClone(codes.tubeFormulas),
    tubeFeeds: [],
    deliriumAssessments,
    restraints,
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
