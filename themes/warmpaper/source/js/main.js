// Mobile nav toggle
(function () {
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.querySelector('.site-nav');
  if (!toggle || !nav) return;

  toggle.addEventListener('click', function (e) {
    var expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!expanded));
    nav.classList.toggle('open');
    e.stopPropagation();
  });

  // Close menu when clicking anywhere outside the nav
  document.addEventListener('click', function (e) {
    if (nav.classList.contains('open') && !nav.contains(e.target) && e.target !== toggle) {
      toggle.setAttribute('aria-expanded', 'false');
      nav.classList.remove('open');
    }
  });
})();

(function () {
  // TOC scroll tracking
  var tocLinks = document.querySelectorAll('.toc a');
  if (!tocLinks.length) return;

  var headings = document.querySelectorAll(
    '.post-content h1[id], .post-content h2[id], .post-content h3[id], .post-content h4[id]'
  );
  if (!headings.length) return;

  function setActive(id) {
    tocLinks.forEach(function (link) {
      link.classList.remove('active');
      var href = link.getAttribute('href') || '';
      if (href.charAt(0) === '#') {
        var hrefId = href.slice(1);
        if (hrefId === id || decodeURIComponent(hrefId) === id) {
          link.classList.add('active');
        }
      }
    });
  }

  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          setActive(entry.target.getAttribute('id'));
        }
      });
    },
    {
      rootMargin: '-80px 0px -75% 0px',
    }
  );

  headings.forEach(function (heading) {
    observer.observe(heading);
  });
})();

// Theme toggle
(function () {
  var STORAGE_KEY = 'warmpaper-theme';
  var btn = document.querySelector('.theme-toggle');
  if (!btn) return;

  var mql = window.matchMedia('(prefers-color-scheme: dark)');

  function currentTheme() {
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'light' || saved === 'dark') return saved;
    } catch (e) {}
    return mql.matches ? 'dark' : 'light';
  }

  function syncIcon() {
    btn.setAttribute('data-theme-state', currentTheme());
  }

  btn.addEventListener('click', function () {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch (e) {}
    btn.setAttribute('data-theme-state', next);
  });

  mql.addEventListener('change', function () {
    var hasManual = false;
    try { hasManual = !!localStorage.getItem(STORAGE_KEY); } catch (e) {}
    if (!hasManual) syncIcon();
  });

  syncIcon();
})();

// TOC toggle for small screens
(function () {
  var tocSidebar = document.querySelector('.toc-sidebar');
  if (!tocSidebar) return;

  // create backdrop
  var backdrop = document.createElement('div');
  backdrop.className = 'toc-backdrop';
  document.body.appendChild(backdrop);

  // create toggle button
  var btn = document.createElement('button');
  btn.className = 'toc-toggle';
  btn.setAttribute('aria-expanded', 'false');
  btn.textContent = '目录';
  document.body.appendChild(btn);

  function toggle(open) {
    var isOpen = open === undefined ? !tocSidebar.classList.contains('open') : open;
    tocSidebar.classList.toggle('open', isOpen);
    backdrop.classList.toggle('open', isOpen);
    btn.setAttribute('aria-expanded', String(isOpen));
    // Prevent body scroll when TOC is open
    document.body.style.overflow = isOpen ? 'hidden' : '';
  }

  btn.addEventListener('click', function (e) {
    toggle();
    e.stopPropagation();
  });

  // Close when clicking backdrop
  backdrop.addEventListener('click', function () {
    toggle(false);
  });

  // Close when clicking outside
  document.addEventListener('click', function (e) {
    if (!tocSidebar.classList.contains('open')) return;
    if (!tocSidebar.contains(e.target) && e.target !== btn) toggle(false);
  });

  // Close on escape
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && tocSidebar.classList.contains('open')) toggle(false);
  });
})();
