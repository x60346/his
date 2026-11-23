// 疼痛與管路的內部工具（index 不匯出、不會被包成 API）：護理站清單、本班待辦、首頁待辦、出院共用。規則在 line-rules
import type { Admission, LineDevice } from '@/types'
import { db } from '@/mock/db'
import { shiftRange } from './nursing-rules'
import { pcaPainRecords } from './pca-work'
import { CHEST_BLEED_MLH, CHEST_RECORD_HOURS, lineKind, lineState, painState, PIVC_REPLACE_HOURS, LINE_ATTENDING_DAYS, type PainState } from './line-rules'

export const activeLines = (admissionId: string): LineDevice[] => db.lines.filter((l) => l.admissionId === admissionId && !l.removedAt)

/** 疼痛：生命徵象上的、加上 PCA 紀錄上的（PCA 每 4 小時也評疼痛） */
export const painStateOf = (admissionId: string, t: string): PainState => painState([...db.vitals.filter((v) => v.admissionId === admissionId), ...pcaPainRecords(admissionId)], t, shiftRange(t).start)

export interface LineTodo {
  id: string
  lineId: string
  /** need 今天還沒評估、removable 評估可移除還沒移除、replace 留置針滿 96 小時、attending 滿 7 天（提醒主治） */
  kind: 'need' | 'removable' | 'replace' | 'attending' | 'chestBleed' | 'chestRecord' | 'chestRemove'
  text: string
}

/** 這位病人的管路待辦（護理站：need、removable、replace；attending 給主治看） */
export function lineTodosOf(admissionId: string, t: string): LineTodo[] {
  const out: LineTodo[] = []
  for (const l of activeLines(admissionId)) {
    const s = lineState(l, t)
    const name = `${lineKind(l.kind).label}（${l.site}）`
    if (s.removable) out.push({ id: `line-rm-${l.id}`, lineId: l.id, kind: 'removable', text: `${name}：評估可以移除，請移除` })
    else if (s.needCheckDue) out.push({ id: `line-need-${l.id}`, lineId: l.id, kind: 'need', text: `${name} 第 ${s.day} 天：今天評估還需要嗎` })
    if (s.replaceDue) out.push({ id: `line-rep-${l.id}`, lineId: l.id, kind: 'replace', text: `${name} 已放 ${s.hours} 小時（滿 ${PIVC_REPLACE_HOURS}）：請更換` })
    if (s.chest?.bleeding) out.push({ id: `line-cb-${l.id}`, lineId: l.id, kind: 'chestBleed', text: `${name} 每小時引流 ${s.chest.lastRate} mL（≥${CHEST_BLEED_MLH}）：通知醫師` })
    if (s.chest?.recordDue) out.push({ id: `line-cr-${l.id}`, lineId: l.id, kind: 'chestRecord', text: `${name}：超過 ${CHEST_RECORD_HOURS} 小時沒記引流量` })
    if (s.chest?.removeHint) out.push({ id: `line-cx-${l.id}`, lineId: l.id, kind: 'chestRemove', text: `${name} 24 小時 ${s.chest.ml24} mL、沒有漏氣：可請醫師評估拔管` })
    if (s.attendingAlert) out.push({ id: `line-att-${l.id}`, lineId: l.id, kind: 'attending', text: `${name} 已放 ${s.day} 天（滿 ${LINE_ATTENDING_DAYS} 天）：請主治評估是否移除` })
  }
  return out
}

/** 出院、結束留觀：還在身上的管路一起移除（原因「出院」） */
export function closeLines(a: Admission, by: string, t: string, reason = '出院'): void {
  for (const l of activeLines(a.id)) Object.assign(l, { removedAt: t, removedBy: by, removeReason: reason })
}

/** 主治的病人有管路滿 7 天（首頁待辦） */
export const attendingLineAlerts = (doctorId: string, t: string) =>
  db.admissions.filter((a) => a.status === 'admitted' && a.doctorId === doctorId).reduce((n, a) => n + lineTodosOf(a.id, t).filter((x) => x.kind === 'attending').length, 0)
