/**
 * 非正式渠道（dev 与本地 `npm run package`）的 userData 目录名。
 *
 * 与正式包共用一份库是有代价的：开发时用高版本 schema 写过之后，再启动装在
 * /Applications 里的旧正式包，那边只能把这份库当降级处理——旧版本的代码已经在磁盘上，
 * 改不动了。分开之后正式库压根不会被开发中的 schema 碰到。
 *
 * **main 与 `scripts/seed-cases.ts` 必须认同一个名字**：对不上的表现是「seed 跑完了，
 * 但 app 里什么都没有」，两边各写各的库，谁都不报错。
 */
export const DEV_USER_DATA_DIR = 'Inquestry (dev)';
