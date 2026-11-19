// 麻醉：麻醉前評估（有「麻醉」權限的醫師）。沒有評估不能做麻醉前查核（surgery.recordCheck 擋）。
// 規則在 anesthesia-rules（純函式）；手術的畫面資料在 surgery-work
import type { AnesHistoryKey, AnesthesiaType, AsaClass, NpoStatus, PreAnesthesia } from '@/types'
import { now } from '@/utils/date'
import { audit, fail, failFields, must, mutate, requirePermission, requireUser } from './http'
import { asaText, checkPreAnes, difficultAirway, type PreAnesInput } from './anesthesia-rules'
import { ANESTHESIA_LABEL, SIDE_LABEL } from './surgery-rules'
import { surgeryOf, surgeryView, type SurgeryView } from './surgery-work'
import { find, nameOf } from './views'

/** 存麻醉前評估（可以重存：精簡版事後補成完整版、病人狀況改變） */
export function savePreAnes(surgeryId: string, input: PreAnesInput): Promise<SurgeryView> {
  return mutate(() => {
    requireUser('doctor')
    const u = requirePermission('anesthesia')
    const s = must(surgeryOf(surgeryId), '手術')
    if (s.status === 'cancelled') fail('手術已取消', 'CONFLICT')
    if (s.status === 'in-progress' || s.status === 'done') fail('手術已經開始，麻醉前評估不能再改', 'CONFLICT')
    const t = now()
    const requested = s.preAnes?.changedFrom ?? s.anesthesia
    failFields(checkPreAnes(input, { urgent: !!s.urgency, requested, at: t }))
    const airway = { mallampati: Number(input.airway!.mallampati) as 1 | 2 | 3 | 4, mouth: input.airway!.mouth as 'ok' | 'limited', neck: input.airway!.neck as 'ok' | 'limited', ...(input.airway!.note?.trim() ? { note: input.airway!.note.trim() } : {}) }
    const plan = input.brief ? undefined : (input.plan as AnesthesiaType)
    const p: PreAnesthesia = {
      asa: Number(input.asa) as AsaClass, emergency: !!s.urgency, airway, difficult: difficultAirway(airway),
      npo: { status: input.npo!.status as NpoStatus, ...(input.npo!.status !== 'unknown' ? { lastIntake: input.npo!.lastIntake } : {}) },
      ...(input.brief ? { brief: true } : { history: { items: [...new Set(input.history!.items as AnesHistoryKey[])], ...(input.history!.note?.trim() ? { note: input.history!.note.trim() } : {}) }, plan }),
      ...(plan && plan !== requested ? { planReason: input.planReason!.trim(), changedFrom: requested } : {}),
      by: u.id, at: t,
    }
    const again = !!s.preAnes
    s.preAnes = p
    // 計畫的麻醉方式就是這台手術的麻醉方式（麻醉費照這個）；改回申請的就還原
    if (plan) s.anesthesia = plan
    audit(again ? '修改麻醉前評估' : '麻醉前評估', `${s.no} ${nameOf.patient(s.patientId)} ${find.procedure(s.procId)?.name ?? ''}（${SIDE_LABEL[s.side]}）：${asaText(p)}${p.difficult ? '、困難插管' : ''}${p.brief ? '、精簡版' : ''}${plan ? `、${ANESTHESIA_LABEL[plan]}${p.changedFrom ? `（原申請${ANESTHESIA_LABEL[p.changedFrom]}：${p.planReason}）` : ''}` : ''}`)
    return surgeryView(s)
  })
}
