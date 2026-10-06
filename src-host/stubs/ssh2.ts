/**
 * ssh2 桩（第一/二挡）。
 *
 * `index.ts` 与 `services/{sftp,cloud-dirs}.ts` 用它实现「云数据目录」，
 * 属于第三挡。这里提供同名导出，让第一/二挡可以先构建、先跑起来；
 * 第三挡开工时装上真的 `ssh2` 并去掉这个别名即可。
 */

export class Client {
  constructor() {
    throw new Error('云数据目录（ssh2）尚未接入：第三挡功能')
  }
}

export default { Client }
