// 狀態代碼 → 顯示文字與顏色。集中在這裡，所有頁面的「待批價」都長得一樣。
import type { AdmissionStatus, BedStatus, DispenseStatus, MarRecord, PayMethod, Role, VisitStatus } from '@/types'

export type Tone = 'gray' | 'blue' | 'green' | 'yellow' | 'red' | 'purple' | 'cyan'

type LabelMap<K extends string> = Record<K, { label: string; tone: Tone }>

export const visitStatus: LabelMap<VisitStatus> = {
  registered: { label: '候診', tone: 'blue' },
  'in-consult': { label: '看診中', tone: 'purple' },
  consulted: { label: '待批價', tone: 'yellow' },
  charged: { label: '已批價', tone: 'cyan' },
  dispensed: { label: '已領藥', tone: 'green' },
  cancelled: { label: '已退掛', tone: 'gray' },
}

export const dispenseStatus: LabelMap<DispenseStatus> = {
  pending: { label: '待調劑', tone: 'yellow' },
  verified: { label: '已核對', tone: 'blue' },
  dispensed: { label: '已發藥', tone: 'green' },
}

export const admissionStatus: LabelMap<AdmissionStatus> = {
  reserved: { label: '待報到', tone: 'yellow' },
  admitted: { label: '住院中', tone: 'blue' },
  discharged: { label: '已出院', tone: 'green' },
  cancelled: { label: '已取消', tone: 'gray' },
}

export const bedStatus: LabelMap<BedStatus> = {
  empty: { label: '空床', tone: 'green' },
  occupied: { label: '使用中', tone: 'blue' },
  reserved: { label: '保留', tone: 'yellow' },
  cleaning: { label: '清潔中', tone: 'gray' },
}

export const marStatus: LabelMap<MarRecord['status']> = {
  pending: { label: '待給藥', tone: 'yellow' },
  given: { label: '已給藥', tone: 'green' },
  held: { label: '暫停', tone: 'gray' },
  refused: { label: '拒絕', tone: 'red' },
}

export const roleLabel: Record<Role, string> = {
  admin: '系統管理員',
  doctor: '醫師',
  nurse: '護理師',
  pharmacist: '藥師',
  clerk: '掛號批價',
}

export const payMethodLabel: Record<PayMethod, string> = { cash: '現金', card: '信用卡', mobile: '行動支付' }

export const genderLabel = { M: '男', F: '女' } as const

export const money = (n: number) => `$${Math.round(n).toLocaleString()}`
