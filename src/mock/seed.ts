// 產生展示資料：以「今天」為基準，讓任何時候開啟都有今日門診、住院中病人等情境。
// 使用固定種子的亂數，每次重置結果相同。所有人名、證號皆為虛構。
import type {
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
} from '@/types'
import { addDays, addMinutes, ageOf, now, parseDate, toDateStr, today } from '@/utils/date'
import { autoQty, calcChargeLines, summarize } from '@/services/billing'
import { checkAllergies } from '@/services/allergy'
import { checkEligibility, withDerivedFields } from '@/services/prevent-rules'
import { allocateFefo, suggestRestockQty, usableQty } from '@/services/stock-rules'
import { udPerDose } from '@/services/ud-rules'
import { effectiveTiming, marTimes, timingApplies } from '@/services/drug-rules'
import { makeIdNo } from '@/utils/validators'
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
    })),
    { id: 'U201', username: 'nurse01', password: '1234', name: '周怡萱', roles: ['nurse'], active: true },
    { id: 'U202', username: 'nurse02', password: '1234', name: '孫佩君', roles: ['nurse'], active: true },
    { id: 'U301', username: 'ph01', password: '1234', name: '方建志', roles: ['pharmacist'], active: true },
    // 第二位藥師：盤點單「清點的人不能自己覆核」，要有另一位藥師可以覆核（小診所沒有的話由管理員覆核）
    { id: 'U302', username: 'ph02', password: '1234', name: '林雅婷', roles: ['pharmacist'], active: true },
    { id: 'U401', username: 'clerk01', password: '1234', name: '馬文琪', roles: ['clerk'], active: true },
    // 小診所常見：跟診護理兼櫃台掛號批價（多角色，登入時選、右上角切換）
    { id: 'U501', username: 'staff01', password: '1234', name: '陳小芬', roles: ['nurse', 'clerk'], active: true },
  ]
  // 密碼設定日：展示帳號都是今天（一開就要求改密碼會干擾展示）；nurse02 示範「快到期」——80 天前設定，90 天期限還剩 10 天，
  // 系統管理把期限改成 60 天就會變成「已過期」，登入後要先改密碼
  for (const u of users) u.passwordSetOn = u.username === 'nurse02' ? addDays(T, -80) : T
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
  const bedsByClass = (cls: Bed['bedClass']) => beds.filter((b) => b.bedClass === cls && b.status === 'empty')

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
    const daysIn = int(1, 6)
    const admitDate = addDays(T, -daysIn)
    const cls: Bed['bedClass'] = i === 2 ? '單人房' : i === 4 ? '雙人房' : '健保床'
    const bed = bedsByClass(cls)[0] ?? bedsByClass('健保床')[0]
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
    ipdOrders.push({ id: id('IO'), admissionId: adm.id, type: 'long', category: 'diet', content: sc.diet, startAt, status: 'active', doctorId: docUser, createdAt: startAt })
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
          sbp: int(110, 140), dbp: int(65, 88), spo2: Math.min(99, int(94, 99) - (i === 0 && k > 1 ? 3 : 0)), pain: int(0, 5),
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
      }]
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

  // 兩床清潔中
  beds.filter((b) => b.status === 'empty').slice(0, 2).forEach((b) => (b.status = 'cleaning'))

  void doctorUser

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
    boxes: [...new Set(udLines.map((l) => l.admissionId))].map((admissionId) => ({ admissionId, status: 'verified' as const, verifiedBy: 'U302', verifiedAt: udVerifiedAt })),
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
  const recvLoc = stockLocations.find((l) => l.receivesPurchase)!.id
  const opdLoc = stockLocations.find((l) => l.dispensesOpd)!.id
  const ipdLoc = stockLocations.find((l) => l.dispensesIpd)!.id
  for (const u of udDispenses) u.locationId = ipdLoc
  const safetyStocks: SafetyStock[] = []
  const realOut = new Map<string, { at: string; qty: number; ref: string }[]>()
  for (const d of dispenses.filter((x) => x.status === 'dispensed')) {
    const e = encounters.find((x) => x.id === d.encounterId)!
    for (const m of e.medications) {
      const list = realOut.get(m.drugId) ?? []
      list.push({ at: d.dispensedAt!, qty: m.qty, ref: `領藥號 ${d.pickupNo}` })
      realOut.set(m.drugId, list)
    }
  }
  drugs.forEach((drug, di) => {
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
    const events: ({ kind: 'lot'; at: string; lot: Omit<DrugLot, 'locationId'>; type: StockTxn['type']; ref?: string } | { kind: 'out'; at: string; qty: number; ref: string; loc?: string; line?: UdLine })[] = [
      { kind: 'lot' as const, at: `${addDays(T, -31)} 08:00`, type: 'opening' as const, lot: { id: id('LOT'), drugId: drug.id, lotNo: `L${String(year - 1).slice(2)}${String(di).padStart(3, '0')}A`, expiry: oldExpiry, qty: opening, receivedAt: `${addDays(T, -31)} 08:00` } },
      ...(receive > 0 ? [{ kind: 'lot' as const, at: receiveAt, type: 'receive' as const, ref: `PO${T.replace(/-/g, '').slice(2, 6)}${String(di).padStart(3, '0')}`, lot: { id: id('LOT'), drugId: drug.id, lotNo: `L${String(year).slice(2)}${String(di).padStart(3, '0')}B`, expiry: `${year + 2}-0${int(1, 9)}-28`, qty: receive, receivedAt: receiveAt } }] : []),
      // 大型：藥庫的備量比單一藥局多——一般的藥另外進一批（安全庫存 5 倍：撥給藥局後仍高於藥庫自己的 3 倍安全量；固定批號效期、不抽亂數）。
      // 示範用「偏低／缺貨」的藥不加：全院都短缺，門診藥局和藥庫才會一起顯示偏低（不然藥庫一直撥，藥局永遠不缺）
      ...(scale === 'large' && target === drug.stock
        ? [{ kind: 'lot' as const, at: `${addDays(T, -7)} 10:00`, type: 'receive' as const, ref: `PO${T.replace(/-/g, '').slice(2, 6)}${String(di).padStart(3, '0')}W`, lot: { id: id('LOT'), drugId: drug.id, lotNo: `L${String(year).slice(2)}${String(di).padStart(3, '0')}W`, expiry: `${year + 2}-06-30`, qty: drug.safetyStock * 5, receivedAt: `${addDays(T, -7)} 10:00` } }]
        : []),
      ...outs.map((o) => ({ kind: 'out' as const, ...o })),
    ].sort((a, b) => a.at.localeCompare(b.at))

    // 各地點的批號與結存（小型只有一個地點，recvLoc === opdLoc，行為和以前完全相同）
    const lots: DrugLot[] = []
    const balance: Record<string, number> = {}
    const at = (loc: string) => lots.filter((l) => l.locationId === loc)
    const post = (loc: string, type: StockTxn['type'], when: string, qty: number, moved: { lotNo: string; qty: number }[], ref?: string) => {
      balance[loc] = (balance[loc] ?? 0) + qty
      stockTxns.push({ id: id('ST'), drugId: drug.id, locationId: loc, at: when, type, qty, balance: balance[loc], lots: moved, ref, userId: 'U301' })
    }
    /** 從藥庫撥 qty 到 to（FEFO），兩筆異動同一個單號 */
    const transfer = (to: string, qty: number, when: string, ref: string) => {
      const takes = allocateFefo(at(recvLoc), qty, when)
      if (!takes) throw new Error(`種子資料撥補錯誤：${drug.id} 於 ${when} 藥庫可用量不足（需 ${qty}）`)
      for (const t of takes) lots.find((l) => l.id === t.lotId)!.qty -= t.qty
      post(recvLoc, 'transfer-out', when, -qty, takes.map((t) => ({ lotNo: t.lotNo, qty: -t.qty })), ref)
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
    let xfer = 0
    const xferRef = () => `撥補 TR${drug.id}-${String(++xfer).padStart(2, '0')}`
    for (const ev of events) {
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
    }
    drug.stock = Object.values(balance).reduce((a, b) => a + b, 0)
    drugLots.push(...lots)
    // 大型：藥庫要存得比藥局多（安全庫存 3 倍）；住院藥局只放少量注射劑
    if (scale === 'large') {
      safetyStocks.push({ locationId: 'LOC-WH', drugId: drug.id, qty: drug.safetyStock * 3 })
      if (drug.category === '注射') safetyStocks.push({ locationId: 'LOC-IPD', drugId: drug.id, qty: 5 })
    }
  })

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
    const outs = stockTxns.filter((t) => t.type === 'transfer-out').sort((x, y) => x.at.localeCompare(y.at))
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
  renumber(charges, (c) => visitById.get(c.visitId)!.date, (c) => c.paidAt, (c) => c.id, (c, n) => {
    c.receiptNo = `R${visitById.get(c.visitId)!.date.replace(/-/g, '')}${String(n).padStart(4, '0')}`
  })
  // 領藥號：同一天依開單（批價）時間
  renumber(dispenses, (d) => visitById.get(d.visitId)!.date, (d) => d.createdAt, (d) => d.id, (d, n) => (d.pickupNo = n))

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

  return {
    schema: 0, // 由 db.ts 填入目前的 SCHEMA_VERSION，版本號只定義在一個地方
    seededAt: T,
    users,
    departments: structuredClone(codes.departments),
    doctors: structuredClone(codes.doctors),
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
    vitals,
    nursingNotes,
    progressNotes,
    handovers,
    preventItems: structuredClone(codes.preventItems),
    preventRecords,
    auditLogs: [],
    counters,
  }
}
