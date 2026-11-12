// 片語展開（門診 SOAP、住院病程、出院病摘、護理紀錄、交班共用）：
// 在文字欄位輸入「.簡碼」再按空白鍵或 Tab，換成自己的片語內容。規則在 phrase-rules.expandPhrase，這裡只處理按鍵與游標。
// 用法：<UTextarea v-model="x" @keydown="phrase.onKey($event, (v) => (x = v))" />
import { nextTick } from 'vue'
import { expandPhrase, phraseApi } from '@/services'
import { useQuery } from './useService'
import { useAuth } from '@/stores/auth'

export function usePhrases() {
  const auth = useAuth()
  // 片語是個人的（醫師、護理師各自一份）；其他角色沒有
  const { data: phrases } = useQuery(async () => (['doctor', 'nurse'].includes(auth.user?.role ?? '') ? phraseApi.listPhrases() : []))

  function onKey(e: KeyboardEvent, set: (v: string) => void) {
    // 中文輸入法選字時按空白是在選字（isComposing），不能攔；有修飾鍵（Shift+Tab 回上一欄）也不攔
    if ((e.key !== ' ' && e.key !== 'Tab') || e.isComposing || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return
    const el = e.target as HTMLTextAreaElement | HTMLInputElement
    if (el.selectionStart === null || el.selectionStart !== el.selectionEnd) return
    const r = expandPhrase(el.value, el.selectionStart, phrases.value ?? [])
    if (!r) return // 不是片語：照常輸入空白、Tab 照常跳下一欄
    e.preventDefault()
    set(r.text)
    nextTick(() => el.setSelectionRange(r.cursor, r.cursor))
  }

  return { phrases, onKey }
}
