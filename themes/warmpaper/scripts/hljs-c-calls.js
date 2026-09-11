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

function patchFunctionCalls(language) {
  const lang = hljs.getLanguage(language);
  if (!lang || typeof lang.rawDefinition !== 'function') return false;

  const grammar = lang.rawDefinition();
  patchAtomicTypes(grammar);
  grammar.contains = (grammar.contains || []).concat({
    className: 'title.function',
    begin: FUNCTION_CALL,
    relevance: 0
  });

  hljs.unregisterLanguage(language);
  hljs.registerLanguage(language, () => grammar);
  return true;
}

patchFunctionCalls('c');
