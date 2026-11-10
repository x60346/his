// 產生展示資料：以「今天」為基準，讓任何時候開啟都有今日門診、住院中病人等情境。
// 使用固定種子的亂數，每次重置結果相同。所有人名、證號皆為虛構。
import type {
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
  Patient,
  Period,
  PreventRecord,
  ProcedureOrder,
  ProgressNote,
  StockTxn,
  User,
  Visit,
  VitalRecord,
  WeeklySlot,
} from '@/types'
import { addDays, addMinutes, ageOf, now, parseDate, toDateStr, today } from '@/utils/date'
import { autoQty, calcChargeLines, summarize } from '@/services/billing'
import { checkAllergies } from '@/services/allergy'
import { checkEligibility } from '@/services/prevent-rules'
import { allocateFefo } from '@/services/stock-rules'
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
  meds: [drugId: string, dose: number, freq: string, days: number][]
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
    dept: 'D02', icd: ['E11.9', 'I10'], s: '糖尿病追蹤，飲食控制中，偶有口渴。', o: 'AC sugar 142 mg/dL。', a: '第二型糖尿病，血糖控制略高', p: '調整 Metformin，衛教飲食，追蹤 HbA1c。',
    meds: [['M015', 1, 'BID', 28], ['M016', 1, 'QD', 28], ['M013', 1, 'QD', 28]], procs: ['P004', 'P005'], caseType: '04',
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

export function buildSeed(): Database {
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
  const counters: Record<string, number> = {}
  const next = (key: string) => (counters[key] = (counters[key] ?? 0) + 1)
  let idn = 0
  const id = (prefix: string) => `${prefix}${String(++idn).padStart(5, '0')}`

  // ---------- 使用者 ----------
  const users: User[] = [
    { id: 'U001', username: 'admin', password: '1234', name: '系統管理員', role: 'admin', active: true },
    ...codes.doctors.map((d, i): User => ({
      id: `U1${String(i + 1).padStart(2, '0')}`, username: `dr${String(i + 1).padStart(2, '0')}`, password: '1234',
      name: d.name, role: 'doctor', doctorId: d.id, active: true,
    })),
    { id: 'U201', username: 'nurse01', password: '1234', name: '周怡萱', role: 'nurse', active: true },
    { id: 'U202', username: 'nurse02', password: '1234', name: '孫佩君', role: 'nurse', active: true },
    { id: 'U301', username: 'ph01', password: '1234', name: '方建志', role: 'pharmacist', active: true },
    { id: 'U401', username: 'clerk01', password: '1234', name: '馬文琪', role: 'clerk', active: true },
  ]
  const doctorUser = (doctorId: string) => users.find((u) => u.doctorId === doctorId)!.id

  // ---------- 每週門診表 ----------
  // 家醫、內科、小兒科週日也有上午診，確保任何一天都有門診可展示
  const weeklySlots: WeeklySlot[] = []
  const room = (deptIdx: number, k: number) => `${deptIdx + 1}0${k + 1}`
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
  const drugMap = new Map(codes.drugs.map((d) => [d.id, d]))
  const procMap = new Map(codes.procedures.map((p) => [p.id, p]))
  const identityMap = new Map(codes.identities.map((x) => [x.code, x]))
  const freqTimes = (f: string) => codes.frequencies.find((x) => x.code === f)?.timesPerDay ?? 1

  const makeVisit = (patient: Patient, session: ClinicSession, status: Visit['status'], hour: number, caseType = '01'): Visit => {
    const seqKey = `seq:${session.id}`
    const v: Visit = {
      id: id('V'), date: session.date, sessionId: session.id, deptId: session.deptId, doctorId: session.doctorId,
      patientId: patient.id, seqNo: next(seqKey), identityCode: patient.defaultIdentity, caseType,
      cardSeq: String(next(`cardseq:${patient.id}`)).padStart(4, '0'), status, firstVisit: false, preventItems: [],
      createdAt: notFuture(`${session.date} ${String(hour).padStart(2, '0')}:${String(int(0, 59)).padStart(2, '0')}`, 120),
    }
    visits.push(v)
    return v
  }

  const makeEncounter = (v: Visit, sc: Scenario, completed: boolean): Encounter => {
    const pt = patients.find((p) => p.id === v.patientId)!
    // 展示資料也要遵守用藥安全：避開病人過敏的藥（與看診畫面使用同一個 checkAllergies 規則）
    const conflicts = new Set(checkAllergies(pt.allergies, sc.meds.map(([id]) => drugMap.get(id)!)).map((w) => w.drugId))
    const safeMeds = sc.meds.filter(([id]) => !conflicts.has(id))
    if (conflicts.size && !safeMeds.some(([id]) => id === 'M001')) safeMeds.push(['M001', 1, 'TID', sc.meds[0][3]])
    const meds: MedicationOrder[] = safeMeds.map(([drugId, dose, freq, days]) => {
      const d = drugMap.get(drugId)!
      return { drugId, dose, freq, route: d.defaultRoute, days, qty: autoQty(d, dose, freqTimes(freq), days) ?? 1, selfPay: false }
    })
    const procs: ProcedureOrder[] = (sc.procs ?? []).map((procId) => ({ procId, qty: 1, selfPay: false }))
    const adult = pt.birthDate < addDays(T, -365 * 12)
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
      completedAt: completed ? notFuture(addMinutes(v.createdAt, int(10, 40)), 60) : undefined,
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

  const makeDispense = (v: Visit, e: Encounter, status: Dispense['status'], at: string) => {
    const d: Dispense = {
      id: id('DP'), visitId: v.id, encounterId: e.id, patientId: v.patientId,
      pickupNo: next(`pickup:${v.date}`), status, createdAt: at,
      ...(status !== 'pending' ? { verifiedBy: 'U301', verifiedAt: at } : {}),
      ...(status === 'dispensed' ? { dispensedBy: 'U301', dispensedAt: at } : {}),
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
      const v = makeVisit(pt, session, 'dispensed', session.period === 'AM' ? int(8, 11) : int(13, 16), sc.caseType)
      const e = makeEncounter(v, sc, true)
      const at = `${date} ${String(Number(v.createdAt.slice(11, 13)) + 1).padStart(2, '0')}:10`
      makeCharge(v, e, at)
      makeDispense(v, e, 'dispensed', at)
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
      const v = makeVisit(pt, session, 'dispensed', session.period === 'AM' ? int(8, 11) : int(13, 16), sc.caseType)
      const e = makeEncounter(v, sc, true)
      const at = `${date} ${String(Number(v.createdAt.slice(11, 13)) + 1).padStart(2, '0')}:10`
      makeCharge(v, e, at)
      makeDispense(v, e, 'dispensed', at)
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
  for (const [pi, period, dept, status] of todayPlan) {
    const pt = opdPatients[pi]
    const session = period === 'AM' ? amFirst(dept) : pmFirst(dept)
    if (!session) continue
    const sc = scenarioFor(session.deptId)
    const v = makeVisit(pt, session, status, period === 'AM' ? 8 : 13, sc.caseType ?? '01')
    if (status === 'consulted' || status === 'charged' || status === 'dispensed') {
      const e = makeEncounter(v, sc, true)
      if (status !== 'consulted') {
        makeCharge(v, e, notFuture(`${T} 10:${String(int(10, 59)).padStart(2, '0')}`, 30))
        makeDispense(v, e, status === 'dispensed' ? 'dispensed' : 'pending', notFuture(`${T} 10:30`, 10))
      }
    }
  }

  // 未來預約掛號
  for (let k = 0; k < 8; k++) {
    const date = addDays(T, int(1, 10))
    const pt = opdPatients[int(0, 23)]
    const session = sessionFor(pt, sessionsOn(date))
    // 同一位病人同一診次不重複掛號
    if (!session || visits.some((v) => v.sessionId === session.id && v.patientId === pt.id)) continue
    makeVisit(pt, session, 'registered', 9)
  }

  // 預防保健紀錄
  const prevent = (pt: Patient, itemCode: string, daysAgo: number, result: PreventRecord['result'], data: Record<string, string>) => {
    preventRecords.push({ id: id('PR'), patientId: pt.id, itemCode, date: addDays(T, -daysAgo), doctorId: 'DR01', result, data })
  }
  prevent(patients[0], 'ADULT', 420, '異常需追蹤', { 血壓: '146/92', 空腹血糖: '108', 總膽固醇: '232', BMI: '26.1' })
  prevent(patients[1], 'BREAST', 900, '正常', { 報告: 'BI-RADS 1' })
  prevent(patients[3], 'ADULT', 300, '正常', { 血壓: '128/80', 空腹血糖: '96', 總膽固醇: '188', BMI: '23.4' })
  prevent(patients[7], 'COLON', 500, '正常', { 糞便潛血: '陰性' })
  prevent(patients[8], 'LUNG', 400, '異常需追蹤', { 報告: 'Lung-RADS 3，6 個月後追蹤' })
  prevent(patients[5], 'CERVIX', 200, '正常', { 報告: 'NILM' })
  prevent(patients[21], 'BCLIVER', 700, '正常', { HBsAg: '陰性', 'Anti-HCV': '陰性' })

  // 近半年的服務紀錄（統計用）：每一筆都先經過 checkEligibility，展示資料不能出現「不符資格卻做了」的紀錄
  const sampleData: Record<string, () => [PreventRecord['result'], Record<string, string>]> = {
    ADULT: () => (rand() < 0.3 ? ['異常需追蹤', { 血壓: `${int(140, 160)}/${int(88, 98)}`, 空腹血糖: String(int(100, 130)), BMI: '27.2' }] : ['正常', { 血壓: `${int(110, 135)}/${int(70, 85)}`, 空腹血糖: String(int(80, 99)), BMI: '22.8' }]),
    CERVIX: () => ['正常', { 報告: 'NILM' }],
    BREAST: () => (rand() < 0.15 ? ['異常需追蹤', { 報告: 'BI-RADS 0，需進一步檢查' }] : ['正常', { 報告: 'BI-RADS 1' }]),
    COLON: () => (rand() < 0.1 ? ['異常需追蹤', { 糞便潛血: '陽性，轉介大腸鏡' }] : ['正常', { 糞便潛血: '陰性' }]),
    ORAL: () => ['正常', { 檢查結果: '未見異常' }],
    LUNG: () => (rand() < 0.2 ? ['異常需追蹤', { 報告: 'Lung-RADS 3' }] : ['正常', { 報告: 'Lung-RADS 1' }]),
    BCLIVER: () => ['正常', { HBsAg: '陰性', 'Anti-HCV': '陰性' }],
    CHILD: () => ['正常', { 發展評估: '正常' }],
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
    preventRecords.push({ id: id('PR'), patientId: pt.id, itemCode: item.code, date, doctorId: pick(['DR01', 'DR02', 'DR03']), result: pendingReport ? '待報告' : result, data: pendingReport ? {} : data })
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
    preventRecords.push({ id: id('PR'), patientId: doneVisit.patientId, itemCode: code, date: T, visitId: doneVisit.id, doctorId: doneVisit.doctorId, result, data })
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
    meds: [drugId: string, dose: number, freq: string, route: string][]
    prn?: [drugId: string, dose: number, route: string][]
    nursing: string[]
  }
  const ipdScenarios: IpdScenario[] = [
    { dept: 'D02', doctor: 'DR02', dx: 'J18.9 肺炎', reason: '發燒咳嗽、血氧偏低', diet: '普通飲食', meds: [['M036', 1, 'Q12H', 'IV'], ['M037', 1, 'QD', 'IV'], ['M010', 1, 'TID', 'PO']], prn: [['M001', 1, 'PO']], nursing: ['Vital signs Q4H', '監測血氧，SpO2 < 92% 給予氧氣'] },
    { dept: 'D02', doctor: 'DR03', dx: 'E11.65 糖尿病伴高血糖', reason: '血糖控制不佳', diet: '糖尿病飲食 1800 kcal', meds: [['M015', 1, 'BID', 'PO'], ['M038', 10, 'HS', 'SC']], nursing: ['AC/HS 血糖監測', '糖尿病衛教'] },
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
    if (!f || !f.times.length) return
    for (const t of f.times) {
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
    sc.meds.forEach(([drugId, dose, freq, route]) => {
      const d = drugMap.get(drugId)!
      const o: IpdOrder = {
        id: id('IO'), admissionId: adm.id, type: 'long', category: 'medication', drugId, content: d.name, dose, freq, route,
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
    ipdOrders.push({ id: id('IO'), admissionId: adm.id, type: 'stat', category: 'procedure', procId: 'P003', content: '全套血液檢查 CBC', startAt, status: 'done', doctorId: docUser, createdAt: startAt })
    ipdOrders.push({ id: id('IO'), admissionId: adm.id, type: 'stat', category: 'procedure', procId: 'P013', content: '胸部 X 光', startAt, status: 'done', doctorId: docUser, createdAt: startAt })

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
      progressNotes.push({
        id: id('PN'), admissionId: adm.id, at: `${addDays(T, -k)} 08:30`, doctorId: sc.doctor,
        subjective: k === 0 ? '病人自覺症狀改善，食慾恢復中。' : '病人仍有不適，夜間睡眠普通。',
        objective: febrile && k > 1 ? '體溫 38.0°C，心跳 98。' : '生命徵象穩定。',
        assessment: sc.dx,
        plan: k === 0 ? '續目前治療，評估出院時程。' : '續目前治療，追蹤檢驗數據。',
      })
    }
  })

  // 已出院（歷史）
  for (let k = 0; k < 4; k++) {
    const pt = patients[int(0, 23)]
    const admitDate = addDays(T, -int(20, 90))
    admissions.push({
      id: id('A'), admitNo: `I${admitDate.replace(/-/g, '').slice(2)}${String(next('admitNo')).padStart(3, '0')}`,
      patientId: pt.id, deptId: 'D02', doctorId: 'DR02', preferBedClass: '健保床', reason: '肺炎', diagnosis: 'J18.9 肺炎',
      status: 'discharged', reservedAt: `${admitDate} 09:00`, expectedDate: admitDate, admittedAt: `${admitDate} 14:00`,
      dischargedAt: `${addDays(admitDate, int(3, 8))} 11:00`, dischargeType: '治癒出院',
      dischargeSummary: '住院期間給予抗生素治療，症狀改善，生命徵象穩定，准予出院，一週後門診追蹤。',
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

  // ---------- 藥品庫存帳 ----------
  // 用「重播」產生：期初 → 進貨 → 每日發藥，依時間順序、用與服務層相同的 FEFO 規則扣批號。
  // 這樣產生的帳，結存、批號、異動一定對得起來；最後的庫存約等於 codes 裡設定的目標值。
  const drugs = structuredClone(codes.drugs)
  const drugLots: DrugLot[] = []
  const stockTxns: StockTxn[] = []
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
    ]
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
    const events: ({ kind: 'lot'; at: string; lot: DrugLot; type: StockTxn['type']; ref?: string } | { kind: 'out'; at: string; qty: number; ref: string })[] = [
      { kind: 'lot' as const, at: `${addDays(T, -31)} 08:00`, type: 'opening' as const, lot: { id: id('LOT'), drugId: drug.id, lotNo: `L${String(year - 1).slice(2)}${String(di).padStart(3, '0')}A`, expiry: oldExpiry, qty: opening, receivedAt: `${addDays(T, -31)} 08:00` } },
      ...(receive > 0 ? [{ kind: 'lot' as const, at: receiveAt, type: 'receive' as const, ref: `PO${T.replace(/-/g, '').slice(2, 6)}${String(di).padStart(3, '0')}`, lot: { id: id('LOT'), drugId: drug.id, lotNo: `L${String(year).slice(2)}${String(di).padStart(3, '0')}B`, expiry: `${year + 2}-0${int(1, 9)}-28`, qty: receive, receivedAt: receiveAt } }] : []),
      ...outs.map((o) => ({ kind: 'out' as const, ...o })),
    ].sort((a, b) => a.at.localeCompare(b.at))

    let balance = 0
    const lots: DrugLot[] = []
    for (const ev of events) {
      if (ev.kind === 'lot') {
        lots.push(ev.lot)
        balance += ev.lot.qty
        stockTxns.push({ id: id('ST'), drugId: drug.id, at: ev.at, type: ev.type, qty: ev.lot.qty, balance, lots: [{ lotNo: ev.lot.lotNo, qty: ev.lot.qty }], ref: ev.ref, userId: 'U301' })
        continue
      }
      const takes = allocateFefo(lots, ev.qty, ev.at)
      // 不足就直接報錯：之前這裡是「默默略過」，結果期初之前的舊發藥被略過卻仍算進總量，期初多出 120 都沒人發現
      if (!takes) throw new Error(`種子資料庫存帳錯誤：${drug.id} 於 ${ev.at} 可用量不足（需 ${ev.qty}）`)
      for (const t of takes) lots.find((l) => l.id === t.lotId)!.qty -= t.qty
      balance -= ev.qty
      stockTxns.push({ id: id('ST'), drugId: drug.id, at: ev.at, type: 'dispense', qty: -ev.qty, balance, lots: takes.map((t) => ({ lotNo: t.lotNo, qty: -t.qty })), ref: ev.ref, userId: 'U301' })
    }
    drug.stock = balance
    drugLots.push(...lots)
  })

  return {
    schema: 0, // 由 db.ts 填入目前的 SCHEMA_VERSION，版本號只定義在一個地方
    seededAt: T,
    users,
    departments: structuredClone(codes.departments),
    doctors: structuredClone(codes.doctors),
    identities: structuredClone(codes.identities),
    billingSettings: structuredClone(codes.billingSettings),
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
