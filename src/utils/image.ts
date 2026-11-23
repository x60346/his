// 影像縮圖：手機拍的同意書照片動輒好幾 MB，存進瀏覽器前先縮到長邊 1400 像素、JPEG 品質 0.7（約 100–300 KB）
export function shrinkImage(file: File, maxSide = 1400, quality = 0.7): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const k = Math.min(1, maxSide / Math.max(img.width, img.height))
      const c = document.createElement('canvas')
      c.width = Math.round(img.width * k)
      c.height = Math.round(img.height * k)
      const g = c.getContext('2d')
      if (!g) return reject(new Error('瀏覽器不支援影像處理'))
      g.fillStyle = '#fff'
      g.fillRect(0, 0, c.width, c.height)
      g.drawImage(img, 0, 0, c.width, c.height)
      URL.revokeObjectURL(url)
      resolve(c.toDataURL('image/jpeg', quality))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error(`${file.name} 不是可以讀的影像`))
    }
    img.src = url
  })
}
