/**
 * ssh2 的**可选**原生加速模块（cpu-features / sshcrypto.node）的桩。
 *
 * ssh2 的原码是这样用的：
 *   try { cpuInfo = require('cpu-features')() } catch {}
 *   try { binding = require('./crypto/build/Release/sshcrypto.node') } catch {}
 *
 * 也就是说"没有原生模块"本来就是它支持的正常路径（自动退回纯 JS 实现）。
 * 这里直接抛错，正好落进它的 catch —— 比返回空对象更安全：
 * 返回 `{}` 会让 ssh2 以为原生实现可用，然后在调用时炸出 `undefined is not a constructor`。
 */
throw new Error('本环境未编译原生加速模块，ssh2 将使用纯 JS 实现')
