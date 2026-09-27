/* 图片查看器：点击正文图片打开，滚轮/按钮缩放，拖拽平移，双击复位，Esc 关闭 */
(function () {
  'use strict';

  var MIN_SCALE = 0.05;
  var MAX_SCALE = 40;
  var SELECTOR = '.post-body-wrapper img, .post-content img, article.post img, .post img';

  var els = null;          // 已创建的 DOM
  var state = {
    img: null,
    scale: 1,
    tx: 0,
    ty: 0,
    baseW: 0,
    baseH: 0,
    moved: false
  };
  var pointers = {};       // 活动指针，用于双指缩放
  var pinch = null;
  var tipTimer = null;

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function build() {
    if (els) return els;

    var backdrop = document.createElement('div');
    backdrop.className = 'wz-backdrop';
    backdrop.innerHTML =
      '<div class="wz-stage">' +
      '  <img class="wz-img" alt="">' +
      '</div>' +
      '<div class="wz-tip">滚轮缩放 · 拖拽平移 · 双击复位 · Esc 关闭</div>' +
      '<div class="wz-toolbar">' +
      '  <button class="wz-btn" data-act="out" type="button" aria-label="缩小">－</button>' +
      '  <span class="wz-scale">100%</span>' +
      '  <button class="wz-btn" data-act="in" type="button" aria-label="放大">＋</button>' +
      '  <button class="wz-btn" data-act="fit" type="button">适应窗口</button>' +
      '  <button class="wz-btn" data-act="one" type="button">1:1</button>' +
      '</div>' +
      '<button class="wz-close" type="button" aria-label="关闭">&times;</button>';

    document.body.appendChild(backdrop);

    els = {
      backdrop: backdrop,
      img: backdrop.querySelector('.wz-img'),
      tip: backdrop.querySelector('.wz-tip'),
      scale: backdrop.querySelector('.wz-scale')
    };

    els.img.addEventListener('load', function () {
      if (isOpen()) fit();
    });
    els.backdrop.addEventListener('wheel', onWheel, { passive: false });
    els.backdrop.addEventListener('pointerdown', onPointerDown);
    els.backdrop.addEventListener('pointermove', onPointerMove);
    els.backdrop.addEventListener('pointerup', onPointerUp);
    els.backdrop.addEventListener('pointercancel', onPointerUp);
    els.backdrop.addEventListener('dblclick', function (e) {
      e.preventDefault();
      fit();
    });

    els.backdrop.querySelector('.wz-toolbar').addEventListener('click', function (e) {
      var btn = e.target.closest('.wz-btn');
      if (!btn) return;
      e.stopPropagation();
      if (btn.dataset.act === 'in') zoomBy(1.25);
      else if (btn.dataset.act === 'out') zoomBy(0.8);
      else if (btn.dataset.act === 'fit') fit();
      else if (btn.dataset.act === 'one') zoomTo(1);
    });

    els.backdrop.querySelector('.wz-close').addEventListener('click', function (e) {
      e.stopPropagation();
      close();
    });

    document.addEventListener('keydown', onKey);

    return els;
  }

  function updateScale() {
    els.img.style.transform = 'translate(' + state.tx + 'px,' + state.ty + 'px) scale(' + state.scale + ')';
    els.scale.textContent = Math.round(state.scale * 100) + '%';
  }

  function open(src, alt) {
    build();
    state.img = els.img;
    els.img.src = src;
    els.img.alt = alt || '';
    els.backdrop.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    fitIfReady();
    showTip();

    els.img.onerror = function () {
      window.open(src, '_blank');
      close();
    };
  }

  /* 图片是异步解码的，naturalWidth 要等 load 之后才有值，否则 fit() 算出来的比例是错的 */
  function fitIfReady() {
    if (els.img.complete && els.img.naturalWidth) fit();
  }

  function close() {
    if (!els) return;
    els.backdrop.classList.remove('is-open', 'is-panning');
    els.img.removeAttribute('src');
    document.body.style.overflow = '';
  }

  function isOpen() {
    return els && els.backdrop.classList.contains('is-open');
  }

  function showTip() {
    clearTimeout(tipTimer);
    els.tip.classList.add('is-visible');
    tipTimer = setTimeout(function () {
      els.tip.classList.remove('is-visible');
    }, 2200);
  }

  function measure() {
    state.baseW = els.img.naturalWidth || window.innerWidth;
    state.baseH = els.img.naturalHeight || window.innerHeight;
  }

  /* 适应窗口：整图居中，并按 contain 缩放——宽或高刚好顶到视口边缘 */
  function fit() {
    measure();
    state.scale = clamp(Math.min(window.innerWidth / state.baseW,
                                 window.innerHeight / state.baseH), MIN_SCALE, MAX_SCALE);
    center();
  }

  function center() {
    state.tx = (window.innerWidth - state.baseW * state.scale) / 2;
    state.ty = (window.innerHeight - state.baseH * state.scale) / 2;
    updateScale();
  }

  function zoomTo(next, cx, cy) {
    next = clamp(next, MIN_SCALE, MAX_SCALE);
    if (cx === undefined) {
      cx = window.innerWidth / 2;
      cy = window.innerHeight / 2;
    }
    var k = next / state.scale;
    state.tx = cx - (cx - state.tx) * k;
    state.ty = cy - (cy - state.ty) * k;
    state.scale = next;
    updateScale();
  }

  function zoomBy(k) {
    zoomTo(state.scale * k);
  }

  function onWheel(e) {
    if (!isOpen()) return;
    e.preventDefault();
    var factor = Math.pow(0.999, e.deltaY * (e.deltaMode === 1 ? 16 : 1));
    zoomTo(state.scale * factor, e.clientX, e.clientY);
  }

  function dist(a, b) {
    var dx = a.x - b.x;
    var dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function onPointerDown(e) {
    if (!isOpen()) return;
    pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    state.moved = false;
    if (Object.keys(pointers).length === 2) {
      var ids = Object.keys(pointers);
      pinch = { scale: state.scale, d: dist(pointers[ids[0]], pointers[ids[1]]) };
    }
    if (e.target.closest('.wz-toolbar, .wz-close')) return;
    els.backdrop.classList.add('is-panning');
    els.backdrop.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e) {
    if (!isOpen() || !pointers[e.pointerId]) return;
    var prev = pointers[e.pointerId];
    pointers[e.pointerId] = { x: e.clientX, y: e.clientY };

    var ids = Object.keys(pointers);
    if (ids.length === 2 && pinch) {
      var d = dist(pointers[ids[0]], pointers[ids[1]]);
      if (pinch.d > 0) {
        var mid = {
          x: (pointers[ids[0]].x + pointers[ids[1]].x) / 2,
          y: (pointers[ids[0]].y + pointers[ids[1]].y) / 2
        };
        zoomTo(pinch.scale * (d / pinch.d), mid.x, mid.y);
      }
      return;
    }

    var dx = e.clientX - prev.x;
    var dy = e.clientY - prev.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) state.moved = true;
    state.tx += dx;
    state.ty += dy;
    updateScale();
  }

  function onPointerUp(e) {
    if (!pointers[e.pointerId]) return;
    delete pointers[e.pointerId];
    if (Object.keys(pointers).length < 2) pinch = null;
    els.backdrop.classList.remove('is-panning');
    if (e.type === 'pointerup' && !state.moved && !e.target.closest('.wz-img, .wz-toolbar, .wz-close')) {
      close();   // 点空白处关闭
    }
  }

  function onKey(e) {
    if (!isOpen()) return;
    if (e.key === 'Escape') close();
    else if (e.key === '+' || e.key === '=') zoomBy(1.25);
    else if (e.key === '-' || e.key === '_') zoomBy(0.8);
    else if (e.key === '0') fit();
  }

  function init() {
    var imgs = document.querySelectorAll(SELECTOR);
    Array.prototype.forEach.call(imgs, function (img) {
      if (img.dataset.wzBound) return;
      img.dataset.wzBound = '1';
      img.classList.add('wz-openable');
      img.title = img.alt ? img.alt + '（点击放大，可调缩放）' : '点击放大，可调缩放';
      img.addEventListener('click', function () {
        open(img.currentSrc || img.src, img.alt);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  window.addEventListener('resize', function () {
    if (isOpen()) updateScale();
  });
})();
