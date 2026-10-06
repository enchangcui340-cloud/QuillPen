/**
 * 附件（库内 `_attachments/**`）相关的前端小工具。
 *
 * DSH 版与 Electron 版的差别只有一处：图片地址。
 *   · 原版走 Electron 自定义协议 `dsh-attachment://local/<path>`（主进程注册，做越界校验）；
 *   · 这里走同源的宿主路由 `/quill/attachment?rel=<path>`（插件宿主半边做同样的越界校验）。
 * 效果一致：不占内存、不重复编码；宿主侧的校验逻辑沿用 `notes.attachmentAbs()`。
 */

/** 附件地址：交给 <img src> 用 */
export function attachmentUrl(rel: string): string {
  return '/quill-user/attachment?rel=' + encodeURIComponent(rel)
}

/** 把剪贴板/拖拽进来的图片读成 data URL（再交给宿主存档） */
export function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

/** 粘贴进来的图片给个像样的名字（截图通常只叫 image.png） */
export function nameForPastedImage(file: File): string {
  const raw = (file.name || '').trim()
  const generic = !raw || /^(image|blob|粘贴的图片)(\.\w+)?$/i.test(raw)
  if (!generic) return raw
  const d = new Date()
  const p = (n: number): string => (n < 10 ? '0' + n : String(n))
  const stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  const ext = (file.type || '').includes('jpeg') ? '.jpg' : (file.type || '').includes('gif') ? '.gif' : (file.type || '').includes('webp') ? '.webp' : '.png'
  return '粘贴的图片-' + stamp + ext
}
