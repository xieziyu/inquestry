/**
 * 「这条 SQL 查的是哪几张表」——`spike-tools` 与 `spike-wire` 的假操作员共用一份。
 *
 * 🔴 **不能在整条 SQL 原文里搜关键字。** 那样写的几种错法都不报错，只是让 spike 从此验不出东西：
 *   - 别名：`SELECT * FROM t_order AS orders` 会被判成查了不存在的 orders，假操作员回一句
 *     伪造的 1146，而 agent 其实写对了；
 *   - 前缀：`t_order_item` 真的在 `SHOW TABLES` 里，子串匹配一样会把它当成 t_order；
 *   - 字面量与注释：`SELECT 'copied FROM orders' AS note FROM t_order`、`-- FROM orders`
 *     里的那个 orders 不是表引用；反过来 `SELECT '--' AS marker FROM orders` 里的 `--`
 *     也不是注释起点，先删注释会把后面真正的 `FROM orders` 一起吞掉；
 *   - CTE：`WITH orders(id) AS (SELECT id FROM t_order) SELECT * FROM orders` 里的 orders
 *     是这条语句自己声明的名字，不是物理表。
 *
 * 所以先**一趟扫**把注释与字符串同时认掉（两者会互相包住，分两趟正则必然出错），
 * 再在剩下的正文里认表引用。这**不是 SQL parser**，只够假操作员分辨"查的哪张表"——
 * 真要处理方言差异该换 tokenizer，而这里的输入是 agent 写的普通查询。
 */

/**
 * 去掉注释、把字符串字面量抹成空串，位置之外的正文原样留着。
 *
 * **必须一趟扫完**：`--` 在字符串里不是注释、引号在注释里不是字符串，
 * 分成两条正则先后跑的话，两种情形各错一种，而且都只是安静地少认一张表。
 * 反引号是标识符引号（MySQL），内容要留着——表名就在里头。
 *
 * 注释按 **MySQL 的词法**认，不按"看见 `--` 就算"：
 *   - `--` 只有后面跟着空白（或到头）才是注释。`SELECT 1--2 FROM orders` 是 `1 - -2`，
 *     照通用写法会把后面的 `FROM orders` 一起吞掉，那条本该回 1146 的路就没了；
 *   - `#` 到行尾也是注释，漏了的话 `# FROM orders` 里的错表名会被当成真引用。
 */
function clean(sql: string): string {
  let out = '';
  for (let i = 0; i < sql.length; ) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === '-' && next === '-' && (i + 2 >= sql.length || /[\s\u0000-\u001f]/.test(sql[i + 2]!))) {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      out += ' ';
    } else if (c === '#') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      out += ' ';
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      out += ' ';
    } else if (c === "'" || c === '"') {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '\\') i += 2;
        else if (sql[i] === c && sql[i + 1] === c) i += 2; // '' 是转义的引号，不是结束
        else if (sql[i] === c) { i += 1; break; }
        else i += 1;
      }
      out += `${c}${c}`;
    } else if (c === '`') {
      out += c;
      i += 1;
      while (i < sql.length && sql[i] !== '`') { out += sql[i]; i += 1; }
      out += '`';
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/**
 * 表引用：可选的 `库.` 前缀 + 表名，两段都可以带反引号。
 *
 * 限定名必须认——假操作员回的 1146 里就写着库名（`Table 'shop.orders' ...`），
 * agent 照着写 `FROM shop.t_order` 是自然反应。只取第一段的话它会被判成查了名叫 `shop` 的表，
 * 于是既拿不到数据、也触发不了错表名那条，spike 两头落空。
 */
const IDENT = String.raw`\`?[a-z_][a-z0-9_]*\`?`;
const TABLE_REF = new RegExp(String.raw`\b(?:from|join|update|into|table)\s+(${IDENT}(?:\s*\.\s*${IDENT})?)`, 'gi');

/**
 * 这条语句自己声明的 CTE 名。名字可以带反引号，`AS` 之前还可以有一串列名。
 *
 * `名字 [(列…)] AS (` 这个形状足够分辨：派生表的别名是 `) AS 别名`（括号在前），
 * 列别名后面也跟不了左括号。够假操作员用了。
 */
const CTE_NAME = new RegExp(String.raw`\b(${IDENT})\s*(?:\([^)]*\)\s*)?as\s*\(`, 'gi');

const bare = (ident: string) => ident.replace(/`/g, '').trim().toLowerCase();

/** 这条语句真正查了哪几张**物理**表。自己声明的 CTE 名不算。 */
export function tablesOf(sql: string): string[] {
  const body = clean(sql);
  const ctes = new Set([...body.matchAll(CTE_NAME)].map((m) => bare(m[1]!)));
  return [...body.matchAll(TABLE_REF)]
    .map((m) => {
      const parts = m[1]!.split('.');
      // 限定名取最后一段（库名不是表名），但**得记着它带过库名**
      return { table: bare(parts.pop()!), qualified: parts.length > 0 };
    })
    // 只有不带库名的引用才可能是 CTE：`WITH orders AS (…) SELECT * FROM shop.orders`
    // 里那个 shop.orders 一定是物理表，先降成裸名再滤的话它会被 CTE 同名吃掉
    .filter((r) => r.qualified || !ctes.has(r.table))
    .map((r) => r.table);
}

/**
 * 这条语句本身就是 `SHOW TABLES`（真名靠它查得到）。
 *
 * **看的是去掉注释之后的正文，而且要整条都是它**（`FROM` / `LIKE` / `WHERE` 那几种变体算，
 * 末尾分号也算）。只锚开头不够：`SHOW TABLES; SELECT * FROM orders` 会先命中这里拿到表清单，
 * 后面那条查错表的根本走不到 1146；写成"整条里搜得到"的话，注释里提一句都能抢走。
 */
export const isShowTables = (sql: string) => /^\s*show\s+tables\b[^;]*;?\s*$/i.test(clean(sql));

/** 真名。`SHOW TABLES` 里查得到，schema 也是照它给的。 */
export const REAL_TABLE = 't_order';

/** agent 最容易猜的那个错名。查它要照数据库那样回 1146，不替它改。 */
const WRONG_TABLES = ['order', 'orders'];

export const queriesRealTable = (sql: string) => tablesOf(sql).includes(REAL_TABLE);
export const queriesWrongTable = (sql: string) => tablesOf(sql).some((t) => WRONG_TABLES.includes(t));
