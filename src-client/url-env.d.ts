// Vite 的 ?url 导入：返回资源最终 URL 字符串。
declare module '*?url' {
  const src: string
  export default src
}

declare module '*?raw' {
  const content: string
  export default content
}

declare module '*.png' {
  const src: string
  export default src
}
