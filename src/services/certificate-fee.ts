// 診斷證明書的費用（內部模組，index 不匯出）：門診批價試算、待退費重算、住院帳單共用同一個算法——
// 主檔「診斷證明書」自費價（依開立日）× 份數。以「原本那張」為單位收一次：
//   - 作廢（沒重開）：不收
//   - 作廢重開（replaces 指回原本那張）：照原本那張的字號、份數收一次——收據上的那一列和之後任何重算都一樣，
//     收據作廢重新批價也不會因此變成免費，待退費也不會把證明書費誤算成要退
import type { ChargeLine, MedicalCertificate } from '@/types'
import { db } from '@/mock/db'
import { procPriceOn } from './billing'
import { find } from './views'

/** 證明書費的醫令（主檔 P027 診斷證明書，自費） */
export const CERT_PROC_ID = 'P027'

/** 證明書費的明細（沒有要收的回傳空陣列）：每張「原本的證明書」一列（寫原本的字號），它或它的重開還有效才收 */
export function certFeeLines(certs: MedicalCertificate[]): ChargeLine[] {
  const proc = find.procedure(CERT_PROC_ID)
  if (!proc) return []
  return certs
    .filter((root) => !root.replaces)
    .filter((root) => certs.some((c) => (c.id === root.id || c.replaces === root.id) && !c.voided))
    .map((root) => {
      const price = procPriceOn(proc, root.issuedAt.slice(0, 10))
      return { kind: 'self' as const, name: `${proc.name}（自費，${root.no}）`, qty: root.copies, unitPrice: price.selfPrice, amount: price.selfPrice * root.copies, patientPay: true }
    })
}

export const certsOfEncounter = (encounterId: string) => db.certificates.filter((c) => c.encounterId === encounterId)
export const certsOfAdmission = (admissionId: string) => db.certificates.filter((c) => c.admissionId === admissionId)
