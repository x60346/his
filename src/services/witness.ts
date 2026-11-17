// 第二人當場確認（見證、覆核）：管制藥點班要另一位護理師見證、報廢要另一位藥師（或管理者）覆核。
// 共用 witness-core（和優免主管核准同一套）：第二人輸入自己的帳號密碼、不能是自己、一次性、綁定對象與發起人、10 分鐘有效。
// 這裡只發「確認」；真正的點班（ward-stock.countWard）、報廢（inventory.scrapExpired / scrapQuarantine）帶著它送出才算數。
import { db } from '@/mock/db'
import { today } from '@/utils/date'
import { fail, must, mutate, requireUser } from './http'
import { find, nameOf, stockLoc } from './views'
import { residualOf } from './drug-rules'
import { expiredScrapRef, grantWitness, hasRole, pcaRef, quarantineScrapRef, returnScrapRef, transfusionRef, type WitnessResult } from './witness-core'
import { BLOOD_PRODUCT_LABEL, bloodTypeText, issueState, latestIssue } from './blood-rules'

export type WitnessTarget =
  /** 病房點班（含管制藥）：另一位護理師見證 */
  | { purpose: 'wardCount'; ward: string }
  /** 報廢某地點的過期批號：另一位藥師或管理者覆核 */
  | { purpose: 'scrapExpired'; drugId: string; locationId?: string }
  /** 報廢待報廢區的一個批號：另一位藥師或管理者覆核 */
  | { purpose: 'scrapQuarantine'; lotId: string }
  /** 門診退藥不可再用（退回後直接報廢）：另一位藥師或管理者覆核。items＝要報廢的品項說明（畫面上看得到的） */
  | { purpose: 'scrapReturn'; dispenseId: string; items: string }
  /** 管制藥殘餘量銷毀（給不是整數的劑量，整支扣、剩下的當場銷毀）：另一位護理師見證 */
  | { purpose: 'residual'; orderId: string }
  /** 床邊輸血雙人核對（病人、血型、血袋號、效期）：另一位護理師或醫師 */
  | { purpose: 'transfusion'; requestId: string; unitId: string }
  /** PCA 架設（藥袋、設定）與結束（剩餘量銷毀）：另一位護理師 */
  | { purpose: 'pca'; pcaId: string; stage: 'setup' | 'end' }

export type { WitnessResult }

/**
 * 第二人確認。帳密錯誤、資格不符、找自己確認都**回傳**失敗（不丟錯），失敗的嘗試也留在稽核。
 * 對象本身不對（病房沒有管制藥、沒有過期批號）才丟錯——那是發起的人的問題，不是第二人的。
 */
export function approveWitness(input: WitnessTarget & { username: string; password: string }): Promise<WitnessResult> {
  return mutate((): WitnessResult => {
    const cred = { username: input.username, password: input.password }
    if (input.purpose === 'wardCount') {
      const u = requireUser('nurse')
      const ward = input.ward
      const loc = stockLoc.ward(ward)
      if (!loc) fail(`「${ward}」沒有病房常備`)
      const ctrl = stockLoc.wardDrugIds(ward, loc!.id).map((id) => find.drug(id)).filter((d) => d?.controlled)
      if (!ctrl.length) fail(`${ward}的病房常備沒有管制藥，點班不需要見證`)
      return grantWitness({
        purpose: 'wardCount', refId: ward, actor: u, ...cred, who: '見證護理師',
        selfMessage: '不能見證自己的點班，請另一位護理師見證',
        qualifies: (w) => (hasRole(w, ['nurse']) ? null : `${w.name} 不是護理師，不能見證病房點班`),
        auditAction: '管制藥點班見證', verb: '見證', what: `${ward} 點班（管制藥：${ctrl.map((d) => d!.name).join('、')}；點班 ${u.name}）`,
      })
    }
    if (input.purpose === 'residual') {
      const u = requireUser('nurse')
      const o = must(db.ipdOrders.find((x) => x.id === input.orderId), '醫囑')
      const drug = must(find.drug(o.drugId ?? ''), '藥品')
      const r = residualOf(drug, o.dose)
      if (!r) fail('這筆醫囑沒有殘餘量要銷毀（不是管制藥、或劑量是整數）')
      if (o.status !== 'active') fail('這筆醫囑已停止或完成', 'CONFLICT')
      return grantWitness({
        purpose: 'residual', refId: o.id, actor: u, ...cred, who: '見證護理師',
        selfMessage: '不能見證自己的殘餘量銷毀，請另一位護理師見證',
        qualifies: (w) => (hasRole(w, ['nurse']) ? null : `${w.name} 不是護理師，不能見證殘餘量銷毀`),
        auditAction: '管制藥殘餘量見證', verb: '見證',
        what: `${nameOf.patient(find.admission(o.admissionId)?.patientId)} ${drug.name} 給 ${o.dose} ${drug.unit}、殘餘 ${r!.residual} ${drug.unit} 銷毀（給藥 ${u.name}）`,
      })
    }
    if (input.purpose === 'transfusion') {
      const u = requireUser('nurse')
      const r = must(db.bloodRequests.find((x) => x.id === input.requestId), '備血單')
      const unit = must(db.bloodUnits.find((x) => x.id === input.unitId), '血袋')
      const i = latestIssue(r, unit.id)
      if (!i || issueState(i) !== 'issued') fail('這袋不是「已發血、待輸血」，不用核對', 'CONFLICT')
      return grantWitness({
        purpose: 'transfusion', refId: transfusionRef(r.id, unit.id), actor: u, ...cred, who: '核對人',
        selfMessage: '輸血要兩個人核對，請另一位護理師或醫師核對',
        qualifies: (w) => (hasRole(w, ['nurse', 'doctor']) ? null : `${w.name} 不是護理師或醫師，不能核對輸血`),
        auditAction: '輸血雙人核對', verb: '核對',
        what: `${nameOf.patient(r.patientId)} ${r.no} 血袋 ${unit.unitNo} ${BLOOD_PRODUCT_LABEL[unit.product]} ${bloodTypeText(unit)}（輸血 ${u.name}）`,
      })
    }
    if (input.purpose === 'pca') {
      const u = requireUser('nurse')
      const p = must(db.pcas.find((x) => x.id === input.pcaId), 'PCA')
      if (input.stage === 'setup' && p.status !== 'ordered') fail('這筆 PCA 已經架設了', 'CONFLICT')
      if (input.stage === 'end' && p.status !== 'running') fail('這筆 PCA 沒有在使用中', 'CONFLICT')
      const drug = find.drug(p.drugId)
      return grantWitness({
        purpose: 'pca', refId: pcaRef(p.id, input.stage), actor: u, ...cred, who: '核對護理師',
        selfMessage: 'PCA 要兩個人核對，請另一位護理師核對',
        qualifies: (w) => (hasRole(w, ['nurse']) ? null : `${w.name} 不是護理師，不能核對 PCA`),
        auditAction: input.stage === 'setup' ? 'PCA 架設雙人核對' : 'PCA 剩餘量銷毀見證', verb: input.stage === 'setup' ? '核對' : '見證',
        what: `${nameOf.patient(find.admission(p.admissionId)?.patientId)} ${drug?.name ?? ''}（單次 ${p.bolusMg} mg、鎖定 ${p.lockoutMin} 分、每小時上限 ${p.hourLimitMg} mg、基礎 ${p.basalMgH} mg/h；${u.name}）`,
      })
    }
    const u = requireUser('pharmacist')
    const scrapRule = (w: Parameters<Parameters<typeof grantWitness>[0]['qualifies']>[0]) => (hasRole(w, ['pharmacist', 'admin']) ? null : `${w.name} 不是藥師或管理者，不能覆核報廢`)
    const base = { purpose: 'scrap' as const, actor: u, ...cred, who: '覆核人', selfMessage: '不能覆核自己的報廢，請另一位藥師覆核', qualifies: scrapRule, auditAction: '報廢覆核', verb: '覆核' }
    if (input.purpose === 'scrapExpired') {
      const loc = stockLoc.usable(input.locationId)
      const drug = must(find.drug(input.drugId), '藥品')
      const t = today()
      const expired = stockLoc.lots(drug.id, loc.id).filter((l) => l.qty > 0 && l.expiry < t)
      if (!expired.length) fail(`${loc.name}沒有已過期的批號`)
      return grantWitness({ ...base, refId: expiredScrapRef(drug.id, loc.id), what: `${drug.name} ${loc.name} 過期報廢 ${expired.reduce((n, l) => n + l.qty, 0)} ${drug.unit}（${u.name}）` })
    }
    if (input.purpose === 'scrapQuarantine') {
      const lot = must(db.drugLots.find((x) => x.id === input.lotId), '批號')
      if (db.stockLocations.find((l) => l.id === lot.locationId)?.kind !== 'quarantine') fail('這個批號不在待報廢區')
      if (lot.qty <= 0) fail('這個批號已經處理完了', 'CONFLICT')
      const drug = find.drug(lot.drugId)
      return grantWitness({ ...base, refId: quarantineScrapRef(lot.id), what: `${drug?.name} 批號 ${lot.lotNo} 待報廢區報廢 ${lot.qty} ${drug?.unit ?? ''}（${u.name}）` })
    }
    if (input.purpose === 'scrapReturn') {
      const d = must(db.dispenses.find((x) => x.id === input.dispenseId), '調劑單')
      if (d.status !== 'dispensed') fail('這張調劑單沒有可以退的藥', 'CONFLICT')
      return grantWitness({ ...base, refId: returnScrapRef(d.id), what: `領藥號 ${d.pickupNo} 退藥不可再用、報廢：${String(input.items ?? '').slice(0, 200)}（${u.name}）` })
    }
    fail('不支援的確認類型')
  })
}
