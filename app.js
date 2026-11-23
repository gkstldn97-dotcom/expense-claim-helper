/* app.js — 개인비용 정산 (영수증 → 엑셀·PPT)
 * 모든 데이터는 이 기기(브라우저)에만 저장됩니다.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* 상수                                                                */
  /* ------------------------------------------------------------------ */

  var PRESETS = [
    { code: '5910', name: 'Food/Canteen Cost', hint: '야근식대 · 회의 식음료' },
    { code: '5970', name: 'Other Social/Employee Costs', hint: '팀 회식 · 간식' },
    { code: '5950', name: 'Seminars/Employee Training', hint: '교육 · 자기계발' },
    { code: '5960', name: 'Company Health Service', hint: '건강검진' },
    { code: '6580', name: 'IT Costs (Hardware & Software)', hint: '소프트웨어 구독 · 기기' },
    { code: '6800', name: 'Printing and Stationary', hint: '인쇄 · 문구' },
    { code: '6810', name: 'Office Accessories', hint: '사무용품' },
    { code: '6840', name: 'Newspapers, Magazines', hint: '도서 · 정기구독' },
    { code: '6900', name: 'Telecommunications', hint: '사무실 전화' },
    { code: '6901', name: 'Cellular Phones', hint: '휴대폰 · 통신비' },
    { code: '6940', name: 'Postage', hint: '택배 · 우편' },
    { code: '7140', name: 'Travelling and Subsistence Allowances', hint: '출장 · 야근택시' },
    { code: '7350', name: 'Event/Meetings', hint: '행사 · 회의' },
    { code: '7360', name: 'Entertaining', hint: '접대비' }
  ];

  var STORE_KEY = 'ech.v1';
  var DB_NAME = 'expense-claim-helper';
  var DB_STORE = 'images';
  var MAX_ITEMS = 50;
  var MAX_EDGE = 1800;
  var JPEG_Q = 0.85;

  /* ------------------------------------------------------------------ */
  /* 작은 도구들                                                          */
  /* ------------------------------------------------------------------ */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function won(n) { return (Number(n) || 0).toLocaleString('ko-KR'); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function monthKeyNow() { return todayISO().slice(0, 7); }
  function monthLabel(key) { return Number(String(key).slice(5, 7)) + '월'; }
  function monthLong(key) { return String(key).slice(0, 4) + '. ' + Number(String(key).slice(5, 7)) + '월'; }

  var toastEl = $('#toast');
  var toastTimer = null;
  var pendingShare = null;

  function toast(msg, kind, action) {
    if (!toastEl) return;
    toastEl.className = 'toast' + (kind === 'err' ? ' err' : '');
    toastEl.innerHTML = '<span>' + esc(msg) + '</span>';
    if (action && action.label && action.onClick) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = action.label;
      b.addEventListener('click', function () { hideToast(); action.onClick(); });
      toastEl.appendChild(b);
    }
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, action ? 9000 : 2600);
  }
  function hideToast() { toastEl.hidden = true; }

  /* ------------------------------------------------------------------ */
  /* 저장소                                                              */
  /* ------------------------------------------------------------------ */

  var memImages = new Map();
  var dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!('indexedDB' in window)) return reject(new Error('no-idb'));
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'id' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  async function dbPut(rec) {
    try {
      var db = await openDB();
      await new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(rec);
        tx.oncomplete = resolve;
        tx.onerror = function () { reject(tx.error); };
      });
    } catch (e) { memImages.set(rec.id, rec); }
  }

  async function dbGet(id) {
    try {
      var db = await openDB();
      return await new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, 'readonly');
        var r = tx.objectStore(DB_STORE).get(id);
        r.onsuccess = function () { resolve(r.result || null); };
        r.onerror = function () { reject(r.error); };
      });
    } catch (e) { return memImages.get(id) || null; }
  }

  async function dbDel(id) {
    try {
      var db = await openDB();
      await new Promise(function (resolve) {
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).delete(id);
        tx.oncomplete = resolve;
        tx.onerror = resolve;
      });
    } catch (e) { memImages.delete(id); }
  }

  /* ------------------------------------------------------------------ */
  /* 상태                                                                */
  /* ------------------------------------------------------------------ */

  function defaultState() {
    return {
      settings: { company: '', employee: '', department: '', account: '', bank: '', template: null },
      months: {},
      active: monthKeyNow(),
      lastAcct: PRESETS[0].code,
      lastType: 'CC'
    };
  }

  var state = loadState();

  function loadState() {
    var base = defaultState();
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return base;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return base;
      base.settings = Object.assign(base.settings, parsed.settings || {});
      base.months = parsed.months || {};
      base.active = parsed.active || base.active;
      base.lastAcct = parsed.lastAcct || base.lastAcct;
      base.lastType = parsed.lastType || base.lastType;
      return base;
    } catch (e) {
      return base;
    }
  }

  var saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeState, 250);
  }
  function writeState() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      toast('저장 공간이 부족합니다. 이전 달 항목을 정리해 주세요.', 'err');
    }
  }

  function currentMonth() {
    if (!state.months[state.active]) state.months[state.active] = { items: [] };
    var m = state.months[state.active];
    if (!Array.isArray(m.items)) m.items = [];
    return m;
  }

  function allMonthKeys() {
    var keys = Object.keys(state.months);
    if (keys.indexOf(state.active) < 0) keys.push(state.active);
    keys.sort();
    return keys;
  }

  function findItem(id) {
    var items = currentMonth().items;
    for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i];
    return null;
  }

  function itemIndex(id) {
    var items = currentMonth().items;
    for (var i = 0; i < items.length; i++) if (items[i].id === id) return i;
    return -1;
  }

  /* ------------------------------------------------------------------ */
  /* 이미지 처리 (EXIF 회전 보정 + 리사이즈/JPEG 압축)                     */
  /* ------------------------------------------------------------------ */

  function loadBitmap(file) {
    return new Promise(function (resolve, reject) {
      if (window.createImageBitmap) {
        Promise.resolve()
          .then(function () { return createImageBitmap(file, { imageOrientation: 'from-image' }); })
          .then(resolve)
          .catch(function () { loadViaImg(); });
        return;
      }
      loadViaImg();
      function loadViaImg() {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () {
          setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
          resolve(img);
        };
        img.onerror = function () {
          URL.revokeObjectURL(url);
          reject(new Error('이미지를 읽지 못했습니다.'));
        };
        img.src = url;
      }
    });
  }

  function drawTo(bitmap, maxEdge, quality) {
    var w0 = bitmap.width || bitmap.naturalWidth;
    var h0 = bitmap.height || bitmap.naturalHeight;
    var scale = Math.min(1, maxEdge / Math.max(w0, h0));
    var w = Math.max(1, Math.round(w0 * scale));
    var h = Math.max(1, Math.round(h0 * scale));
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    return new Promise(function (resolve) {
      canvas.toBlob(function (blob) { resolve({ blob: blob, w: w, h: h }); }, 'image/jpeg', quality);
    });
  }

  async function processImage(file) {
    var bitmap = await loadBitmap(file);
    var big = await drawTo(bitmap, MAX_EDGE, JPEG_Q);
    var small = await drawTo(bitmap, 240, 0.6);
    var thumb = await new Promise(function (resolve) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result)); };
      fr.readAsDataURL(small.blob);
    });
    if (bitmap.close) { try { bitmap.close(); } catch (e) {} }
    return { blob: big.blob, w: big.w, h: big.h, thumb: thumb };
  }

  /* ------------------------------------------------------------------ */
  /* 렌더                                                                */
  /* ------------------------------------------------------------------ */

  var listEl = $('#list');
  var monthbarEl = $('#monthbar');

  function renderAll() {
    renderMonths();
    renderSummary();
    renderList();
    renderDock();
    renderSettingsValues();
  }

  function renderMonths() {
    var keys = allMonthKeys();
    var html = '';
    keys.forEach(function (k) {
      html += '<button type="button" class="chip' + (k === state.active ? ' on' : '') +
        '" data-month="' + esc(k) + '">' + monthLong(k) + '</button>';
    });
    html += '<button type="button" class="chip add" data-act="newMonth">＋ 월 추가</button>';
    monthbarEl.innerHTML = html;
    var on = monthbarEl.querySelector('.chip.on');
    if (on && on.scrollIntoView) {
      try { on.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) {}
    }
  }

  function totals(items) {
    var t = { CC: 0, PC: 0, Cash: 0, all: 0 };
    items.forEach(function (it) {
      var a = Number(it.amount) || 0;
      t.all += a;
      if (it.type === 'PC') t.PC += a;
      else if (it.type === 'Cash') t.Cash += a;
      else t.CC += a;
    });
    return t;
  }

  function renderSummary() {
    var items = currentMonth().items;
    var t = totals(items);
    var chips = '';
    if (t.CC) chips += '<span class="s-chip">CC ' + won(t.CC) + '원</span>';
    if (t.PC) chips += '<span class="s-chip">PC ' + won(t.PC) + '원</span>';
    if (t.Cash) chips += '<span class="s-chip">Cash ' + won(t.Cash) + '원</span>';
    $('#summary').innerHTML =
      '<div class="s-top"><div><div class="s-label">' + monthLong(state.active) +
      ' 정산 · ' + items.length + '건</div>' +
      '<div class="s-total">' + won(t.all) + '원</div></div></div>' +
      (chips ? '<div class="s-chips">' + chips + '</div>' : '');
    $('#subtitle').textContent = monthLong(state.active) + ' · ' + items.length + '건';
  }

  function acctSelectHtml(it) {
    var known = PRESETS.some(function (p) { return String(p.code) === String(it.code); });
    var html = '';
    if (!known && it.code) {
      html += '<option value="' + esc(it.code) + '" selected>' + esc(it.code) + ' · 직접 입력</option>';
    } else if (!known) {
      html += '<option value="" selected>계정 선택</option>';
    }
    PRESETS.forEach(function (p) {
      html += '<option value="' + p.code + '"' +
        (String(it.code) === String(p.code) ? ' selected' : '') + '>' +
        p.code + ' · ' + esc(p.hint) + '</option>';
    });
    html += '<option value="__custom">＋ 직접 입력…</option>';
    return html;
  }

  function cardHtml(it, i) {
    var type = it.type || 'CC';
    return '' +
      '<article class="card" data-id="' + esc(it.id) + '">' +
        '<div class="card-head">' +
          '<span class="no">' + (i + 1) + '</span>' +
          '<button type="button" class="thumb" data-act="view" aria-label="영수증 크게 보기">' +
            (it.thumb ? '<img src="' + it.thumb + '" alt="">' : '') +
          '</button>' +
          '<div class="head-fields">' +
            '<div class="row">' +
              '<input type="date" data-f="date" value="' + esc(it.date || '') + '">' +
              '<input type="text" inputmode="numeric" class="amount" data-f="amount" ' +
                'placeholder="금액" value="' + (it.amount ? won(it.amount) : '') + '">' +
            '</div>' +
            '<select data-f="acct" aria-label="계정과목">' + acctSelectHtml(it) + '</select>' +
          '</div>' +
        '</div>' +
        '<div class="card-body">' +
          '<input type="text" data-f="detail" placeholder="세부내역 (예: 야근식대)" value="' +
            esc(it.detail || '') + '">' +
          '<div class="row">' +
            '<div class="seg">' +
              ['CC', 'PC', 'Cash'].map(function (v) {
                return '<button type="button" data-act="type" data-v="' + v + '" class="' +
                  (type === v ? 'on' : '') + '">' + v + '</button>';
              }).join('') +
            '</div>' +
            '<div class="tools">' +
              '<button type="button" class="tool" data-act="more" aria-label="상세">⋯</button>' +
              '<button type="button" class="tool" data-act="up" aria-label="위로"' +
                (i === 0 ? ' disabled' : '') + '>↑</button>' +
              '<button type="button" class="tool" data-act="down" aria-label="아래로"' +
                (i === currentMonth().items.length - 1 ? ' disabled' : '') + '>↓</button>' +
              '<button type="button" class="tool del" data-act="del" aria-label="삭제">✕</button>' +
            '</div>' +
          '</div>' +
          '<div class="more" hidden>' +
            '<label class="wide"><span>영문 계정명</span>' +
              '<input type="text" data-f="desc" placeholder="Food/Canteen Cost" value="' +
              esc(it.desc || '') + '"></label>' +
            '<label><span>계정 코드</span>' +
              '<input type="text" inputmode="numeric" data-f="code" placeholder="5910" value="' +
              esc(it.code || '') + '"></label>' +
            '<label><span>인원</span>' +
              '<input type="text" inputmode="numeric" data-f="persons" value="' +
              esc(it.persons || 1) + '"></label>' +
            '<label><span>환율 (해외 결제)</span>' +
              '<input type="text" inputmode="decimal" data-f="fx" value="' +
              esc(it.fx || 1) + '"></label>' +
          '</div>' +
        '</div>' +
      '</article>';
  }

  function renderList() {
    var items = currentMonth().items;
    if (!items.length) {
      listEl.innerHTML = '<div class="empty"><strong>이 달 영수증이 없습니다</strong>' +
        '아래 버튼으로 영수증 사진을 한 번에 올려 보세요.</div>';
      return;
    }
    listEl.innerHTML = items.map(cardHtml).join('');
  }

  function renderDock() {
    var items = currentMonth().items;
    var t = totals(items);
    $('#dockCount').textContent = items.length + '건';
    $('#dockTotal').textContent = won(t.all) + '원';
  }

  function updateTotals() { renderSummary(); renderDock(); }

  /* ------------------------------------------------------------------ */
  /* 편집                                                                */
  /* ------------------------------------------------------------------ */

  function defaultDate() {
    var today = todayISO();
    return today.slice(0, 7) === state.active ? today : state.active + '-01';
  }

  async function addFiles(fileList) {
    var files = [];
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      if (/^image\//.test(f.type) || /\.(jpe?g|png|heic|heif|webp)$/i.test(f.name || '')) files.push(f);
    }
    if (!files.length) return;
    var month = currentMonth();
    var room = MAX_ITEMS - month.items.length;
    if (room <= 0) { toast('한 달에 ' + MAX_ITEMS + '건까지 넣을 수 있어요.', 'err'); return; }
    if (files.length > room) {
      files = files.slice(0, room);
      toast('한 달 최대 ' + MAX_ITEMS + '건까지만 담았습니다.');
    }
    toast(files.length + '장 불러오는 중…');
    var failed = 0;
    for (var k = 0; k < files.length; k++) {
      try {
        var proc = await processImage(files[k]);
        var id = uid();
        await dbPut({ id: id, blob: proc.blob, w: proc.w, h: proc.h, name: files[k].name, created: Date.now() });
        var preset = PRESETS.filter(function (p) { return p.code === state.lastAcct; })[0] || PRESETS[0];
        month.items.push({
          id: id,
          date: defaultDate(),
          amount: 0,
          detail: '',
          desc: preset.name,
          code: preset.code,
          persons: 1,
          type: state.lastType || 'CC',
          fx: 1,
          thumb: proc.thumb,
          w: proc.w,
          h: proc.h,
          name: files[k].name
        });
      } catch (e) {
        failed++;
      }
    }
    save();
    renderAll();
    if (failed) toast(failed + '장은 읽지 못했습니다. (HEIC 형식은 아이폰 사파리에서만 열립니다)', 'err');
    else toast(files.length + '장 추가했습니다. 금액과 세부내역을 채워 주세요.');
  }

  function bindListEvents() {
    listEl.addEventListener('input', function (e) {
      var field = e.target.getAttribute('data-f');
      if (!field) return;
      var card = e.target.closest('.card');
      if (!card) return;
      var it = findItem(card.getAttribute('data-id'));
      if (!it) return;
      var v = e.target.value;
      if (field === 'date') it.date = v || it.date;
      else if (field === 'amount') {
        var digits = v.replace(/[^0-9]/g, '');
        it.amount = Number(digits) || 0;
        if (digits !== v) e.target.value = digits;
      } else if (field === 'persons') {
        it.persons = Number(v.replace(/[^0-9]/g, '')) || 1;
      } else if (field === 'fx') {
        it.fx = Number(v.replace(/[^0-9.]/g, '')) || 1;
      } else if (field === 'detail') it.detail = v;
      else if (field === 'desc') it.desc = v;
      else if (field === 'code') it.code = v.replace(/[^0-9A-Za-z]/g, '');
      save();
      updateTotals();
    });

    listEl.addEventListener('focusin', function (e) {
      if (e.target.getAttribute('data-f') === 'amount') {
        var it = findItem(e.target.closest('.card').getAttribute('data-id'));
        if (it) { e.target.value = it.amount ? String(it.amount) : ''; }
      }
    });

    listEl.addEventListener('focusout', function (e) {
      if (e.target.getAttribute('data-f') === 'amount') {
        var it = findItem(e.target.closest('.card').getAttribute('data-id'));
        if (it) e.target.value = it.amount ? won(it.amount) : '';
      }
      if (e.target.getAttribute('data-f') === 'persons') {
        var it2 = findItem(e.target.closest('.card').getAttribute('data-id'));
        if (it2) e.target.value = it2.persons || 1;
      }
    });

    listEl.addEventListener('change', function (e) {
      var field = e.target.getAttribute('data-f');
      if (field !== 'acct') return;
      var card = e.target.closest('.card');
      var it = findItem(card.getAttribute('data-id'));
      if (!it) return;
      var v = e.target.value;
      if (v === '__custom') {
        var more = card.querySelector('.more');
        more.hidden = false;
        var codeInput = card.querySelector('[data-f="code"]');
        if (codeInput) codeInput.focus();
        return;
      }
      if (v === '') return;
      it.code = v;
      var preset = PRESETS.filter(function (p) { return p.code === v; })[0];
      if (preset) {
        it.desc = preset.name;
        var descInput = card.querySelector('[data-f="desc"]');
        if (descInput) descInput.value = preset.name;
        if (!it.detail) {
          it.detail = preset.hint;
          var detailInput = card.querySelector('[data-f="detail"]');
          if (detailInput) detailInput.value = preset.hint;
        }
      }
      save();
    });

    listEl.addEventListener('click', async function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var card = btn.closest('.card');
      var id = card && card.getAttribute('data-id');
      var it = id ? findItem(id) : null;
      var act = btn.getAttribute('data-act');
      var items = currentMonth().items;

      if (act === 'type' && it) {
        it.type = btn.getAttribute('data-v');
        state.lastType = it.type;
        card.querySelectorAll('.seg button').forEach(function (b) {
          b.classList.toggle('on', b.getAttribute('data-v') === it.type);
        });
        save();
        updateTotals();
        return;
      }
      if (act === 'more' && card) {
        var more = card.querySelector('.more');
        more.hidden = !more.hidden;
        return;
      }
      if (act === 'up' && it) {
        var i = itemIndex(id);
        if (i > 0) {
          items.splice(i - 1, 0, items.splice(i, 1)[0]);
          save(); renderAll();
        }
        return;
      }
      if (act === 'down' && it) {
        var j = itemIndex(id);
        if (j >= 0 && j < items.length - 1) {
          items.splice(j + 1, 0, items.splice(j, 1)[0]);
          save(); renderAll();
        }
        return;
      }
      if (act === 'del' && it) {
        if (!window.confirm('이 영수증을 목록에서 지울까요?')) return;
        items.splice(itemIndex(id), 1);
        await dbDel(id);
        save(); renderAll();
        return;
      }
      if (act === 'view' && it) {
        var rec = await dbGet(id);
        if (rec && rec.blob) openViewer(URL.createObjectURL(rec.blob));
        else if (it.thumb) openViewer(it.thumb);
        return;
      }
    });
  }

  function openViewer(url) {
    var wrap = document.createElement('div');
    wrap.className = 'viewer';
    var img = document.createElement('img');
    img.src = url;
    img.alt = '영수증';
    wrap.appendChild(img);
    wrap.addEventListener('click', function () {
      wrap.remove();
      if (url.indexOf('blob:') === 0) setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });
    document.body.appendChild(wrap);
  }

  /* ------------------------------------------------------------------ */
  /* 월 선택                                                             */
  /* ------------------------------------------------------------------ */

  var monthSheet = $('#monthSheet');
  var msYear = Number(monthKeyNow().slice(0, 4));

  function openMonthSheet() {
    msYear = Number(state.active.slice(0, 4));
    renderMonthSheet();
    monthSheet.hidden = false;
    backdropEl.hidden = false;
  }
  function closeMonthSheet() {
    monthSheet.hidden = true;
    backdropEl.hidden = true;
  }

  function renderMonthSheet() {
    $('#msYear').textContent = msYear;
    var grid = '';
    for (var m = 1; m <= 12; m++) {
      var key = msYear + '-' + pad2(m);
      var bucket = state.months[key];
      var has = bucket && bucket.items && bucket.items.length;
      grid += '<button type="button" class="ms-btn' + (key === state.active ? ' on' : '') +
        '" data-month="' + key + '">' + m + '월' + (has ? '<span class="dot"></span>' : '') + '</button>';
    }
    $('#msGrid').innerHTML = grid;
  }

  function chooseMonth(key) {
    if (!key) return;
    if (!state.months[key]) state.months[key] = { items: [] };
    state.active = key;
    save();
    closeMonthSheet();
    renderAll();
  }

  function bindMonthEvents() {
    monthbarEl.addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      if (btn.getAttribute('data-act') === 'newMonth') { openMonthSheet(); return; }
      var m = btn.getAttribute('data-month');
      if (m) { state.active = m; save(); renderAll(); }
    });

    monthSheet.addEventListener('click', function (e) {
      var step = e.target.closest('[data-ystep]');
      if (step) {
        msYear += Number(step.getAttribute('data-ystep'));
        renderMonthSheet();
        return;
      }
      var pick = e.target.closest('.ms-btn');
      if (pick) { chooseMonth(pick.getAttribute('data-month')); return; }
    });
    $('#btnCloseMonth').addEventListener('click', closeMonthSheet);
  }

  /* ------------------------------------------------------------------ */
  /* 내보내기                                                            */
  /* ------------------------------------------------------------------ */

  var baseCache = { xlsx: null, pptx: null };
  var lastExport = null;

  async function fetchAsset(path, key) {
    if (baseCache[key]) return baseCache[key];
    var res = await fetch(path, { cache: 'force-cache' });
    if (!res.ok) throw new Error(path + ' 를 불러오지 못했습니다.');
    var buf = await res.arrayBuffer();
    baseCache[key] = buf;
    return buf;
  }

  function base64ToBuf(b64) {
    var bin = atob(b64);
    var len = bin.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  function bufToBase64(buf) {
    var bytes = new Uint8Array(buf);
    var chunk = 0x8000, out = '';
    for (var i = 0; i < bytes.length; i += chunk) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(out);
  }

  function exportName(ext) {
    var m = Number(String(state.active).slice(5, 7));
    var name = String(state.settings.employee || '').replace(/[\\/:*?"<>|\s]+/g, '');
    var base = ext === 'xlsx' ? m + '월_Expense_Claim' : m + '월_영수증_파일';
    return base + (name ? '_' + name : '') + '.' + ext;
  }

  function downloadBlob(blob, name) {
    lastExport = { blob: blob, name: name };
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);

    var canShare = false;
    try {
      var file = new File([blob], name, { type: blob.type });
      canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
    } catch (e) { canShare = false; }

    if (canShare) {
      toast(name + ' 준비됨. 저장이 안 되면 공유로 저장하세요.', null, {
        label: '공유',
        onClick: function () {
          try {
            var f = new File([lastExport.blob], lastExport.name, { type: lastExport.blob.type });
            navigator.share({ files: [f], title: lastExport.name }).catch(function () {});
          } catch (e) { toast('공유할 수 없습니다.', 'err'); }
        }
      });
    } else {
      toast(name + ' 저장을 시작했습니다.');
    }
  }

  function busy(btn, on, label) {
    if (on) {
      btn.dataset.label = btn.textContent;
      btn.classList.add('busy');
      btn.disabled = true;
      btn.textContent = label || '만드는 중…';
    } else {
      btn.classList.remove('busy');
      btn.disabled = false;
      if (btn.dataset.label) btn.textContent = btn.dataset.label;
    }
  }

  async function exportExcel(btn) {
    var items = currentMonth().items;
    if (!items.length) { toast('영수증을 먼저 추가해 주세요.', 'err'); return; }
    busy(btn, true);
    try {
      var buf;
      if (state.settings.template && state.settings.template.data) {
        buf = base64ToBuf(state.settings.template.data);
      } else {
        buf = await fetchAsset('assets/base.xlsx', 'xlsx');
      }
      var rows = items.map(function (it) {
        return {
          date: it.date,
          amount: it.amount,
          detail: it.detail,
          desc: it.desc,
          code: it.code,
          persons: it.persons,
          type: it.type,
          fx: it.fx
        };
      });
      var blob = await XLSXKit.build({
        baseArrayBuffer: buf,
        items: rows,
        settings: state.settings,
        monthKey: state.active
      });
      downloadBlob(blob, exportName('xlsx'));
    } catch (e) {
      console.error(e);
      toast('엑셀을 만들지 못했습니다: ' + (e && e.message ? e.message : '알 수 없는 오류'), 'err');
    } finally {
      busy(btn, false);
    }
  }

  async function exportPpt(btn) {
    var items = currentMonth().items;
    if (!items.length) { toast('영수증을 먼저 추가해 주세요.', 'err'); return; }
    busy(btn, true, '사진 준비 중…');
    try {
      var images = [];
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var rec = await dbGet(it.id);
        if (!rec || !rec.blob) continue;
        var bytes = new Uint8Array(await rec.blob.arrayBuffer());
        images.push({ bytes: bytes, w: it.w || rec.w || 1, h: it.h || rec.h || 1 });
      }
      if (!images.length) throw new Error('영수증 사진을 불러오지 못했습니다.');
      busy(btn, true, 'PPT 만드는 중…');
      var base = await fetchAsset('assets/base.pptx', 'pptx');
      var blob = await PPTXKit.build(base, images);
      downloadBlob(blob, exportName('pptx'));
    } catch (e) {
      console.error(e);
      toast('PPT를 만들지 못했습니다: ' + (e && e.message ? e.message : '알 수 없는 오류'), 'err');
    } finally {
      busy(btn, false);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 설정 시트                                                           */
  /* ------------------------------------------------------------------ */

  var sheetEl = $('#sheet');
  var backdropEl = $('#sheetBackdrop');

  function openSheet() {
    sheetEl.hidden = false;
    backdropEl.hidden = false;
    renderSettingsValues();
    updateTplStatus();
  }
  function closeSheet() {
    sheetEl.hidden = true;
    backdropEl.hidden = true;
    var ms = $('#monthSheet');
    if (ms) ms.hidden = true;
  }

  function renderSettingsValues() {
    var s = state.settings;
    var map = { setCompany: s.company, setEmployee: s.employee, setDepartment: s.department, setAccount: s.account, setBank: s.bank };
    Object.keys(map).forEach(function (id) {
      var el = document.getElementById(id);
      if (el && document.activeElement !== el) el.value = map[id] || '';
    });
    updateTplStatus();
  }

  function updateTplStatus() {
    var el = $('#tplStatus');
    var clearBtn = $('#btnTemplateClear');
    if (!el) return;
    if (state.settings.template && state.settings.template.data) {
      el.textContent = '✓ ' + state.settings.template.name + ' 사용 중' +
        (state.settings.template.target ? ' (' + state.settings.template.target + ' 시트)' : '');
      el.classList.add('ok');
      clearBtn.hidden = false;
    } else {
      el.textContent = '올린 양식 없음 · 기본 양식 사용';
      el.classList.remove('ok');
      clearBtn.hidden = true;
    }
  }

  function bindSettings() {
    $('#btnSettings').addEventListener('click', openSheet);
    $('#btnCloseSheet').addEventListener('click', closeSheet);
    backdropEl.addEventListener('click', closeSheet);

    var fields = {
      setCompany: 'company', setEmployee: 'employee', setDepartment: 'department',
      setAccount: 'account', setBank: 'bank'
    };
    Object.keys(fields).forEach(function (id) {
      var el = document.getElementById(id);
      el.addEventListener('input', function () {
        state.settings[fields[id]] = el.value;
        save();
      });
    });

    $('#btnTemplate').addEventListener('click', function () { $('#templateInput').click(); });
    $('#templateInput').addEventListener('change', async function (e) {
      var file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      if (!/\.xlsx$/i.test(file.name)) { toast('xlsx 파일만 올릴 수 있습니다.', 'err'); return; }
      try {
        var buf = await file.arrayBuffer();
        var info = await XLSXKit.inspect(buf);
        if (!info.sheets.length) throw new Error('시트가 없습니다.');
        state.settings.template = {
          name: file.name,
          data: bufToBase64(buf),
          sheets: info.sheets,
          target: info.target
        };
        save();
        updateTplStatus();
        if (info.exact) {
          toast('양식을 저장했습니다. 이제 이 양식(Expense Claim 시트)으로 만듭니다.');
        } else {
          toast('저장했습니다. 다만 ‘Expense Claim’ 시트가 없어 ‘' + info.target + '’ 시트를 채웁니다.', 'err');
        }
      } catch (err) {
        console.error(err);
        toast('엑셀 양식으로 읽지 못했습니다. .xlsx 파일인지 확인해 주세요.', 'err');
      }
    });
    $('#btnTemplateClear').addEventListener('click', function () {
      state.settings.template = null;
      save();
      updateTplStatus();
      toast('양식을 지웠습니다. 기본 양식으로 만듭니다.');
    });

    $('#btnReset').addEventListener('click', async function () {
      var items = currentMonth().items;
      if (!items.length) { toast('지울 항목이 없습니다.'); return; }
      if (!window.confirm(monthLong(state.active) + ' 항목 ' + items.length + '건과 사진을 지울까요?')) return;
      for (var i = 0; i < items.length; i++) await dbDel(items[i].id);
      state.months[state.active] = { items: [] };
      save(); renderAll();
      closeSheet();
      toast('이 달 항목을 지웠습니다.');
    });
  }

  /* ------------------------------------------------------------------ */
  /* 시작                                                                */
  /* ------------------------------------------------------------------ */

  function bindMain() {
    $('#btnAdd').addEventListener('click', function () { $('#fileInput').click(); });
    $('#fileInput').addEventListener('change', function (e) {
      var files = e.target.files;
      if (files && files.length) addFiles(files);
      e.target.value = '';
    });
    $('#btnExcel').addEventListener('click', function () { exportExcel(this); });
    $('#btnPpt').addEventListener('click', function () { exportPpt(this); });
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }

  function init() {
    bindMain();
    bindListEvents();
    bindMonthEvents();
    bindSettings();
    renderAll();
    registerSW();
    if (!state.months[state.active]) { state.months[state.active] = { items: [] }; save(); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
