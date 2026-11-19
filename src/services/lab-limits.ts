// 檢驗時限設定（主檔）：依檢驗醫令設定急件、一般時效、危急值通報時限、不計時效；空白＝預設（急件 60、一般 240、通報 30 分鐘）。
// 修改要寫原因、留在 labLimitHistory，稽核也記。權限 lab.limits（預設管理員，可指定給檢驗科主管）。
// 檢驗時效（tat-work）、危急值通報（lab-work.calloutMinutesOf）都讀這裡
import type { LabLimits } from '@/types'
import { db } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, failFields, must, mutate, permissionsOf, query, requirePermission, requireUser } from './http'
import { nameOf } from './views'
import { checkLabLimits, TAT_MINUTES, tatLimitOf } from './tat-rules'
import { calloutLimitOf, CALLOUT_MINUTES } from './callout-rules'

export interface LabLimitRow {
  procId: string
  code: string
  name: string
  limits: LabLimits
  /** 實際用的（主檔有設用主檔，沒有用預設） */
  effective: { stat: number; routine: number; callout: number; noTat: boolean }
  history: { at: string; byName: string; reason: string; text: string }[]
}
const fmt = (x: LabLimits) =>
  [`急件 ${x.stat ?? '預設'}`, `一般 ${x.routine ?? '預設'}`, `通報 ${x.callout ?? '預設'}`, x.noTat ? '不計時效' : ''].filter(Boolean).join('、')

/** 檢驗醫令的時限設定（檢驗科、管理員看；canEdit＝有 lab.limits 權限） */
export function labLimitList(): Promise<{ rows: LabLimitRow[]; defaults: { stat: number; routine: number; callout: number }; canEdit: boolean }> {
  return query(() => {
    const u = requireUser('lab', 'admin')
    return {
      rows: db.procedures.filter((p) => p.labItems?.length && p.active).map((p) => {
        const l = p.labLimits ?? {}
        return {
          procId: p.id, code: p.code, name: p.name, limits: l,
          effective: { stat: tatLimitOf(l, 'stat'), routine: tatLimitOf(l, 'routine'), callout: calloutLimitOf(l), noTat: !!l.noTat },
          history: [...(p.labLimitHistory ?? [])].reverse().map((h) => ({ at: h.at, byName: nameOf.user(h.by), reason: h.reason, text: `${fmt(h.before)} → ${fmt(h.after)}` })),
        }
      }),
      defaults: { stat: TAT_MINUTES.stat, routine: TAT_MINUTES.routine, callout: CALLOUT_MINUTES },
      canEdit: permissionsOf(u).includes('lab.limits'),
    }
  })
}

/** 修改（lab.limits）：空白＝回到預設；要寫原因 */
export function setLabLimits(procId: string, input: { stat?: number | null; routine?: number | null; callout?: number | null; noTat?: boolean; reason: string }): Promise<LabLimitRow> {
  return mutate(() => {
    const u = requirePermission('lab.limits')
    const p = must(db.procedures.find((x) => x.id === procId && x.labItems?.length), '檢驗醫令')
    failFields(checkLabLimits(input ?? { reason: '' }))
    const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v))
    const after: LabLimits = {}
    for (const k of ['stat', 'routine', 'callout'] as const) {
      const n = num(input[k])
      if (n !== undefined) after[k] = n
    }
    if (input.noTat) after.noTat = true
    const before = p.labLimits ?? {}
    if (JSON.stringify(before) === JSON.stringify(after)) failFields({ stat: '沒有改變' })
    const t = now()
    if (Object.keys(after).length) p.labLimits = after
    else delete p.labLimits
    ;(p.labLimitHistory ??= []).push({ at: t, by: u.id, reason: input.reason.trim(), before, after })
    audit('檢驗時限設定', `${p.name}：${fmt(before)} → ${fmt(after)}（${input.reason.trim()}）`)
    const l = p.labLimits ?? {}
    return {
      procId: p.id, code: p.code, name: p.name, limits: l, effective: { stat: tatLimitOf(l, 'stat'), routine: tatLimitOf(l, 'routine'), callout: calloutLimitOf(l), noTat: !!l.noTat },
      history: [...p.labLimitHistory].reverse().map((h) => ({ at: h.at, byName: nameOf.user(h.by), reason: h.reason, text: `${fmt(h.before)} → ${fmt(h.after)}` })),
    }
  })
}
