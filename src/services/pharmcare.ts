// 藥事照護紀錄（臨床藥師查房）：藥師在「住院藥局 > 藥事照護」看住院病人（診斷、過敏、腎功能、在用的藥），對病人寫建議
// （劑量調整、建議監測、交互作用處理、停用不必要的藥、其他）；主治首頁「藥師建議待回覆」，在住院醫囑「藥事照護」分頁接受或不接受（寫原因）。
// 和藥師審核（一筆醫囑能不能用）不同：這是對病人的主動建議，不綁醫囑、不擋給藥。規則在 pharmcare-rules
import type { PharmCareKind, PharmCareNote } from '@/types'
import { db, newId } from '@/mock/db'
import { addDays, now } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requireUser } from './http'
import { checkPharmCareInput, PHARMCARE_KIND_LABEL, PHARMCARE_STATUS_LABEL, pharmCareStats, type PharmCareStat } from './pharmcare-rules'
import { renalOf } from './renal-work'
import { requireCare } from './care-team'
import { find, nameOf } from './views'

export interface PharmCareView extends PharmCareNote {
  kindLabel: string
  statusLabel: string
  byName: string
  replyByName?: string
  patientName: string
  bedNo: string
}
const view = (x: PharmCareNote): PharmCareView => {
  const a = find.admission(x.admissionId)
  return {
    ...x, kindLabel: PHARMCARE_KIND_LABEL[x.kind], statusLabel: PHARMCARE_STATUS_LABEL[x.status], byName: nameOf.user(x.by),
    ...(x.reply ? { replyByName: nameOf.user(x.reply.by) } : {}), patientName: nameOf.patient(x.patientId), bedNo: find.bed(a?.bedId ?? '')?.bedNo ?? '',
  }
}

export interface PharmCarePatient {
  admissionId: string
  bedNo: string
  patientName: string
  diagnosis: string
  attendingName: string
  allergies: string[]
  renal: string
  /** 執行中的給藥醫囑 */
  meds: string[]
  /** 這位病人待主治回覆的建議數 */
  pending: number
}

/** 藥師的藥事照護頁：住院中的病人（床號序）、最近 30 天的建議、依類型統計 */
export function listPharmCare(): Promise<{ patients: PharmCarePatient[]; notes: PharmCareView[]; stats: PharmCareStat[] }> {
  return query(() => {
    requireUser('pharmacist')
    const since = addDays(now().slice(0, 10), -29)
    const recent = db.pharmCareNotes.filter((x) => x.at.slice(0, 10) >= since)
    const patients = db.admissions
      .filter((a) => a.status === 'admitted' && !a.obs)
      .map((a): PharmCarePatient => ({
        admissionId: a.id, bedNo: find.bed(a.bedId ?? '')?.bedNo ?? '', patientName: nameOf.patient(a.patientId), diagnosis: a.diagnosis, attendingName: nameOf.doctor(a.doctorId),
        allergies: find.patient(a.patientId)?.allergies ?? [], renal: renalOf(a.id).text,
        meds: db.ipdOrders.filter((o) => o.admissionId === a.id && o.status === 'active' && o.category === 'medication').map((o) => `${o.content} 每次 ${o.dose} ${o.freq} ${o.route}`),
        pending: db.pharmCareNotes.filter((x) => x.admissionId === a.id && x.status === 'sent').length,
      }))
      .sort((x, y) => x.bedNo.localeCompare(y.bedNo))
    return { patients, notes: [...recent].sort((a, b) => b.at.localeCompare(a.at)).map(view), stats: pharmCareStats(recent) }
  })
}

/** 病人分頁：這次住院的藥事照護紀錄（醫師、護理師、藥師都看得到） */
export function patientPharmCare(admissionId: string): Promise<{ admissionId: string; notes: PharmCareView[] }> {
  return query(() => {
    requireUser('doctor', 'nurse', 'pharmacist')
    must(find.admission(admissionId), '住院紀錄')
    return { admissionId, notes: db.pharmCareNotes.filter((x) => x.admissionId === admissionId).sort((a, b) => b.at.localeCompare(a.at)).map(view) }
  })
}

/** 藥師寫建議（住院中的病人） */
export function addPharmCare(admissionId: string, input: { kind: PharmCareKind; text: string }): Promise<PharmCareView> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const a = must(find.admission(admissionId), '住院紀錄')
    if (a.status !== 'admitted') fail('病人不在住院中', 'CONFLICT')
    failFields(checkPharmCareInput(input))
    const x: PharmCareNote = { id: newId('PC'), admissionId: a.id, patientId: a.patientId, kind: input.kind, text: input.text.trim(), by: u.id, at: now(), status: 'sent' }
    db.pharmCareNotes.push(x)
    audit('藥事照護建議', `${a.admitNo} ${nameOf.patient(a.patientId)}【${PHARMCARE_KIND_LABEL[x.kind]}】${x.text}`)
    return view(x)
  })
}

/** 主治（照護團隊）回覆：接受（可寫怎麼處理）或不接受（要寫原因） */
export function replyPharmCare(id: string, input: { accept: boolean; text?: string }): Promise<PharmCareView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const x = must(db.pharmCareNotes.find((n) => n.id === id), '藥事照護建議')
    if (x.status !== 'sent') fail(`這則建議已經回覆過（${PHARMCARE_STATUS_LABEL[x.status]}）`, 'CONFLICT')
    const a = must(find.admission(x.admissionId), '住院紀錄')
    requireCare(u.doctorId, a, '回覆藥師建議', { consult: false })
    const text = input.text?.trim() ?? ''
    if (!input.accept && !text) failField('text', '不接受要寫原因（例：病人臨床穩定，暫時維持）')
    Object.assign(x, { status: input.accept ? 'accepted' : 'declined', reply: { by: u.id, at: now(), text: text || '接受' } })
    audit(input.accept ? '接受藥師建議' : '不接受藥師建議', `${a.admitNo}【${PHARMCARE_KIND_LABEL[x.kind]}】${x.text}${text ? `：${text}` : ''}`)
    return view(x)
  })
}
