/* xlsx.js — .xlsx 채우기 (외부 라이브러리 없이 JSZip 위에서 OOXML을 직접 수정)
 *
 * 두 가지 모드가 같은 코드를 씁니다.
 *  - 기본 모드:  assets/base.xlsx (앱에 내장된 중립 양식) 을 채움
 *  - 내 양식 모드: 사용자가 올린 회사 양식을 채움 (원본 시트·수식 그대로 유지)
 */
(function (global) {
  'use strict';

  var DATE_BUILTIN = {
    14: 1, 15: 1, 16: 1, 17: 1, 18: 1, 19: 1, 20: 1, 21: 1, 22: 1,
    27: 1, 28: 1, 29: 1, 30: 1, 31: 1, 32: 1, 33: 1, 34: 1, 35: 1, 36: 1,
    45: 1, 46: 1, 47: 1, 50: 1, 51: 1, 52: 1, 53: 1, 54: 1, 55: 1, 56: 1, 57: 1, 58: 1
  };

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function unesc(s) {
    return String(s)
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** 'YYYY-MM-DD' -> 엑셀 일련번호 */
  function dateSerial(str) {
    var p = String(str).split('-').map(Number);
    if (p.length !== 3 || !p[0] || !p[1] || !p[2]) return null;
    return Math.round((Date.UTC(p[0], p[1] - 1, p[2]) - Date.UTC(1899, 11, 30)) / 86400000);
  }

  function monthEndDate(key) {
    var p = String(key).split('-').map(Number);
    var last = new Date(Date.UTC(p[0], p[1], 0)).getUTCDate();
    return p[0] + '-' + pad2(p[1]) + '-' + pad2(last);
  }

  function dotDate(str) {
    var p = String(str).split('-');
    return p.length === 3 ? p[0] + '.' + p[1] + '.' + p[2] : String(str);
  }

  function colIndex(letters) {
    var n = 0;
    for (var i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n;
  }

  function splitRef(ref) {
    var m = /^([A-Z]+)(\d+)$/.exec(ref);
    return { col: colIndex(m[1]), row: Number(m[2]), colLetters: m[1] };
  }

  /* ---------- styles: 어떤 셀이 날짜 서식인지 ---------- */

  function buildStyleInfo(stylesXml) {
    var custom = {};
    var re = /<numFmt\b[^>]*>/g, m;
    while ((m = re.exec(stylesXml || ''))) {
      var id = /numFmtId="(\d+)"/.exec(m[0]);
      var code = /formatCode="([^"]*)"/.exec(m[0]);
      if (id && code) custom[Number(id[1])] = unesc(code[1]);
    }
    var isDate = [];
    var block = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml || '');
    if (block) {
      var tags = block[1].match(/<xf\b[^>]*>/g) || [];
      for (var i = 0; i < tags.length; i++) {
        var idm = /numFmtId="(\d+)"/.exec(tags[i]);
        var nf = idm ? Number(idm[1]) : 0;
        var flag = false;
        if (custom[nf] != null) {
          var c = custom[nf].replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, '').replace(/\\./g, '');
          flag = /[ymd]/i.test(c) && !/^[#0.,%\s\-]+$/.test(c);
        } else if (DATE_BUILTIN[nf]) {
          flag = true;
        }
        isDate.push(flag);
      }
    }
    return isDate;
  }

  /* ---------- sheet xml 조작 ---------- */

  function findCellStart(xml, ref) {
    var re = new RegExp('<c r="' + ref + '"(?=[\\s/>])');
    var m = re.exec(xml);
    return m ? m.index : -1;
  }

  function cellInfo(xml, ref) {
    var start = findCellStart(xml, ref);
    if (start < 0) return null;
    var tagEnd = xml.indexOf('>', start);
    var tag = xml.slice(start, tagEnd + 1);
    var selfClose = xml.charAt(tagEnd - 1) === '/';
    var end = selfClose ? tagEnd + 1 : xml.indexOf('</c>', tagEnd) + 4;
    var body = selfClose ? '' : xml.slice(tagEnd + 1, end - 4);
    var sm = / s="(\d+)"/.exec(tag);
    return {
      start: start,
      end: end,
      style: sm ? sm[1] : null,
      hasFormula: /<f[\s>]/.test(body),
      hasValue: /<v>|<is>/.test(body)
    };
  }

  function buildCell(ref, style, val) {
    var sa = style != null ? ' s="' + style + '"' : '';
    if (val === null || val === undefined || val === '') {
      return '<c r="' + ref + '"' + sa + '/>';
    }
    if (typeof val === 'number' && isFinite(val)) {
      return '<c r="' + ref + '"' + sa + '><v>' + val + '</v></c>';
    }
    if (typeof val === 'object' && val.f) {
      return '<c r="' + ref + '"' + sa + '><f>' + esc(val.f) + '</f></c>';
    }
    return '<c r="' + ref + '"' + sa + ' t="inlineStr"><is><t xml:space="preserve">' +
      esc(val) + '</t></is></c>';
  }

  function insertCell(xml, ref, val, styleHint) {
    var rr = splitRef(ref);
    var rowRe = new RegExp('<row r="' + rr.row + '"(?=[\\s/>])');
    var rm = rowRe.exec(xml);
    var xmlCell = buildCell(ref, styleHint, val);

    if (!rm) {
      var sheetDataEnd = xml.indexOf('</sheetData>');
      if (sheetDataEnd < 0) return xml;
      var at = sheetDataEnd;
      var rows = xml.match(/<row r="(\d+)"[^>]*>/g) || [];
      for (var i = 0; i < rows.length; i++) {
        var num = Number(/r="(\d+)"/.exec(rows[i])[1]);
        if (num > rr.row) { at = xml.indexOf(rows[i]); break; }
      }
      return xml.slice(0, at) + '<row r="' + rr.row + '">' + xmlCell + '</row>' + xml.slice(at);
    }

    var tagEnd = xml.indexOf('>', rm.index);
    if (xml.charAt(tagEnd - 1) === '/') {
      return xml.slice(0, rm.index) + '<row r="' + rr.row + '">' + xmlCell + '</row>' +
        xml.slice(tagEnd + 1);
    }
    var rowClose = xml.indexOf('</row>', tagEnd);
    if (rowClose < 0) return xml;
    var body = xml.slice(tagEnd + 1, rowClose);
    var insertAt = rowClose;
    var cre = /<c r="([A-Z]+)\d+"/g, cm;
    while ((cm = cre.exec(body))) {
      if (colIndex(cm[1]) > rr.col) { insertAt = tagEnd + 1 + cm.index; break; }
    }
    return xml.slice(0, insertAt) + xmlCell + xml.slice(insertAt);
  }

  function setCell(xml, ref, val, styleHint) {
    var info = cellInfo(xml, ref);
    if (!info) return insertCell(xml, ref, val, styleHint);
    return xml.slice(0, info.start) + buildCell(ref, info.style, val) + xml.slice(info.end);
  }

  /* ---------- package ---------- */

  function resolveTarget(target) {
    var t = String(target);
    if (t.charAt(0) === '/') return t.slice(1);
    if (t.indexOf('xl/') === 0) return t;
    return 'xl/' + t.replace(/^\.\//, '');
  }

  async function locateSheet(zip, wanted) {
    var wbFile = zip.file('xl/workbook.xml');
    var relsFile = zip.file('xl/_rels/workbook.xml.rels');
    if (!wbFile || !relsFile) throw new Error('엑셀 파일 구조를 읽을 수 없습니다.');
    var wbXml = await wbFile.async('string');
    var relsXml = await relsFile.async('string');
    var rels = {};
    var rre = /<Relationship\b[^>]*>/g, rm;
    while ((rm = rre.exec(relsXml))) {
      var id = /Id="([^"]+)"/.exec(rm[0]);
      var tg = /Target="([^"]+)"/.exec(rm[0]);
      if (id && tg) rels[id[1]] = resolveTarget(tg[1]);
    }
    var sheets = [];
    var sre = /<sheet\b[^>]*>/g, sm;
    while ((sm = sre.exec(wbXml))) {
      var name = /name="([^"]*)"/.exec(sm[0]);
      var rid = /r:id="([^"]+)"/.exec(sm[0]);
      if (name && rid) sheets.push({ name: unesc(name[1]), path: rels[rid[1]] });
    }
    if (!sheets.length) throw new Error('시트를 찾지 못했습니다.');
    var pick = null;
    for (var i = 0; i < sheets.length; i++) {
      if (sheet_equals(sheets[i].name, wanted)) { pick = sheets[i]; break; }
    }
    if (!pick) {
      for (var j = 0; j < sheets.length; j++) {
        if (/expense/i.test(sheets[j].name)) { pick = sheets[j]; break; }
      }
    }
    if (!pick) pick = sheets[0];
    if (!pick.path || !zip.file(pick.path)) throw new Error('정산 시트를 읽지 못했습니다.');
    return { path: pick.path, sheets: sheets, wbXml: wbXml };
  }

  function sheet_equals(a, b) {
    return String(a).replace(/\s+/g, ' ').trim().toLowerCase() ===
      String(b).replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /**
   * opts: { baseArrayBuffer, items, settings, monthKey, maxRows }
   * items: [{date, amount, detail, desc, code, persons, type, fx}]
   */
  async function build(opts) {
    var zip = await JSZip.loadAsync(opts.baseArrayBuffer);
    var found = await locateSheet(zip, 'Expense Claim');
    var sheetXml = await zip.file(found.path).async('string');
    var stylesFile = zip.file('xl/styles.xml');
    var stylesXml = stylesFile ? await stylesFile.async('string') : '';
    var dateStyles = buildStyleInfo(stylesXml);

    var settings = opts.settings || {};
    var items = opts.items || [];
    var maxRows = opts.maxRows || 50;
    var used = items.slice(0, maxRows);

    function isDateCell(ref) {
      var info = cellInfo(sheetXml, ref);
      if (!info || info.style == null) return false;
      return dateStyles[Number(info.style)] === true;
    }

    function writeDate(ref, iso) {
      if (!iso) { sheetXml = setCell(sheetXml, ref, null); return; }
      if (isDateCell(ref)) {
        var serial = dateSerial(iso);
        sheetXml = setCell(sheetXml, ref, serial == null ? dotDate(iso) : serial);
      } else {
        sheetXml = setCell(sheetXml, ref, dotDate(iso));
      }
    }

    /* --- 상단 정보: 비어 있는 칸만 채웁니다 (양식이 이미 가진 값·수식은 보존) --- */
    function infoOf(ref) { return cellInfo(sheetXml, ref); }
    function isEmpty(ref) {
      var i = infoOf(ref);
      return !i || (!i.hasFormula && !i.hasValue);
    }
    function isFormula(ref) {
      var i = infoOf(ref);
      return !!(i && i.hasFormula);
    }

    if (settings.company) sheetXml = setCell(sheetXml, 'B2', settings.company);
    if (settings.employee && isEmpty('D4')) sheetXml = setCell(sheetXml, 'D4', settings.employee);
    if (settings.department && !isFormula('D5')) sheetXml = setCell(sheetXml, 'D5', settings.department);
    if (settings.account) sheetXml = setCell(sheetXml, 'D6', settings.account);
    if (settings.bank) sheetXml = setCell(sheetXml, 'E6', settings.bank);
    writeDate('L4', monthEndDate(opts.monthKey));

    /* --- 10~59행 --- */
    for (var i = 0; i < used.length; i++) {
      var it = used[i];
      var r = 10 + i;
      writeDate('C' + r, it.date);
      sheetXml = setCell(sheetXml, 'D' + r, it.desc || '');
      sheetXml = setCell(sheetXml, 'E' + r, it.detail || '');
      sheetXml = setCell(sheetXml, 'F' + r, Number(it.persons) > 0 ? Number(it.persons) : 1);
      var codeTxt = it.code == null ? '' : String(it.code).trim();
      sheetXml = setCell(sheetXml, 'G' + r,
        /^\d+(\.\d+)?$/.test(codeTxt) ? Number(codeTxt) : (codeTxt || null));
      sheetXml = setCell(sheetXml, 'I' + r, it.type || 'CC');
      var amt = Number(it.amount);
      sheetXml = setCell(sheetXml, 'J' + r, isFinite(amt) && amt ? amt : null);
      var fx = Number(it.fx);
      sheetXml = setCell(sheetXml, 'K' + r, isFinite(fx) && fx ? fx : 1);

      if (!isFormula('H' + r)) {
        if (/^\d+(\.\d+)?$/.test(codeTxt)) {
          sheetXml = setCell(sheetXml, 'H' + r,
            { f: 'IFERROR(VLOOKUP($G' + r + ',CoA!$C$3:$E$37,2,0),"")' });
        } else if (it.desc) {
          sheetXml = setCell(sheetXml, 'H' + r, it.desc);
        }
      }
      if (!isFormula('L' + r)) sheetXml = setCell(sheetXml, 'L' + r, { f: 'IFERROR($J' + r + '*$K' + r + ',0)' });
    }

    /* --- 남은 행 비우기 (양식에 남아 있는 지난달 값 제거) --- */
    var clearCols = ['C', 'D', 'E', 'F', 'G', 'I', 'J'];
    for (var rr = 10 + used.length; rr <= 59; rr++) {
      for (var c = 0; c < clearCols.length; c++) {
        sheetXml = setCell(sheetXml, clearCols[c] + rr, null);
      }
    }

    if (!isFormula('L6')) sheetXml = setCell(sheetXml, 'L6', { f: 'SUM($L10:$L59)' }, '0');

    /* 다시 계산: 엑셀이 열 때 수식 결과를 새로 계산하도록 */
    var wbXml = found.wbXml;
    if (/<calcPr\b[^>]*\/>/.test(wbXml)) {
      wbXml = wbXml.replace(/<calcPr\b[^>]*\/>/, '<calcPr calcId="171027" fullCalcOnLoad="1"/>');
    } else if (!/<calcPr\b/.test(wbXml)) {
      wbXml = wbXml.replace('</workbook>', '<calcPr calcId="171027" fullCalcOnLoad="1"/></workbook>');
    }

    zip.file(found.path, sheetXml, { createFolders: false });
    zip.file('xl/workbook.xml', wbXml, { createFolders: false });

    return zip.generateAsync({
      type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
      createFolders: false
    });
  }

  global.XLSXKit = {
    build: build,
    dateSerial: dateSerial,
    monthEndDate: monthEndDate,
    listSheets: async function (buf) {
      var zip = await JSZip.loadAsync(buf);
      var found = await locateSheet(zip, 'Expense Claim');
      return found.sheets.map(function (s) { return s.name; });
    },
    _setCell: function (xml, ref, val) { return setCell(xml, ref, val); }
  };
})(window);
