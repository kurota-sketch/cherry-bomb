// KATSUMIA — 拼貼牆、可換圖欄位、圖庫，以及給站主用的編輯模式
(function () {
  var DEFAULT = { v: 1, slots: {}, collage: [], gallery: [] };
  var state = null;
  var pending = {};      // 尚未儲存的新圖：path -> Blob
  var localURL = {};     // path -> objectURL（新圖在儲存前後都用這個顯示）
  var savedPaths = {};   // 已發布版本裡用到的 img/ 檔
  var dirty = false, editing = false, sel = null, art = null;

  var $ = function (id) { return document.getElementById(id); };
  var board = $('board'), grid = $('grid');
  var CAT = { comm: '委託', doodle: '塗鴉', comic: '', illus: '' };

  function src(path) { return localURL[path] || path; }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function esc(t) { var d = document.createElement('div'); d.textContent = t == null ? '' : t; return d.innerHTML; }
  function status(t) { $('ebStatus').textContent = t; }
  function markDirty() { dirty = true; status('有未儲存的變更'); if (!restoring) scheduleSnap(); }
  // 復原／重做：每次變更後記下一份快照
  var hist = [], hi = -1, restoring = false, snapT = null;
  function scheduleSnap() { clearTimeout(snapT); snapT = setTimeout(commitSnap, 350); }
  function commitSnap() {
    clearTimeout(snapT); if (!state) return;
    var j = JSON.stringify(state);
    if (hist[hi] === j) return;
    hist = hist.slice(0, hi + 1); hist.push(j);
    if (hist.length > 120) hist.shift();
    hi = hist.length - 1; undoUI();
  }
  function restoreSnap(j) {
    restoring = true;
    state = JSON.parse(j); sel = null;
    ['cropper', 'slideMgr', 'creditDlg'].forEach(function (id) { $(id).hidden = true; });
    renderAll();
    dirty = true; restoring = false; undoUI();
  }
  function undo() { commitSnap(); if (hi > 0) { hi--; restoreSnap(hist[hi]); status('已復原（Ctrl+Z）'); } else status('沒有可以復原的步驟'); }
  function redo() { commitSnap(); if (hi < hist.length - 1) { hi++; restoreSnap(hist[hi]); status('已重做'); } }
  function undoUI() {
    var u = document.getElementById('undoBtn'), r = document.getElementById('redoBtn');
    if (u) u.disabled = hi <= 0; if (r) r.disabled = hi >= hist.length - 1;
  }

  function usedPaths() {
    var u = {};
    Object.keys(state.slots).forEach(function (k) { if (state.slots[k]) u[state.slots[k]] = 1; });
    state.collage.forEach(function (c) { if (c.src) u[c.src] = 1; (c.srcs || []).forEach(function (p) { u[p] = 1; }); });
    state.gallery.forEach(function (g) { u[g.src] = 1; (g.alts || []).forEach(function (p) { u[p] = 1; }); });
    (state.wardrobe || []).forEach(function (o) { (o.imgs || []).forEach(function (p) { u[p] = 1; }); });
    (state.music || []).forEach(function (t) { if (t.src) u[t.src] = 1; });
    (state.library || []).forEach(function (w) { if (w.cover) u[w.cover] = 1; (w.pages || []).forEach(function (p) { u[p] = 1; }); (w.blocks || []).forEach(function (b) { if (b.src) u[b.src] = 1; }); });
    Object.keys(u).forEach(function (k) { if (k.indexOf('img/') !== 0 && k.indexOf('music/') !== 0) delete u[k]; });
    return u;
  }

  // ---------- 圖片壓縮 ----------
  function compress(file) {
    return createImageBitmap(file).then(function (bmp) {
      var max = 1600, sc = Math.min(1, max / Math.max(bmp.width, bmp.height));
      var c = document.createElement('canvas');
      c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
      var ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      // 檢查有沒有透明的地方
      var alpha = false;
      try {
        var t = document.createElement('canvas'); t.width = 64; t.height = 64;
        var tc = t.getContext('2d'); tc.drawImage(c, 0, 0, 64, 64);
        var px = tc.getImageData(0, 0, 64, 64).data;
        for (var i = 3; i < px.length; i += 4) if (px[i] < 250) { alpha = true; break; }
      } catch (_) {}
      return new Promise(function (res) {
        c.toBlob(function (b) {
          if (b && b.type === 'image/webp') return res({ blob: b, ext: 'webp', alpha: alpha });
          // 瀏覽器不支援 webp：透明圖存 PNG，保留透明；一般圖存 JPG
          if (alpha) c.toBlob(function (p) { res({ blob: p, ext: 'png', alpha: true }); }, 'image/png');
          else c.toBlob(function (j) { res({ blob: j, ext: 'jpg', alpha: false }); }, 'image/jpeg', 0.86);
        }, 'image/webp', 0.86);
      });
    });
  }
  var MAXB = 15 * 1024 * 1024;
  function isVid(p) { return /\.(mp4|webm)$/i.test(p || ''); }
  function hasAlpha(file) {
    return createImageBitmap(file).then(function (bmp) {
      var t = document.createElement('canvas'); t.width = 64; t.height = 64;
      var tc = t.getContext('2d'); tc.drawImage(bmp, 0, 0, 64, 64);
      var px = tc.getImageData(0, 0, 64, 64).data;
      for (var i = 3; i < px.length; i += 4) if (px[i] < 250) return true;
      return false;
    }).catch(function () { return false; });
  }
  function addFile(file) {
    var type = (file.type || '').toLowerCase();
    // GIF 和影片不壓縮，原檔上傳才會動
    if (type === 'image/gif' || type === 'video/mp4' || type === 'video/webm') {
      if (file.size > MAXB) return Promise.reject({ msg: '「' + file.name + '」超過 15MB，請先壓小一點再上傳' });
      var ext = type === 'image/gif' ? 'gif' : type === 'video/mp4' ? 'mp4' : 'webm';
      return (ext === 'gif' ? hasAlpha(file) : Promise.resolve(false)).then(function (a) {
        var path = 'img/' + uid() + '.' + ext;
        pending[path] = file; localURL[path] = URL.createObjectURL(file);
        if (a) alphaMap[path] = true;
        return path;
      });
    }
    if (/^audio\//.test(type) || /\.(mp3|m4a|aac|ogg|oga|wav)$/i.test(file.name || '')) {
      if (file.size > MAXB) return Promise.reject({ msg: '「' + file.name + '」超過 15MB，請先壓小一點（建議 mp3 128–192kbps）' });
      var aext = (/\.([a-z0-9]+)$/i.exec(file.name || '') || [0, 'mp3'])[1].toLowerCase();
      if (!/^(mp3|m4a|aac|ogg|oga|wav)$/.test(aext)) aext = 'mp3';
      var apath = 'music/' + uid() + '.' + aext;
      pending[apath] = file; localURL[apath] = URL.createObjectURL(file);
      return Promise.resolve(apath);
    }
    if (/^video\//.test(type)) return Promise.reject({ msg: '影片請用 MP4 或 WebM 格式（iPhone 的 MOV 要先轉檔）' });
    return compress(file).then(function (r) {
      var path = 'img/' + uid() + '.' + r.ext;
      pending[path] = r.blob; localURL[path] = URL.createObjectURL(r.blob);
      if (r.alpha) alphaMap[path] = true;
      return path;
    });
  }
  var alphaMap = {};    // 有透明背景的圖
  function styleFor(p) { return 'plain'; } // 新圖一律不加框，要框再自己按「樣式」
  var pickCb = null;
  $('filePick').addEventListener('change', function (e) {
    var f = e.target.files[0]; e.target.value = '';
    if (!f || !pickCb) return;
    var cb = pickCb; pickCb = null;
    status('處理圖片中…');
    addFile(f).then(function (p) { cb(p); markDirty();  }).catch(function (er) { status((er && er.msg) || '這個檔案讀不了，換一張試試'); });
  });
  function pick(cb) { pickCb = cb; $('filePick').click(); }

  // ---------- 繪師署名（每張圖一筆，用圖片路徑對應） ----------
  function creditOf(p) {
    var c = p && (state.credits || {})[p]; if (c && c.n) return c;
    var g = p && (state.gallery || []).filter(function (x) { return x.src === p && x.credit; })[0];
    return g ? { n: g.credit } : null;
  }
  function safeUrl(u) { return /^https?:\/\/[^\s"'<>]+$/i.test(u || '') ? u : ''; }
  function creditInner(c) { var u = safeUrl(c.u); return 'art / ' + (u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(c.n) + '</a>' : esc(c.n)); }
  function creditBadge(p) {
    var c = creditOf(p); if (!c) return null;
    var s = document.createElement('span'); s.className = 'credit'; s.tabIndex = 0;
    s.setAttribute('aria-label', '繪師：' + c.n);
    s.innerHTML = '<i>©</i><span class="cr-t">' + creditInner(c) + '</span>';
    s.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    s.addEventListener('click', function (e) {
      if (e.target.closest('a') && s.classList.contains('open')) return;
      e.preventDefault(); e.stopPropagation();
      var o = !s.classList.contains('open');
      [].forEach.call(document.querySelectorAll('.credit.open'), function (x) { x.classList.remove('open'); });
      s.classList.toggle('open', o);
    });
    return s;
  }
  document.addEventListener('click', function (e) { if (!e.target.closest('.credit')) [].forEach.call(document.querySelectorAll('.credit.open'), function (x) { x.classList.remove('open'); }); });
  var cdPath = null, cdAfter = null;
  function openCredit(p, after) {
    cdPath = p; cdAfter = after;
    var c = (state.credits || {})[p] || creditOf(p) || {};
    $('cdName').value = c.n || ''; $('cdUrl').value = c.u || '';
    var names = {};
    Object.keys(state.credits || {}).forEach(function (k) { var x = state.credits[k]; if (x && x.n) names[x.n] = 1; });
    (state.gallery || []).forEach(function (g) { if (g.credit) names[g.credit] = 1; });
    $('cdNames').innerHTML = Object.keys(names).map(function (n) { return '<option value="' + esc(n) + '">'; }).join('');
    $('creditDlg').hidden = false; setTimeout(function () { $('cdName').focus(); }, 30);
  }
  function closeCredit(save, clear) {
    if (save && cdPath) {
      state.credits = state.credits || {};
      var n = $('cdName').value.trim(), u = $('cdUrl').value.trim();
      if (clear || !n) delete state.credits[cdPath];
      else { state.credits[cdPath] = { n: n }; if (safeUrl(u)) state.credits[cdPath].u = u; }
      // 同一位繪師之後打字時會自動出現在選單裡
      markDirty(); if (cdAfter) cdAfter();
      status(clear || !n ? '已清除署名' : '已加上繪師：' + n);
    }
    $('creditDlg').hidden = true; cdPath = null; cdAfter = null;
  }
  $('cdOk').addEventListener('click', function () { closeCredit(true); });
  $('cdClear').addEventListener('click', function () { closeCredit(true, true); });
  $('cdCancel').addEventListener('click', function () { closeCredit(false); });
  $('creditDlg').addEventListener('click', function (e) { if (e.target === this) closeCredit(false); });
  $('creditDlg').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); closeCredit(true); } if (e.key === 'Escape') closeCredit(false); });

  // ---------- 欄位（入口圖、角色圖） ----------
  var slotEls = [].slice.call(document.querySelectorAll('[data-slot]'));
  slotEls.forEach(function (el) { el.dataset.ph = el.innerHTML; });
  // 欄位：圖片完整顯示、框跟著圖片比例走；要裁切或移動取景就用裁切視窗
  function slotCropOf(k) { return (state.slotCrop || {})[k]; }
  function slotArOf(k) { return (state.slotAr || {})[k]; }
  function slotMedia(k, p) {
    var c = slotCropOf(k), ar = slotArOf(k);
    if (!c || !ar) return media(p);
    var R = (c.w * ar / c.h).toFixed(4);
    return '<div class="crop" style="aspect-ratio:' + R + ';--r:' + R + '">' + media(p, ' style="width:' + (100 / c.w) + '%;height:auto;left:' + (-c.x / c.w * 100) + '%;top:' + (-c.y / c.h * 100) + '%"') + '</div>';
  }
  // 身高圖的全身圖：自由移動、縮放、翻轉（x、y 是自身寬高的 %）
  function xfOf(k) { state.slotXf = state.slotXf || {}; var q = state.slotXf[k] || {}; return { x: q.x || 0, y: q.y || 0, s: q.s || 1, f: !!q.f }; }
  // 可以自由移動的欄位：全身圖、特寫
  function isXf(el) { return !!(el.closest('.hc-fig') || el.closest('.anc') || el.classList.contains('hud-fig') || el.classList.contains('hud-lens')); }
  // 特寫：框固定是正方形，圖片先填滿框（置中），再讓人自己拖、縮放
  function fitCover(el, k) {
    var m = el.querySelector(':scope > img, :scope > video, :scope > .crop'); if (!m) return;
    var c = slotCropOf(k), ar = slotArOf(k); if (!ar) return;
    var R = c ? c.w * ar / c.h : ar, w, h;
    // 角色介紹的膠囊/放大鏡框不是正方形：用框自己的寬高算「填滿不變形」
    if (el.classList.contains('hud-fig') || el.classList.contains('hud-lens')) {
      var W = 'max(100cqw, calc(100cqh * ' + R + '))', H = 'max(100cqh, calc(100cqw / ' + R + '))';
      m.style.width = W; m.style.height = H;
      m.style.left = 'calc((100cqw - ' + W + ') / 2)'; m.style.top = 'calc((100cqh - ' + H + ') / 2)';
      return;
    }
    if (R >= 1) { h = 100; w = 100 * R; } else { w = 100; h = 100 / R; }
    m.style.width = w + '%'; m.style.height = h + '%';
    m.style.left = (100 - w) / 2 + '%'; m.style.top = (100 - h) / 2 + '%';
  }
  function applyXf(el, k) {
    var m = el.querySelector(':scope > img, :scope > video, :scope > .crop'); if (!m) return;
    var q = xfOf(k);
    m.style.transformOrigin = (el.closest('.anc') || el.classList.contains('hud-fig') || el.classList.contains('hud-lens')) ? '50% 50%' : '50% 100%';
    m.style.transform = 'translate(' + q.x + '%,' + q.y + '%) scale(' + q.s + ')' + (q.f ? ' scaleX(-1)' : '');
  }
  var xd = null;
  slotEls.forEach(function (el) {
    if (!isXf(el)) return;
    el.addEventListener('pointerdown', function (e) {
      if (!editing || !el.classList.contains('filled') || e.target.closest('button')) return;
      var m = el.querySelector(':scope > img, :scope > video, :scope > .crop'); if (!m) return;
      var q = xfOf(el.dataset.slot);
      xd = { el: el, k: el.dataset.slot, sx: e.clientX, sy: e.clientY, x: q.x, y: q.y, w: m.offsetWidth || 1, h: m.offsetHeight || 1, moved: false };
      el.setPointerCapture(e.pointerId); e.preventDefault();
    });
    el.addEventListener('pointermove', function (e) {
      if (!xd || xd.el !== el) return;
      var q = xfOf(xd.k);
      q.x = Math.round((xd.x + (e.clientX - xd.sx) / xd.w * 100) * 10) / 10;
      q.y = Math.round((xd.y + (e.clientY - xd.sy) / xd.h * 100) * 10) / 10;
      xd.moved = true; state.slotXf[xd.k] = q; applyXf(el, xd.k);
    });
    var end = function () { if (xd && xd.el === el) { if (xd.moved) markDirty(); xd = null; } };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', function (e) {
      if (!editing || !el.classList.contains('filled')) return;
      e.preventDefault();
      var q = xfOf(el.dataset.slot);
      q.s = Math.min(8, Math.max(0.2, q.s * Math.pow(1.0015, -e.deltaY)));
      state.slotXf[el.dataset.slot] = q; applyXf(el, el.dataset.slot); markDirty();
    }, { passive: false });
  });
  function renderSlots() {
    slotEls.forEach(function (el) {
      var k = el.dataset.slot, own = state.slots[k], fb = el.dataset.fallback;
      // 放大鏡特寫：自己沒放圖時，直接放大主圖
      var mk = own || !fb ? k : fb, p = own || (fb && state.slots[fb]);
      if (p && !own && el.dataset.z && !(state.slotXf || {})[k]) { var z = el.dataset.z.split(',').map(Number); state.slotXf = state.slotXf || {}; state.slotXf[k] = { x: z[1], y: z[2], s: z[0] }; }
      el.classList.toggle('filled', !!p);
      var framed = !!(el.closest('.anc') || el.classList.contains('hud-fig') || el.classList.contains('hud-lens'));
      el.classList.toggle('natural', !!p && !framed);
      el.classList.toggle('framed', !!p && framed);
      el.innerHTML = p ? slotMedia(mk, p) : el.dataset.ph;
      if (p && !slotArOf(mk)) {
        var m = el.querySelector('img,video');
        var setAr = function (w, h) { if (!w || !h) return; state.slotAr = state.slotAr || {}; state.slotAr[mk] = w / h; if (slotCropOf(mk) || framed) renderSlots(); };
        if (m.tagName === 'VIDEO') m.addEventListener('loadedmetadata', function () { setAr(m.videoWidth, m.videoHeight); });
        else m.addEventListener('load', function () { setAr(m.naturalWidth, m.naturalHeight); });
      }
      if (p && framed) fitCover(el, mk);
      var cb = own && creditBadge(own); if (cb) el.appendChild(cb);
      if (p && isXf(el)) applyXf(el, k);
      if (!editing) return;
      var bar = document.createElement('div'); bar.className = 'slot-tools';
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'btn small'; b.textContent = own ? '換圖' : (p ? '另外上傳' : '放圖');
      b.onclick = function () { pick(function (path) { state.slots[k] = path; if (state.slotCrop) delete state.slotCrop[k]; if (state.slotAr) delete state.slotAr[k]; if (fb && state.slotXf) delete state.slotXf[k]; renderSlots(); }); };
      bar.appendChild(b);
      if (p && !own) {
        var rz = document.createElement('button'); rz.type = 'button'; rz.className = 'btn small ghost'; rz.textContent = '重設';
        rz.onclick = function () { delete state.slotXf[k]; markDirty(); renderSlots(); };
        bar.appendChild(rz); el.appendChild(bar);
        var xb0 = document.createElement('div'); xb0.className = 'xf-tools';
        [['＋', '放大', 1.1], ['−', '縮小', 1 / 1.1]].forEach(function (t) { var bt = document.createElement('button'); bt.type = 'button'; bt.className = 'ic'; bt.textContent = t[0]; bt.title = t[1]; bt.onclick = function (e) { e.stopPropagation(); var q = xfOf(k); q.s = Math.min(8, Math.max(0.2, q.s * t[2])); state.slotXf[k] = q; applyXf(el, k); markDirty(); }; xb0.appendChild(bt); });
        el.appendChild(xb0); return;
      }
      if (p) {
        var a = document.createElement('button');
        a.type = 'button'; a.className = 'btn small ghost'; a.textContent = '裁切';
        a.onclick = function () { openCrop({ _slot: k, _square: framed, src: p, crop: slotCropOf(k), ar: slotArOf(k) }); };
        bar.appendChild(a);
        var cr = document.createElement('button');
        cr.type = 'button'; cr.className = 'btn small ghost'; cr.textContent = '繪師';
        cr.onclick = function () { openCredit(p, renderSlots); };
        bar.appendChild(cr);
        var d = document.createElement('button');
        d.type = 'button'; d.className = 'btn small ghost'; d.textContent = '移除';
        d.onclick = function () { delete state.slots[k]; if (state.slotCrop) delete state.slotCrop[k]; if (fb && state.slotXf) delete state.slotXf[k]; markDirty(); renderSlots(); };
        bar.appendChild(d);
        if (isXf(el)) {
          var xb = document.createElement('div'); xb.className = 'xf-tools';
          [['＋', '放大', function (q) { q.s = Math.min(6, q.s * 1.08); }],
           ['−', '縮小', function (q) { q.s = Math.max(0.2, q.s / 1.08); }],
           ['⇋', '左右翻轉', function (q) { q.f = !q.f; }],
           ['↺', '重設位置和大小', function (q) { q.x = 0; q.y = 0; q.s = 1; q.f = false; }]].filter(function (t) { return !framed || t[0] !== '⇋'; }).forEach(function (t) {
            var bt = document.createElement('button'); bt.type = 'button'; bt.className = 'ic'; bt.textContent = t[0]; bt.title = t[1];
            bt.onclick = function (e) { e.stopPropagation(); var q = xfOf(k); t[2](q); state.slotXf[k] = q; applyXf(el, k); markDirty(); };
            xb.appendChild(bt);
          });
          el.appendChild(xb);
        }
      }
      el.appendChild(bar);
    });
  }

  // ---------- 角色介紹 HUD：背景用角色圖做灰階模糊、細節框借用首頁特寫 ----------
  function renderHud() {
    [].forEach.call(document.querySelectorAll('.hud'), function (hud) {
      var fig = hud.querySelector('.hud-fig'), p = fig && state.slots[fig.dataset.slot];
      hud.querySelector('.hud-bg').style.backgroundImage = p && !isVid(p) ? 'url("' + src(p) + '")' : '';
      [].forEach.call(hud.querySelectorAll('[data-src-slot]'), function (el) {
        var k = el.dataset.srcSlot, q = state.slots[k];
        el.hidden = !q; el.innerHTML = q ? slotMedia(k, q) : '';
      });
    });
  }
  var _renderSlots0 = renderSlots;
  // 角色檔案：能力圖跟著評級文字畫、跑馬燈跟著文字跑
  var GRADE = { 'E': 1, 'E+': 1.5, 'D': 2, 'D+': 2.5, 'C': 3, 'C+': 3.5, 'B': 4, 'B+': 4.5, 'A': 5, 'A+': 5.5, 'S': 6, 'S+': 6.5, 'EX': 7 };
  function renderRadar() {
    [].forEach.call(document.querySelectorAll('.dos-radar'), function (box) {
      var pts = [], dots = '', AX = [-90, -18, 54, 126, 198], CX = 120, CY = 122, R = 78;
      [].forEach.call(box.querySelectorAll('.rd-l b'), function (b, i) {
        var g = (b.textContent || '').trim().toUpperCase(), v = GRADE[g] != null ? GRADE[g] : 3;
        var f = Math.min(1, v / 6.5), a = AX[i] * Math.PI / 180, x = CX + R * f * Math.cos(a), y = CY + R * f * Math.sin(a);
        pts.push(x.toFixed(1) + ',' + y.toFixed(1)); dots += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="3.4"/>';
      });
      box.querySelector('.val').setAttribute('points', pts.join(' '));
      box.querySelector('.vdots').innerHTML = dots;
    });
  }
  function renderMq() {
    [].forEach.call(document.querySelectorAll('.dos-mq'), function (m) {
      var t = (m.querySelector('.mq-src').textContent || '').trim() + ' ', h = '';
      for (var i = 0; i < 8; i++) h += '<span>' + esc(t) + '</span>';
      m.querySelector('.mq-track').innerHTML = h;
    });
  }
  document.addEventListener('input', function (e) {
    if (!e.target.closest) return;
    if (e.target.closest('.dos-radar')) renderRadar();
    if (e.target.closest('.mq-src')) renderMq();
  });
  renderSlots = function () { _renderSlots0(); renderHud(); renderRadar(); renderMq(); };

  // ---------- 拼貼牆 ----------
  var WIDGETS = { title: '標題', timer: '夢齡計時器', about: '關於本站', log: '更新紀錄' };
  var SHAPES = {
    bubble: '<svg viewBox="0 0 100 92"><path d="M12 6h76a9 9 0 0 1 9 9v42a9 9 0 0 1-9 9H44L28 84l3-18H12a9 9 0 0 1-9-9V15a9 9 0 0 1 9-9z" fill="#fff" stroke="#7a4b51" stroke-width="4" stroke-linejoin="round"/><path d="M50 56C38 48 32 42 32 33c0-6 4-10 9-10 4 0 7 2 9 6 2-4 5-6 9-6 5 0 9 4 9 10 0 9-6 15-18 23z"/></svg>',
    pow: '<svg viewBox="0 0 100 100"><path d="M50 4l9 22 21-12-4 24 22 6-19 14 13 20-24-3-3 23-15-18-17 16-1-24-24 1 15-18L4 40l23-7-6-23 21 10z" fill="none" stroke="currentColor" stroke-width="6" stroke-linejoin="round"/></svg>',
    puff: '<svg viewBox="0 0 100 96"><path d="M50 6c6 0 8 14 13 20s21 4 24 10-11 15-12 22 9 20 4 25-18-3-25-3-19 9-25 5 0-18-2-25S4 42 6 36s18-5 23-10S44 6 50 6z" stroke-linejoin="round"/></svg>',
    ribbon: '<svg viewBox="0 0 100 60"><path d="M6 40c10-30 22 10 32-12s20 22 30-6 18 20 26 4" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    dots: '<svg viewBox="0 0 100 40"><circle cx="14" cy="20" r="11"/><circle cx="46" cy="20" r="8"/><circle cx="72" cy="20" r="6"/><circle cx="92" cy="20" r="4"/></svg>',
    hearts: '<svg viewBox="0 0 100 80"><path d="M38 74C14 56 2 44 2 28 2 16 11 8 22 8c7 0 13 4 16 10 3-6 9-10 16-10 11 0 20 8 20 20 0 16-12 28-36 46z"/><path d="M80 40C68 31 62 25 62 17c0-6 4-10 10-10 3 0 6 2 8 5 2-3 5-5 8-5 6 0 10 4 10 10 0 8-6 14-18 23z" opacity=".6"/></svg>',
    heart: '<svg viewBox="0 0 100 92"><path d="M50 90C20 66 2 50 2 28 2 13 14 2 28 2c9 0 17 5 22 13C55 7 63 2 72 2c14 0 26 11 26 26 0 22-18 38-48 62z"/></svg>',
    star: '<svg viewBox="0 0 100 96"><path d="M50 3l13 30 33 3-25 22 8 33-29-18-29 18 8-33L4 36l33-3z" stroke-linejoin="round"/></svg>',
    sparkle: '<svg viewBox="0 0 100 100"><path d="M50 0c4 28 22 46 50 50-28 4-46 22-50 50-4-28-22-46-50-50 28-4 46-22 50-50z"/></svg>',
    flower: '<svg viewBox="0 0 100 100"><g><circle cx="50" cy="24" r="22"/><circle cx="76" cy="44" r="22"/><circle cx="66" cy="74" r="22"/><circle cx="34" cy="74" r="22"/><circle cx="24" cy="44" r="22"/></g><circle cx="50" cy="52" r="12" fill="#fdfcfa"/></svg>',
    cherry: '<svg viewBox="0 0 100 100"><path d="M55 8C48 30 38 46 28 62M55 8c6 20 16 36 30 52" stroke="#7d9256" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M55 8c10-8 24-8 32 0-10 6-22 6-32 0z" fill="#93ad6c"/><circle cx="27" cy="74" r="20"/><circle cx="76" cy="72" r="20"/><circle cx="20" cy="67" r="5" fill="#fff" opacity=".7"/><circle cx="69" cy="65" r="5" fill="#fff" opacity=".7"/></svg>'
  };
  var SHAPE_KEYS = Object.keys(SHAPES);
  // ---- 手帳小物 ----
  var J = {
    washi:    { styles: ['gingham', 'dots', 'stripe', 'solid'], colors: ['cherry', 'apricot', 'blush', 'cream'] },
    headline: { styles: ['serif', 'italic', 'type'], colors: ['deep', 'cherry', 'apricot', 'ink'], k: 0.16 },
    lbl:      { styles: ['box', 'outline', 'tag'], colors: ['deep', 'cherry', 'apricot'], k: 0.075 },
    bit:      { styles: ['ticket', 'torn', 'stamp', 'number'], colors: ['cherry', 'apricot', 'deep'], k: { ticket: 0.075, torn: 0.08, stamp: 0.085, number: 0.3 } }
  };
  var PAPERS = { notebook: '手帳攤開', dots: '點點紙', grid: '方格紙', plain: '素面' };
  function journalHTML(it) {
    var t = esc(it.text || '');
    if (it.type === 'washi') return '';
    if (it.type === 'headline') return '<span class="m">' + t + '</span>' + (it.label ? '<span class="s">' + esc(it.label) + '</span>' : '');
    if (it.type === 'lbl') return '<span>' + t + '</span>';
    if (it.style === 'ticket') return '<div class="tk-main">' + t + '</div><div class="tk-stub">ADMIT<br>ONE</div>';
    if (it.style === 'stamp') return '<div class="st-in"><small>KATSUMIA</small><b>' + t + '</b><small>♡ ♡ ♡</small></div>';
    return '<span>' + t + '</span>';
  }
  function isJ(t) { return t === 'washi' || t === 'headline' || t === 'lbl' || t === 'bit'; }
  var PALETTE = { cherry: '#c46f78', apricot: '#d6a283', blush: '#ecc3c3', cream: '#f8e8de', ink: '#7a4b51' };

  function editableText(el, it) {
    el.textContent = it.text;
    if (!editing) return;
    try { el.contentEditable = 'plaintext-only'; } catch (_) { el.contentEditable = 'true'; }
    el.addEventListener('input', function () { it.text = el.innerText; if (document.activeElement !== $('txtInput')) $('txtInput').value = it.text; markDirty(); });
  }
  function renderBoard() {
    board.innerHTML = '';
    board.classList.toggle('editing', editing);
    $('canvasScroll').classList.toggle('editing', editing);
    board.style.aspectRatio = '100/' + (state.canvasH || 80);
    var pp = state.paper || 'notebook';
    Object.keys(PAPERS).forEach(function (k) { board.classList.toggle('paper-' + k, k === pp); });
    if ($('paperSel').value !== pp) $('paperSel').value = pp;
    state.collage.slice().sort(function (a, b) { return a.z - b.z; }).forEach(function (it) {
      var el = document.createElement('div');
      var cls = 'ci ';
      if (it.type === 'note') cls += 'note ' + (it.color || 'paper');
      else if (it.type === 'bubble') cls += 'bubble ' + (it.color || 'paper') + ' ' + (it.tail || 'tl');
      else if (it.type === 'sticker') cls += 'sticker';
      else if (it.type === 'widget') cls += 'widget w-' + it.key;
      else if (it.type === 'slides') cls += 'window slideshow';
      else if (isJ(it.type)) cls += 'j ' + it.type + ' ' + (it.style || J[it.type].styles[0]) + ' c-' + (it.color || J[it.type].colors[0]);
      else cls += (it.style || 'polaroid');
      el.className = cls;
      el.dataset.id = it.id;
      el.style.left = it.x + '%'; el.style.top = it.y + '%'; el.style.width = it.w + '%';
      el.style.zIndex = it.z; el.style.setProperty('--rot', (it.r || 0) + 'deg');
      if (it.type === 'note' || it.type === 'bubble') editableText(el, it);
      else if (it.type === 'sticker') { el.innerHTML = SHAPES[it.shape] || SHAPES.heart; el.style.color = PALETTE[it.color] || PALETTE.cherry; el.querySelector('svg').setAttribute('fill', 'currentColor'); }
      else if (it.type === 'widget') { var t = $('tpl-' + it.key); el.innerHTML = t ? t.innerHTML : ''; }
      else if (isJ(it.type)) {
        el.innerHTML = journalHTML(it);
        var kk = J[it.type].k; if (kk && typeof kk === 'object') kk = kk[it.style || 'ticket'];
        if (kk) el.style.fontSize = (it.w * kk).toFixed(3) + 'em';
      }
      else if (it.type === 'slides') { el.innerHTML = slidesHTML(it); if (editing) el.addEventListener('dblclick', function () { openMgr(it); }); }
      else {
        var inner = it.src ? imgHTML(it) : '<div class="ph"><span>' + esc(it.label || '放圖') + '<small>' + (editing ? '點「換圖」放圖片' : 'coming soon') + '</small></span></div>';
        if (it.style === 'window') el.innerHTML = '<div class="bar"><i></i><i></i><span>' + esc(it.label || 'photo') + '</span></div><div class="body">' + inner + '</div>';
        else el.innerHTML = inner + (it.style === 'polaroid' && it.label ? '<span class="cap">' + esc(it.label) + '</span>' : '');
      }
      if (editing && sel === it.id) {
        el.classList.add('sel');
        el.insertAdjacentHTML('beforeend', '<span contenteditable="false" class="h" data-h="nw"></span><span contenteditable="false" class="h" data-h="ne"></span><span contenteditable="false" class="h" data-h="sw"></span><span contenteditable="false" class="h" data-h="se"></span><span contenteditable="false" class="rot" title="拖曳旋轉"></span>');
      }
      var im = it.type === 'img' && el.querySelector('img,video');
      if (im && !it.ar) {
        if (im.tagName === 'VIDEO') im.addEventListener('loadedmetadata', function () { it.ar = im.videoWidth / im.videoHeight; if (it.crop) renderBoard(); });
        else im.addEventListener('load', function () { it.ar = im.naturalWidth / im.naturalHeight; if (it.crop) renderBoard(); });
      }
      if (editing && it.type === 'img' && it.src) el.addEventListener('dblclick', function () { openCrop(it); });
      if (it.type === 'img' && it.src) { var bb = creditBadge(it.src); if (bb) el.appendChild(bb); }
      board.appendChild(el);
    });
    tick(); startSlides();
    var item = find(sel);
    $('selTools').hidden = !(editing && item);
    if (item) {
      var t = item.type;
      var show = function (act, on) { document.querySelector('[data-act="' + act + '"]').hidden = !on; };
      show('replace', t === 'img'); show('cx', true); show('cy', true); show('crop', t === 'img' && !!item.src); show('credit', t === 'img' && !!item.src);
      show('style', t === 'img' || t === 'bubble' || t === 'sticker' || isJ(t));
      show('color', t === 'note' || t === 'bubble' || t === 'sticker' || isJ(t));
      show('dup', t !== 'widget');
      show('slides', t === 'slides');
      var hasLbl = t === 'img' || t === 'slides' || t === 'headline';
      var hasTxt = t === 'note' || t === 'bubble' || t === 'headline' || t === 'lbl' || t === 'bit';
      $('lblInput').hidden = !hasLbl; $('lblInput').placeholder = t === 'headline' ? '下面的小字' : '標題文字';
      $('txtInput').hidden = !hasTxt;
      if (hasTxt && document.activeElement !== $('txtInput')) $('txtInput').value = item.text || '';
      if (hasLbl && document.activeElement !== $('lblInput')) $('lblInput').value = item.label || '';
    }
    var sel2 = $('addWidget'), have = {};
    state.collage.forEach(function (c) { if (c.type === 'widget') have[c.key] = 1; });
    sel2.innerHTML = '<option value="">＋區塊</option>' + Object.keys(WIDGETS).filter(function (k) { return !have[k]; }).map(function (k) { return '<option value="' + k + '">' + WIDGETS[k] + '</option>'; }).join('');
    sel2.hidden = sel2.options.length < 2;
  }
  function media(p, extra) {
    var s = esc(src(p)); extra = extra || '';
    return isVid(p) ? '<video src="' + s + '" autoplay muted loop playsinline' + extra + '></video>' : '<img alt="" src="' + s + '"' + extra + '>';
  }
  function imgHTML(it) {
    var c = it.crop;
    if (!c || !it.ar) return media(it.src);
    return '<div class="crop" style="aspect-ratio:' + (c.w * it.ar / c.h).toFixed(4) + '">' + media(it.src, ' style="width:' + (100 / c.w) + '%;left:' + (-c.x / c.w * 100) + '%;top:' + (-c.y / c.h * 100) + '%"') + '</div>';
  }
  function slidesHTML(it) {
    var list = it.srcs || [];
    var inner = list.length ? list.map(function (p, i) { return '<div class="sl' + (i === 0 ? ' on' : '') + '">' + media(p) + '</div>'; }).join('') +
      (list.length > 1 ? '<div class="dots">' + list.map(function (_, i) { return '<i' + (i === 0 ? ' class="on"' : '') + '></i>'; }).join('') + '</div>' : '')
      : '<div class="ph" style="aspect-ratio:auto;height:100%"><span>輪播視窗<small>' + (editing ? '按「管理輪播」加圖' : 'coming soon') + '</small></span></div>';
    return '<div class="bar"><i></i><i></i><span>' + esc(it.label || 'slides') + '</span></div><div class="body"><div class="slides" style="aspect-ratio:' + (it.ratio || 0.75) + '">' + inner + '</div></div>';
  }
  var slideTimers = [];
  function startSlides() {
    slideTimers.forEach(clearInterval); slideTimers = [];
    [].forEach.call(board.querySelectorAll('.ci.slideshow'), function (el) {
      var it = find(el.dataset.id); if (!it || !it.srcs || it.srcs.length < 2) return;
      var sls = el.querySelectorAll('.sl'), dots = el.querySelectorAll('.dots i'), n = 0;
      slideTimers.push(setInterval(function () {
        sls[n].classList.remove('on'); if (dots[n]) dots[n].classList.remove('on');
        n = (n + 1) % sls.length;
        sls[n].classList.add('on'); if (dots[n]) dots[n].classList.add('on');
      }, Math.max(0.4, it.interval || 1.2) * 1000));
    });
  }
  function find(id) { for (var i = 0; i < state.collage.length; i++) if (state.collage[i].id === id) return state.collage[i]; return null; }
  function topZ() { return state.collage.reduce(function (m, c) { return Math.max(m, c.z || 0); }, 0) + 1; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  // 拖曳 / 縮放 / 旋轉
  var drag = null;
  board.addEventListener('pointerdown', function (e) {
    if (!editing) return;
    var el = e.target.closest('.ci');
    if (!el) { sel = null; renderBoard(); return; }
    var it = find(el.dataset.id);
    var h = e.target.dataset.h, rot = e.target.classList.contains('rot');
    if (sel !== it.id) { sel = it.id; renderBoard(); el = board.querySelector('[data-id="' + it.id + '"]'); }
    if (it.type === 'note' && !h && !rot && document.activeElement === el) return;
    var br = board.getBoundingClientRect(), er = el.getBoundingClientRect();
    var cx = er.left + er.width / 2, cy = er.top + er.height / 2;
    drag = { it: it, el: el, mode: h ? 'rz' : rot ? 'rot' : 'mv', sx: e.clientX, sy: e.clientY,
      x: it.x, y: it.y, w: it.w, bw: br.width, bh: br.height, cx: cx, cy: cy,
      d0: Math.hypot(e.clientX - cx, e.clientY - cy) || 1, h0: el.offsetHeight / br.height * 100, moved: false };
    board.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  board.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var dx = (e.clientX - drag.sx) / drag.bw * 100, dy = (e.clientY - drag.sy) / drag.bh * 100;
    if (Math.abs(dx) + Math.abs(dy) > 0.4) drag.moved = true;
    if (!drag.moved) return;
    e.preventDefault();
    var it = drag.it, el = drag.el;
    if (drag.mode === 'mv') {
      it.x = clamp(drag.x + dx, -it.w / 2, 100 - it.w / 2);
      it.y = clamp(drag.y + dy, -10, 95);
    } else if (drag.mode === 'rz') {
      var f = Math.hypot(e.clientX - drag.cx, e.clientY - drag.cy) / drag.d0;
      f = clamp(f, 6 / drag.w, 95 / drag.w);
      it.w = drag.w * f;
      it.x = drag.x + drag.w * (1 - f) / 2;
      it.y = drag.y + drag.h0 * (1 - f) / 2;
      status('寬度 ' + Math.round(it.w) + '%');
    } else {
      var a = Math.atan2(e.clientY - drag.cy, e.clientX - drag.cx) * 180 / Math.PI + 90;
      a = ((a + 540) % 360) - 180;
      if (e.shiftKey) a = Math.round(a / 15) * 15;
      else if (Math.abs(a) < 3) a = 0;
      it.r = Math.round(a);
      status('角度 ' + it.r + '°（按住 Shift 每 15° 對齊）');
    }
    el.style.left = it.x + '%'; el.style.top = it.y + '%'; el.style.width = it.w + '%';
    el.style.setProperty('--rot', it.r + 'deg');
  });
  function endDrag() {
    if (!drag) return;
    var d = drag; drag = null;
    if (d.moved) { ['x', 'y', 'w'].forEach(function (k) { d.it[k] = Math.round(d.it[k] * 10) / 10; }); markDirty(); }
    else if (d.it.type === 'note' && d.mode === 'mv') { d.el.focus(); }
  }
  board.addEventListener('pointerup', endDrag);
  board.addEventListener('pointercancel', endDrag);

  // 鍵盤：方向鍵微調、Delete 刪除
  document.addEventListener('keydown', function (e) {
    if (!editing) return;
    var ae = document.activeElement, typing = ae && (ae.isContentEditable || /INPUT|SELECT|TEXTAREA/.test(ae.tagName));
    var mod = e.ctrlKey || e.metaKey, key = (e.key || '').toLowerCase();
    if (mod && !typing && key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (mod && !typing && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
    if (mod && key === 's') { e.preventDefault(); $('saveBtn').click(); return; }
  });
  document.addEventListener('keydown', function (e) {
    if (!editing || !sel || !$('cropper').hidden || !$('slideMgr').hidden) return;
    if (document.activeElement && (document.activeElement.isContentEditable || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName))) return;
    var it = find(sel); if (!it) return;
    var st = e.shiftKey ? 2 : 0.5, k = e.key;
    if (k === 'ArrowLeft') it.x -= st; else if (k === 'ArrowRight') it.x += st;
    else if (k === 'ArrowUp') it.y -= st; else if (k === 'ArrowDown') it.y += st;
    else if (k === 'Delete' || k === 'Backspace') { state.collage = state.collage.filter(function (c) { return c !== it; }); sel = null; }
    else return;
    e.preventDefault(); markDirty(); renderBoard();
  });

  // ---------- 裁切 ----------
  var crop = null; // {it, x,y,w,h, ratio}
  var crWrap = $('crWrap'), crBox = $('crBox'), crImg = $('crImg');
  var crVid = $('crVid');
  function openCrop(it) {
    var vid = isVid(it.src);
    crImg.hidden = vid; crVid.hidden = !vid;
    var ready = function (ar) {
      it.ar = ar;
      var c = it.crop || { x: 0, y: 0, w: 1, h: 1 };
      crop = { it: it, x: c.x, y: c.y, w: c.w, h: c.h, ratio: 0 };
      var r0 = it._square ? '1' : '0';
      [].forEach.call(document.querySelectorAll('[data-ratio]'), function (b) { b.setAttribute('aria-pressed', String(b.dataset.ratio === r0)); });
      drawCrop();
      if (it._square) applyRatio(1); // 特寫的框是正方形，裁切預設 1:1，框起來的就是顯示的

    };
    if (vid) {
      crVid.onloadedmetadata = function () { ready(crVid.videoWidth / crVid.videoHeight); };
      crVid.src = src(it.src);
    } else {
      crImg.onload = function () { ready(crImg.naturalWidth / crImg.naturalHeight); };
      crImg.removeAttribute('src');
      crImg.src = src(it.src);
    }
    $('cropper').hidden = false;
  }
  function drawCrop() {
    crBox.style.left = crop.x * 100 + '%'; crBox.style.top = crop.y * 100 + '%';
    crBox.style.width = crop.w * 100 + '%'; crBox.style.height = crop.h * 100 + '%';
  }
  function applyRatio(R) {
    crop.ratio = R; if (!R) return;
    var ar = crop.it.ar, cxm = crop.x + crop.w / 2, cym = crop.y + crop.h / 2;
    var w = crop.w, h = w * ar / R;
    if (h > 1) { h = 1; w = R / ar; }
    if (w > 1) { w = 1; h = ar / R; }
    crop.w = w; crop.h = h;
    crop.x = clamp(cxm - w / 2, 0, 1 - w); crop.y = clamp(cym - h / 2, 0, 1 - h);
    drawCrop();
  }
  var cd = null;
  crWrap.addEventListener('pointerdown', function (e) {
    if (!crop) return;
    var r = crWrap.getBoundingClientRect();
    cd = { c: e.target.dataset.c || (e.target === crBox ? 'mv' : null), sx: e.clientX, sy: e.clientY, rw: r.width, rh: r.height, s: { x: crop.x, y: crop.y, w: crop.w, h: crop.h } };
    if (!cd.c) { cd = null; return; }
    crWrap.setPointerCapture(e.pointerId); e.preventDefault();
  });
  crWrap.addEventListener('pointermove', function (e) {
    if (!cd) return;
    var dx = (e.clientX - cd.sx) / cd.rw, dy = (e.clientY - cd.sy) / cd.rh, s = cd.s, m = 0.04;
    if (cd.c === 'mv') {
      crop.x = clamp(s.x + dx, 0, 1 - s.w); crop.y = clamp(s.y + dy, 0, 1 - s.h);
    } else {
      var left = s.x, top = s.y, right = s.x + s.w, bottom = s.y + s.h;
      if (cd.c.indexOf('w') > -1) left = clamp(s.x + dx, 0, right - m);
      if (cd.c.indexOf('e') > -1) right = clamp(right + dx, left + m, 1);
      if (cd.c.indexOf('n') > -1) top = clamp(s.y + dy, 0, bottom - m);
      if (cd.c.indexOf('s') > -1) bottom = clamp(bottom + dy, top + m, 1);
      var w = right - left, h = bottom - top;
      if (crop.ratio) {
        h = w * crop.it.ar / crop.ratio;
        if (cd.c.indexOf('n') > -1) { top = bottom - h; if (top < 0) { top = 0; h = bottom; w = h * crop.ratio / crop.it.ar; if (cd.c.indexOf('w') > -1) left = right - w; } }
        else if (top + h > 1) { h = 1 - top; w = h * crop.ratio / crop.it.ar; if (cd.c.indexOf('w') > -1) left = right - w; }
      }
      crop.x = left; crop.y = top; crop.w = w; crop.h = h;
    }
    drawCrop();
  });
  crWrap.addEventListener('pointerup', function () { cd = null; });
  crWrap.addEventListener('pointercancel', function () { cd = null; });
  $('cropper').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b || !crop) return;
    if (b.dataset.ratio != null) {
      [].forEach.call(document.querySelectorAll('[data-ratio]'), function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      applyRatio(parseFloat(b.dataset.ratio)); return;
    }
    if (b.id === 'crReset') { crop.x = 0; crop.y = 0; crop.w = 1; crop.h = 1; applyRatio(crop.ratio); drawCrop(); return; }
    if (b.id === 'crOk') {
      var full = crop.w > 0.995 && crop.h > 0.995;
      if (full) delete crop.it.crop;
      else crop.it.crop = { x: +crop.x.toFixed(4), y: +crop.y.toFixed(4), w: +crop.w.toFixed(4), h: +crop.h.toFixed(4) };
      markDirty();
      if (crop.it._slot) {
        var sk = crop.it._slot; state.slotCrop = state.slotCrop || {}; state.slotAr = state.slotAr || {};
        if (crop.it.crop) state.slotCrop[sk] = crop.it.crop; else delete state.slotCrop[sk];
        state.slotAr[sk] = crop.it.ar;
        // 特寫：重新裁切後，之前拖曳／縮放的位置歸零，畫面就是剛剛框起來的範圍
        if (crop.it._square && state.slotXf) delete state.slotXf[sk];
      }
    }
    $('cropper').hidden = true; crop = null; renderBoard(); renderSlots();
  });

  var STYLES = ['polaroid', 'tape', 'plain', 'die', 'window', 'round'], COLORS = ['paper', 'cherry', 'apricot'], TAILS = ['tl', 'tr'];
  var SCOLORS = Object.keys(PALETTE);
  function next(list, v) { return list[(list.indexOf(v) + 1) % list.length]; }
  $('selTools').addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]'); if (!b) return;
    var it = find(sel); if (!it) return;
    var a = b.dataset.act;
    if (a === 'rotL') it.r = (it.r || 0) - 5;
    if (a === 'rotR') it.r = (it.r || 0) + 5;
    if (a === 'front') it.z = topZ();
    if (a === 'cx') it.x = Math.round((50 - it.w / 2) * 10) / 10;
    if (a === 'cy') {
      var el0 = board.querySelector('[data-id="' + it.id + '"]');
      var hh = el0 ? el0.offsetHeight / board.clientHeight * 100 : 10;
      it.y = Math.round((50 - hh / 2) * 10) / 10;
    }
    if (a === 'back') { state.collage.forEach(function (c) { c.z = (c.z || 0) + 1; }); it.z = 0; }
    if (a === 'style') {
      if (it.type === 'img') it.style = next(STYLES, it.style || 'polaroid');
      if (it.type === 'bubble') it.tail = next(TAILS, it.tail || 'tl');
      if (it.type === 'sticker') it.shape = next(SHAPE_KEYS, it.shape || 'heart');
      if (isJ(it.type)) it.style = next(J[it.type].styles, it.style || J[it.type].styles[0]);
      if (it.type === 'bit' && it.style === 'number' && (it.text || '').length > 3) { it._t = it.text; it.text = '30'; it.w = 4; }
      else if (it.type === 'bit' && it.style === 'stamp') { if (it._t) { it.text = it._t; delete it._t; } if ((it.text || '').length > 12) { it._t = it.text; it.text = '2024.12.04'; } it.w = 9; }
      else if (it.type === 'bit' && it._t && it.style !== 'number') { it.text = it._t; delete it._t; it.w = 16; }
    }
    if (a === 'color') {
      if (it.type === 'sticker') it.color = next(SCOLORS, it.color || 'cherry');
      else if (isJ(it.type)) it.color = next(J[it.type].colors, it.color || J[it.type].colors[0]);
      else it.color = next(COLORS, it.color || 'paper');
    }
    if (a === 'dup') {
      var c = JSON.parse(JSON.stringify(it)); c.id = uid(); c.x += 2; c.y += 2; c.z = topZ();
      state.collage.push(c); sel = c.id;
    }
    if (a === 'replace') { pick(function (p) { it.src = p; delete it.crop; delete it.ar; renderBoard(); }); return; }
    if (a === 'crop') { openCrop(it); return; }
    if (a === 'credit') { openCredit(it.src, renderBoard); return; }
    if (a === 'slides') { openMgr(it); return; }
    if (a === 'del') { state.collage = state.collage.filter(function (c) { return c !== it; }); sel = null; }
    markDirty(); renderBoard();
  });
  $('txtInput').addEventListener('input', function () {
    var it = find(sel); if (!it) return;
    it.text = this.value; markDirty();
    var el = board.querySelector('[data-id="' + it.id + '"]');
    if (isJ(it.type)) { renderBoard(); return; }
    if (el && document.activeElement !== el) {
      var keep = [].slice.call(el.querySelectorAll('.h,.rot'));
      el.textContent = it.text; keep.forEach(function (k) { el.appendChild(k); });
    }
  });
  $('lblInput').addEventListener('input', function () {
    var it = find(sel); if (!it) return;
    it.label = this.value; markDirty();
    var el = board.querySelector('[data-id="' + it.id + '"]');
    var cap = el && (el.querySelector('.cap') || el.querySelector('.bar span'));
    if (cap) cap.textContent = it.label; else renderBoard();
  });
  // 新增東西時放在目前看得到的位置附近
  function spot() {
    var sc = $('canvasScroll'), br = board.getBoundingClientRect();
    var vx = (sc.scrollLeft + sc.clientWidth / 2) / br.width * 100;
    var vy = (Math.max(0, -br.top) + Math.min(window.innerHeight, br.height) / 2) / br.height * 100;
    return { x: clamp(vx + Math.random() * 10 - 5, 2, 90), y: clamp(vy + Math.random() * 10 - 5, 2, 90) };
  }
  function add(it) {
    var p = spot(); it.id = uid(); it.x = clamp(p.x - it.w / 2, 0, 100 - it.w); it.y = p.y; it.z = topZ();
    if (it.r == null) it.r = Math.round(Math.random() * 8 - 4);
    state.collage.push(it); sel = it.id; markDirty(); renderBoard();
  }
  $('addImg').addEventListener('click', function () { pick(function (p) { add({ type: 'img', src: p, w: 18, style: styleFor(p) }); }); });
  $('addSlides').addEventListener('click', function () {
    add({ type: 'slides', srcs: [], label: 'slides', ratio: 0.75, interval: 1.2, w: 20, r: 0 });
    openMgr(find(sel));
  });
  $('addNote').addEventListener('click', function () { add({ type: 'note', text: '寫點什麼', w: 14, color: 'paper' }); });
  $('addBubble').addEventListener('click', function () { add({ type: 'bubble', text: '對話框', w: 16, color: 'paper', tail: 'tl', r: 0 }); });
  $('addWashi').addEventListener('click', function () { add({ type: 'washi', style: J.washi.styles[Math.floor(Math.random() * 3)], color: J.washi.colors[Math.floor(Math.random() * 4)], w: 16 }); });
  $('addHeadline').addEventListener('click', function () { add({ type: 'headline', text: 'Brave', label: 'katsuki × mia', style: 'serif', color: 'deep', w: 20, r: 0 }); });
  $('addLbl').addEventListener('click', function () { add({ type: 'lbl', text: 'HOLD ON & KEEP MOVING', style: 'box', color: 'deep', w: 14, r: 0 }); });
  $('addBit').addEventListener('click', function () { add({ type: 'bit', text: 'KATSUMIA ♡ since 2024', style: 'ticket', color: 'cherry', w: 16 }); });
  // ---------- 手帳：一鍵套用「滿版貼紙」排版（針對目前的素材手排；之後新加的東西不會被動到） ----------
  // 座標：x、w 是畫布寬度的 %，y 先用「畫布寬度單位」寫，再換成高度 %
  var FULL = {
    H: 86,
    items: {
      // 背景層：照片、輪播斜斜壓在四周，超出畫布的部分直接被切掉（出血）
      'muzpqnge8x3r': { x: -3, y: -2, w: 30, r: -7, z: 3, style: 'tape' },
      'muzq0be6vxjs': { x: 75, y: -4, w: 27, r: 7, z: 4 },
      'muzomufqdzih': { x: -4, y: 30, w: 22, r: -6, z: 5 },
      'muzoms3y72n0': { x: 69, y: 60, w: 33, r: -5, z: 6, style: 'die' },
      // 主角：大大的兩張 Q 版疊在正中間
      'muzoohxs10nq': { x: 22, y: 3, w: 33, r: -3, z: 22, style: 'die' },
      'muzpsprd6kcg': { x: 50, y: 13, w: 35, r: 4, z: 21, style: 'die' },
      'muzqg6j7vzp5': { x: 1, y: 58, w: 27, r: -6, z: 26, style: 'die' },
      // logo 壓在主角下半身，白邊貼紙
      'logo':         { x: 22.5, y: 42.5, w: 54, r: -4, z: 40, style: 'die' },
      'w-title':      { x: 30, y: 72.5, w: 40, r: -2, z: 39 },
      'w-timer':      { x: 67.5, y: 30, w: 31, r: 4, z: 30 },
      'b1':           { x: 6, y: 26.5, w: 12.5, r: -10, z: 41 },
      'n1':           { x: 80, y: 55, w: 13, r: 7, z: 41 },
      's1':           { x: 54.5, y: 6, w: 4.2, r: -12, z: 46 },
      's2':           { x: 20, y: 3.5, w: 3.2, r: 0, z: 46 },
      's3':           { x: 64, y: 49, w: 5, r: 10, z: 46 },
      's4':           { x: 26, y: 56, w: 3.6, r: 10, z: 46 },
      's5':           { x: 18.5, y: 40, w: 4, r: 0, z: 46 },
      'muzq4derw4s8': { x: 61, y: 40, w: 4.5, r: -16, z: 46 }
    },
    deco: [
      { id: 'fx-bubble', type: 'sticker', shape: 'bubble', color: 'cherry', x: 63, y: 3.5, w: 6.5, r: 8, z: 47 },
      { id: 'fx-pow', type: 'sticker', shape: 'pow', color: 'apricot', x: 46, y: 2, w: 6, r: 12, z: 47 },
      { id: 'fx-pow2', type: 'sticker', shape: 'pow', color: 'cherry', x: 87, y: 26, w: 6.5, r: -14, z: 47 },
      { id: 'fx-puff', type: 'sticker', shape: 'puff', color: 'apricot', x: 26, y: 80.5, w: 4, r: -10, z: 47 },
      { id: 'fx-ribbon', type: 'sticker', shape: 'ribbon', color: 'cherry', x: 2.5, y: 22, w: 7, r: 20, z: 47 },
      { id: 'fx-dots', type: 'sticker', shape: 'dots', color: 'cherry', x: 61, y: 81, w: 6.5, r: -4, z: 47 },
      { id: 'fx-hearts', type: 'sticker', shape: 'hearts', color: 'cherry', x: 92, y: 47, w: 5, r: 8, z: 47 },
      { id: 'fx-spark2', type: 'sticker', shape: 'sparkle', color: 'apricot', x: 96, y: 22, w: 3, r: 0, z: 47 },
      { id: 'fx-star2', type: 'sticker', shape: 'puff', color: 'blush', x: 14.5, y: 52, w: 3.6, r: 14, z: 47 },
      { id: 'fx-heart2', type: 'sticker', shape: 'heart', color: 'blush', x: 3.5, y: 81.5, w: 3.8, r: 10, z: 47 },
      { id: 'fx-spark3', type: 'sticker', shape: 'sparkle', color: 'cherry', x: 76, y: 27.5, w: 2.6, r: 0, z: 47 }
    ]
  };
  function applyFull() {
    var k = 100 / FULL.H;
    state.canvasH = FULL.H; state.paper = 'grid';
    Object.keys(FULL.items).forEach(function (id) {
      var it = find(id), p = FULL.items[id]; if (!it) return;
      it.x = p.x; it.y = Math.round(p.y * k * 10) / 10; it.w = p.w; it.r = p.r; it.z = p.z;
      if (p.style && it.type === 'img' && it.src) it.style = p.style;
    });
    FULL.deco.forEach(function (d) {
      var c = find(d.id), y = Math.round(d.y * k * 10) / 10;
      if (c) { c.x = d.x; c.y = y; c.w = d.w; c.r = d.r; c.z = d.z; return; }
      c = JSON.parse(JSON.stringify(d)); c.y = y; state.collage.push(c);
    });
    sel = null; markDirty(); renderBoard();
    status('已套用滿版排版；不喜歡可以按「復原」。之後每一張都還能自己拖');
  }
  window.__cbFull = function () { applyFull(); };
  $('fullLayout').addEventListener('click', applyFull);
  $('allDie').addEventListener('click', function () {
    var n = 0; state.collage.forEach(function (c) { if (c.type === 'img' && c.src && c.src.indexOf('img/') === 0) { c.style = 'die'; n++; } });
    markDirty(); renderBoard(); status(n ? '已把 ' + n + ' 張圖換成貼紙樣式；不喜歡可以按「復原」' : '拼貼裡還沒有圖片');
  });
  $('paperSel').addEventListener('change', function () { state.paper = this.value; markDirty(); renderBoard(); });
  $('addSticker').addEventListener('click', function () { add({ type: 'sticker', shape: SHAPE_KEYS[Math.floor(Math.random() * SHAPE_KEYS.length)], color: 'cherry', w: 5 }); });
  $('addWidget').addEventListener('change', function () {
    var k = this.value; if (!k) return;
    add({ type: 'widget', key: k, w: k === 'timer' ? 36 : 26, r: 0 });
  });
  $('hMinus').addEventListener('click', function () { state.canvasH = clamp((state.canvasH || 80) - 10, 40, 300); markDirty(); renderBoard(); });
  $('hPlus').addEventListener('click', function () { state.canvasH = clamp((state.canvasH || 80) + 10, 40, 300); markDirty(); renderBoard(); });

  // 直接把圖片檔拖進拼貼區
  board.addEventListener('dragover', function (e) { if (!editing) return; e.preventDefault(); board.classList.add('drop'); });
  board.addEventListener('dragleave', function () { board.classList.remove('drop'); });
  board.addEventListener('drop', function (e) {
    if (!editing) return;
    e.preventDefault(); board.classList.remove('drop');
    var br = board.getBoundingClientRect();
    var px = (e.clientX - br.left) / br.width * 100, py = (e.clientY - br.top) / br.height * 100;
    var files = [].filter.call(e.dataTransfer.files, function (f) { return /^(image|video)\//.test(f.type); });
    if (!files.length) return;
    // 拖到既有的圖片上 = 替換；拖到輪播視窗上 = 加進輪播
    var hit = e.target.closest && e.target.closest('.ci'), target = hit && find(hit.dataset.id);
    if (target && target.type === 'img' && files.length === 1) {
      status('替換圖片中…');
      addFile(files[0]).then(function (p) { target.src = p; delete target.crop; delete target.ar; sel = target.id; markDirty(); renderBoard(); status('已替換'); }, function (er) { status((er && er.msg) || '這個檔案讀不了'); });
      return;
    }
    if (target && target.type === 'slides') {
      files.reduce(function (pr, f) { return pr.then(function () { return addFile(f).then(function (p) { target.srcs.push(p); }, function () {}); }); }, Promise.resolve())
        .then(function () { sel = target.id; markDirty(); renderBoard(); status('已加進輪播'); });
      return;
    }
    status('處理圖片中…');
    files.forEach(function (f, i) {
      addFile(f).catch(function (er) { status((er && er.msg) || '有檔案讀不了'); throw er; }).then(function (p) {
        var it = { id: uid(), type: 'img', src: p, w: 18, style: styleFor(p), r: Math.round(Math.random() * 8 - 4), z: topZ() };
        it.x = clamp(px - 9 + i * 3, 0, 82); it.y = clamp(py - 5 + i * 3, 0, 95);
        state.collage.push(it); sel = it.id; markDirty(); renderBoard();
      });
    });
  });

  // ---------- 輪播管理 ----------
  var mgrIt = null;
  function openMgr(it) { if (!it) return; mgrIt = it; renderMgr(); $('slideMgr').hidden = false; }
  function renderMgr() {
    var it = mgrIt, list = it.srcs || (it.srcs = []);
    $('smInterval').value = it.interval || 1.2;
    [].forEach.call(document.querySelectorAll('[data-sratio]'), function (b) { b.setAttribute('aria-pressed', String(Math.abs(parseFloat(b.dataset.sratio) - (it.ratio || 0.75)) < 0.01)); });
    var box = $('smList'); box.innerHTML = '';
    list.forEach(function (p, i) {
      var d = document.createElement('div'); d.className = 'sm-item';
      d.innerHTML = media(p) + '<span class="sm-n">' + (i + 1) + '</span><div class="sm-act"><button type="button" class="ic" data-m="l" title="往前">←</button><button type="button" class="ic" data-m="r" title="往後">→</button><button type="button" class="ic danger" data-m="x" title="移除">✕</button></div>';
      d.addEventListener('click', function (e) {
        var b = e.target.closest('[data-m]'); if (!b) return;
        var m = b.dataset.m;
        if (m === 'x') list.splice(i, 1);
        if (m === 'l' && i > 0) list.splice(i - 1, 0, list.splice(i, 1)[0]);
        if (m === 'r' && i < list.length - 1) list.splice(i + 1, 0, list.splice(i, 1)[0]);
        markDirty(); renderMgr(); renderBoard();
      });
      box.appendChild(d);
    });
    $('smEmpty').hidden = list.length > 0;
  }
  $('smAdd').addEventListener('click', function () { $('multiPick').click(); });
  $('multiPick').addEventListener('change', function (e) {
    var files = [].slice.call(e.target.files); e.target.value = '';
    if (!files.length || !mgrIt) return;
    status('處理圖片中…');
    var it = mgrIt;
    files.reduce(function (pr, f) {
      return pr.then(function () { return addFile(f).then(function (p) { it.srcs.push(p); renderMgr(); }, function (er) { status((er && er.msg) || '有檔案讀不了'); }); });
    }, Promise.resolve()).then(function () { markDirty(); renderBoard(); });
  });
  $('smInterval').addEventListener('input', function () {
    var v = parseFloat(this.value); if (!(v >= 0.4)) return;
    mgrIt.interval = Math.round(v * 10) / 10; markDirty(); startSlides();
  });
  $('slideMgr').addEventListener('click', function (e) {
    var b = e.target.closest('[data-sratio]');
    if (b) { mgrIt.ratio = parseFloat(b.dataset.sratio); markDirty(); renderMgr(); renderBoard(); return; }
    if (e.target.id === 'smDone' || e.target === this) { $('slideMgr').hidden = true; mgrIt = null; renderBoard(); }
  });

  // ---------- 縮圖共用：封面位置（拖曳平移＋縮放）與拖曳排序 ----------
  function applyPos(img, p, dy) {
    if (!img) return; p = p || {};
    var x = p.x == null ? 50 : p.x, y = p.y == null ? (dy == null ? 50 : dy) : p.y, z = p.z || 1;
    img.style.objectPosition = x + '% ' + y + '%';
    img.style.transformOrigin = x + '% ' + y + '%';
    img.style.transform = z > 1 ? 'scale(' + z + ')' : '';
  }
  var panCur = null; // 正在調整封面的那一張（物件）
  function panUI(box, img, it, key, dy, rerender) {
    // box：有 overflow:hidden 的外框；it[key] 存 {x,y,z}
    applyPos(img, it[key], dy);
    if (!editing || panCur !== it || !img) return;
    box.classList.add('panning');
    var p = it[key] = it[key] || { x: 50, y: dy == null ? 50 : dy, z: 1 };
    var bar = document.createElement('div'); bar.className = 'pan-bar';
    bar.innerHTML = '<span>拖曳圖片調整位置</span><button type="button" data-z="-">－</button><button type="button" data-z="+">＋</button><button type="button" data-z="0">重設</button><button type="button" data-z="ok">完成</button>';
    bar.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    bar.addEventListener('click', function (e) {
      e.stopPropagation(); var b = e.target.closest('button'); if (!b) return; var k = b.dataset.z;
      if (k === 'ok') { panCur = null; rerender(); return; }
      if (k === '0') { p.x = 50; p.y = dy == null ? 50 : dy; p.z = 1; }
      if (k === '+') p.z = Math.min(4, Math.round((p.z + .2) * 10) / 10);
      if (k === '-') p.z = Math.max(1, Math.round((p.z - .2) * 10) / 10);
      applyPos(img, p, dy); markDirty();
    });
    box.appendChild(bar);
    var drag = null;
    box.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.pan-bar')) return;
      e.preventDefault(); e.stopPropagation(); drag = { x: e.clientX, y: e.clientY, px: p.x, py: p.y }; try { box.setPointerCapture(e.pointerId); } catch (er) {}
    });
    box.addEventListener('pointermove', function (e) {
      if (!drag) return; var r = box.getBoundingClientRect(), k = 100 / p.z;
      p.x = Math.max(0, Math.min(100, drag.px - (e.clientX - drag.x) / r.width * k));
      p.y = Math.max(0, Math.min(100, drag.py - (e.clientY - drag.y) / r.height * k));
      applyPos(img, p, dy);
    });
    var end = function () { if (drag) { drag = null; markDirty(); } };
    box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
    box.addEventListener('wheel', function (e) { e.preventDefault(); p.z = Math.max(1, Math.min(4, p.z * (e.deltaY < 0 ? 1.08 : 1 / 1.08))); applyPos(img, p, dy); markDirty(); }, { passive: false });
    box.addEventListener('click', function (e) { if (e.target.closest('.pan-bar')) return; e.stopPropagation(); e.preventDefault(); }, true);
  }
  var sortJustDropped = 0;
  function sortable(card, handle, idx, onMove) {
    // 滑鼠：整張卡片直接拖；手機：按住左上角的把手拖
    card.dataset.si = idx; card.classList.add('so');
    function start(e, viaHandle) {
      if (!editing || card.classList.contains('panning')) return;
      if (!viaHandle && (e.pointerType !== 'mouse' || e.button !== 0 || e.target.closest('[contenteditable],input,select,button,.lib-tags,.x,.pan-bar'))) return;
      var sx = e.clientX, sy = e.clientY, on = false, over = null, before = false, pid = e.pointerId;
      if (viaHandle) e.preventDefault();
      function mv(ev) {
        if (ev.pointerId !== pid) return;
        var dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (!on) { if (Math.abs(dx) + Math.abs(dy) < 6) return; on = true; card.classList.add('so-drag'); document.body.classList.add('so-active'); }
        ev.preventDefault();
        card.style.transform = 'translate(' + dx + 'px,' + dy + 'px) rotate(2deg)';
        card.style.pointerEvents = 'none';
        var el = document.elementFromPoint(ev.clientX, ev.clientY), t = el && el.closest('.so');
        if (t && t.parentNode !== card.parentNode) t = null;
        if (over && over !== t) over.classList.remove('so-l', 'so-r');
        over = t !== card ? t : null;
        if (over) { var r = over.getBoundingClientRect(); before = ev.clientX < r.left + r.width / 2; over.classList.toggle('so-l', before); over.classList.toggle('so-r', !before); }
      }
      function up(ev) {
        if (ev.pointerId !== pid) return;
        window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
        if (!on) return;
        sortJustDropped = Date.now(); document.body.classList.remove('so-active');
        card.classList.remove('so-drag'); card.style.transform = ''; card.style.pointerEvents = '';
        if (over) { over.classList.remove('so-l', 'so-r'); var to = +over.dataset.si; if (!before && to < idx) to++; if (before && to > idx) to--; if (to !== idx) onMove(idx, to); }
      }
      window.addEventListener('pointermove', mv, { passive: false }); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    }
    card.addEventListener('pointerdown', function (e) { start(e, false); });
    if (handle) handle.addEventListener('pointerdown', function (e) { e.stopPropagation(); start(e, true); });
    card.addEventListener('click', function (e) { if (Date.now() - sortJustDropped < 300) { e.stopPropagation(); e.preventDefault(); } }, true);
  }
  function moveIn(arr, vis, from, to) { // vis：畫面上看得到的那幾個（可能有篩選）
    var a = vis[from], b = vis[to]; if (!a || !b) return;
    arr.splice(arr.indexOf(a), 1); var j = arr.indexOf(b); arr.splice(from < to ? j + 1 : j, 0, a); markDirty();
  }
  var GRIP = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="5.5" cy="4" r="1.3"/><circle cx="10.5" cy="4" r="1.3"/><circle cx="5.5" cy="8" r="1.3"/><circle cx="10.5" cy="8" r="1.3"/><circle cx="5.5" cy="12" r="1.3"/><circle cx="10.5" cy="12" r="1.3"/></svg>';

  // ---------- 圖庫 ----------
  var filter = 'all';
  function renderGallery() {
    if (typeof renderLib === "function" && state) setTimeout(function(){ try { renderLib(); } catch (e) {} }, 0);
    grid.innerHTML = '';
    var list = state.gallery.filter(function (g) { return filter === 'all' || g.cat === filter; });
    list.forEach(function (g, gi) {
      if (!g.id) g.id = uid();
      var f = document.createElement('figure');
      var n = (g.alts || []).length;
      f.innerHTML = '<div class="g-th">' + (isVid(g.src) ? media(g.src) : '<img alt="' + esc(g.title || '') + '" loading="lazy" src="' + esc(src(g.src)) + '">') + '</div>' +
        (n ? '<span class="g-alts" title="有 ' + (n + 1) + ' 張差分"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="1.5" width="10" height="10" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2 5v7.5A1.5 1.5 0 0 0 3.5 14H11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' + (n + 1) + '</span>' : '');
      var th = f.querySelector('.g-th'), im = th.querySelector('img,video');
      f.onclick = function (e) {
        if (e.target.closest('.x,.g-ed,.pan-bar') || f.querySelector('.panning')) return;
        gvOpen(g.id, list);
      };
      if (editing) {
        var ed = document.createElement('div'); ed.className = 'g-ed';
        ed.innerHTML = '<span class="so-h" title="拖曳換順序">' + GRIP + '</span><button type="button" data-a="pan" title="調整縮圖位置">✥</button><button type="button" data-a="del" title="刪除">×</button>';
        ed.addEventListener('click', function (e) {
          var b = e.target.closest('button'); if (!b) return; e.stopPropagation();
          if (b.dataset.a === 'pan') { panCur = panCur === g ? null : g; renderGallery(); }
          if (b.dataset.a === 'del') { if (!confirmDel()) { b.classList.add('arm'); return; } state.gallery = state.gallery.filter(function (o) { return o !== g; }); markDirty(); renderGallery(); }
        });
        f.appendChild(ed);
        sortable(f, ed.querySelector('.so-h'), gi, function (a, b) { moveIn(state.gallery, list, a, b); renderGallery(); });
      }
      panUI(th, im, g, 'pos', null, renderGallery);
      grid.appendChild(f);
    });
    $('gEmpty').hidden = list.length > 0;
    $('gEmpty').textContent = state.gallery.length ? '這個分類還沒有圖。' : '圖庫還是空的，敬請期待。';
  }
  [].forEach.call(document.querySelectorAll('.filters button'), function (b, _, all) {
    b.addEventListener('click', function () {
      filter = b.dataset.f;
      [].forEach.call(document.querySelectorAll('.filters button'), function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      renderGallery();
    });
  });
  $('lightbox').addEventListener('click', function () { $('lightbox').hidden = true; $('lbVid').pause(); });
  // ---------- 圖庫檢視窗：左邊大圖、右邊像 Notion 的資訊欄（編輯模式下全部可以直接改） ----------
  var GVI = {
    pen: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.7 3.3a2.4 2.4 0 0 0-3.4 0L8.6 12l3.4 3.4 8.7-8.7a2.4 2.4 0 0 0 0-3.4zM7.4 13.4c-2 0-3.4 1.4-3.6 3.4-.1 1.3-.6 2.3-1.8 3 2.6 1 6.4.4 7.6-1.4.8-1.2.7-2.6-.2-3.6z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 10.4 3.6 2.1-1 1.7L11 13V6.5h2z"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r=".6" fill="currentColor"/><circle cx="4.5" cy="12" r=".6" fill="currentColor"/><circle cx="4.5" cy="18" r=".6" fill="currentColor"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/></svg>',
    text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
    date: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4" stroke-linecap="round"/></svg>',
    globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 2.6 15.4 0 18M12 3c-2.6 2.6-2.6 15.4 0 18"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2z"/></svg>'
  };
  var GV_ADD = [['text', '文字'], ['link', '連結'], ['date', '日期'], ['globe', '平台'], ['heart', '心情']];
  var gvList = [], gvId = null, gvAdding = false, gvVar = 0;
  function gvImgs(g) { return [g.src].concat(g.alts || []); }
  function gvAt(g) { if (g.at) return g.at; var t = parseInt(String(g.id || '').slice(0, -4), 36); return t > 1.6e12 && t < 4e12 ? new Date(t).toISOString() : ''; } // 舊圖沒有建立時間：從上傳時產生的編號推回去
  function gvItem() { return (state.gallery || []).filter(function (g) { return g.id === gvId; })[0]; }
  function gvFmt(iso) {
    var d = new Date(iso); if (!iso || isNaN(d)) return '';
    var h = d.getHours(), ap = h < 12 ? '上午' : '下午', hh = h % 12 || 12, mm = ('0' + d.getMinutes()).slice(-2);
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + ap + hh + ':' + mm;
  }
  function gvLocal(iso) { var d = new Date(iso); if (!iso || isNaN(d)) return ''; d = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); }
  function gvOpen(id, list) {
    gvId = id; gvVar = 0; gvList = (list || state.gallery || []).map(function (g) { return g.id || (g.id = uid()); }); gvAdding = false;
    $('gv').hidden = false; document.body.style.overflow = 'hidden'; gvRender();
  }
  function gvClose() { $('gv').hidden = true; document.body.style.overflow = ''; var v = $('gvMedia').querySelector('video'); if (v) v.pause(); gvId = null; }
  function gvStep(d) {
    // 先翻同一張的差分，翻完再到下一張
    var g = gvItem(), n = g ? gvImgs(g).length : 1;
    if (gvVar + d >= 0 && gvVar + d < n) { gvVar += d; gvRender(); return; }
    var i = gvList.indexOf(gvId); if (i < 0 || gvList.length < 2) return;
    gvId = gvList[(i + d + gvList.length) % gvList.length]; gvAdding = false;
    var g2 = gvItem(); gvVar = d < 0 && g2 ? gvImgs(g2).length - 1 : 0; gvRender();
  }
  function gvSet(g, fn) { fn(g); markDirty(); renderGallery(); }
  function gvRender() {
    var g = gvItem(); if (!g) { gvClose(); return; }
    $('gv').style.bottom = editing && !$('editBar').hidden ? $('editBar').offsetHeight + 'px' : '';
    var m = $('gvMedia'), ims = gvImgs(g); if (gvVar >= ims.length) gvVar = ims.length - 1; var cur = ims[gvVar];
    m.innerHTML = (isVid(cur) ? '<video controls loop playsinline src="' + esc(src(cur)) + '"></video>' : '<img alt="' + esc(g.title || '') + '" src="' + esc(src(cur)) + '">') +
      (ims.length > 1 ? '<div class="gv-dots">' + ims.map(function (_, k) { return '<i' + (k === gvVar ? ' class="on"' : '') + '></i>'; }).join('') + '<b>差分 ' + (gvVar + 1) + ' / ' + ims.length + '</b></div>' : '');
    $('gvPrev').hidden = $('gvNext').hidden = gvList.length < 2 && ims.length < 2;
    var side = $('gvSide'); side.innerHTML = '';
    var x = document.createElement('button'); x.type = 'button'; x.className = 'gv-x'; x.textContent = '×'; x.setAttribute('aria-label', '關閉'); x.onclick = gvClose; side.appendChild(x);
    var t = document.createElement('h2'); t.className = 'gv-title'; t.textContent = g.title || ''; side.appendChild(t);
    if (editing) editable(t, function () { return g.title || ''; }, function (v) { gvSet(g, function (o) { o.title = v; }); });
    var box = document.createElement('div'); box.className = 'gv-props'; side.appendChild(box);
    function row(ic, label, cls) {
      var r = document.createElement('div'); r.className = 'gv-row' + (cls ? ' ' + cls : '');
      r.innerHTML = (GVI[ic] || GVI.text) + '<span></span><div></div>'; r.children[1].textContent = label; box.appendChild(r); return r.children[2];
    }
    function inp(type, val, onchange, ph) {
      var i = document.createElement('input'); i.type = type; i.value = val || ''; if (ph) i.placeholder = ph;
      i.onchange = function () { onchange(i.value); };
      i.onkeydown = function (e) { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) i.blur(); };
      return i;
    }
    // 建立時間
    var at = row('clock', '建立時間');
    if (editing) at.appendChild(inp('datetime-local', gvLocal(gvAt(g)), function (v) { gvSet(g, function (o) { o.at = v ? new Date(v).toISOString() : ''; }); gvRender(); }));
    else at.textContent = gvFmt(gvAt(g)) || '—';
    // 繪師（筆）
    var cr = creditOf(g.src), pen = row('pen', '繪師', 'pen');
    if (editing) {
      var pi = inp('text', cr ? cr.n : '', function (v) {
        v = v.trim(); gvSet(g, function (o) { o.credit = v; var c = state.credits && state.credits[o.src]; if (c) { if (v) c.n = v; else delete state.credits[o.src]; } });
      }, '誰畫的？'); pi.setAttribute('list', 'cdNames'); pen.appendChild(pi);
      pi.onfocus = function () { var names = {}; (state.gallery || []).forEach(function (o) { if (o.credit) names[o.credit] = 1; }); Object.keys(state.credits || {}).forEach(function (k) { if (state.credits[k].n) names[state.credits[k].n] = 1; }); $('cdNames').innerHTML = Object.keys(names).map(function (n) { return '<option value="' + esc(n) + '">'; }).join(''); };
    } else if (cr) { var u = safeUrl(cr.u); pen.innerHTML = u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(cr.n) + '</a>' : esc(cr.n); }
    else pen.textContent = '—';
    // 分類
    var ct = row('list', '分類');
    if (editing) {
      var se = document.createElement('select');
      [['comm', '委託'], ['doodle', '塗鴉'], ['', '不分類']].forEach(function (o) { var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; se.appendChild(op); });
      se.value = CAT[g.cat] ? g.cat : ''; se.onchange = function () { gvSet(g, function (o) { o.cat = se.value; }); };
      ct.appendChild(se);
    } else ct.innerHTML = CAT[g.cat] ? '<span class="gv-pill ' + esc(g.cat) + '">' + esc(CAT[g.cat]) + '</span>' : '<span class="gv-pill none">未分類</span>';
    // 自訂欄位
    g.props = g.props || [];
    g.props.forEach(function (pr, pi2) {
      if (!editing && !pr.v) return;
      if (editing) {
        var r = document.createElement('div'); r.className = 'gv-row ed'; r.innerHTML = GVI[pr.ic] || GVI.text; box.appendChild(r);
        var k = inp('text', pr.k, function (v) { gvSet(g, function () { pr.k = v.trim(); }); }, '名稱'); k.className = 'gv-k'; r.appendChild(k);
        var vv = inp(pr.ic === 'date' ? 'date' : pr.ic === 'link' ? 'url' : 'text', pr.v, function (v) { gvSet(g, function () { pr.v = v.trim(); }); }, pr.ic === 'link' ? 'https://…' : '內容'); r.appendChild(vv);
        var d = document.createElement('button'); d.type = 'button'; d.className = 'gv-del'; d.textContent = '×'; d.title = '刪掉這個欄位';
        d.onclick = function () { gvSet(g, function (o) { o.props.splice(pi2, 1); }); gvRender(); }; r.appendChild(d);
      } else {
        var c = row(pr.ic, pr.k || '');
        if (pr.ic === 'link' && safeUrl(pr.v)) c.innerHTML = '<a href="' + esc(pr.v) + '" target="_blank" rel="noopener">' + esc(pr.v.replace(/^https?:\/\//, '')) + '</a>';
        else if (pr.ic === 'date') { var dd = new Date(pr.v); c.textContent = isNaN(dd) ? pr.v : dd.getFullYear() + '年' + (dd.getMonth() + 1) + '月' + dd.getDate() + '日'; }
        else c.textContent = pr.v;
      }
    });
    // 差分
    if (editing || ims.length > 1) {
      var vr = document.createElement('div'); vr.className = 'gv-vars';
      vr.innerHTML = '<p>' + '<svg class="ic" viewBox="0 0 16 16"><rect x="4.5" y="1.5" width="10" height="10" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2 5v7.5A1.5 1.5 0 0 0 3.5 14H11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' + '差分<small>' + (editing ? '第一張是縮圖；點小圖可以切換' : '左右滑可以看') + '</small></p>';
      var rowv = document.createElement('div'); rowv.className = 'gv-vlist'; vr.appendChild(rowv);
      ims.forEach(function (pth, k) {
        var t = document.createElement('button'); t.type = 'button'; t.className = 'gv-v' + (k === gvVar ? ' on' : '');
        t.innerHTML = isVid(pth) ? '<span>▶</span>' : '<img alt="" src="' + esc(src(pth)) + '">';
        t.onclick = function () { gvVar = k; gvRender(); };
        if (editing) {
          var tl = document.createElement('span'); tl.className = 'gv-vt';
          if (k > 0) tl.innerHTML += '<i data-v="main" title="設成第一張（縮圖）">★</i><i data-v="del" title="拿掉這張差分">×</i>';
          tl.onclick = function (e) {
            var a = e.target.dataset.v; if (!a) return; e.stopPropagation();
            gvSet(g, function (o) {
              if (a === 'del') { o.alts.splice(k - 1, 1); if (gvVar >= k) gvVar--; }
              if (a === 'main') { var old = o.src; o.src = o.alts[k - 1]; o.alts[k - 1] = old; if (!o.credit && creditOf(old)) o.credit = creditOf(old).n; gvVar = 0; }
            });
            gvRender();
          };
          t.appendChild(tl);
        }
        rowv.appendChild(t);
      });
      if (editing) {
        var av = document.createElement('button'); av.type = 'button'; av.className = 'gv-v add'; av.textContent = '＋'; av.title = '新增差分（可以一次選很多張）';
        av.onclick = function () { libPick(function (ps) { g.alts = (g.alts || []).concat(ps); gvVar = gvImgs(g).length - 1; renderGallery(); gvRender(); }); };
        rowv.appendChild(av);
      }
      side.appendChild(vr);
    }
    if (editing) {
      var add = document.createElement('button'); add.type = 'button'; add.className = 'gv-add'; add.innerHTML = '＋ 新增欄位';
      add.onclick = function () { gvAdding = !gvAdding; gvRender(); }; side.appendChild(add);
      if (gvAdding) {
        var ic = document.createElement('div'); ic.className = 'gv-icons';
        GV_ADD.forEach(function (a) {
          var b = document.createElement('button'); b.type = 'button'; b.innerHTML = GVI[a[0]] + a[1];
          b.onclick = function () { gvAdding = false; gvSet(g, function (o) { o.props = o.props || []; o.props.push({ k: a[1], v: '', ic: a[0] }); }); gvRender(); var ins = $('gvSide').querySelectorAll('.gv-row.ed'); var last = ins[ins.length - 1]; if (last) last.querySelectorAll('input')[1].focus(); };
          ic.appendChild(b);
        });
        side.appendChild(ic);
      }
      var del = document.createElement('button'); del.type = 'button'; del.className = 'gv-delw'; del.textContent = '刪除這張圖';
      del.onclick = function () {
        if (!confirmDel()) { del.textContent = '再按一次確定刪除'; return; }
        var i = gvList.indexOf(gvId); state.gallery = state.gallery.filter(function (o) { return o !== g; }); gvList.splice(i, 1); markDirty(); renderGallery();
        if (!gvList.length) gvClose(); else { gvId = gvList[Math.min(i, gvList.length - 1)]; gvRender(); }
      };
      side.appendChild(del);
      var hint = document.createElement('p'); hint.className = 'gv-hint'; hint.textContent = '標題點一下就能改；欄位名稱也可以自己改。'; side.appendChild(hint);
    }
  }
  $('gvPrev').addEventListener('click', function (e) { e.stopPropagation(); gvStep(-1); });
  $('gvNext').addEventListener('click', function (e) { e.stopPropagation(); gvStep(1); });
  $('gvStage').addEventListener('click', function (e) { if (e.target === this) gvClose(); });
  document.addEventListener('keydown', function (e) {
    if ($('gv').hidden || e.target.closest('input,select,textarea,[contenteditable="true"]')) return;
    if (e.key === 'Escape') gvClose(); else if (e.key === 'ArrowLeft') gvStep(-1); else if (e.key === 'ArrowRight') gvStep(1);
  });
  (function () { var sx = 0, sy = 0; var st = $('gvStage');
    st.addEventListener('touchstart', function (e) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    st.addEventListener('touchend', function (e) { var dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) gvStep(dx < 0 ? 1 : -1); });
  })();

  $('addForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var files = [].slice.call($('gFile').files);
    if (!files.length) return;
    status('處理圖片中…');
    var cat = $('gCat').value, title = $('gTitle').value.trim(), credit = $('gCredit').value.trim();
    Promise.all(files.map(addFile)).then(function (paths) {
      paths.forEach(function (p) { state.gallery.unshift({ id: uid(), src: p, cat: cat, title: title, credit: credit, at: new Date().toISOString() }); });
      $('addForm').reset(); markDirty(); renderGallery();
    }).catch(function (er) { status((er && er.msg) || '有圖片讀不了，換一張試試'); });
  });

  // ---------- 未亜的衣櫃（雜誌型錄） ----------
  var LOOKS0 = ['戰鬥服', '制服', '常服', '春夏秋冬約會服', 'Light color', '美式餐廳', '平安妖怪 AU', '東京鐵塔', '十周年', '私服', '出遊'];
  var lkCur = 0, lkHero = 0;
  function looks() {
    if (!state.wardrobe) state.wardrobe = LOOKS0.map(function (n) { return { id: uid(), name: n, note: '', imgs: [] }; });
    return state.wardrobe;
  }
  function two(n) { return (n < 9 ? '0' : '') + (n + 1); }
  function lkOpen(i, h) { var L = looks(); if (!L.length) return; lkCur = (i + L.length) % L.length; lkHero = h || 0; renderLook(); }
  function renderLook() {
    if (!$('lookbook')) return;
    var L = looks(); if (lkCur >= L.length) lkCur = Math.max(0, L.length - 1);
    var lk = L[lkCur];
    $('lkCount').textContent = L.length + ' LOOKS';
    var idx = $('lkIndex'); idx.innerHTML = '';
    L.forEach(function (o, i) {
      var b = document.createElement('button'); b.type = 'button';
      b.innerHTML = '<i>' + two(i) + '</i>' + esc(o.name || '未命名');
      b.setAttribute('aria-current', String(i === lkCur));
      b.onclick = function (e) { if (e.target.closest('.lk-x')) return; lkOpen(i); };
      if (editing) {
        // 編輯：直接拖曳換順序、× 刪除；編號永遠照目前順序重排
        b.draggable = true; b.classList.add('lk-drag'); b.title = '拖曳可以換順序';
        b.addEventListener('dragstart', function (e) { lkDrag = i; b.classList.add('dragging'); try { e.dataTransfer.setData('text/plain', String(i)); e.dataTransfer.effectAllowed = 'move'; } catch (er) {} });
        b.addEventListener('dragend', function () { lkDrag = -1; b.classList.remove('dragging'); });
        b.addEventListener('dragover', function (e) { if (lkDrag < 0) return; e.preventDefault(); b.classList.add('drop'); });
        b.addEventListener('dragleave', function () { b.classList.remove('drop'); });
        b.addEventListener('drop', function (e) {
          e.preventDefault(); b.classList.remove('drop'); var from = lkDrag; lkDrag = -1;
          if (from < 0 || from === i) return;
          var curId = L[lkCur] && L[lkCur].id, it = L.splice(from, 1)[0]; L.splice(i, 0, it);
          lkCur = Math.max(0, L.findIndex(function (o) { return o.id === curId; }));
          markDirty(); renderLook();
        });
        var x = document.createElement('span'); x.className = 'lk-x'; x.textContent = '×'; x.title = '刪除這套（按兩次）';
        x.onclick = function (e) {
          e.stopPropagation(); if (!confirmDel()) return;
          var curId = L[lkCur] && L[lkCur].id; L.splice(i, 1);
          var k = L.findIndex(function (o) { return o.id === curId; }); lkCur = k >= 0 ? k : Math.min(i, L.length - 1);
          lkHero = 0; markDirty(); renderLook();
        };
        b.appendChild(x);
      }
      idx.appendChild(b);
    });
    var cur = idx.children[lkCur]; if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    var sp = $('lkSpread'); sp.innerHTML = '';
    if (!lk) { sp.innerHTML = '<p class="empty" style="grid-column:1/-1">衣櫃還是空的。</p>'; return; }
    if (lkHero >= lk.imgs.length) lkHero = 0;
    // 主圖
    var hero = document.createElement('figure'); hero.className = 'lk-hero';
    if (lk.imgs.length) {
      hero.innerHTML = media(lk.imgs[lkHero]);
      var hc = creditOf(lk.imgs[lkHero]);
      if (hc) hero.insertAdjacentHTML('beforeend', '<figcaption class="lk-credit">' + creditInner(hc) + '</figcaption>');
      hero.onclick = function (e) {
        if (e.target.closest('button,a')) return;
        var p = lk.imgs[lkHero], v = isVid(p);
        $('lbImg').hidden = v; $('lbVid').hidden = !v;
        if (v) $('lbVid').src = src(p); else $('lbImg').src = src(p);
        var lc = creditOf(p);
        $('lbCap').textContent = two(lkCur) + '　' + (lk.name || '') + '　' + (lkHero + 1) + ' / ' + lk.imgs.length + (lc ? '　art / ' + lc.n : '');
        $('lightbox').hidden = false;
      };
      if (lk.imgs.length > 1) {
        [['prev', '‹', -1], ['next', '›', 1]].forEach(function (t) {
          var nb = document.createElement('button'); nb.type = 'button'; nb.className = 'lk-nav ' + t[0]; nb.textContent = t[1];
          nb.setAttribute('aria-label', t[2] < 0 ? '上一張' : '下一張');
          nb.onclick = function (e) { e.stopPropagation(); lkHero = (lkHero + t[2] + lk.imgs.length) % lk.imgs.length; renderLook(); };
          hero.appendChild(nb);
        });
        var sx = null;
        hero.addEventListener('touchstart', function (e) { sx = e.touches[0].clientX; }, { passive: true });
        hero.addEventListener('touchend', function (e) {
          if (sx == null) return; var dx = e.changedTouches[0].clientX - sx; sx = null;
          if (Math.abs(dx) > 40) { lkHero = (lkHero + (dx < 0 ? 1 : -1) + lk.imgs.length) % lk.imgs.length; renderLook(); }
        });
      }
    } else hero.innerHTML = '<div class="ph">' + (editing ? '按右邊的「＋加圖片」放這套造型的圖' : '這套造型的圖還沒放上來') + '</div>';
    sp.appendChild(hero);
    // 文字欄
    var cp = document.createElement('div'); cp.className = 'lk-copy';
    cp.innerHTML = '<div class="lk-no"><small>LOOK</small>' + two(lkCur) + '</div>' +
      '<h3 class="lk-title"></h3><p class="lk-note"></p><div class="lk-thumbs"></div>' +
      '<span class="lk-page">' + (lk.imgs.length ? (lkHero + 1) + ' / ' + lk.imgs.length + ' PHOTOS' : '') + '</span>';
    var ti = cp.querySelector('.lk-title'), no = cp.querySelector('.lk-note');
    ti.textContent = lk.name || ''; no.textContent = lk.note || '';
    if (editing) {
      [[ti, 'name'], [no, 'note']].forEach(function (t) {
        t[0].contentEditable = 'plaintext-only';
        t[0].addEventListener('input', function () {
          lk[t[1]] = t[0].innerText.replace(/\n+$/, '');
          if (t[1] === 'name') { var b = idx.children[lkCur]; if (b) b.innerHTML = '<i>' + two(lkCur) + '</i>' + esc(lk.name || '未命名'); }
          markDirty();
        });
      });
      ti.title = '點一下改名稱'; no.title = '點一下寫說明（可以換行）';
    }
    var th = cp.querySelector('.lk-thumbs');
    lk.imgs.forEach(function (p, i) {
      var f = document.createElement('figure'); f.className = 'lk-th';
      f.setAttribute('aria-current', String(i === lkHero));
      f.innerHTML = isVid(p) ? media(p) : '<img alt="" loading="lazy" src="' + esc(src(p)) + '">';
      f.onclick = function (e) { if (e.target.closest('button')) return; lkHero = i; renderLook(); };
      if (editing) {
        var ac = document.createElement('div'); ac.className = 'acts';
        [['←', '往前', function () { if (i > 0) { lk.imgs.splice(i - 1, 0, lk.imgs.splice(i, 1)[0]); lkHero = i - 1; } }],
         ['★', '設成封面', function () { lk.imgs.unshift(lk.imgs.splice(i, 1)[0]); lkHero = 0; }],
         ['×', '移除這張', function () { lk.imgs.splice(i, 1); lkHero = 0; }],
         ['→', '往後', function () { if (i < lk.imgs.length - 1) { lk.imgs.splice(i + 1, 0, lk.imgs.splice(i, 1)[0]); lkHero = i + 1; } }]].forEach(function (t) {
          var b = document.createElement('button'); b.type = 'button'; b.textContent = t[0]; b.title = t[1];
          b.onclick = function (e) { e.stopPropagation(); t[2](); markDirty(); renderLook(); };
          ac.appendChild(b);
        });
        f.appendChild(ac);
      }
      th.appendChild(f);
    });
    if (editing) {
      var row = document.createElement('div'); row.className = 'lk-row';
      [['＋加圖片', 'btn small', function () { $('lkPick').click(); }],
       ['這張的繪師', 'btn small ghost', function () { if (lk.imgs[lkHero]) openCredit(lk.imgs[lkHero], renderLook); else status('這套還沒有圖'); }],
       ['← 往前移', 'btn small ghost', function () { if (lkCur > 0) { L.splice(lkCur - 1, 0, L.splice(lkCur, 1)[0]); lkCur--; markDirty(); renderLook(); } }],
       ['往後移 →', 'btn small ghost', function () { if (lkCur < L.length - 1) { L.splice(lkCur + 1, 0, L.splice(lkCur, 1)[0]); lkCur++; markDirty(); renderLook(); } }],
       ['刪除這套', 'btn small ghost', function () { if (!confirmDel()) return; L.splice(lkCur, 1); lkCur = Math.max(0, lkCur - 1); markDirty(); renderLook(); }]].forEach(function (t) {
        var b = document.createElement('button'); b.type = 'button'; b.className = t[1]; b.textContent = t[0]; b.onclick = t[2]; row.appendChild(b);
      });
      cp.appendChild(row);
    }
    sp.appendChild(cp);
  }
  var lkDelArm = 0, lkDrag = -1;
  function confirmDel() { // 按兩次才刪，避免手滑
    if (Date.now() - lkDelArm < 2500) { lkDelArm = 0; return true; }
    lkDelArm = Date.now(); status('再按一次就會刪掉這套（可以用復原救回來）'); return false;
  }
  $('lkAdd').addEventListener('click', function () {
    var L = looks(); L.push({ id: uid(), name: '新造型', note: '', imgs: [] }); lkCur = L.length - 1; lkHero = 0; markDirty(); renderLook();
  });
  $('lkPick').addEventListener('change', function (e) {
    var files = [].slice.call(e.target.files); e.target.value = '';
    var lk = looks()[lkCur]; if (!files.length || !lk) return;
    status('處理圖片中…');
    files.reduce(function (pr, f) {
      return pr.then(function () { return addFile(f).then(function (p) { lk.imgs.push(p); renderLook(); }, function (er) { status((er && er.msg) || '有檔案讀不了'); }); });
    }, Promise.resolve()).then(function () { markDirty(); status('加好了，記得按「儲存」'); });
  });

  // ---------- Route：好感度隨著往下讀慢慢上升 ----------
  (function () {
    var ol = document.querySelector('ol.tl'), gauge = $('affGauge'); if (!ol || !gauge) return;
    var items = [].slice.call(ol.children), n = items.length;
    items.forEach(function (li, i) {
      var v = Math.round((i + 1) / n * 100), card = li.querySelector('.card'); li.dataset.aff = v;
      var full = Math.floor(v / 20), half = v % 20 >= 10 ? 1 : 0, hs = '';
      for (var k = 0; k < 5; k++) hs += '<b class="' + (k < full ? 'on' : (k === full && half ? 'half' : '')) + '">♥</b>';
      if (card) card.insertAdjacentHTML('beforeend', '<div class="aff">好感度<span class="hearts">' + hs + '</span><span class="pct">' + v + '%</span><span class="up">♥ UP</span></div>');
    });
    var shown = 0;
    function upd() {
      if (ol.closest('[hidden]')) return;
      var vh = window.innerHeight, r = ol.getBoundingClientRect(), mark = vh * 0.62, cur = 0;
      items.forEach(function (li) {
        var b = li.getBoundingClientRect();
        if (b.top < vh * 0.9) li.classList.remove('lock');
        if (b.top < mark) cur = +li.dataset.aff;
      });
      var fill = Math.max(0, Math.min(1, (mark - r.top) / r.height));
      ol.style.setProperty('--fill', (fill * 100).toFixed(1) + '%');
      if (cur !== shown) { shown = cur; gauge.querySelector('.bar').style.setProperty('--g', cur + '%'); gauge.querySelector('.gp').textContent = cur + '%'; }
    }
    items.forEach(function (li) { li.classList.add('lock'); });
    window.addEventListener('scroll', upd, { passive: true });
    window.addEventListener('resize', upd);
    window.addEventListener('hashchange', function () { setTimeout(upd, 60); });
    setTimeout(upd, 100);
  })();

  // ---------- 夢齡計時器（台灣時間 2024/12/04 00:00 起算） ----------
  var START = new Date('2024-12-04T00:00:00+08:00');
  function addYears(d, n) { var x = new Date(d.getTime()); x.setUTCFullYear(x.getUTCFullYear() + n); return x; }
  function pad(v) { return v < 10 ? '0' + v : '' + v; }
  function tick() {
    var now = new Date(), y = 0;
    while (addYears(START, y + 1) <= now) y++;
    var rest = Math.floor((now - addYears(START, y)) / 1000);
    var v = { y: String(y), d: String(Math.floor(rest / 86400)), h: pad(Math.floor(rest % 86400 / 3600)), m: pad(Math.floor(rest % 3600 / 60)), s: pad(rest % 60), total: Math.floor((now - START) / 86400000).toLocaleString() };
    [].forEach.call(document.querySelectorAll('[data-k]'), function (n) { var t = v[n.dataset.k]; if (t != null && n.textContent !== t) n.textContent = t; });
  }
  setInterval(tick, 1000);

  // ---------- 雙人簡介表：文字和色票 ----------
  var sheetEls = [].slice.call(document.querySelectorAll('[data-e]'));
  var swEls = [].slice.call(document.querySelectorAll('.swc[data-c]'));
  function sheetData() { state.sheet = state.sheet || {}; state.sheet.t = state.sheet.t || {}; state.sheet.c = state.sheet.c || {}; return state.sheet; }
  function renderSheet() {
    var d = sheetData();
    sheetEls.forEach(function (el) {
      var k = el.dataset.e;
      if (el.dataset.def == null) el.dataset.def = el.textContent;
      var want = d.t[k] != null ? d.t[k] : el.dataset.def;
      if (el.textContent !== want && document.activeElement !== el) el.textContent = want;
      if (editing) { try { el.contentEditable = 'plaintext-only'; } catch (_) { el.contentEditable = 'true'; } }
      else el.removeAttribute('contenteditable');
    });
    swEls.forEach(function (b) { var c = d.c[b.dataset.c]; if (c) b.style.setProperty('--c', c); });
    heights();
    renderGateNotes();
  }
  // 入口注意事項：一行一條，自己打
  function gateNotesText() { var t = sheetData().t['gate-notes']; return t != null ? t : ($('gateNotesDef') ? $('gateNotesDef').innerHTML.replace(/&amp;/g, '&') : ''); }
  function renderGateNotes() {
    var ol = $('gateNotes'), ed = $('gateNotesEdit'); if (!ol) return;
    var txt = gateNotesText();
    ol.innerHTML = txt.split('\n').map(function (l) { return l.trim(); }).filter(Boolean).map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('');
    ol.hidden = editing; ed.hidden = !editing;
    if (editing) {
      if (document.activeElement !== ed) ed.textContent = txt;
      try { ed.contentEditable = 'plaintext-only'; } catch (_) { ed.contentEditable = 'true'; }
      if (!ed.nextElementSibling || !ed.nextElementSibling.classList.contains('notice-hint')) ed.insertAdjacentHTML('afterend', '<span class="notice-hint">一行就是一條，按 Enter 換下一條；空白行會自動略過</span>');
    } else {
      ed.removeAttribute('contenteditable');
      var hint = document.querySelector('.notice-hint'); if (hint) hint.remove();
    }
  }
  if ($('gateNotesEdit')) $('gateNotesEdit').addEventListener('input', function () { if (!editing) return; sheetData().t['gate-notes'] = this.innerText.replace(/\n+$/, ''); markDirty(); });

  // 身高對照圖：制服／戰鬥服切換
  [].forEach.call(document.querySelectorAll('.o-swap'), function (b) {
    b.addEventListener('click', function () { var s = b.closest('.side'); s.dataset.o = s.dataset.o === 'b' ? 'u' : 'b'; });
  });
  // 身高對照圖跟著表格裡的身高走
  function heights() {
    var gk = document.querySelector('[data-e="k-p3"]'), gm = document.querySelector('[data-e="m-p3"]');
    if (!gk || !gm || !$('hcK') || !$('hcKt')) return;
    var k = parseFloat(gk.textContent) || 172, m = parseFloat(gm.textContent) || 153;
    k = Math.max(50, Math.min(189, k)); m = Math.max(50, Math.min(189, m));
    $('hcK').style.setProperty('--h', k); $('hcM').style.setProperty('--h', m);
    $('hcKt').textContent = k + ' cm'; $('hcMt').textContent = m + ' cm';
    $('hcDiff').textContent = '身高差 ' + Math.round(Math.abs(k - m)) + ' cm';
  }
  sheetEls.forEach(function (el) {
    el.addEventListener('input', function () { if (!editing) return; sheetData().t[el.dataset.e] = el.innerText.trim(); markDirty(); if (/-p3$/.test(el.dataset.e)) heights(); });
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter' && el.tagName !== 'LI') { e.preventDefault(); el.blur(); } });
  });
  var swTarget = null;
  swEls.forEach(function (b) {
    b.addEventListener('click', function () {
      if (!editing) return;
      swTarget = b;
      var cur = getComputedStyle(b).getPropertyValue('--c').trim();
      if (/^#[0-9a-f]{6}$/i.test(cur)) $('colorPick').value = cur;
      $('colorPick').click();
    });
  });
  $('colorPick').addEventListener('input', function () {
    if (!swTarget) return;
    swTarget.style.setProperty('--c', this.value);
    sheetData().c[swTarget.dataset.c] = this.value; markDirty();
  });

  function renderAll() { if (!state) return; renderSheet(); renderSlots(); renderBoard(); renderGallery(); renderLook(); renderMusic(); renderLib(); }

  // ---------- 編輯模式 ----------
  function setEditing(on) {
    editing = on; sel = null;
    $('editBar').hidden = !on; $('editFab').hidden = on || !canEditView; $('navEdit').hidden = on || !canEditView;
    document.body.classList.toggle('is-editing', on);
    [].forEach.call(document.querySelectorAll('.edit-only'), function (el) { el.hidden = !on; });
    if (on) {
      status(dirty ? '有未儲存的變更' : '點一下項目就能拖曳、拉角落縮放、拉上方圓點旋轉；也可以直接把圖片檔拖進拼貼區');
    }
    renderAll();
    if (!$('gv').hidden) gvRender();
  }
  var canEditView = false;
  function startEdit() { setEditing(true); }
  $('editFab').addEventListener('click', startEdit);
  $('undoBtn').addEventListener('click', undo);
  $('redoBtn').addEventListener('click', redo);
  $('navEdit').addEventListener('click', startEdit);
  $('doneBtn').addEventListener('click', function () {
    if (dirty) { status('還沒儲存喔，先按「儲存」，或再按一次「結束」放棄這次的變更'); if (!this.dataset.warned) { this.dataset.warned = '1'; return; } location.reload(); return; }
    setEditing(false);
  });

  $('saveBtn').addEventListener('click', function () {
    if (!art) return;
    var btn = this; btn.disabled = true; status('儲存中…');
    var used = usedPaths(), files = {};
    files['data/state.json'] = { content: JSON.stringify(state, null, 1), contentType: 'application/json' };
    Object.keys(pending).forEach(function (p) { if (used[p]) files[p] = pending[p]; });
    Object.keys(savedPaths).forEach(function (p) { if (!used[p]) files[p] = null; });
    art.publish(files).then(function () {
      pending = {}; savedPaths = used; dirty = false; delete $('doneBtn').dataset.warned;
      status('已儲存 ✓ 大家打開網站都會看到新版本');
    }).catch(function (err) {
      var c = err && err.code;
      if (c === 'gh_auth') status('GitHub 鑰匙無效、過期或沒有寫入權限：按右下角的鑰匙重新登入');
      else if (c === 'conflict') status('GitHub 上剛好有別的更新，重新整理頁面後再存一次');
      else if (c === 'not_writer' || c === 'not_granted' || c === 'capability_disabled' || c === 'not_declared')
        status('這裡無法儲存：網站公開分享時或沒有編輯權限時不能存。先把分享改回私人再編輯。');
      else if (c === 'too_large') status('這次加的圖太多太大了，分幾次存');
      else if (c === 'rate_limited') status('存太快了，等幾秒再按一次');
      else status('儲存失敗，等一下再試一次');
    }).then(function () { btn.disabled = false; });
  });
  window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });


  // ---------- 音樂播放器：歌單存在 state.music，換頁不中斷 ----------
  var au = new Audio(), mIdx = 0, mOpen = false;
  au.preload = 'none';
  function tracks() { if (!state.music) state.music = []; return state.music; }
  var mpLS = function (k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } };
  function mLoad(i, play) {
    var T = tracks(); if (!T.length) return;
    mIdx = (i + T.length) % T.length; au.src = src(T[mIdx].src);
    try { au.volume = +(mpLS('cb-vol') || .6); } catch (e) {}
    if (play) au.play().catch(function () {});
    renderMusic();
  }
  function mToggle() {
    var T = tracks(); if (!T.length) { if (editing) $('musicPick').click(); return; }
    if (!au.src) return mLoad(mIdx, true), mpLS('cb-music', 'on');
    if (au.paused) { au.play().catch(function () {}); mpLS('cb-music', 'on'); } else { au.pause(); mpLS('cb-music', 'off'); }
  }
  function renderMusic() {
    var mp = $('mp'); if (!mp || !state) return;
    var T = tracks(), t = T[mIdx];
    mp.hidden = !T.length && !editing && !canEditView; // 站主（有編輯權限）就算還沒放歌也看得到
    mp.classList.toggle('playing', !au.paused);
    mp.classList.toggle('open', mOpen);
    $('mpTitle').textContent = t ? (t.title || '未命名') : (editing ? '還沒有歌，點唱片按 ＋ 加歌' : '還沒有歌：按「編輯」後加入');
    $('mpArtist').textContent = t ? (t.artist || '') : '';
    $('mpPlay').textContent = au.paused ? '▶' : '❚❚';
    $('mpPlay').setAttribute('aria-label', au.paused ? '播放' : '暫停');
    var ul = $('mpList'); ul.innerHTML = '';
    T.forEach(function (o, i) {
      var li = document.createElement('li'); li.setAttribute('aria-current', String(i === mIdx));
      li.innerHTML = '<span class="n">' + (i < 9 ? '0' : '') + (i + 1) + '</span><span class="tt"><b></b><small></small></span>';
      var b = li.querySelector('b'), sm = li.querySelector('small');
      b.textContent = o.title || '未命名'; sm.textContent = o.artist || '';
      if (editing) {
        [[b, 'title'], [sm, 'artist']].forEach(function (x) {
          x[0].contentEditable = 'plaintext-only'; x[0].title = x[1] === 'title' ? '點一下改歌名' : '點一下改歌手';
          if (!x[0].textContent) x[0].dataset.ph = x[1] === 'title' ? '歌名' : '歌手';
          x[0].addEventListener('input', function () { o[x[1]] = x[0].innerText.trim(); markDirty(); if (i === mIdx) { $(x[1] === 'title' ? 'mpTitle' : 'mpArtist').textContent = o[x[1]]; } });
          x[0].addEventListener('click', function (e) { e.stopPropagation(); });
        });
        var ac = document.createElement('span'); ac.className = 'acts';
        [['↑', '往上', function () { if (i > 0) { T.splice(i - 1, 0, T.splice(i, 1)[0]); if (mIdx === i) mIdx--; else if (mIdx === i - 1) mIdx++; } }],
         ['↓', '往下', function () { if (i < T.length - 1) { T.splice(i + 1, 0, T.splice(i, 1)[0]); if (mIdx === i) mIdx++; else if (mIdx === i + 1) mIdx--; } }],
         ['×', '刪除這首', function () { var wasCur = i === mIdx; T.splice(i, 1); if (wasCur) { au.pause(); au.removeAttribute('src'); mIdx = 0; } else if (i < mIdx) mIdx--; }]].forEach(function (a) {
          var bt = document.createElement('button'); bt.type = 'button'; bt.textContent = a[0]; bt.title = a[1];
          bt.onclick = function (e) { e.stopPropagation(); a[2](); markDirty(); renderMusic(); };
          ac.appendChild(bt);
        });
        li.appendChild(ac);
      }
      li.onclick = function () { mLoad(i, true); mpLS('cb-music', 'on'); };
      ul.appendChild(li);
    });
    $('mpAdd').hidden = !editing;
  }
  au.addEventListener('ended', function () { mLoad(mIdx + 1, true); });
  ['play', 'pause'].forEach(function (ev) { au.addEventListener(ev, renderMusic); });
  au.addEventListener('timeupdate', function () { var d = au.duration; $('mpBar').style.width = d ? (au.currentTime / d * 100) + '%' : '0'; });
  $('mpPlay').addEventListener('click', mToggle);
  $('mpPrev').addEventListener('click', function () { if (tracks().length) mLoad(mIdx - 1, true); });
  $('mpNext').addEventListener('click', function () { if (tracks().length) mLoad(mIdx + 1, true); });
  $('mpListBtn').addEventListener('click', function () { mOpen = !mOpen; renderMusic(); });
  $('mpVol').value = mpLS('cb-vol') || .6;
  $('mpVol').addEventListener('input', function () { au.volume = +this.value; mpLS('cb-vol', this.value); });
  $('mpAdd').addEventListener('click', function () { $('musicPick').click(); });
  $('musicPick').addEventListener('change', function (e) {
    var files = [].slice.call(e.target.files); e.target.value = ''; if (!files.length) return;
    status('處理音樂中…');
    files.reduce(function (pr, f) {
      return pr.then(function () { return addFile(f).then(function (p) {
        tracks().push({ id: uid(), title: (f.name || '').replace(/\.[^.]+$/, ''), artist: '', src: p }); mOpen = true; renderMusic();
      }, function (er) { status((er && er.msg) || '這個檔案讀不了'); }); });
    }, Promise.resolve()).then(function () { markDirty(); status('加好了，記得按「儲存」'); });
  });
  // 按「進入」那一下開始播（瀏覽器不讓網站一打開就自己出聲）；訪客上次按過暫停就不自動播
  $('enterBtn').addEventListener('click', function () { if (state && tracks().length && mpLS('cb-music') !== 'off' && au.paused) mLoad(mIdx, true); });

  // ---------- 游標小未亜 ----------
  (function () {
    if (!window.matchMedia || !matchMedia('(hover:hover) and (pointer:fine)').matches) return;
    var mia = $('mia'), still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    // 緊貼在箭頭右下方，跟著游標同步移動，不延遲、不搖晃
    document.addEventListener('pointermove', function (e) {
      if (e.pointerType !== 'mouse') return;
      mia.hidden = false;
      mia.style.transform = 'translate(' + (e.clientX + 12) + 'px,' + (e.clientY + 16) + 'px)';
    });
    document.documentElement.addEventListener('mouseleave', function () { mia.hidden = true; });
    // 彩蛋：滑鼠在勝己的介紹頁移動時，會冒出小小的爆炸
    if (still) return;
    var chara = $('chara'), lx = 0, ly = 0, lt = 0;
    var burst = '<svg viewBox="0 0 100 100"><path d="M50 2l9 26 22-15-8 26 26 2-23 13 18 20-26-5-2 27-16-21-16 21-2-27-26 5 18-20L2 56l26-2-8-26 22 15z" fill="#f0c27a" stroke="#d6a283" stroke-width="3" stroke-linejoin="round"/><circle cx="50" cy="52" r="13" fill="#fffcfb"/></svg>';
    chara.addEventListener('pointermove', function (e) {
      if (e.pointerType !== 'mouse' || editing) return;
      var now = performance.now();
      if (now - lt < 140 || Math.hypot(e.clientX - lx, e.clientY - ly) < 60) return;
      lt = now; lx = e.clientX; ly = e.clientY;
      var b = document.createElement('span');
      b.className = 'boom';
      b.style.transform = 'translate(' + (e.clientX - 10 + Math.random() * 20) + 'px,' + (e.clientY - 16 + Math.random() * 12) + 'px)';
      var sparks = '';
      for (var k = 0; k < 6; k++) {
        var a = Math.random() * Math.PI * 2, d = 18 + Math.random() * 16;
        sparks += '<i style="--sx:' + (Math.cos(a) * d).toFixed(0) + 'px;--sy:' + (Math.sin(a) * d).toFixed(0) + 'px"></i>';
      }
      b.innerHTML = burst + sparks;
      document.body.appendChild(b);
      setTimeout(function () { b.remove(); }, 700);
    });
  })();

  // ---------- 閱讀：小說（往下捲、可穿插配圖）／漫畫（左右滑） ----------
  function lib() { if (!state.library) state.library = []; return state.library; }
  function libFind(id) { return lib().filter(function (w) { return w.id === id; })[0]; }
  function coverOf(w) {
    if (w.cover) return w.cover;
    if (w.type === 'comic') return (w.pages || [])[0];
    var im = (w.blocks || []).filter(function (b) { return b.t === 'img' && b.src; })[0]; return im && im.src;
  }
  var libPickCb = null, libDelArm = '', rdOpen = null;
  function libPick(cb) { libPickCb = cb; $('libPick').click(); }
  $('libPick').addEventListener('change', function (e) {
    var files = [].slice.call(e.target.files), cb = libPickCb; e.target.value = ''; libPickCb = null;
    if (!files.length || !cb) return;
    status('處理圖片中…'); var out = [];
    files.reduce(function (pr, f) { return pr.then(function () { return addFile(f).then(function (p) { out.push(p); }, function (er) { status((er && er.msg) || '有檔案讀不了'); }); }); }, Promise.resolve())
      .then(function () { if (out.length) { cb(out); markDirty(); status('加好了，記得按「儲存」'); } });
  });
  function editable(el, get, set, multi) {
    el.textContent = get() || '';
    if (!editing) { el.removeAttribute('contenteditable'); return; }
    try { el.contentEditable = 'plaintext-only'; } catch (er) { el.contentEditable = 'true'; }
    el.oninput = function () { set(el.innerText.replace(/\n+$/, '')); markDirty(); };
    el.onclick = function (e) { e.stopPropagation(); };
    if (!multi) el.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } };
  }
  // 標籤顏色（跟 Notion 一樣自動配色，站主點一下可以換色）
  var TAGC = [['#f8dfe2', '#a8485a'], ['#fbe2d6', '#b35a32'], ['#fcebd9', '#a86a2c'], ['#f1e9df', '#7d6a55'], ['#eee3e7', '#7a5a66'], ['#f3d3da', '#8c3247'], ['#f7f1e3', '#8a7440'], ['#ecebea', '#6f6869']];
  function tagCol(n) {
    state.libTags = state.libTags || {};
    if (state.libTags[n] == null) { var h = 0; for (var i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) % 997; return h % TAGC.length; }
    return state.libTags[n] % TAGC.length;
  }
  function tagPill(n) { var c = TAGC[tagCol(n)], s = document.createElement('span'); s.className = 'lib-tag'; s.style.background = c[0]; s.style.color = c[1]; s.textContent = n; return s; }
  var libTab = 'comic', libTagF = '';
  try { libTab = localStorage.getItem('cb-lib-tab') || 'comic'; } catch (er) {}
  function renderLib() {
    if (!$('libGrid') || !state) return;
    var L = lib(), g = $('libGrid'); g.innerHTML = '';
    // 圖庫分頁：插圖／漫畫／小說（插圖在 #gallery，漫畫小說在 #library）
    ['libTabs', 'galTabs'].forEach(function (tid) {
      var tabs = $(tid); if (!tabs) return; tabs.innerHTML = '';
      [['img', '插圖'], ['comic', '漫畫'], ['novel', '小說']].forEach(function (t) {
        var n = t[0] === 'img' ? (state.gallery || []).length : L.filter(function (w) { return w.type === t[0]; }).length, b = document.createElement('button');
        var on = tid === 'galTabs' ? t[0] === 'img' : libTab === t[0];
        b.type = 'button'; b.setAttribute('aria-pressed', String(on)); b.innerHTML = esc(t[1]) + '<i>' + n + '</i>';
        b.onclick = function () {
          if (t[0] === 'img') { location.hash = 'gallery'; return; }
          libTab = t[0]; libTagF = ''; try { localStorage.setItem('cb-lib-tab', libTab); } catch (er) {}
          if (location.hash !== '#library') location.hash = 'library'; renderLib();
        };
        tabs.appendChild(b);
      });
    });
    $('libAddComic').hidden = libTab !== 'comic'; $('libAddNovel').hidden = libTab !== 'novel';
    var inTab = L.filter(function (w) { return w.type === libTab; });
    // 標籤篩選
    var all = {}; inTab.forEach(function (w) { (w.tags || []).forEach(function (t) { all[t] = (all[t] || 0) + 1; }); });
    var names = Object.keys(all).sort(); if (libTagF && !all[libTagF]) libTagF = '';
    var bar = $('libTagbar'); bar.innerHTML = ''; bar.hidden = !names.length;
    if (names.length) {
      var allB = document.createElement('button'); allB.type = 'button'; allB.className = 'lib-fall'; allB.textContent = '全部'; allB.setAttribute('aria-pressed', String(!libTagF));
      allB.onclick = function () { libTagF = ''; renderLib(); }; bar.appendChild(allB);
      names.forEach(function (n) {
        var b = document.createElement('button'); b.type = 'button'; b.className = 'lib-fbtn'; b.setAttribute('aria-pressed', String(libTagF === n));
        b.appendChild(tagPill(n)); b.onclick = function () { libTagF = libTagF === n ? '' : n; renderLib(); }; bar.appendChild(b);
      });
    }
    var dl = $('libTagList'); dl.innerHTML = '';
    var every = {}; L.forEach(function (w) { (w.tags || []).forEach(function (t) { every[t] = 1; }); });
    Object.keys(every).sort().forEach(function (t) { var o = document.createElement('option'); o.value = t; dl.appendChild(o); });
    var vis = inTab.filter(function (w) { return !libTagF || (w.tags || []).indexOf(libTagF) >= 0; });
    if (!vis.length) g.innerHTML = '<p class="lib-empty">' + (editing ? '按右上角「＋ 新增' + (libTab === 'comic' ? '漫畫' : '小說') + '」開始放作品' : (libTagF ? '這個標籤還沒有作品' : '作品準備中 ♡')) + '</p>';
    vis.forEach(function (w, vi) {
      var i = L.indexOf(w);
      var c = document.createElement('div'); c.className = 'lib-card'; c.tabIndex = 0; c.setAttribute('role', 'button');
      var cv = coverOf(w);
      c.innerHTML = '<div class="lib-cover">' + (cv ? '<img alt="" loading="lazy" src="' + esc(src(cv)) + '">' : '<span class="ph">' + (w.type === 'comic' ? 'COMIC' : 'NOVEL') + '</span>') + '</div>' +
        '<div class="lib-info"><p class="lib-t"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5.5L13 5v9.5H4z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9.5 1.5V5H13M6 8h5M6 10.5h5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg><b></b></p><div class="lib-tags"></div><small></small></div>';
      editable(c.querySelector('b'), function () { return w.title; }, function (v) { w.title = v; });
      editable(c.querySelector('small'), function () { return w.note; }, function (v) { w.note = v; }, true);
      var tw = c.querySelector('.lib-tags'); w.tags = w.tags || [];
      // 標籤：一部作品可以有很多個；輸入框按 Enter（或用逗號、頓號隔開）就加一個，輸入框會留著繼續加
      var tagEditOpen = false;
      function addTags(v) {
        var n = 0;
        String(v || '').split(/[,，、;；\n]+/).forEach(function (t) { t = t.trim(); if (t && w.tags.indexOf(t) < 0) { w.tags.push(t); n++; } });
        if (n) markDirty(); return n;
      }
      function buildTags(openInput) {
        tw.innerHTML = '';
        w.tags.forEach(function (t, ti) {
          var p = tagPill(t);
          if (editing) {
            p.title = '點一下換顏色'; p.classList.add('ed');
            p.onclick = function (e) { e.stopPropagation(); state.libTags = state.libTags || {}; state.libTags[t] = (tagCol(t) + 1) % TAGC.length; markDirty(); renderLib(); };
            var x = document.createElement('i'); x.textContent = '×'; x.title = '拿掉這個標籤';
            x.onclick = function (e) { e.stopPropagation(); w.tags.splice(ti, 1); markDirty(); buildTags(tagEditOpen); };
            p.appendChild(x);
          }
          tw.appendChild(p);
        });
        if (!editing) return;
        if (!openInput) {
          var add = document.createElement('button'); add.type = 'button'; add.className = 'lib-tadd'; add.textContent = '＋ 標籤';
          add.onclick = function (e) { e.stopPropagation(); tagEditOpen = true; buildTags(true); };
          tw.appendChild(add); return;
        }
        var box = document.createElement('span'); box.className = 'lib-tbox';
        var inp = document.createElement('input'); inp.className = 'lib-tin'; inp.setAttribute('list', 'libTagList'); inp.placeholder = '標籤名稱';
        var ok = document.createElement('button'); ok.type = 'button'; ok.className = 'lib-tok'; ok.textContent = '加入'; ok.title = '加入這個標籤（之後可以繼續加）';
        var fin = document.createElement('button'); fin.type = 'button'; fin.className = 'lib-tfin'; fin.textContent = '完成';
        box.appendChild(inp); box.appendChild(ok); box.appendChild(fin); tw.appendChild(box);
        var commitKeep = function () { addTags(inp.value); buildTags(true); };
        var close = function () { addTags(inp.value); tagEditOpen = false; renderLib(); };
        [inp, ok, fin, box].forEach(function (el) { el.addEventListener('click', function (ev) { ev.stopPropagation(); }); });
        ok.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
        fin.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
        ok.onclick = function (ev) { ev.stopPropagation(); commitKeep(); };
        fin.onclick = function (ev) { ev.stopPropagation(); close(); };
        inp.addEventListener('keydown', function (ev) {
          if (ev.isComposing || ev.keyCode === 229) return; // 中文輸入法選字時的 Enter 不算
          if (ev.key === 'Enter') { ev.preventDefault(); if (inp.value.trim()) commitKeep(); else close(); }
          if (ev.key === 'Escape') { ev.preventDefault(); tagEditOpen = false; renderLib(); }
          if (ev.key === 'Backspace' && !inp.value && w.tags.length) { w.tags.pop(); markDirty(); buildTags(true); }
        });
        inp.addEventListener('input', function () { if (/[,，、;；]/.test(inp.value)) { addTags(inp.value); buildTags(true); } });
        inp.addEventListener('blur', function () { setTimeout(function () { if (tagEditOpen && document.activeElement !== inp && !box.contains(document.activeElement) && box.isConnected) close(); }, 150); });
        inp.focus();
      }
      buildTags(false);
      var go = function () { location.hash = 'read-' + w.id; };
      c.addEventListener('click', function (e) { if (e.target.closest('.lib-acts,[contenteditable],.lib-tags,.pan-bar,.so-h') || c.querySelector('.panning')) return; go(); });
      panUI(c.querySelector('.lib-cover'), c.querySelector('.lib-cover img'), w, 'coverPos', 20, renderLib);
      c.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.target.closest('[contenteditable],input,button')) go(); });
      if (editing) {
        var a = document.createElement('div'); a.className = 'lib-acts';
        [['換封面', function () { libPick(function (ps) { w.cover = ps[0]; w.coverPos = null; renderLib(); }); }],
         ['調整封面位置', function () { panCur = panCur === w ? null : w; renderLib(); }],
         ['刪除', function () { if (libDelArm !== w.id) { libDelArm = w.id; status('再按一次「刪除」就會刪掉這部作品（可以用復原救回來）'); return; } libDelArm = ''; L.splice(i, 1); markDirty(); renderLib(); }]].forEach(function (t) {
          var b = document.createElement('button'); b.type = 'button'; b.textContent = t[0]; b.onclick = function (e) { e.stopPropagation(); t[1](); }; a.appendChild(b);
        });
        c.appendChild(a);
        var hd = document.createElement('span'); hd.className = 'so-h lib-grip'; hd.title = '拖曳換順序'; hd.innerHTML = GRIP; c.appendChild(hd);
        sortable(c, hd, vi, function (x, y) { moveIn(L, vis, x, y); renderLib(); });
      }
      g.appendChild(c);
    });
    if (rdOpen) { var w = libFind(rdOpen); if (w && w.type === 'novel') renderNovel(w); if (w && w.type === 'comic' && !$('comic').hidden) renderComic(w, true); }
  }
  function newId() { return uid(); }
  $('libAddNovel').addEventListener('click', function () {
    var w = { id: newId(), type: 'novel', title: '新的小說', note: '', tags: [], blocks: [{ t: 'p', text: '在這裡開始寫……' }] };
    lib().push(w); libTab = 'novel'; markDirty(); location.hash = 'read-' + w.id;
  });
  $('libAddComic').addEventListener('click', function () {
    var w = { id: newId(), type: 'comic', title: '新的漫畫', note: '', tags: [], pages: [], dir: 'ltr' };
    lib().push(w); libTab = 'comic'; markDirty(); renderLib(); location.hash = 'read-' + w.id;
  });
  // ---- 小說 ----
  function renderNovel(w) {
    editable($('nvTitle'), function () { return w.title; }, function (v) { w.title = v; });
    editable($('nvNote'), function () { return w.note; }, function (v) { w.note = v; }, true);
    var nt = $('nvTags'); nt.innerHTML = ''; (w.tags || []).forEach(function (t) { nt.appendChild(tagPill(t)); });
    var body = $('nvBody'); body.innerHTML = ''; var B = w.blocks = w.blocks || [];
    function ins(at) {
      var bar = document.createElement('div'); bar.className = 'nv-ins';
      [['＋ 文字', function () { B.splice(at, 0, { t: 'p', text: '' }); }], ['＋ 小標', function () { B.splice(at, 0, { t: 'h', text: '' }); }],
       ['＋ 配圖', null], ['＋ 分隔 ✦', function () { B.splice(at, 0, { t: 'hr' }); }]].forEach(function (t) {
        var b = document.createElement('button'); b.type = 'button'; b.textContent = t[0];
        b.onclick = function () {
          if (!t[1]) { libPick(function (ps) { B.splice.apply(B, [at, 0].concat(ps.map(function (p) { return { t: 'img', src: p, cap: '' }; }))); renderNovel(w); }); return; }
          t[1](); markDirty(); renderNovel(w); var el = body.querySelectorAll('[data-i]')[at]; if (el) { var f = el.querySelector('[contenteditable]'); if (f) f.focus(); }
        };
        bar.appendChild(b);
      });
      body.appendChild(bar);
    }
    B.forEach(function (b, i) {
      if (editing) ins(i);
      var el;
      if (b.t === 'img') {
        el = document.createElement('figure'); el.className = 'nv-b nv-fig';
        el.innerHTML = b.src ? '<img alt="" loading="lazy" src="' + esc(src(b.src)) + '">' : '';
        var cap = document.createElement('figcaption'); el.appendChild(cap);
        editable(cap, function () { return b.cap; }, function (v) { b.cap = v; });
        var im = el.querySelector('img');
        if (im) im.onclick = function () {
          if (editing) { libPick(function (ps) { b.src = ps[0]; renderNovel(w); }); return; }
          $('lbImg').hidden = false; $('lbVid').hidden = true; $('lbImg').src = src(b.src); $('lbCap').textContent = b.cap || ''; $('lightbox').hidden = false;
        };
        if (im && editing) im.title = '點一下換圖';
      } else if (b.t === 'hr') {
        el = document.createElement('div'); el.className = 'nv-b nv-hr'; el.textContent = '✦ ✦ ✦';
      } else {
        el = document.createElement(b.t === 'h' ? 'h3' : 'div'); el.className = 'nv-b ' + (b.t === 'h' ? 'nv-h' : 'nv-p');
        editable(el, function () { return b.text; }, function (v) { b.text = v; }, b.t === 'p');
        if (editing && !b.text) el.dataset.ph = '1';
      }
      el.dataset.i = i;
      if (editing) {
        el.classList.add('ed');
        var tl = document.createElement('div'); tl.className = 'nv-tools';
        [['↑', '往上', function () { if (i > 0) B.splice(i - 1, 0, B.splice(i, 1)[0]); }],
         ['↓', '往下', function () { if (i < B.length - 1) B.splice(i + 1, 0, B.splice(i, 1)[0]); }],
         ['×', '刪除這段', function () { B.splice(i, 1); }]].forEach(function (t) {
          var bt = document.createElement('button'); bt.type = 'button'; bt.textContent = t[0]; bt.title = t[1]; bt.contentEditable = 'false';
          bt.onclick = function (e) { e.stopPropagation(); t[2](); markDirty(); renderNovel(w); };
          tl.appendChild(bt);
        });
        // 工具列放在外層，避免被當成文字內容存進去
        var wrap = document.createElement('div'); wrap.style.position = 'relative'; wrap.dataset.i = i; el.removeAttribute('data-i');
        wrap.appendChild(el); wrap.appendChild(tl); body.appendChild(wrap);
      } else body.appendChild(el);
    });
    if (editing) ins(B.length);
  }
  // ---- 漫畫 ----
  var cmW = null;
  function cmIdx() { var t = $('cmTrack'); return Math.round(Math.abs(t.scrollLeft) / (t.clientWidth || 1)); }
  function cmGo(d) { if (cmZ > 1) cmZoom(1); var t = $('cmTrack'); var rtl = t.classList.contains('rtl'); t.scrollBy({ left: (rtl ? -d : d) * t.clientWidth, behavior: 'smooth' }); }
  // 電腦上放大：100% → 150% → 200% → 250%，放大後可以拖曳看細節
  var cmZ = 1, CMZ = [1, 1.5, 2, 2.5];
  function cmZoom(z) {
    var t = $('cmTrack'), pg = t.children[cmIdx()];
    [].forEach.call(t.querySelectorAll('.cm-pg'), function (c) { c.classList.remove('zoomed'); var im = c.querySelector('img'); if (im) { im.style.width = ''; im.style.height = ''; } });
    var im = pg && pg.querySelector('img');
    if (z > 1 && im && im.naturalWidth) {
      var r = im.naturalWidth / im.naturalHeight, base = Math.min(pg.clientHeight - 10, (pg.clientWidth - 16) / r);
      pg.classList.add('zoomed'); im.style.height = base * z + 'px'; im.style.width = base * z * r + 'px';
      pg.scrollLeft = (pg.scrollWidth - pg.clientWidth) / 2; pg.scrollTop = (pg.scrollHeight - pg.clientHeight) / 2;
    } else z = 1;
    cmZ = z; t.classList.toggle('zooming', z > 1);
    $('cmZV').textContent = Math.round(z * 100) + '%'; $('cmZOut').disabled = z <= 1; $('cmZIn').disabled = z >= CMZ[CMZ.length - 1];
  }
  $('cmZIn').addEventListener('click', function () { var i = CMZ.indexOf(cmZ); cmZoom(CMZ[Math.min(CMZ.length - 1, i + 1)]); });
  $('cmZOut').addEventListener('click', function () { var i = CMZ.indexOf(cmZ); cmZoom(CMZ[Math.max(0, i - 1)]); });
  $('cmTrack').addEventListener('dblclick', function (e) { if (e.target.tagName === 'IMG') cmZoom(cmZ > 1 ? 1 : 2); });
  function cmTo(i, smooth) { if (cmZ > 1) cmZoom(1); var t = $('cmTrack'); t.scrollTo({ left: (t.classList.contains('rtl') ? -1 : 1) * i * t.clientWidth, behavior: smooth ? 'smooth' : 'auto' }); }
  function cmCount() {
    var P = (cmW && cmW.pages) || [], i = Math.min(cmIdx(), Math.max(0, P.length - 1)), sl = $('cmSlider');
    $('cmPage').textContent = P.length ? (i + 1) + ' / ' + P.length : '';
    sl.max = Math.max(1, P.length); if (document.activeElement !== sl) sl.value = i + 1;
    $('cmA').textContent = P.length ? i + 1 : 0; $('cmB').textContent = P.length;
    sl.parentNode.classList.toggle('rtl', !!(cmW && cmW.dir === 'rtl')); sl.parentNode.hidden = P.length < 2;
  }
  // 頁數拉桿：電腦上拖拉直接跳頁
  $('cmSlider').addEventListener('input', function () { cmTo(this.value - 1); $('cmA').textContent = this.value; });
  // 滑鼠按住拖曳也能翻頁；滾輪往下＝下一頁
  (function () {
    var t = $('cmTrack'), d = null, wl = 0;
    t.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      if (cmZ > 1) { var pg = e.target.closest('.cm-pg'); if (pg) { d = { pan: pg, x: e.clientX, y: e.clientY, sl: pg.scrollLeft, st: pg.scrollTop }; e.preventDefault(); } return; }
      d = { x: e.clientX, s: t.scrollLeft, i: cmIdx() }; t.classList.add('drag'); e.preventDefault(); });
    window.addEventListener('pointermove', function (e) { if (!d) return; if (d.pan) { d.pan.scrollLeft = d.sl - (e.clientX - d.x); d.pan.scrollTop = d.st - (e.clientY - d.y); return; } t.scrollLeft = d.s - (e.clientX - d.x); });
    window.addEventListener('pointerup', function (e) {
      if (!d) return; if (d.pan) { d = null; return; } var dx = e.clientX - d.x, i = d.i, rtl = t.classList.contains('rtl'); d = null; t.classList.remove('drag');
      if (Math.abs(dx) > 50) i += (dx < 0 ? 1 : -1) * (rtl ? -1 : 1);
      var n = ((cmW && cmW.pages) || []).length; cmTo(Math.max(0, Math.min(n - 1, i)), true);
    });
    t.addEventListener('wheel', function (e) {
      if (cmZ > 1 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; e.preventDefault();
      var now = Date.now(); if (now - wl < 450 || Math.abs(e.deltaY) < 4) return; wl = now;
      var n = ((cmW && cmW.pages) || []).length; cmTo(Math.max(0, Math.min(n - 1, cmIdx() + (e.deltaY > 0 ? 1 : -1))), true);
    }, { passive: false });
  })();
  var cmGridOn = false;
  function cmGrid(on) {
    cmGridOn = on; $('comic').classList.toggle('grid', on); $('cmGridBtn').setAttribute('aria-pressed', String(on));
    var g = $('cmGrid'); g.hidden = !on; if (!on) return;
    var P = (cmW && cmW.pages) || [], cur = Math.min(cmIdx(), P.length - 1); g.innerHTML = '';
    if (!P.length) { g.innerHTML = '<p class="cm-gempty">' + (editing ? '按下方「＋ 加頁面」放漫畫圖' : '這部漫畫還沒有頁面') + '</p>'; return; }
    P.forEach(function (p, i) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'cm-th'; if (i === cur) b.setAttribute('aria-current', 'true');
      b.innerHTML = '<span><img alt="" loading="lazy" src="' + esc(src(p)) + '"></span><small>' + (i + 1) + '</small>';
      b.onclick = function () { cmGrid(false); requestAnimationFrame(function () { cmTo(i); cmCount(); }); };
      g.appendChild(b);
    });
    var c = g.querySelector('[aria-current]'); if (c) c.scrollIntoView({ block: 'center' });
  }
  $('cmGridBtn').addEventListener('click', function () { cmGrid(!cmGridOn); });
  function renderComic(w, keep) {
    cmW = w; var t = $('cmTrack'), at = keep ? cmIdx() : 0, P = w.pages = w.pages || []; cmZ = 1; t.classList.remove('zooming'); $('cmZV').textContent = '100%'; $('cmZOut').disabled = true; $('cmZIn').disabled = false;
    $('cmTitle').textContent = w.title || '';
    t.classList.toggle('rtl', w.dir === 'rtl'); t.innerHTML = '';
    if (!P.length) t.innerHTML = '<div class="cm-pg empty">' + (editing ? '按下方「＋ 加頁面」放漫畫圖（可以一次選很多張）' : '這部漫畫還沒有頁面') + '</div>';
    P.forEach(function (p, i) { var d = document.createElement('div'); d.className = 'cm-pg'; d.innerHTML = '<img alt="第 ' + (i + 1) + ' 頁" ' + (i > 2 ? 'loading="lazy" ' : '') + 'src="' + esc(src(p)) + '">'; t.appendChild(d); });
    requestAnimationFrame(function () { t.scrollLeft = (w.dir === 'rtl' ? -1 : 1) * at * t.clientWidth; cmCount(); if (cmGridOn) cmGrid(true); });
    $('comic').style.bottom = editing && $('editBar') ? $('editBar').offsetHeight + 'px' : ''; // 編輯時把下方的編輯列留出來（才按得到儲存）
    var ed = $('cmEdit'); ed.hidden = !editing; ed.innerHTML = '';
    if (editing) {
      [['＋ 加頁面（加在最後）', function () { libPick(function (ps) { P.push.apply(P, ps); renderComic(w, true); }); }],
       ['在這頁前面插入', function () { var i = cmIdx(); libPick(function (ps) { P.splice.apply(P, [Math.min(i, P.length), 0].concat(ps)); renderComic(w, true); }); }],
       ['換這頁的圖', function () { var i = cmIdx(); if (!P[i]) return; libPick(function (ps) { P[i] = ps[0]; renderComic(w, true); }); }],
       ['往前移', function () { var i = cmIdx(); if (i > 0) { P.splice(i - 1, 0, P.splice(i, 1)[0]); markDirty(); renderComic(w, true); cmGo(-1); } }],
       ['往後移', function () { var i = cmIdx(); if (i < P.length - 1) { P.splice(i + 1, 0, P.splice(i, 1)[0]); markDirty(); renderComic(w, true); cmGo(1); } }],
       ['刪除這頁', function () { var i = cmIdx(); if (!P[i]) return; if (libDelArm !== 'pg' + i) { libDelArm = 'pg' + i; status('再按一次「刪除這頁」就會刪掉'); return; } libDelArm = ''; P.splice(i, 1); markDirty(); renderComic(w, true); }],
       ['設為封面', function () { var i = cmIdx(); if (P[i]) { w.cover = P[i]; markDirty(); status('已設為封面'); } }],
       [w.dir === 'rtl' ? '翻頁方向：右 → 左（日漫）' : '翻頁方向：左 → 右', function () { w.dir = w.dir === 'rtl' ? 'ltr' : 'rtl'; markDirty(); renderComic(w); }]].forEach(function (x) {
        var b = document.createElement('button'); b.type = 'button'; b.textContent = x[0]; b.onclick = x[1]; ed.appendChild(b);
      });
    }
  }
  $('cmTrack').addEventListener('scroll', function () { cmCount(); }, { passive: true });
  $('cmPrev').addEventListener('click', function () { cmGo(cmW && cmW.dir === 'rtl' ? 1 : -1); });
  $('cmNext').addEventListener('click', function () { cmGo(cmW && cmW.dir === 'rtl' ? -1 : 1); });
  $('cmClose').addEventListener('click', function () { location.hash = 'library'; });
  document.addEventListener('keydown', function (e) {
    if ($('comic').hidden || e.target.closest('[contenteditable],input,textarea')) return;
    if (cmGridOn) { if (e.key === 'Escape') cmGrid(false); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); cmGo(cmW && cmW.dir === 'rtl' ? -1 : 1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); cmGo(cmW && cmW.dir === 'rtl' ? 1 : -1); }
    if (e.key === 'Escape') location.hash = 'library';
  });
  [].forEach.call(document.querySelectorAll('#novel [data-back]'), function (b) { b.addEventListener('click', function () { location.hash = 'library'; }); });
  function openRead(id) {
    if (!state) { setTimeout(function () { openRead(id); }, 200); return; }
    var w = libFind(id); if (!w) { location.hash = 'library'; return; }
    rdOpen = id;
    if (w.type === 'comic') { $('libList').hidden = false; $('novel').hidden = true; $('comic').hidden = false; document.body.style.overflow = 'hidden'; cmGridOn = !!(window.matchMedia && matchMedia('(max-width: 720px)').matches && (w.pages || []).length > 1); renderComic(w); if (!cmGridOn) cmGrid(false); }
    else { $('comic').hidden = true; document.body.style.overflow = ''; $('libList').hidden = true; $('novel').hidden = false; renderNovel(w); window.scrollTo(0, 0); }
  }
  function closeRead() { rdOpen = null; cmW = null; $('comic').hidden = true; document.body.style.overflow = ''; $('novel').hidden = true; $('libList').hidden = false; if (state) renderLib(); }
  window.__cbOpenRead = openRead; window.__cbCloseRead = closeRead;
  // 直接用連結打開某部作品（#read-xxx）時，等資料載入後自動打開
  (function () { var m = /^#read-(.+)$/.exec(location.hash); var inn = false; try { inn = sessionStorage.getItem('cb-in') === '1'; } catch (er) {} if (m && inn) openRead(decodeURIComponent(m[1])); })();
  window.addEventListener('hashchange', function () { if (!/^#(read-|library)/.test(location.hash)) { $('comic').hidden = true; document.body.style.overflow = ''; } });

  // ---------- 載入 ----------
  fetch('data/state.json', { cache: 'no-store' })
    .then(function (r) { if (!r.ok) throw 0; return r.json(); })
    .catch(function () { return DEFAULT; })
    .then(function (s) {
      if (window.__cbFresh) return; // 站主已從 GitHub 讀到更新的版本
      state = s; state.slots = state.slots || {}; state.collage = state.collage || []; state.gallery = state.gallery || [];
      savedPaths = usedPaths();
      setTimeout(function () { commitSnap(); }, 0);
      renderAll();
    });

  // ---------- GitHub 版：只有站主登入（貼上專屬鑰匙）後才能編輯，儲存直接寫進 GitHub ----------
  var GH = (function () {
    if (window.claude && window.claude.use) return null;
    var m = /^([^.]+)\.github\.io$/i.exec(location.hostname); if (!m) return null;
    var seg = location.pathname.split('/').filter(Boolean)[0];
    return { owner: m[1], repo: seg && !/\.html?$/.test(seg) ? seg : m[1] + '.github.io', branch: 'main' };
  })();
  if (GH) (function () {
    var KEY = 'cb-gh-token';
    var tok = function (v) { try { if (v === undefined) return localStorage.getItem(KEY) || ''; if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch (e) { return ''; } };
    function api(path, opt) {
      opt = opt || {};
      return fetch('https://api.github.com/repos/' + GH.owner + '/' + GH.repo + path, {
        method: opt.method || 'GET', cache: 'no-store',
        headers: { Authorization: 'Bearer ' + tok(), Accept: opt.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: opt.body ? JSON.stringify(opt.body) : undefined
      }).then(function (r) {
        if (r.ok) return opt.raw ? r.text() : r.json();
        var code = (r.status === 401 || r.status === 403 || r.status === 404) ? 'gh_auth' : (r.status === 409 || r.status === 422) ? 'conflict' : 'gh_fail';
        throw { code: code, status: r.status };
      });
    }
    function b64(blob) {
      return new Promise(function (ok, no) { var fr = new FileReader(); fr.onload = function () { ok(String(fr.result).split(',')[1] || ''); }; fr.onerror = no; fr.readAsDataURL(blob); });
    }
    // 一次儲存 = 一個 commit（圖片、文字一起），沒用到的舊圖一起刪掉
    function publish(files) {
      var head, base, have = {};
      return api('/git/ref/heads/' + GH.branch).then(function (r) { head = r.object.sha; return api('/git/commits/' + head); })
        .then(function (c) { base = c.tree.sha; return api('/git/trees/' + base + '?recursive=1'); })
        .then(function (t) {
          (t.tree || []).forEach(function (x) { have[x.path] = 1; });
          var entries = [];
          return Object.keys(files).reduce(function (pr, path) {
            return pr.then(function () {
              var f = files[path];
              if (f === null) { if (have[path]) entries.push({ path: path, mode: '100644', type: 'blob', sha: null }); return; }
              var body = f && f.content != null ? Promise.resolve({ content: f.content, encoding: 'utf-8' }) : b64(f).then(function (c) { return { content: c, encoding: 'base64' }; });
              return body.then(function (b) { return api('/git/blobs', { method: 'POST', body: b }); })
                .then(function (r) { entries.push({ path: path, mode: '100644', type: 'blob', sha: r.sha }); });
            });
          }, Promise.resolve()).then(function () { return entries; });
        })
        .then(function (entries) { return api('/git/trees', { method: 'POST', body: { base_tree: base, tree: entries } }); })
        .then(function (t) { return api('/git/commits', { method: 'POST', body: { message: '網站內容更新（從網站儲存）', tree: t.sha, parents: [head] } }); })
        .then(function (c) { return api('/git/refs/heads/' + GH.branch, { method: 'PATCH', body: { sha: c.sha } }); })
        .then(function () { setTimeout(function () { status('已存到 GitHub ✓ 大約 1～3 分鐘後，大家看到的網站就會更新'); }, 50); });
    }
    // 登入後改讀 GitHub 上最新的資料（網站本身可能還在更新中，避免舊資料蓋掉新資料）
    function loadFresh() {
      return api('/contents/data/state.json?ref=' + GH.branch, { raw: true }).then(function (t) {
        var s = JSON.parse(t); state = s; state.slots = state.slots || {}; state.collage = state.collage || []; state.gallery = state.gallery || [];
        window.__cbFresh = true; savedPaths = usedPaths(); setTimeout(function () { commitSnap(); }, 0); renderAll();
      });
    }
    function enable() {
      art = { publish: publish }; canEditView = true;
      if (!editing) { $('editFab').hidden = false; $('navEdit').hidden = false; }
      $('ghKey').classList.add('on'); $('ghKey').title = '已登入（點一下可以登出）';
      renderMusic();
    }
    function openDlg() { $('ghDlg').hidden = false; $('ghTok').value = ''; $('ghErr').textContent = ''; setTimeout(function () { $('ghTok').focus(); }, 30); }
    $('ghKey').hidden = false;
    $('ghKey').addEventListener('click', function () {
      if (canEditView) { if (dirty && !confirmLeave()) return; tok(''); location.reload(); return; }
      openDlg();
    });
    function confirmLeave() { status('還有沒儲存的變更，先按「儲存」；再按一次鑰匙就會登出'); var a = $('ghKey').dataset.arm === '1'; $('ghKey').dataset.arm = '1'; return a; }
    $('ghCancel').addEventListener('click', function () { $('ghDlg').hidden = true; });
    $('ghOk').addEventListener('click', function () {
      var v = $('ghTok').value.trim(); if (!v) return;
      tok(v); $('ghErr').textContent = '確認中…';
      api('/git/ref/heads/' + GH.branch).then(function () { return loadFresh(); }).then(function () {
        $('ghDlg').hidden = true; enable(); status('登入成功 ✓ 按「編輯」開始修改');
      }).catch(function () { tok(''); $('ghErr').textContent = '這把鑰匙不能用：請確認它有 cherry-bomb 專案的「Contents：Read and write」權限，而且還沒過期。'; });
    });
    $('ghTok').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('ghOk').click(); if (e.key === 'Escape') $('ghCancel').click(); });
    if (tok()) api('/git/ref/heads/' + GH.branch).then(function () { return loadFresh(); }).then(enable).catch(function (e) { if (e && e.code === 'gh_auth') tok(''); });
    if (location.hash === '#admin' && !tok()) openDlg();
  })();

  // 只有能編輯的人會看到「編輯」按鈕
  if (window.claude && window.claude.use) {
    Promise.all([window.claude.use('artifact'), window.claude.use('user')]).then(function (r) {
      art = r[0];
      if (!art || !r[1]) return false;
      return r[1].canEdit();
    }).then(function (ok) { if (ok) { canEditView = true; if (!editing) { $('editFab').hidden = false; $('navEdit').hidden = false; } renderMusic(); } }).catch(function () {});
  }
})();
