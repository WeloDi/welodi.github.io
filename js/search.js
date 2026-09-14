/* Warmpaper static search: fetch /search.json and filter locally */
(function () {
  var overlay = document.getElementById('search-overlay');
  if (!overlay) return;

  var input = document.getElementById('search-input');
  var results = document.getElementById('search-results');
  var meta = document.getElementById('search-meta');
  var closeBtn = overlay.querySelector('.search-close');
  var toggleBtn = document.querySelector('.search-toggle');
  var indexUrl = overlay.getAttribute('data-search-url') || '/search.json';

  var MAX_RESULTS = 30;
  var docs = null; // [{title,url,date,categories,tags,text,titleLower,metaLower,textLower}]
  var loading = false;
  var failed = false;
  var matches = [];
  var active = -1;

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function escapeRe(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function termsOf(query) {
    return query.toLowerCase().split(/\s+/).filter(Boolean);
  }

  function highlight(text, terms) {
    var html = escapeHtml(text);
    terms.forEach(function (term) {
      html = html.replace(new RegExp('(' + escapeRe(term) + ')', 'ig'), '<mark>$1</mark>');
    });
    return html;
  }

  function snippet(doc, terms) {
    var at = -1;
    terms.forEach(function (term) {
      var pos = doc.textLower.indexOf(term);
      if (pos !== -1 && (at === -1 || pos < at)) at = pos;
    });
    if (at === -1) {
      return doc.text.slice(0, 150) + (doc.text.length > 150 ? '…' : '');
    }
    var start = Math.max(0, at - 40);
    var end = Math.min(doc.text.length, at + 130);
    return (start > 0 ? '…' : '') + doc.text.slice(start, end) + (end < doc.text.length ? '…' : '');
  }

  function search(query) {
    var terms = termsOf(query);
    var out = [];
    docs.forEach(function (doc) {
      var score = 0;
      for (var i = 0; i < terms.length; i++) {
        var term = terms[i];
        var s = 0;
        if (doc.titleLower.indexOf(term) !== -1) s += 100;
        if (doc.metaLower.indexOf(term) !== -1) s += 30;
        var hits = doc.textLower.split(term).length - 1;
        if (hits > 0) s += Math.min(hits, 5) * 3;
        if (!s) return; // 所有关键词都要命中（AND）
        score += s;
      }
      out.push({ doc: doc, score: score });
    });
    out.sort(function (a, b) {
      return b.score - a.score || (a.doc.date < b.doc.date ? 1 : -1);
    });
    return out.slice(0, MAX_RESULTS);
  }

  function itemHtml(doc, i, terms, withSnippet) {
    var extra = (doc.tags || []).concat(doc.categories || []);
    return (
      // i === -1 means "no keyboard selection" (recent list), so never mark it active
      '<a class="search-item' + (i > -1 && i === active ? ' active' : '') + '"' +
      (i > -1 ? ' data-i="' + i + '"' : '') + ' href="' + escapeHtml(doc.url) + '">' +
      '<div class="search-item-title">' + (terms ? highlight(doc.title, terms) : escapeHtml(doc.title)) + '</div>' +
      (withSnippet ? '<div class="search-item-snippet">' + highlight(snippet(doc, terms), terms) + '</div>' : '') +
      '<div class="search-item-meta">' +
      '<span>' + escapeHtml(doc.date) + '</span>' +
      (extra.length ? '<span>' + escapeHtml(extra.join(' · ')) + '</span>' : '') +
      '</div>' +
      '</a>'
    );
  }

  function render() {
    if (!docs) {
      meta.textContent = failed ? '索引加载失败，刷新页面重试' : '正在加载索引…';
      results.innerHTML = '';
      return;
    }
    var query = input.value.trim();
    if (!query) {
      matches = [];
      active = -1;
      meta.textContent = '共 ' + docs.length + ' 篇文章';
      results.innerHTML = docs.slice(0, 6).map(function (doc) { return itemHtml(doc, -1, null, false); }).join('');
      return;
    }
    matches = search(query);
    active = matches.length ? 0 : -1;
    if (!matches.length) {
      meta.textContent = '没有匹配「' + query + '」的文章';
      results.innerHTML = '<div class="search-empty">换个关键词试试，比如 DRM、I2S、寄存器、HPD</div>';
      return;
    }
    var terms = termsOf(query);
    meta.textContent = '找到 ' + matches.length + ' 篇';
    results.innerHTML = matches.map(function (item, i) {
      return itemHtml(item.doc, i, terms, true);
    }).join('');
  }

  function updateActive() {
    var items = results.querySelectorAll('.search-item[data-i]');
    Array.prototype.forEach.call(items, function (item) {
      var isActive = parseInt(item.getAttribute('data-i'), 10) === active;
      item.classList.toggle('active', isActive);
      if (isActive && item.scrollIntoView) item.scrollIntoView({ block: 'nearest' });
    });
  }

  function load() {
    if (docs || loading) return;
    loading = true;
    render();
    fetch(indexUrl)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        docs = (Array.isArray(data) ? data : []).map(function (doc) {
          doc.text = doc.text || '';
          doc.title = doc.title || '(Untitled)';
          doc.tags = doc.tags || [];
          doc.categories = doc.categories || [];
          doc.titleLower = doc.title.toLowerCase();
          doc.metaLower = doc.tags.concat(doc.categories).join(' ').toLowerCase();
          doc.textLower = doc.text.toLowerCase();
          return doc;
        });
        loading = false;
        render();
      })
      .catch(function () {
        loading = false;
        failed = true;
        render();
      });
  }

  function openOverlay() {
    overlay.hidden = false;
    document.body.classList.add('search-open');
    load();
    render();
    input.focus();
    input.select();
  }

  function closeOverlay() {
    overlay.hidden = true;
    document.body.classList.remove('search-open');
  }

  function isOpen() {
    return !overlay.hidden;
  }

  input.addEventListener('input', render);

  input.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!matches.length) return;
      active = e.key === 'ArrowDown'
        ? (active + 1) % matches.length
        : (active - 1 + matches.length) % matches.length;
      updateActive();
    } else if (e.key === 'Enter') {
      if (active > -1 && matches[active]) {
        e.preventDefault();
        window.location.href = matches[active].doc.url;
      }
    }
  });

  results.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('.search-item')) closeOverlay();
  });

  results.addEventListener('mousemove', function (e) {
    var item = e.target.closest && e.target.closest('.search-item[data-i]');
    if (!item) return;
    var i = parseInt(item.getAttribute('data-i'), 10);
    if (i !== active) {
      active = i;
      updateActive();
    }
  });

  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) closeOverlay();
  });

  if (closeBtn) closeBtn.addEventListener('click', closeOverlay);
  if (toggleBtn) toggleBtn.addEventListener('click', function () { isOpen() ? closeOverlay() : openOverlay(); });

  document.addEventListener('keydown', function (e) {
    if (isOpen()) {
      if (e.key === 'Escape') closeOverlay();
      return;
    }
    var tag = (e.target && e.target.tagName) || '';
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable);
    if (typing) return;
    var isSlash = e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey;
    var isCmdK = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k';
    if (isSlash || isCmdK) {
      e.preventDefault();
      openOverlay();
    }
  });
})();
