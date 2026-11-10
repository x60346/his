// 藥物過敏比對（純函式）：病患過敏原 → 藥品學名關鍵字。
// 只做展示用的類別比對，真實系統會使用藥物交互作用資料庫。
import type { Drug } from '@/types'

const allergyClasses: Record<string, string[]> = {
  Penicillin: ['amoxicillin', 'clavulanate', 'penicillin', 'ampicillin'],
  Cephalosporin: ['cephalexin', 'ceftriaxone', 'cefazolin'],
  Aspirin: ['acetylsalicylic'],
  NSAIDs: ['ibuprofen', 'celecoxib', 'diclofenac', 'acetylsalicylic', 'naproxen'],
  Sulfa: ['sulfamethoxazole', 'sulfasalazine'],
}

export interface AllergyWarning {
  drugId: string
  drugName: string
  allergen: string
}

export function checkAllergies(allergies: string[], drugs: Drug[]): AllergyWarning[] {
  const warnings: AllergyWarning[] = []
  for (const allergen of allergies) {
    const keywords = allergyClasses[allergen] ?? [allergen.toLowerCase()]
    for (const d of drugs) {
      const text = `${d.generic} ${d.name}`.toLowerCase()
      if (keywords.some((k) => text.includes(k))) warnings.push({ drugId: d.id, drugName: d.name, allergen })
    }
  }
  return warnings
}
