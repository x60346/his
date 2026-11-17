// PCA 的內部工具（index 不匯出、不會被包成 API）：進行中的 PCA、紀錄待辦、未處理的警示、疼痛紀錄（給疼痛評估用）。規則在 pca-rules
import type { PcaOrder } from '@/types'
import { db } from '@/mock/db'
import { pcaRecordDue } from './pca-rules'

export const runningPca = (admissionId: string): PcaOrder | undefined => db.pcas.find((p) => p.admissionId === admissionId && p.status === 'running')
/** 還沒結束的（已開還沒架設、使用中）：出院、結束留觀前要處理 */
export const openPca = (admissionId: string): PcaOrder | undefined => db.pcas.find((p) => p.admissionId === admissionId && (p.status === 'ordered' || p.status === 'running'))

export function pcaRecordState(p: PcaOrder, t: string) {
  const last = p.records.at(-1)?.at ?? p.setup?.at
  return last ? pcaRecordDue(last, t) : undefined
}

/** 最近一筆警示、還沒有醫師處理（處理之後的新警示要再處理） */
export function pcaOpenAlert(p: PcaOrder) {
  const last = [...p.records].reverse().find((r) => r.alert)
  return last && (!p.alertAck || p.alertAck.at < last.at) ? last : undefined
}

/** 給疼痛評估：PCA 紀錄上的疼痛分數 */
export const pcaPainRecords = (admissionId: string) => db.pcas.filter((p) => p.admissionId === admissionId).flatMap((p) => p.records.map((r) => ({ at: r.at, pain: r.pain })))
