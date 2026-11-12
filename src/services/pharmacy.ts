// 門診藥局：調劑清單、核對、發藥（扣庫存）。
// 扣庫存一律透過 inventory.postStock：寫異動帳、依 FEFO 扣批號；這裡不直接改 drug.stock。
// 狀態：pending（待調劑）→ verified（已核對）→ dispensed（已發藥，掛號狀態同步為 dispensed）。
import type { Dispense, DispenseStatus, Drug } from '@/types'
import { db } from '@/mock/db'
import { now, today } from '@/utils/date'
import { audit, fail, fieldErrors, must, mutate, query, requireUser, sessionUser } from './http'
import { checkAllergies, type AllergyWarning } from './allergy'
import { doseUnitOf } from './billing'
import { postStock } from './inventory'
import { usableQty } from './stock-rules'
import { rxExpired, rxValidUntil } from './rx-rules'
import { timingText } from './drug-rules'
import { find, nameOf, patientBrief, type PatientBrief, stockLoc } from './views'

export interface DispenseItem {
  drugId: string
  drugName: string
  /** 中文名（藥袋、處方表） */
  drugNameZh: string
  spec: string
  /** 調劑單位（總量用） */
  unit: string
  /** 給藥單位（每次劑量用） */
  doseUnit: string
  dose: number
  freq: string
  freqLabel: string
  route: string
  days: number
  qty: number
  /** 可用庫存（未過期批號）——過期的藥在架上也不能發 */
  stock: number
  highAlert: boolean
  /** 服用時機（藥袋用完整句、處方表用短字；不必印為空字串）——規則見 drug-rules.timingText */
  timingText: string
  timingShort: string
  /** 作用或適應症、警語或副作用（藥袋用） */
  indication: string
  warning: string
  shortage: boolean
  /** 門診藥局正在盤點這種藥（盲盤）：stock 不給看（0），畫面顯示「盤點中」；缺藥判斷 shortage 仍用真的量 */
  counting?: string
  /** 這種藥有待到貨的補貨申請：申請量、尚欠、何時申請、這張單是否已在等待名單上 */
  restock?: { qty: number; outstanding: number; requestedAt: string; includesThis: boolean }
}

export interface DispenseView extends Dispense, PatientBrief {
  date: string
  doctorName: string
  deptName: string
  items: DispenseItem[]
  allergyWarnings: AllergyWarning[]
  diagnoses: string[]
  /** 慢箋第幾次調劑（一般看診沒有） */
  refillSeq?: number
  /**
   * 藥袋上的調劑藥師：核對過的印核對的藥師；還沒核對就先印（藥師常邊調劑邊印藥袋）印目前登入的藥師——他就是要調劑的人
   */
  pharmacistName: string
  /** 調劑日期：核對日；還沒核對就是今天 */
  dispenseDate: string
  /** 處方箋有效期最後一天（看診日起 3 日，見 rx-rules） */
  rxValidUntil: string
  /** 已逾有效期：還沒發的看今天，已發的看發藥那天（紀錄上看得出是逾期後才發的）。只提醒、不擋 */
  rxExpired: boolean
}

function dispenseView(d: Dispense): DispenseView {
  const e = must(db.encounters.find((x) => x.id === d.encounterId), '病歷')
  const p = find.patient(d.patientId)
  const items: DispenseItem[] = e.medications.map((m) => {
    const drug = find.drug(m.drugId)
    // 門診發藥的藥局（大型醫院藥庫裡有，不代表窗口發得出來）
    const usable = usableQty(stockLoc.lots(m.drugId, stockLoc.opd()), today())
    const req = db.restockRequests.find((x) => x.drugId === m.drugId && x.status === 'open')
    return {
      drugId: m.drugId,
      drugName: drug?.name ?? m.drugId,
      drugNameZh: drug?.nameZh ?? '',
      spec: drug?.spec ?? '',
      unit: drug?.unit ?? '',
      doseUnit: drug ? doseUnitOf(drug) : '',
      dose: m.dose,
      freq: m.freq,
      freqLabel: find.freq(m.freq)?.label ?? m.freq,
      route: m.route,
      days: m.days,
      qty: m.qty,
      stock: stockLoc.counting(m.drugId, stockLoc.opd()) ? 0 : usable,
      ...(stockLoc.counting(m.drugId, stockLoc.opd()) ? { counting: stockLoc.counting(m.drugId, stockLoc.opd()) } : {}),
      highAlert: drug?.highAlert ?? false,
      timingText: timingText(drug?.timing, m.freq, m.route),
      timingShort: timingText(drug?.timing, m.freq, m.route, true),
      indication: drug?.indication ?? '',
      warning: drug?.warning ?? '',
      shortage: d.status !== 'dispensed' && usable < m.qty,
      ...(req ? { restock: { qty: req.qty, outstanding: Math.max(0, req.qty - req.receivedQty), requestedAt: req.requestedAt, includesThis: req.dispenseIds.includes(d.id) } } : {}),
    }
  })
  const drugs = e.medications.map((m) => find.drug(m.drugId)).filter((x): x is Drug => !!x)
  return {
    ...d,
    ...patientBrief(d.patientId),
    date: e.date,
    doctorName: nameOf.doctor(e.doctorId),
    deptName: nameOf.dept(e.deptId),
    items,
    allergyWarnings: checkAllergies(p?.allergies ?? [], drugs),
    diagnoses: e.diagnoses.map((x) => `${x.icd} ${x.name}`),
    refillSeq: find.visit(d.visitId)?.refillSeq,
    pharmacistName: d.verifiedBy ? nameOf.user(d.verifiedBy) : sessionUser()?.roles.includes('pharmacist') ? sessionUser()!.name : '',
    dispenseDate: d.verifiedAt?.slice(0, 10) ?? today(),
    rxValidUntil: rxValidUntil(e.date),
    rxExpired: rxExpired(e.date, d.dispensedAt ?? today()),
  }
}

/**
 * 某一天的調劑清單：
 *   待調劑／已核對：當天「以前（含）」開立、還沒發藥的——沒做完的工作要一直帶著走，
 *     以前只看「開立當天」，昨天批價沒領的病人今天回來，清單上找不到他。
 *   已發藥：當天「發出」的（依發藥時間，不是開立日）——昨天的單今天才領，算今天的工作量。
 * 排序：當天開立的在前（依領藥號），前幾天的接在後面（依日期、領藥號）——窗口前的人優先。
 */
/** 這一天還等著領藥的單：當天以前（含）開立、還沒發藥。藥局清單與首頁「待領藥」共用 */
export const awaitingPickup = (d: Pick<Dispense, 'status' | 'createdAt'>, date: string) => d.status !== 'dispensed' && d.createdAt.slice(0, 10) <= date

export function listDispenses(q: { date: string; status?: DispenseStatus[] }): Promise<DispenseView[]> {
  return query(() =>
    db.dispenses
      .filter((d) => (d.status === 'dispensed' ? !!d.dispensedAt?.startsWith(q.date) : awaitingPickup(d, q.date)))
      .filter((d) => !q.status || q.status.includes(d.status))
      .sort((a, b) => {
        const da = a.createdAt.slice(0, 10)
        const db_ = b.createdAt.slice(0, 10)
        return Number(da !== q.date) - Number(db_ !== q.date) || da.localeCompare(db_) || a.pickupNo - b.pickupNo
      })
      .map(dispenseView),
  )
}

export const getDispense = (id: string): Promise<DispenseView> => query(() => dispenseView(must(db.dispenses.find((d) => d.id === id), '調劑單')))

function assertStock(view: DispenseView): void {
  // 用 shortage（真的可用量算的），不用 stock——盤點中 stock 被遮成 0，拿它判斷會把有貨的藥擋下
  const short = view.items.filter((i) => i.shortage)
  if (short.length) fail(`庫存不足：${short.map((i) => `${i.drugName}（需 ${i.qty}${i.counting ? '，盤點中' : `，存 ${i.stock}`}）`).join('、')}`, 'CONFLICT')
}

/** 核對處方（第一位藥師） */
export function verifyDispense(id: string): Promise<DispenseView> {
  return mutate(() => {
    const ph = requireUser('pharmacist')
    const d = must(db.dispenses.find((x) => x.id === id), '調劑單')
    if (d.status !== 'pending') fail('此單已核對', 'CONFLICT')
    assertStock(dispenseView(d))
    d.status = 'verified'
    d.verifiedBy = ph.id
    d.verifiedAt = now()
    audit('調劑核對', `領藥號 ${d.pickupNo}`)
    return dispenseView(d)
  })
}

/** 發藥：扣庫存 → 調劑單 dispensed → 掛號 dispensed（整筆交易，任一藥不足就全部不扣） */
/**
 * 發藥前的身分確認：請病人說出出生月日（4 碼，例 0314），藥師輸入，由這裡比對；或他人代領（記代領人姓名與關係）。
 * 「發錯人」是藥局最主要的風險之一。生日在病人資料列上本來就看得到（藥師要拿來比對），
 * 這一步的用意是逼藥師真的開口問——以前按「發藥」就交出去了，中間沒有任何核對。
 */
export interface PickupCheckInput {
  proxy?: boolean
  birthMMDD?: string
  proxyName?: string
  relation?: string
}

export function dispense(id: string, check: PickupCheckInput = {}): Promise<DispenseView> {
  return mutate(() => {
    const ph = requireUser('pharmacist')
    const d = must(db.dispenses.find((x) => x.id === id), '調劑單')
    if (d.status !== 'verified') fail('請先完成核對再發藥', 'CONFLICT')
    const p = must(find.patient(d.patientId), '病患')
    const v = fieldErrors()
    if (check.proxy) {
      if (!check.proxyName?.trim()) v.add('proxyName', '請輸入代領人姓名')
      if (!check.relation?.trim()) v.add('relation', '請輸入代領人與病人的關係')
    } else if (!/^\d{4}$/.test(check.birthMMDD ?? '')) {
      v.add('birthMMDD', '請輸入病人說出的出生月日（4 碼，例 0314）')
    } else if (check.birthMMDD !== p.birthDate.slice(5).replace('-', '')) {
      v.add('birthMMDD', '與病人資料不符，請再確認領藥的是不是本人')
    }
    v.done()
    d.pickupCheck = check.proxy ? { method: 'proxy', proxyName: check.proxyName!.trim(), relation: check.relation!.trim() } : { method: 'birth' }
    const view = dispenseView(d)
    assertStock(view)
    // 每個品項寫一筆發藥異動；任何一項失敗，mutate 會整筆回滾（不會只扣一半）
    for (const item of view.items) postStock({ kind: 'out', type: 'dispense', drugId: item.drugId, locationId: stockLoc.opd(), qty: item.qty, ref: `領藥號 ${d.pickupNo}` }, ph.id)
    d.status = 'dispensed'
    d.dispensedBy = ph.id
    d.dispensedAt = now()
    must(find.visit(d.visitId), '掛號紀錄').status = 'dispensed'
    // 逾期處方不擋，但發出去要留紀錄：日後查得到是藥師知情下發的
    const late = view.rxExpired ? `（處方已逾有效期：${view.date} 開立、有效至 ${view.rxValidUntil}）` : ''
    audit('發藥', `領藥號 ${d.pickupNo} ${view.patientName}（${check.proxy ? `代領：${d.pickupCheck.proxyName}／${d.pickupCheck.relation}` : '本人，核對生日'}）${late}`)
    return dispenseView(d)
  })
}
