'use strict';

/**
 * 让 highlight.js 的 C 语法把「函数调用点」也着色。
 *
 * hljs 11 的 C 语法里，FUNCTION_TITLE（标识符 + 左括号）只被 FUNCTION_DECLARATION
 * 引用，而那条规则要求左括号前必须先有类型（如 `static irqreturn_t foo(`）。
 * 结果就是：函数定义名有 title.function 标记，而调用点（regmap_read(...)、
 * dev_info(...)）完全不产生 span，看起来像没高亮。
 *
 * 这里取到 C 语法的原始定义，在 contains 末尾补一条「标识符 + 左括号」规则，
 * 所有 ```c 代码块里的函数调用即套用 .title.function_ 的配色（见 style.css）。
 * 追加在末尾可保证已有规则（关键字 / 类型 / 字符串等）优先命中；
 * 同时用否定断言排除 if/for/while 等后跟括号的关键字，避免被误判成函数名。
 */

const hljs = require('highlight.js');

const FUNCTION_CALL =
  /\b(?!if\b|for\b|while\b|switch\b|return\b|sizeof\b|do\b|else\b|case\b|goto\b|typedef\b)[A-Za-z_]\w*(?=\s*\()/;

/**
 * 另一处误判：hljs 的 C 语法把「atomic_ + 3~6 个小写字母」当作 C11 <stdatomic.h>
 * 的类型名（TYPES.variants 里的 /\batomic_[a-z]{3,6}\b/）。这条启发式会把 DRM 的
 * `.atomic_enable`（enable 正好 6 字母）和 `.atomic_reset`（reset 5 字母）当类型染黄；
 * 而 `.atomic_pre_enable` / `.atomic_post_disable` / `.atomic_duplicate_state`
 * 因字母数超限或 3~6 个字母后紧跟 `_`（不构成词边界）而整条不命中、完全无色。
 * 同一个结构体初始化里于是「有的字段有色、有的没色」，看起来像随机漏染。
 *
 * 这里把该变体收紧为 C11 真实类型名白名单：`atomic_int`、`atomic_bool`、`atomic_t`
 * 等仍按类型着色，内核风格的 atomic_xxx 回调名不再被误判。
 */
const C11_ATOMIC_TYPE = new RegExp(
  '\\batomic_(?:bool|char|schar|uchar|short|ushort|int|uint|long|ulong|llong|ullong'
  + '|wchar_t|char16_t|char32_t|size_t|ptrdiff_t|intptr_t|uintptr_t|intmax_t|uintmax_t'
  + '|int_least\\d+_t|uint_least\\d+_t|int_fast\\d+_t|uint_fast\\d+_t|flag)\\b'
);

function patchAtomicTypes(grammar) {
  const seen = new Set();
  const walk = (modes) => {
    (modes || []).forEach((mode) => {
      if (!mode || typeof mode !== 'object' || seen.has(mode)) return;
      seen.add(mode);

      (mode.variants || []).forEach((variant) => {
        if (!variant) return;
        const source = variant.match
          ? String(variant.match.source || variant.match)
          : String(variant.begin || '');
        if (source === '\\batomic_[a-z]{3,6}\\b') variant.match = C11_ATOMIC_TYPE;
      });

      walk(mode.contains);
    });
  };

  walk(grammar.contains);
}

/**
 * 下标初始化器（designated initializer）着色：
 *
 *   static const struct drm_bridge_funcs x = {
 *       .attach = lt9611_bridge_attach,
 *   };
 *
 * hljs 的 C 语法不为 `.字段名 =` 产生任何 span，整块结构体初始化是一片纯文本，
 * 和上下文（关键字 / 类型 / 注释有色）对比起来像"没高亮"。补两条规则：
 *
 *  1. `.字段名` → .attr（黄）。必须后跟 `=`（且不是 `==`），避免把成员调用
 *     `.foo(...)`、浮点 `.5` 卷进来；
 *  2. `.字段名 = 函数指针` 的值 → .title.function（蓝）。用变长后行断言把范围
 *     锁死在「点号字段 + 等号」之后，所以普通赋值 `int a = b, c;` 不会被染；
 *     再排除全大写宏（THIS_MODULE / MEDIA_BUS_FMT_*）与 true/false/NULL。
 *
 * 两条规则都带 relevance: 0，避免影响 _config.yml 里 auto_detect 的语言判定。
 */
const DESIGNATED_FIELD = /\.(?!\d)[A-Za-z_]\w*(?=\s*=[^=])/;

const INITIALIZER_VALUE = new RegExp(
  '(?<=\\.(?!\\d)[A-Za-z_]\\w*[ \\t]*=[ \\t]*)'
  + '(?![A-Z][A-Z_0-9]*\\b)(?!true\\b|false\\b|NULL\\b)'
  + '[A-Za-z_]\\w*(?=[ \\t]*[,\\n}])'
);

const EXTRA_RULES = [
  { className: 'attr', begin: DESIGNATED_FIELD, relevance: 0 },
  { className: 'title.function', begin: INITIALIZER_VALUE, relevance: 0 },
  { className: 'title.function', begin: FUNCTION_CALL, relevance: 0 }
];

/**
 * hljs 的 C 语法里另有一个「表达式上下文」模式（EXPRESSION_CONTEXT）：
 *   `begin: /=/, end: /;/`   —— `int ret = foo();`
 *   `begin: /\(/, end: /\)/` —— `if (regmap_read(...))`
 * 它用的是一份独立的 contains 列表（EXPRESSION_CONTAINS），因此只往顶层
 * contains 追加规则会漏掉两类内容：
 *
 *  1. `int ret = foo();`、`if (regmap_read(...))` 里的调用点拿不到 span；
 *  2. 结构体初始化时，从第二个 `=` 起、直到末尾 `};` 之间的整段（也就是所有
 *     `.字段 = 值,` 行）都被这个模式吞掉 —— 于是只有第一行 `.attach` 能命中
 *     字段规则，其余字段永远没颜色。
 *
 * 这里按「contains 中是否含共享的 PREPROCESSOR 模式」找出这些上下文模式，
 * 把同一套规则也追加进去（顶层 contains 同样含该模式，故一并覆盖）。
 */
const PREPROCESSOR_BEGIN = '#\\s*[a-z]+\\b';

function collectExpressionContexts(grammar) {
  const nodes = [];
  const seen = new Set();
  const preprocessors = new Set();

  (function walk(mode) {
    if (!mode || typeof mode !== 'object' || seen.has(mode)) return;
    seen.add(mode);
    nodes.push(mode);

    const begin = String((mode.begin && mode.begin.source) || mode.begin || '');
    if (mode.className === 'meta' && begin === PREPROCESSOR_BEGIN) preprocessors.add(mode);

    (mode.contains || []).forEach(walk);
  })(grammar);

  return nodes.filter((mode) =>
    Array.isArray(mode.contains) && mode.contains.some((child) => preprocessors.has(child))
  );
}

function patchFunctionCalls(language) {
  const lang = hljs.getLanguage(language);
  if (!lang || typeof lang.rawDefinition !== 'function') return false;

  const grammar = lang.rawDefinition();
  patchAtomicTypes(grammar);

  collectExpressionContexts(grammar).forEach((mode) => {
    mode.contains = mode.contains.concat(EXTRA_RULES);
  });

  hljs.unregisterLanguage(language);
  hljs.registerLanguage(language, () => grammar);
  return true;
}

patchFunctionCalls('c');
