/* Generate a static search index at /search.json (used by source/js/search.js) */
'use strict';

function toPlainText(html) {
  return String(html || '')
    // drop code block line-number gutter
    .replace(/<td class="gutter">[\s\S]*?<\/td>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

hexo.extend.generator.register('search_index', function (locals) {
  var root = hexo.config.root || '/';
  if (root.charAt(root.length - 1) !== '/') root += '/';

  var posts = locals.posts.sort('-date');
  var index = posts.map(function (post) {
    return {
      title: post.title || '',
      url: root + String(post.path || '').replace(/^\/+/, ''),
      date: post.date ? post.date.format('YYYY-MM-DD') : '',
      categories: post.categories ? post.categories.toArray().map(function (cat) { return cat.name; }) : [],
      tags: post.tags ? post.tags.toArray().map(function (tag) { return tag.name; }) : [],
      text: toPlainText(post.content)
    };
  });

  return {
    path: 'search.json',
    data: JSON.stringify(index)
  };
});
