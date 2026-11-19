// 手術排程與術前核對（純函式）：左右側、麻醉方式、手術房、術前準備清單、三段安全查核的項目、狀態、排程撞期、紗布器械計數。
// 服務層把關、病房與手術室畫面、首頁待辦都用這一份
import type { AnesthesiaType, Surgery, SurgeryCheckStage, SurgeryPrepKey, SurgerySide, SurgeryStatus, SurgeryUrgency, TeamRole } from '@/types'
import { addMinutes, parseDate } from '@/utils/date'

export const SIDE_LABEL: Record<SurgerySide, string> = { left: '左側', right: '右側', bilateral: '兩側', na: '不分側' }
export const ANESTHESIA_LABEL: Record<AnesthesiaType, string> = { general: '全身麻醉', spinal: '脊髓麻醉', regional: '神經阻斷麻醉', local: '局部麻醉' }
export const OR_ROOMS = ['OR1', 'OR2', 'OR3']
export const SURGERY_STATUS_LABEL: Record<SurgeryStatus, string> = {
  requested: '待排程', scheduled: '已排程', sent: '已送手術室', 'in-progress': '手術中', done: '已完成', cancelled: '已取消',
}
/** 手術房一天的時段（排程只能排在這裡面） */
export const OR_DAY = { start: '08:00', end: '20:00' }

/** 術前準備：哪些可以「不需要」（要寫原因） */
export const PREP_ITEMS: { key: SurgeryPrepKey; label: string; hint: string; optional: boolean }[] = [
  { key: 'consent', label: '手術與麻醉同意書', hint: '病人（或家屬）已簽署手術、麻醉同意書', optional: false },
  { key: 'npo', label: '禁食', hint: '術前 8 小時禁食（局部麻醉可不需要）', optional: true },
  { key: 'siteMark', label: '手術部位標記', hint: '主刀醫師已在手術部位畫記（不分側的可不需要）', optional: true },
  { key: 'blood', label: '備血', hint: '連到這次住院的備血單，或寫不需要的原因', optional: true },
  { key: 'abx', label: '預防性抗生素', hint: '連到這次住院的抗生素醫囑（劃刀前 60 分鐘內給），或寫不需要的原因', optional: true },
]

/** 三段安全查核（世界衛生組織手術安全查核表）：每段的項目都要勾完才算完成 */
export const CHECK_ITEMS: Record<SurgeryCheckStage, { title: string; items: string[] }> = {
  signIn: { title: '麻醉前（Sign In）', items: ['病人身分、術式、部位、同意書與病人（或家屬）確認', '手術部位已標記', '麻醉機與藥物已檢查', '過敏史已確認', '困難呼吸道、吸入性肺炎風險已評估', '出血風險已評估（大量出血已備血）'] },
  timeOut: { title: '劃刀前暫停確認（Time Out）', items: ['團隊成員自我介紹（姓名、職責）', '再次確認病人、術式、部位', '預防性抗生素已在 60 分鐘內給予（或不需要）', '主刀說明關鍵步驟、預估時間與失血', '麻醉說明病人特殊考量', '器械已滅菌、設備正常', '必要的影像已顯示'] },
  signOut: { title: '離開手術室前（Sign Out）', items: ['確認實際執行的術式名稱', '紗布、器械、針數清點', '檢體已標示病人姓名', '有無設備問題要處理', '術後照護重點已交班'] },
}
export const CHECK_ORDER: SurgeryCheckStage[] = ['signIn', 'timeOut', 'signOut']

/** 還沒完成的術前準備（送手術室前要全部完成） */
export const prepMissing = (s: Pick<Surgery, 'prep'>): SurgeryPrepKey[] => PREP_ITEMS.filter((x) => !s.prep[x.key]).map((x) => x.key)

/** 兩個時段是否重疊（同一間手術房不能撞）：start＋分鐘數 */
export function overlaps(aStart: string, aMin: number, bStart: string, bMin: number): boolean {
  return aStart < addMinutes(bStart, bMin) && bStart < addMinutes(aStart, aMin)
}

/** 申請欄位檢查（欄位 key 對應畫面） */
export function checkSurgeryInput(x: { procId?: string; side?: string; anesthesia?: string; requestedDate?: string; estMinutes?: number; diagnosis?: string }, today: string): Record<string, string> {
  const e: Record<string, string> = {}
  if (!x.procId) e.procId = '請選擇術式'
  if (!x.side || !(x.side in SIDE_LABEL)) e.side = '請選擇左右側（不分側也要選）'
  if (!x.anesthesia || !(x.anesthesia in ANESTHESIA_LABEL)) e.anesthesia = '請選擇麻醉方式'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(x.requestedDate ?? '')) e.requestedDate = '請選擇預計日期'
  else if (x.requestedDate! < today) e.requestedDate = '預計日期不能早於今天'
  if (!Number.isInteger(x.estMinutes) || x.estMinutes! < 15 || x.estMinutes! > 720) e.estMinutes = '預估時間是 15–720 分鐘'
  if (!x.diagnosis?.trim()) e.diagnosis = '請寫術前診斷'
  return e
}

/** 紗布、器械計數：都要填、術後和術前一樣才算相符 */
export function countsProblem(c: { spongeBefore?: number; spongeAfter?: number; instrumentBefore?: number; instrumentAfter?: number }): { fields: Record<string, string>; mismatch: string[] } {
  const fields: Record<string, string> = {}
  for (const k of ['spongeBefore', 'spongeAfter', 'instrumentBefore', 'instrumentAfter'] as const) {
    const v = c[k]
    if (v === undefined || v === null || !Number.isInteger(v) || v < 0 || v > 999) fields[k] = '請填 0–999 的整數'
  }
  const mismatch: string[] = []
  if (!Object.keys(fields).length) {
    if (c.spongeBefore !== c.spongeAfter) mismatch.push(`紗布 術前 ${c.spongeBefore}、術後 ${c.spongeAfter}`)
    if (c.instrumentBefore !== c.instrumentAfter) mismatch.push(`器械 術前 ${c.instrumentBefore}、術後 ${c.instrumentAfter}`)
  }
  return { fields, mismatch }
}

// ---------- 緊急手術（急刀） ----------

export const URGENCY_LABEL: Record<SurgeryUrgency, string> = { immediate: '立即', urgent: '緊急', semi: '次緊急' }
/** 從申請到入刀房（送手術室）的時限（分鐘） */
export const URGENCY_MINUTES: Record<SurgeryUrgency, number> = { immediate: 60, urgent: 360, semi: 1440 }
export const URGENCY_ORDER: Record<SurgeryUrgency, number> = { immediate: 0, urgent: 1, semi: 2 }
/** 急刀的期限 */
export const emergencyDue = (s: Pick<Surgery, 'urgency' | 'createdAt'>) => (s.urgency ? addMinutes(s.createdAt, URGENCY_MINUTES[s.urgency]) : undefined)
/**
 * 急刀時效：入刀房了（送手術室）→ ontime／late；還沒→ waiting（時限內）／overdue（超過）。取消的、擇期的沒有
 */
export function emergencyState(s: Pick<Surgery, 'urgency' | 'createdAt' | 'sentAt' | 'status'>, now: string): { state: 'ontime' | 'late' | 'waiting' | 'overdue'; due: string; minutes: number } | undefined {
  if (!s.urgency || s.status === 'cancelled') return undefined
  const due = emergencyDue(s)!
  const end = s.sentAt ?? now
  const minutes = Math.round((parseDate(end).getTime() - parseDate(s.createdAt).getTime()) / 60000)
  if (s.sentAt) return { state: s.sentAt <= due ? 'ontime' : 'late', due, minutes }
  return { state: now > due ? 'overdue' : 'waiting', due, minutes }
}
/** 急刀時效達成率（已入刀房的；依等級） */
export function emergencyRate(xs: Pick<Surgery, 'urgency' | 'createdAt' | 'sentAt' | 'status'>[], now: string) {
  const done = xs.map((s) => emergencyState(s, now)).filter((x): x is NonNullable<typeof x> => !!x && (x.state === 'ontime' || x.state === 'late'))
  const ontime = done.filter((x) => x.state === 'ontime').length
  return { total: done.length, ontime, pct: done.length ? Math.round((ontime / done.length) * 100) : 100 }
}

// ---------- 手術團隊 ----------
export const TEAM_LABEL: Record<TeamRole, string> = { assistant: '助手', anesthetist: '麻醉醫師', scrub: '刷手護理師', circulating: '流動護理師' }
export const TEAM_ORDER: TeamRole[] = ['assistant', 'anesthetist', 'scrub', 'circulating']
/** 這個角色現在的人（最後一段、還沒交出去） */
export const teamNow = (s: Pick<Surgery, 'team'>, role: TeamRole): string | undefined => ((x) => (x && !x.to ? x.userId : undefined))(s.team?.[role]?.at(-1))
/**
 * 到這一關前團隊還缺誰：麻醉前查核（Sign In）要流動護理師、麻醉醫師（局部麻醉不用）；
 * 劃刀前暫停確認（Time Out）再加刷手護理師。助手選填
 */
export function teamMissing(s: Pick<Surgery, 'team' | 'anesthesia'>, stage: 'signIn' | 'timeOut'): TeamRole[] {
  const need: TeamRole[] = ['circulating', ...(s.anesthesia !== 'local' ? (['anesthetist'] as TeamRole[]) : []), ...(stage === 'timeOut' ? (['scrub'] as TeamRole[]) : [])]
  return need.filter((r) => !teamNow(s, r))
}
