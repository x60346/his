// 讓瀏覽器下載一份檔案（CSV、Excel、匯出檔）。內容由服務層產生，這裡只負責觸發下載
export function downloadFile(data: BlobPart, type: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}
