/**
 * pdfjs 桩（第一/二挡）。
 *
 * 原项目用它做两件事：宿主侧把 PDF 附件的第一页渲成 SVG（AI 阅读附件用）、
 * 渲染层把 PDF 转成图片（同样是 AI 附件链路）。DSH 版没有 AI；
 * 第三挡做「文档导入」时再装真的 pdfjs-dist。
 */

const MESSAGE = 'PDF 解析未接入（第三挡），当前不支持读取 PDF'

export function getDocument(): never {
  throw new Error(MESSAGE)
}

export const GlobalWorkerOptions = { workerSrc: '' }

export default { getDocument, GlobalWorkerOptions }
