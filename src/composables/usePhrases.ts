// 片語展開（門診 SOAP、住院病程、出院病摘、護理紀錄、交班共用）：
// 在文字欄位輸入「.簡碼」再按空白鍵或 Tab，換成片語內容。規則在 phrase-rules.expandPhrase，這裡只處理按鍵與游標。
// 用法：const phrase = usePhrases(() => 病房)；<UTextarea v-model="x" @keydown="phrase.onKey($event, (v) => (x = v))" />
// 片語清單由服務層排好（個人的在前、共用的在後），expandPhrase 取第一個符合的簡碼——個人的優先。
// 護理師傳目前的病房，才有那個病房的共用片語；醫師的科室共用片語由服務層依所屬科別決定。
import { computed, nextTick } from 'vue'
import { expandPhrase, phraseApi } from '@/services'
import { useQuery } from './useService'
import { useAuth } from '@/stores/auth'

export function usePhrases(ward: () => string | undefined = () => undefined) {
  const auth = useAuth()
  // 醫師、護理師才有片語；其他角色沒有
  const { data } = useQuery(async () => (['doctor', 'nurse'].includes(auth.user?.role ?? '') ? phraseApi.listPhrases({ ward: ward() }) : undefined), [ward])
  const phrases = computed(() => data.value?.phrases ?? [])

  function onKey(e: KeyboardEvent, set: (v: string) => void) {
    // 中文輸入法選字時按空白是在選字（isComposing），不能攔；有修飾鍵（Shift+Tab 回上一欄）也不攔
    if ((e.key !== ' ' && e.key !== 'Tab') || e.isComposing || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return
    const el = e.target as HTMLTextAreaElement | HTMLInputElement
    if (el.selectionStart === null || el.selectionStart !== el.selectionEnd) return
    const r = expandPhrase(el.value, el.selectionStart, phrases.value)
    if (!r) return // 不是片語：照常輸入空白、Tab 照常跳下一欄
    e.preventDefault()
    set(r.text)
    nextTick(() => el.setSelectionRange(r.cursor, r.cursor))
  }

  return { phrases, ward, onKey }
}
