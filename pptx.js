/* pptx.js — 영수증 PPT(.pptx) 만들기
 *
 * assets/base.pptx (빈 16:9 슬라이드 덱) 을 열어서
 * 세로 영수증 이미지를 슬라이드 높이(7.5in)에 맞춰 가로로 나란히 놓고,
 * 슬라이드 폭(13.33in)을 넘으면 다음 슬라이드로 넘깁니다.
 */
(function (global) {
  'use strict';

  var SLIDE_W = 12192000; /* 13.333in */
  var SLIDE_H = 6858000;  /* 7.5in   */

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** 이미지들을 슬라이드별로 배치 */
  function layout(images) {
    var pages = [], cur = [], used = 0;
    for (var i = 0; i < images.length; i++) {
      var im = images[i];
      var w = Math.round(SLIDE_H * (im.w || 1) / (im.h || 1));
      var h = SLIDE_H;
      if (w > SLIDE_W) {
        w = SLIDE_W;
        h = Math.round(SLIDE_W * (im.h || 1) / (im.w || 1));
      }
      if (cur.length && used + w > SLIDE_W) {
        pages.push(cur); cur = []; used = 0;
      }
      if (w > SLIDE_W) w = SLIDE_W;
      cur.push({ img: im, x: used, y: Math.round((SLIDE_H - h) / 2), w: w, h: h });
      used += w;
    }
    if (cur.length) pages.push(cur);
    return pages;
  }

  function picXml(shapeId, rId, name, p) {
    return '<p:pic>' +
      '<p:nvPicPr>' +
      '<p:cNvPr id="' + shapeId + '" name="' + esc(name) + '"/>' +
      '<p:cNvPicPr><a:picLocks noChangeAspect="1" noMove="0" noResize="0"/></p:cNvPicPr>' +
      '<p:nvPr/>' +
      '</p:nvPicPr>' +
      '<p:blipFill><a:blip r:embed="' + rId + '"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
      '<p:spPr><a:xfrm><a:off x="' + p.x + '" y="' + p.y + '"/>' +
      '<a:ext cx="' + p.w + '" cy="' + p.h + '"/></a:xfrm>' +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
      '<a:ln><a:noFill/></a:ln>' +
      '</p:spPr></p:pic>';
  }

  /** ppt/slideLayouts/slideLayout7.xml -> ../slideLayouts/slideLayout7.xml */
  function layoutRel(part) {
    return '../' + String(part).replace(/^ppt\//, '');
  }

  function slideXml(pics, firstId) {
    var body = '';
    for (var i = 0; i < pics.length; i++) {
      body += picXml(firstId + i, pics[i].rId, '영수증 ' + (pics[i].n || (i + 1)), pics[i]);
    }
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
      '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
      'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
      '<p:cSld><p:spTree>' +
      '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
      '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
      '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
      body +
      '</p:spTree></p:cSld>' +
      '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
  }

  function slideRels(layoutPart, images) {
    var rels = '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="' +
      layoutRel(layoutPart) + '"/>';
    for (var i = 0; i < images.length; i++) {
      rels += '<Relationship Id="rId' + (i + 2) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../' +
        images[i].mediaName + '"/>';
    }
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      rels + '</Relationships>';
  }

  /**
   * baseArrayBuffer: assets/base.pptx
   * images: [{ bytes: Uint8Array, w, h, ext }]  (넣을 순서대로)
   */
  async function build(baseArrayBuffer, images) {
    if (!images || !images.length) throw new Error('영수증 사진이 없습니다.');
    var zip = await JSZip.loadAsync(baseArrayBuffer);

    var layoutPart = 'ppt/slideLayouts/slideLayout7.xml';
    if (!zip.file(layoutPart)) layoutPart = 'ppt/slideLayouts/slideLayout1.xml';

    var pages = layout(images);
    var mediaParts = [];
    var imageCount = 0;
    var maxRidInPresentation = 0;

    var presFile = zip.file('ppt/presentation.xml');
    var presRelsFile = zip.file('ppt/_rels/presentation.xml.rels');
    var ctFile = zip.file('[Content_Types].xml');
    if (!presFile || !presRelsFile || !ctFile) throw new Error('PPT 기본 양식을 읽지 못했습니다.');

    var presXml = await presFile.async('string');
    var presRels = await presRelsFile.async('string');
    var ctXml = await ctFile.async('string');

    var rre = /Id="rId(\d+)"/g, rm;
    while ((rm = rre.exec(presRels))) {
      maxRidInPresentation = Math.max(maxRidInPresentation, Number(rm[1]));
    }

    for (var p = 0; p < pages.length; p++) {
      var pics = pages[p];
      var slideNo = p + 1;
      var slideImages = [];
      for (var k = 0; k < pics.length; k++) {
        imageCount++;
        var mediaName = 'media/receipt' + imageCount + '.jpg';
        zip.file('ppt/' + mediaName, pics[k].img.bytes, { createFolders: false });
        slideImages.push({ mediaName: mediaName, rId: 'rId' + (k + 2), n: imageCount });
        pics[k].rId = 'rId' + (k + 2);
        pics[k].n = imageCount;
      }
      zip.file('ppt/slides/slide' + slideNo + '.xml', slideXml(pics, 2), { createFolders: false });
      zip.file('ppt/slides/_rels/slide' + slideNo + '.xml.rels',
        slideRels(layoutPart, slideImages), { createFolders: false });

      var rid = 'rId' + (++maxRidInPresentation);
      presRels = presRels.replace('</Relationships>',
        '<Relationship Id="' + rid + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide' + slideNo + '.xml"/></Relationships>');

      ctXml = ctXml.replace('</Types>',
        '<Override PartName="/ppt/slides/slide' + slideNo + '.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>');

      var sldIdEntry = '<p:sldId id="' + (255 + slideNo) + '" r:id="' + rid + '"/>';
      if (/<p:sldIdLst\b/.test(presXml)) {
        presXml = presXml.replace('</p:sldIdLst>', sldIdEntry + '</p:sldIdLst>');
      } else {
        presXml = presXml.replace('</p:sldMasterIdLst>',
          '</p:sldMasterIdLst><p:sldIdLst>' + sldIdEntry + '</p:sldIdLst>');
      }
    }

    zip.file('ppt/presentation.xml', presXml);
    zip.file('ppt/_rels/presentation.xml.rels', presRels);
    zip.file('[Content_Types].xml', ctXml);

    return zip.generateAsync({
      type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
      createFolders: false
    });
  }

  global.PPTXKit = { build: build, layout: layout };
})(window);
