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

/**
 * 藥物不良反應判定要加入過敏時，記成哪一個過敏原：屬於某一類（例：Ceftriaxone → Cephalosporin）就記那一類，
 * 之後同類的藥都會被過敏檢查擋到；不屬於任何一類就記學名（只擋這一種成分）
 */
export function allergenOfDrug(d: Pick<Drug, 'generic' | 'name'>): string {
  const text = `${d.generic} ${d.name}`.toLowerCase()
  // Aspirin 在 NSAIDs 裡也有，先比對範圍窄的那一類
  const order = ['Penicillin', 'Cephalosporin', 'Aspirin', 'Sulfa', 'NSAIDs']
  return order.find((k) => allergyClasses[k].some((w) => text.includes(w))) ?? d.generic
}
