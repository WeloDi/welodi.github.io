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

function patchFunctionCalls(language) {
  const lang = hljs.getLanguage(language);
  if (!lang || typeof lang.rawDefinition !== 'function') return false;

  const grammar = lang.rawDefinition();
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
