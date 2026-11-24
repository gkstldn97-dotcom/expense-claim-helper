/* ocr.js — 영수증 사진에서 결제 금액(총액)과 날짜를 읽어 냅니다.
 *
 * · 브라우저 안에서만 동작합니다(Tesseract.js, 한국어+영어). 서버·API 키 없음.
 * · 인식 라이브러리와 언어 데이터는 vendor/tesseract/ 에 함께 배포합니다.
 * · OCR 로딩·인식이 실패해도 앱의 나머지 기능은 그대로 씁니다(수동 입력·엑셀·PPT).
 */
(function (global) {
  'use strict';

  var VENDOR = 'vendor/tesseract/';

  /* ================================================================== */
  /* 1. 텍스트 다듬기                                                     */
  /* ================================================================== */

  function toHalf(s) {
    return String(s == null ? '' : s)
      .replace(/[\uFF01-\uFF5E]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/\u00A0/g, ' ')
      .replace(/[\u2018\u2019\u02BC]/g, "'")
      .replace(/[\u201C\u201D]/g, '"');
  }

  /* 숫자 사이에 끼어든 공백·점·가운뎃점을 쉼표로 정리: "24, 500" / "24.500" → "24,500" */
  function tidyAmounts(s) {
    var prev;
    var out = s;
    do {
      prev = out;
      out = out.replace(/(\d)\s*[,.\u00B7\u3132]\s*(\d{3})(?!\d)/g, '$1,$2');
    } while (out !== prev);
    return out;
  }

  /* 금액 후보를 찾기 전에 날짜·전화·사업자번호·카드번호 덩어리를 지운다. */
  var STRUCTURED = [
    /\d{4}\s*[-./년]\s*\d{1,2}\s*[-./월]\s*\d{1,2}\s*일?/g,        /* 2026-11-24, 2026.11.24, 2026년 11월 24일 */
    /\d{1,2}\s*[-./월]\s*\d{1,2}\s*일?/g,                          /* 11/24, 11월 24일 */
    /\d{1,2}\s*:\s*\d{2}(\s*:\s*\d{2})?/g,                         /* 19:32:05 */
    /\d{2,4}\s*-\s*\d{2,4}\s*-\s*\d{2,4}\s*-\s*\d{2,4}/g,          /* 5310-12**-****-3456 */
    /\d{2,4}\s*-\s*\d{2,4}\s*-\s*\d{2,4}/g,                        /* 123-45-67890, 010-2345-6789 */
    /\d{4}\s*-\s*\d{2}\s*-\s*\d{2,4}/g,
    /\d{2,4}\s*-\s*\d{4,8}/g
  ];

  function stripStructured(line) {
    var s = line;
    for (var i = 0; i < STRUCTURED.length; i++) s = s.replace(STRUCTURED[i], ' ');
    return s;
  }

  /* 한 줄에서 금액 후보 추출 */
  function amountsIn(line) {
    var out = [];
    var re = /(\d{1,3}(?:,\d{3})+|\d{3,8})(\s*원)?/g;
    var m;
    while ((m = re.exec(line)) !== null) {
      var digits = m[1].replace(/[^0-9]/g, '');
      if (!digits || digits.length > 8) continue;
      var v = parseInt(digits, 10);
      if (!isFinite(v)) continue;
      out.push({
        value: v,
        comma: m[1].indexOf(',') >= 0,
        won: !!m[2],
        index: m.index,
        end: m.index + m[0].length
      });
    }
    return out;
  }

  function compact(s) {
    return String(s).replace(/[^0-9A-Za-z가-힣]/g, '').toLowerCase();
  }

  /* ================================================================== */
  /* 2. 키워드 (합계류 / 제외류)                                          */
  /* ================================================================== */

  var TOTAL_KEYS = [
    ['총결제금액', 100], ['결제금액합계', 100], ['합계금액', 99], ['총합계', 100],
    ['결제금액', 100], ['결재금액', 97], ['합계', 96], ['총액', 95], ['합계액', 95],
    ['판매합계', 92], ['판매금액', 88], ['매출합계', 92], ['매출액', 86],
    ['승인금액', 90], ['청구금액', 92], ['지불금액', 94], ['결제액', 94],
    ['받을금액', 86], ['총매출', 90], ['요금합계', 92], ['합계금', 92],
    ['grandtotal', 98], ['total', 90], ['amountdue', 90], ['amount', 60], ['totaldue', 96],
    ['정산금액', 90], ['결제요금', 88], ['합금액', 90], ['합계금애', 90], ['합게', 88],
    ['이용금액', 88], ['매출금액', 88], ['청구액', 88], ['금액', 62], ['계', 35]
  ];

  var VETO_KEYS = [
    '부가세', '부가가치세', '세액', 'vat', 'tax', '공급가액', '공급대가', '과세', '면세',
    '봉사료', '승인번호', '승인no', '카드번호', '사업자', '등록번호', '법인번호',
    '전화', 'tel', '팩스', 'fax', '휴대', '할부', '포인트', '적립', '잔액', '거스름',
    '현금', '상품권', '쿠폰', '할인', '에누리', '반품', '환불',
    '주문번호', '영수증번호', '거래번호', '일시', '시간', '회원', '마일리지',
    '단가', '수량', '개월', '누적', '잔여', '예정', '잔액', '포인트', '적립금', '할부개월'
  ];

  /* 부분 일치(정확) 먼저, 없으면 한 글자 오차까지 허용한다: "압계"→"합계" 같은 인식 오류 */
  function matchKeyword(compactLine, kw) {
    if (!compactLine) return 0;
    if (compactLine.indexOf(kw) >= 0) return 1;
    if (kw.length < 2) return 0;
    var isHangul = /[가-힣]/.test(kw);
    if (!isHangul) return 0;                     /* 영문 키워드는 정확히 일치할 때만 */
    for (var i = 0; i + kw.length <= compactLine.length; i++) {
      var diff = 0;
      for (var j = 0; j < kw.length; j++) {
        if (compactLine.charAt(i + j) !== kw.charAt(j)) diff++;
        if (diff > 1) break;
      }
      if (diff <= 1) return 0.82;
    }
    return 0;
  }

  function bestTotalKey(line) {
    var c = compact(line);
    var best = null;
    for (var i = 0; i < TOTAL_KEYS.length; i++) {
      var q = matchKeyword(c, TOTAL_KEYS[i][0]);
      if (!q) continue;
      var w = TOTAL_KEYS[i][1] * q;
      if (!best || w > best.weight) best = { keyword: TOTAL_KEYS[i][0], quality: q, weight: w };
    }
    return best;
  }

  function isVetoed(line) {
    var c = compact(line);
    for (var i = 0; i < VETO_KEYS.length; i++) {
      if (c.indexOf(compact(VETO_KEYS[i])) >= 0) return true;
    }
    return false;
  }

  /* ================================================================== */
  /* 3. 금액 파싱                                                        */
  /* ================================================================== */

  function amountOnLine(amounts) {
    if (!amounts.length) return null;
    var usable = amounts.filter(function (a) { return a.value >= 100 && a.value <= 20000000; });
    if (!usable.length) return null;
    var comma = usable.filter(function (a) { return a.comma; });
    var pool = comma.length ? comma : usable;
    var best = pool[0];
    for (var i = 1; i < pool.length; i++) if (pool[i].value > best.value) best = pool[i];
    return best;
  }

  /* 키워드만 있는 줄(예: "합 계")의 바로 아래 줄에서 금액을 찾는다 */
  function lookAhead(lines, from) {
    for (var k = 1; k <= 2; k++) {
      var nxt = lines[from + k];
      if (!nxt) return null;
      if (bestTotalKey(nxt)) return null;
      var body = tidyAmounts(nxt).replace(/[\d,.\s원]/g, '');
      if (body.length > 3) return null;          /* 숫자만 있는 줄일 때만 */
      var amounts = amountsIn(stripStructured(nxt));
      var picked = amountOnLine(amounts);
      if (picked) return { picked: picked, line: from + k };
    }
    return null;
  }

  function parseAmount(text) {
    var lines = text.split('\n');
    var strong = [];   /* 합계 키워드가 있는 줄 */
    var weak = [];     /* 키워드 없는 후보 (마지막 수단) */

    for (var i = 0; i < lines.length; i++) {
      var line = tidyAmounts(lines[i]);
      if (!line) continue;
      var amounts = amountsIn(stripStructured(line));
      var key = bestTotalKey(line);
      var vetoed = isVetoed(line);

      if (key && (!vetoed || key.weight >= 90)) {
        /* 키워드 줄에 금액이 없으면 바로 아래 줄에서 찾는다 */
        var picked = amountOnLine(amounts);
        var at = i;
        if (!picked) {
          var near = lookAhead(lines, i);
          if (near) { picked = near.picked; at = near.line; }
        }
        if (picked) {
          strong.push({
            value: picked.value,
            weight: key.weight,
            keyword: key.keyword,
            line: at,
            score: key.weight +
              (picked.comma ? 4 : 0) + (picked.won ? 6 : 0) + at * 0.01
          });
        }
        continue;
      }

      if (!amounts.length || vetoed) continue;
      var cand = amountOnLine(amounts);
      if (cand && cand.value >= 500) {
        weak.push({ value: cand.value, line: i, score: (cand.comma ? 4 : 0) + i * 0.01 });
      }
    }

    /* 같은 금액이 여러 번 나오면(합계·결제금액·총액) 가장 강한 줄을 믿는다 */
    if (strong.length) {
      strong.sort(function (a, b) { return b.score - a.score; });
      var top = strong[0];
      var agree = strong.filter(function (c) { return c.value === top.value; }).length;
      return {
        amount: top.value,
        keyword: top.keyword,
        confidence: top.weight >= 78 ? 'high' : (top.weight >= 60 ? 'medium' : 'low'),
        agree: agree,
        line: top.line
      };
    }

    if (weak.length) {
      var best = weak[0];
      for (var k = 1; k < weak.length; k++) {
        if (weak[k].value > best.value) best = weak[k];
      }
      return { amount: best.value, keyword: null, confidence: 'low', agree: 0, line: best.line };
    }
    return { amount: null, keyword: null, confidence: null, agree: 0, line: -1 };
  }

  /* ================================================================== */
  /* 4. 날짜 파싱                                                        */
  /* ================================================================== */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function validDate(y, m, d) {
    if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return false;
    var dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }

  function parseDateFrom(line) {
    var s = tidyAmounts(line);
    var m;

    m = s.match(/(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?/);
    if (m) {
      var y = +m[1], mo = +m[2], d = +m[3];
      if (validDate(y, mo, d)) return { y: y, m: mo, d: d, exact: true };
    }
    m = s.match(/(\d{2})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})/);
    if (m) {
      var y2 = +m[1], mo2 = +m[2], d2 = +m[3];
      if (y2 >= 15 && y2 <= 49) y2 += 2000;
      else if (y2 >= 90) y2 += 1900;
      else y2 = -1;
      if (y2 > 0 && validDate(y2, mo2, d2)) return { y: y2, m: mo2, d: d2, exact: false };
    }
    return null;
  }

  var DATE_HINT = ['거래일시', '거래일자', '거래일', '일시', '날짜', '일자', 'date', '승인일'];

  function parseDate(text) {
    var lines = text.split('\n');
    var hinted = null, plain = null;
    for (var i = 0; i < lines.length; i++) {
      var got = parseDateFrom(lines[i]);
      if (!got) continue;
      var c = compact(lines[i]);
      var isHinted = DATE_HINT.some(function (h) { return c.indexOf(compact(h)) >= 0; });
      var iso = got.y + '-' + pad2(got.m) + '-' + pad2(got.d);
      if (isHinted && !hinted) hinted = { iso: iso, exact: got.exact, line: i };
      else if (!plain) plain = { iso: iso, exact: got.exact, line: i };
    }
    var pick = hinted || plain;
    if (!pick) return null;

    /* 영수증은 미래 날짜일 수 없고, 너무 옛날 영수증은 정산 대상이 아니다 */
    var when = new Date(pick.iso + 'T00:00:00');
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var diffDays = Math.round((when - today) / 86400000);
    if (diffDays > 1 || diffDays < -400) return null;

    return {
      date: pick.iso,
      confidence: (pick.exact && (hinted || diffDays <= 0)) ? 'high' : 'medium'
    };
  }

  /* ================================================================== */
  /* 5. 공개 파서                                                        */
  /* ================================================================== */

  function parseReceipt(rawText) {
    var text = toHalf(rawText).replace(/\r/g, '').replace(/[ \t]+/g, ' ');
    var amount = parseAmount(text);
    var date = parseDate(text);
    return {
      amount: amount.amount,
      amountKeyword: amount.keyword,
      amountConfidence: amount.confidence,
      date: date ? date.date : null,
      dateConfidence: date ? date.confidence : null
    };
  }

  /* ================================================================== */
  /* 6. 이미지 준비 (EXIF 회전은 브라우저가 그려 줄 때 이미 반영됨)         */
  /* ================================================================== */

  var OCR_WIDTH = 1600;

  function prepCanvas(img, mode) {
    var w0 = img.naturalWidth || img.width;
    var h0 = img.naturalHeight || img.height;
    var scale = Math.min(3, OCR_WIDTH / Math.max(1, w0));
    if (scale < 1) scale = 1;
    var w = Math.max(1, Math.round(w0 * scale));
    var h = Math.max(1, Math.round(h0 * scale));
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    if (mode === 'raw') return canvas;

    var id = ctx.getImageData(0, 0, w, h);
    var data = id.data;
    var n = w * h;
    var gray = new Uint8Array(n);
    var lo = 255, hi = 0, i, p, v;
    for (i = 0, p = 0; i < data.length; i += 4, p++) {
      v = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
      gray[p] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    var span = Math.max(1, hi - lo);

    if (mode === 'gray') {
      for (i = 0, p = 0; i < data.length; i += 4, p++) {
        v = ((gray[p] - lo) * 255 / span) | 0;
        data[i] = data[i + 1] = data[i + 2] = v;
        data[i + 3] = 255;
      }
    } else { /* 'bin' — Otsu 이진화 */
      var hist = new Uint32Array(256);
      for (p = 0; p < n; p++) hist[gray[p]]++;
      var sum = 0;
      for (var t = 0; t < 256; t++) sum += t * hist[t];
      var sumB = 0, wB = 0, best = -1, thr = 128;
      for (var t2 = 0; t2 < 256; t2++) {
        wB += hist[t2];
        if (!wB) continue;
        var wF = n - wB;
        if (!wF) break;
        sumB += t2 * hist[t2];
        var mB = sumB / wB, mF = (sum - sumB) / wF;
        var between = wB * wF * (mB - mF) * (mB - mF);
        if (between > best) { best = between; thr = t2; }
      }
      for (i = 0, p = 0; i < data.length; i += 4, p++) {
        v = gray[p] < thr ? 0 : 255;
        data[i] = data[i + 1] = data[i + 2] = v;
        data[i + 3] = 255;
      }
    }
    ctx.putImageData(id, 0, 0);
    return canvas;
  }

  /* ================================================================== */
  /* 7. Tesseract 워커 (처음 쓸 때만 불러오고, 잠시 안 쓰면 정리)           */
  /* ================================================================== */

  var scriptPromise = null;
  var workerPromise = null;
  var idleTimer = null;
  var queueTail = Promise.resolve();

  function loadScript() {
    if (global.Tesseract && global.Tesseract.createWorker) return Promise.resolve();
    if (scriptPromise) return scriptPromise;
    scriptPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = VENDOR + 'tesseract.min.js';
      s.async = true;
      s.onload = function () {
        if (global.Tesseract && global.Tesseract.createWorker) resolve();
        else reject(new Error('OCR 라이브러리를 읽지 못했습니다.'));
      };
      s.onerror = function () { reject(new Error('OCR 라이브러리를 불러오지 못했습니다.')); };
      document.head.appendChild(s);
    });
    return scriptPromise;
  }

  function createWorkerOnce(onStatus) {
    return loadScript().then(function () {
      return global.Tesseract.createWorker('kor+eng', 1, {
        workerPath: VENDOR + 'worker.min.js',
        corePath: VENDOR + 'core',
        langPath: VENDOR + 'lang',
        cacheMethod: 'none',
        logger: function (m) {
          if (onStatus && m && typeof m.progress === 'number') onStatus(m.status, m.progress);
        }
      });
    }).then(function (worker) {
      return worker.setParameters({
        tessedit_pageseg_mode: '6',
        preserve_interword_spaces: '1'
      }).then(function () { return worker; });
    });
  }

  function getWorker(onStatus) {
    if (workerPromise) return workerPromise;
    workerPromise = createWorkerOnce(onStatus).catch(function (err) {
      workerPromise = null;
      throw err;
    });
    return workerPromise;
  }

  function closeWorker() {
    var w = workerPromise;
    workerPromise = null;
    if (!w) return Promise.resolve();
    return w.then(function (worker) {
      try { return worker.terminate(); } catch (e) { return null; }
    }).catch(function () { return null; });
  }

  function touchIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { closeWorker(); }, 90000);
  }

  function withTimeout(promise, ms, what) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error(what || '시간이 너무 오래 걸립니다.'));
      }, ms);
      promise.then(function (v) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      }, function (e) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        setTimeout(function () { URL.revokeObjectURL(url); }, 8000);
        resolve(img);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('이미지를 읽지 못했습니다.'));
      };
      img.src = url;
    });
  }

  function recognizeText(worker, canvas) {
    return worker.recognize(canvas).then(function (res) {
      return (res && res.data && res.data.text) || '';
    });
  }

  /* 한 장 인식: 흑백 → (금액을 못 찾으면) 이진화 순서로 한 번 더 */
  function recognizeFile(file, onStage) {
    var run = function () {
      return getWorker(onStage).then(function (worker) {
        return withTimeout(loadImage(file), 20000, '이미지를 읽지 못했습니다.').then(function (img) {
          var first = prepCanvas(img, 'gray');
          if (onStage) onStage('recognizing text', 0);
          return withTimeout(recognizeText(worker, first), 75000, 'ocr-timeout').then(function (text) {
            var parsed = parseReceipt(text);
            if (parsed.amount || text.replace(/\s/g, '').length < 40) {
              return { text: text, parsed: parsed, passes: 1 };
            }
            var second = prepCanvas(img, 'bin');
            return withTimeout(recognizeText(worker, second), 75000, 'ocr-timeout').then(function (text2) {
              var parsed2 = parseReceipt(text2);
              if (parsed2.amount || (!parsed.date && !parsed2.date)) {
                return { text: text2, parsed: parsed2, passes: 2 };
              }
              return {
                text: text + '\n' + text2,
                parsed: {
                  amount: parsed2.amount || parsed.amount,
                  amountKeyword: parsed2.amountKeyword || parsed.amountKeyword,
                  amountConfidence: parsed2.amountConfidence || parsed.amountConfidence,
                  date: parsed.date || parsed2.date,
                  dateConfidence: parsed.dateConfidence || parsed2.dateConfidence
                },
                passes: 2
              };
            });
          });
        });
      });
    };

    /* 워커는 한 번에 한 장만 쓴다 (아이폰 메모리 보호) */
    var task = queueTail.then(run, run);
    queueTail = task.then(function () { return null; }, function () { return null; });
    return task.then(function (out) {
      touchIdle();
      return out;
    }, function (err) {
      if (err && err.message === 'ocr-timeout') {
        closeWorker();   /* 멈춘 워커는 버리고 다음에 새로 만든다 */
        throw new Error('시간이 너무 오래 걸립니다.');
      }
      throw err;
    });
  }

  global.OCRKit = {
    parseReceipt: parseReceipt,
    recognize: recognizeFile,
    close: closeWorker,
    isBusy: function () { return !!workerPromise; }
  };
})(typeof window !== 'undefined' ? window : this);
