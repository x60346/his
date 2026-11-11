// Code 39 條碼（純函式）：掛號單上的病歷號條碼。
// 選 Code 39：規則簡單（每個字 9 條，3 寬 6 窄）、不需要檢查碼，掃描器普遍支援；病歷號只有數字，長度也短。
// 條碼掃描器的行為就是「打字＋Enter」：掃描掛號單 → 搜尋框收到病歷號 → 只剩一筆就直接選取（批價、掛號的搜尋都這樣做）。

/** 每個字的 9 個元素（條、空、條、空…），n＝窄、w＝寬；* 是起訖符號 */
export const CODE39: Record<string, string> = {
  '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn', '4': 'nnnwwnnnw',
  '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw', '8': 'wnnwnnwnn', '9': 'nnwwnnwnn',
  A: 'wnnnnwnnw', B: 'nnwnnwnnw', C: 'wnwnnwnnn', D: 'nnnnwwnnw', E: 'wnnnwwnnn',
  F: 'nnwnwwnnn', G: 'nnnnnwwnw', H: 'wnnnnwwnn', I: 'nnwnnwwnn', J: 'nnnnwwwnn',
  K: 'wnnnnnnww', L: 'nnwnnnnww', M: 'wnwnnnnwn', N: 'nnnnwnnww', O: 'wnnnwnnwn',
  P: 'nnwnwnnwn', Q: 'nnnnnnwww', R: 'wnnnnnwwn', S: 'nnwnnnwwn', T: 'nnnnwnwwn',
  U: 'wwnnnnnnw', V: 'nwwnnnnnw', W: 'wwwnnnnnn', X: 'nwnnwnnnw', Y: 'wwnnwnnnn',
  Z: 'nwwnwnnnn', '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn', '*': 'nwnnwnwnn',
}

export interface Bar {
  x: number
  w: number
}

/**
 * 文字 → 黑條的位置與寬度（單位：窄條寬）。寬條 = 3 倍窄條；字與字之間一個窄空白。
 * 不支援的字元丟錯——印出掃不出來的條碼，比印不出來更糟
 */
export function code39Bars(text: string, wide = 3): { bars: Bar[]; width: number } {
  const chars = `*${text.toUpperCase()}*`
  const bars: Bar[] = []
  let x = 0
  for (const ch of chars) {
    const pattern = CODE39[ch]
    if (!pattern) throw new Error(`Code 39 不支援字元「${ch}」`)
    for (let i = 0; i < 9; i++) {
      const w = pattern[i] === 'w' ? wide : 1
      if (i % 2 === 0) bars.push({ x, w })
      x += w
    }
    x += 1 // 字間空白
  }
  return { bars, width: x - 1 }
}
