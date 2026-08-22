/* 科技島大富翁 — 地圖繪製與動畫
 * 2.5D 等距視角 + 鏡頭跟隨（角色恆在畫面中央）
 * 純 SVG，不用 3D 引擎，舊平板也跑得動
 */
(function (global) {
  'use strict';

  var B = global.BOARD;
  var NS = 'http://www.w3.org/2000/svg';
  var XLINK = 'http://www.w3.org/1999/xlink';

  var SX = 4.0, SQ = 0.60;          // 地圖放大倍率、等距壓扁比例
  var VW = 1920, VH = 1080;         // 邏輯畫布（投影用 16:9）
  var CHAR_H = 260;                 // 角色顯示高度
  var CELL_RX = 68, CELL_RY = 38;   // 格子橢圓

  var ISLAND = 'M300 42 C356 48,398 92,414 156 C436 240,450 332,444 428 C436 526,416 618,382 700 ' +
               'C360 756,330 812,298 818 C270 824,248 784,234 724 C210 626,188 500,188 384 ' +
               'C188 276,222 138,300 42 Z';
  var TRACK = 'M300 78 C250 92,230 164,220 264 C212 354,218 464,232 568 ' +
              'C242 644,256 714,278 766 C294 798,318 794,336 756 ' +
              'C366 686,394 594,406 494 C418 390,414 286,394 198 C376 130,348 86,300 78 Z';

  // 鏡頭放大倍率。因為鏡頭會跟著角色跑，不需要把整座島塞進畫面，
  // 所以拉近一點讓格子變大、遠處的白板也看得清楚。
  var ZOOM = 1.45;

  var POS = {};          // 格子座標
  var AVAIL = {};        // 哪些角色的立繪真的存在（沒有的用色塊佔位）
  var svg, cam, layers = {}, sprites = {}, minimap = {};
  var followGid = null, zoomOut = false;
  var speed = 1;          // 動畫速度倍率（老師端可調）

  function el(tag, attr) {
    var e = document.createElementNS(NS, tag);
    for (var k in attr) e.setAttribute(k, attr[k]);
    return e;
  }
  function href(imgEl, url) {
    imgEl.setAttribute('href', url);
    imgEl.setAttributeNS(XLINK, 'href', url);
  }
  function shade(hex, amt) {
    var n = parseInt(hex.slice(1), 16), r = (n >> 16) + amt, g = ((n >> 8) & 255) + amt, b = (n & 255) + amt;
    function c(v) { return Math.max(0, Math.min(255, v)); }
    return '#' + ((1 << 24) + (c(r) << 16) + (c(g) << 8) + c(b)).toString(16).slice(1);
  }

  // ── 格子座標 ──
  function frac(i) {
    if (i <= 2) return 0.005 + i * 0.017;
    if (i <= 34) return 0.058 + (i - 3) * 0.0147;
    if (i <= 37) return 0.565 + (i - 35) * 0.023;
    return 0.650 + (i - 38) * 0.0245;
  }
  function computePositions() {
    var probe = el('path', { d: TRACK });
    probe.style.display = 'none';
    svg.appendChild(probe);
    var L = probe.getTotalLength();
    for (var i = 0; i < B.RING; i++) {
      var p = probe.getPointAtLength(L * frac(i));
      POS[i] = { x: p.x * SX, y: p.y * SX * SQ };
    }
    svg.removeChild(probe);

    // 山區格：夾在橫貫公路兩端之間，用弧線往島中央鼓出去
    function bridge(a, b, i1, i2, dx, dy) {
      var pa = POS[a], pb = POS[b];
      [[i1, 0.34], [i2, 0.66]].forEach(function (pr) {
        var t = pr[1], bg = Math.sin(t * Math.PI);
        POS[pr[0]] = { x: pa.x + (pb.x - pa.x) * t + dx * bg, y: pa.y + (pb.y - pa.y) * t + dy * bg };
      });
    }
    bridge(9, 44, 55, 56, 56, 0);       // 北橫
    bridge(22, 41, 57, 58, 56, 0);      // 中橫
    bridge(32, 38, 59, 60, 104, -150);  // 南橫

    // 海外三廠：從桃園機場往島外（左側海上）凸出一小圈
    var a = POS[9];
    POS[52] = { x: a.x - 300, y: a.y - 40 };
    POS[53] = { x: a.x - 420, y: a.y - 200 };
    POS[54] = { x: a.x - 260, y: a.y - 330 };
  }

  /** 預先檢查哪些角色有立繪，沒有的用色塊佔位（Codex 還沒交完時也能玩） */
  function preloadAvatars(chars) {
    return Promise.all(chars.map(function (c) {
      return new Promise(function (res) {
        var im = new Image();
        im.onload = function () { AVAIL[c.id] = true; res(); };
        im.onerror = function () { AVAIL[c.id] = false; res(); };
        im.src = avatarUrl(c, 'idle');
      });
    })).then(function () {
      var have = Object.keys(AVAIL).filter(function (k) { return AVAIL[k]; }).length;
      return { total: chars.length, have: have };
    });
  }
  function avatarUrl(ch, frame) {
    return 'images/characters/char_' + (ch.num < 10 ? '0' : '') + ch.num + '_' + ch.id + '_' + frame + '.png';
  }
  function hasAvatar(id) { return AVAIL[id] === true; }

  // ── 初始化 ──
  function init(svgEl) {
    svg = svgEl;
    svg.setAttribute('viewBox', '0 0 ' + VW + ' ' + VH);
    svg.innerHTML = '';

    var defs = el('defs', {});
    defs.innerHTML =
      '<linearGradient id="seaG" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#7dd3fc"/><stop offset="100%" stop-color="#0369a1"/></linearGradient>' +
      '<linearGradient id="landG" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#d9f99d"/><stop offset="55%" stop-color="#86efac"/>' +
      '<stop offset="100%" stop-color="#4ade80"/></linearGradient>' +
      '<filter id="soft"><feDropShadow dx="0" dy="4" stdDeviation="4" flood-opacity=".3"/></filter>';
    svg.appendChild(defs);
    svg.appendChild(el('rect', { width: VW, height: VH, fill: 'url(#seaG)' }));

    cam = el('g', { id: 'cam' });
    svg.appendChild(cam);
    ['terrain', 'roads', 'cells', 'buildings', 'pieces', 'labels'].forEach(function (n) {
      layers[n] = el('g', { id: 'L-' + n });
      // 只有格子本身要能點；其他層（名稱標籤、廠房、角色）都放行，
      // 否則手指點在名字上就抓不到底下是哪一格。
      if (n !== 'cells') layers[n].style.pointerEvents = 'none';
      cam.appendChild(layers[n]);
    });

    computePositions();
    drawTerrain();
    return { POS: POS, VW: VW, VH: VH };
  }

  function drawTerrain() {
    var M = 'matrix(' + SX + ',0,0,' + (SX * SQ) + ',0,0)';
    layers.terrain.appendChild(el('path', { d: ISLAND, transform: M + ' translate(0,26)', fill: '#3f6212', 'fill-opacity': .85 }));
    layers.terrain.appendChild(el('path', { d: ISLAND, transform: M, fill: 'url(#landG)', stroke: '#3f6212', 'stroke-width': 3 }));
    layers.terrain.appendChild(el('path', { d: TRACK, transform: M, fill: 'none', stroke: '#fff', 'stroke-width': 11, 'stroke-opacity': .45 }));

    function road(seq, color) {
      layers.roads.appendChild(el('path', {
        d: 'M' + seq.map(function (i) { return POS[i].x + ' ' + POS[i].y; }).join(' L '),
        fill: 'none', stroke: color, 'stroke-width': 22, 'stroke-opacity': .85, 'stroke-linecap': 'round'
      }));
    }
    road([9, 55, 56, 44], '#16a34a');     // 北橫
    road([22, 57, 58, 41], '#0891b2');    // 中橫
    road([32, 59, 60, 38], '#ca8a04');    // 南橫
    road([9, 52, 53, 54, 10], '#818cf8'); // 海外支線
  }

  // ── 格子與建築 ──
  function drawBoard(state) {
    layers.cells.innerHTML = '';
    layers.buildings.innerHTML = '';
    layers.labels.innerHTML = '';

    B.CELLS.forEach(function (c, i) {
      var p = POS[i];
      if (!p) return;
      var color = cellColor(c, state, i);
      layers.cells.appendChild(el('ellipse', { cx: p.x, cy: p.y + 12, rx: CELL_RX, ry: CELL_RY, fill: '#000', 'fill-opacity': .15 }));
      var e = el('ellipse', {
        cx: p.x, cy: p.y, rx: CELL_RX, ry: CELL_RY, fill: color,
        stroke: '#1e293b', 'stroke-width': 6, id: 'cell' + i, 'data-cell': i
      });
      e.style.cursor = 'pointer';
      layers.cells.appendChild(e);

      var lv = (state && state.board.level[i]) || 0;
      if (lv > 0) layers.buildings.appendChild(drawBuilding(p.x, p.y - 16, lv, color));

      // 地主符號：買下這塊地的科學家，他的符號就蓋在地上，一眼看得出是誰的
      var ownerGid = state && state.board.owner[i];
      var ownerCh = null;
      if (ownerGid && state.players[ownerGid] && state.players[ownerGid].charId) {
        ownerCh = global.charById(state.players[ownerGid].charId);
      }
      if (ownerCh) {
        var ring = el('circle', {
          cx: p.x - CELL_RX * 0.52, cy: p.y + CELL_RY * 0.34, r: 30,
          fill: ownerCh.color, stroke: '#fff', 'stroke-width': 5
        });
        ring.style.pointerEvents = 'none';
        layers.cells.appendChild(ring);
        var badge = el('text', {
          x: p.x - CELL_RX * 0.52, y: p.y + CELL_RY * 0.34 + 13,
          'text-anchor': 'middle', 'font-size': 32
        });
        badge.style.pointerEvents = 'none';
        badge.textContent = ownerCh.emoji;
        layers.cells.appendChild(badge);
      }

      // 標籤（畫在最上層，不會被前排廠房蓋住）
      var left = p.x < VW * 1.3;
      var txt = (ownerCh ? ownerCh.emoji + ' ' : '') + c.name;
      var w = txt.length * 34 + 22;
      layers.labels.appendChild(el('rect', {
        x: left ? p.x - 88 - w : p.x + 88, y: p.y - 26,
        width: w, height: 52, rx: 12, fill: '#f8fafc', 'fill-opacity': .85
      }));
      var t = el('text', {
        x: left ? p.x - 98 : p.x + 98, y: p.y + 14,
        'text-anchor': left ? 'end' : 'start',
        'font-size': 34, 'font-weight': 800, fill: '#0b3a52'
      });
      t.textContent = txt;
      layers.labels.appendChild(t);
    });
  }

  function cellColor(c, state, i) {
    if (c.type === 'land') {
      var owner = state && state.board.owner[i];
      return owner ? B.COLORS[c.color].hex : shade(B.COLORS[c.color].hex, 55);
    }
    var map = {
      shop: '#f8fafc', bank: '#34d399', subsidy: '#fde68a', chest: '#fca5a5',
      packet: '#fdba74', patent: '#e2e8f0', news: '#c4b5fd', god: '#a5f3fc',
      tax: '#fca5a5', pool: '#fcd34d', audit: '#a8a29e', jail: '#78716c',
      hosp: '#fb7185', airport: '#22d3ee', fork: '#22d3ee', mountain: '#84cc16'
    };
    return map[c.type] || '#e2e8f0';
  }

  function drawBuilding(x, y, level, color) {
    var g = el('g', {}), w = 38, h = 30 + level * 32;
    g.appendChild(el('path', { d: 'M' + (x - w) + ' ' + y + ' L' + x + ' ' + (y + w * .5) + ' L' + x + ' ' + (y + w * .5 - h) + ' L' + (x - w) + ' ' + (y - h) + ' Z', fill: shade(color, -46) }));
    g.appendChild(el('path', { d: 'M' + (x + w) + ' ' + y + ' L' + x + ' ' + (y + w * .5) + ' L' + x + ' ' + (y + w * .5 - h) + ' L' + (x + w) + ' ' + (y - h) + ' Z', fill: shade(color, -20) }));
    g.appendChild(el('path', { d: 'M' + x + ' ' + (y + w * .5 - h) + ' L' + (x + w) + ' ' + (y - h) + ' L' + x + ' ' + (y - w * .5 - h) + ' L' + (x - w) + ' ' + (y - h) + ' Z', fill: shade(color, 34), stroke: '#0f172a', 'stroke-width': 2.5 }));
    for (var k = 1; k <= level; k++) {
      var yy = y - h + k * (h / (level + 1));
      g.appendChild(el('rect', { x: x - w + 9, y: yy, width: 2 * w - 18, height: 5, fill: '#0f172a', 'fill-opacity': .22 }));
    }
    if (level >= 5) {
      g.appendChild(el('rect', { x: x - 7, y: y - h - 46, width: 14, height: 46, fill: shade(color, -8) }));
      g.appendChild(el('circle', { cx: x, cy: y - h - 58, r: 17, fill: '#e2e8f0', 'fill-opacity': .55 }));
    }
    return g;
  }

  // ── 棋子（角色立繪 + 走路動畫）──
  function drawPlayers(state) {
    layers.pieces.innerHTML = '';
    sprites = {};
    Object.keys(state.players).forEach(function (gid) {
      var p = state.players[gid];
      var ch = p.charId ? global.charById(p.charId) : null;
      var g = el('g', { id: 'piece-' + gid });
      var shadow = el('ellipse', { rx: 46, ry: 24, fill: '#000', 'fill-opacity': .28 });
      var w = CHAR_H * 512 / 768;
      var useImg = ch && hasAvatar(ch.id);
      // 沒有立繪就用色塊佔位（Codex 尚未交件的角色）
      var ph = el('g', { opacity: useImg ? 0 : 1 });
      if (ch) {
        ph.appendChild(el('ellipse', { cx: 0, cy: 0, rx: 44, ry: 62, fill: ch.color, stroke: '#fff', 'stroke-width': 6 }));
        var pt = el('text', { 'text-anchor': 'middle', 'font-size': 46 });
        pt.textContent = ch.emoji;
        ph.appendChild(pt);
      }
      var img = el('image', { width: w, height: CHAR_H, preserveAspectRatio: 'xMidYMax meet', opacity: useImg ? 1 : 0 });
      if (useImg) href(img, avatarUrl(ch, 'idle'));
      var badge = el('circle', { r: 26, fill: ch ? ch.color : '#94a3b8', stroke: '#fff', 'stroke-width': 5 });
      var num = el('text', { 'text-anchor': 'middle', 'font-size': 30, 'font-weight': 900, fill: '#fff' });
      num.textContent = p.num;
      g.appendChild(shadow); g.appendChild(ph); g.appendChild(img); g.appendChild(badge); g.appendChild(num);
      layers.pieces.appendChild(g);
      sprites[gid] = { g: g, shadow: shadow, img: img, ph: ph, badge: badge, num: num,
                       ch: ch, frame: 0, timer: null, w: w, useImg: useImg };
      placePiece(gid, p.pos, 0);
    });
  }

  function placePiece(gid, cellIdx, lift) {
    var s = sprites[gid], p = POS[cellIdx];
    if (!s || !p) return;
    setPieceXY(gid, p.x, p.y, lift || 0);
  }
  function setPieceXY(gid, x, y, lift) {
    var s = sprites[gid];
    if (!s) return;
    s.shadow.setAttribute('cx', x); s.shadow.setAttribute('cy', y + 6);
    s.shadow.setAttribute('rx', 46 - lift * .12); s.shadow.setAttribute('ry', 24 - lift * .07);
    s.img.setAttribute('x', x - s.w / 2);
    s.img.setAttribute('y', y - CHAR_H + 8 - lift);
    if (s.ph) {
      s.ph.setAttribute('transform', 'translate(' + x + ',' + (y - 64 - lift) + ')');
      var pt2 = s.ph.querySelector('text');
      if (pt2) { pt2.setAttribute('x', 0); pt2.setAttribute('y', 16); }
    }
    s.badge.setAttribute('cx', x + s.w / 2 - 8); s.badge.setAttribute('cy', y - CHAR_H + 36 - lift);
    s.num.setAttribute('x', x + s.w / 2 - 8); s.num.setAttribute('y', y - CHAR_H + 46 - lift);
    s.x = x; s.y = y;
  }

  function setFrame(gid, name) {
    var s = sprites[gid];
    if (!s || !s.ch || !s.useImg) return;
    href(s.img, avatarUrl(s.ch, name));
  }
  function startWalk(gid) {
    var s = sprites[gid];
    if (!s || s.timer || !s.useImg) return;
    s.timer = setInterval(function () {
      s.frame = 1 - s.frame;
      setFrame(gid, s.frame ? 'walk_a' : 'walk_b');
    }, 200);
  }
  function stopWalk(gid) {
    var s = sprites[gid];
    if (!s) return;
    if (s.timer) { clearInterval(s.timer); s.timer = null; }
    setFrame(gid, 'idle');
  }

  /** 跳一格（拋物線），回傳 Promise */
  function setSpeed(v) { speed = v || 1; }

  function hop(gid, fromIdx, toIdx, ms) {
    ms = Math.max(60, (ms || 230) / speed);
    return new Promise(function (res) {
      var a = POS[fromIdx], b = POS[toIdx];
      if (!a || !b) { res(); return; }
      var t0 = performance.now(), done = false, safety;
      function finish() {
        if (done) return;
        done = true; clearTimeout(safety);
        setPieceXY(gid, b.x, b.y, 0);
        if (followGid === gid) camTo(b.x, b.y);
        flashCell(toIdx); res();
      }
      // 保險：老師切到別的分頁時 requestAnimationFrame 會停擺，
      // 沒有這道保險遊戲會永久卡住。時間到就直接完成這一步。
      safety = setTimeout(finish, ms + 450);
      function fr(t) {
        if (done) return;
        var k = Math.min(1, (t - t0) / ms);
        var e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        var x = a.x + (b.x - a.x) * e, y = a.y + (b.y - a.y) * e;
        setPieceXY(gid, x, y, Math.sin(k * Math.PI) * 60);
        if (followGid === gid) camTo(x, y);
        if (k < 1) requestAnimationFrame(fr); else finish();
      }
      requestAnimationFrame(fr);
    });
  }

  function flashCell(i) {
    var e = document.getElementById('cell' + i);
    if (!e) return;
    e.setAttribute('ry', CELL_RY + 8);
    setTimeout(function () { e.setAttribute('ry', CELL_RY); }, 240);
  }

  // ── 鏡頭 ──
  var lastCam = null;                 // 記住鏡頭停在哪，按完「全島」才回得來
  function camTo(x, y) {
    lastCam = { x: x, y: y };
    if (zoomOut) return;
    cam.setAttribute('transform',
      'translate(' + (VW / 2 - x * ZOOM) + ',' + (VH / 2 - y * ZOOM) + ') scale(' + ZOOM + ')');
    // 小地圖上的取景框也要跟著縮小，才對得上實際看得到的範圍
    if (minimap.view) {
      minimap.view.setAttribute('x', x - VW / (2 * ZOOM));
      minimap.view.setAttribute('y', y - VH / (2 * ZOOM));
    }
  }

  /** 平板看地圖用：自由指定中心點與縮放（不受鏡頭跟隨影響） */
  function setView(cx, cy, k) {
    k = k || 1;
    zoomOut = false;
    cam.setAttribute('transform',
      'translate(' + (VW / 2 - cx * k) + ',' + (VH / 2 - cy * k) + ') scale(' + k + ')');
  }

  /** 整張地圖的範圍（平板拖曳時用來擋住，免得滑到外太空） */
  function mapBounds() {
    var xs = [], ys = [];
    Object.keys(POS).forEach(function (i) { xs.push(POS[i].x); ys.push(POS[i].y); });
    return {
      x1: Math.min.apply(null, xs) - 200, x2: Math.max.apply(null, xs) + 200,
      y1: Math.min.apply(null, ys) - 200, y2: Math.max.apply(null, ys) + 200
    };
  }
  function focusOn(gid, state) {
    followGid = gid;
    var p = state.players[gid];
    if (p && POS[p.pos]) camTo(POS[p.pos].x, POS[p.pos].y);
  }
  function setZoomOut(on) {
    zoomOut = on;
    if (on) {
      var w = 620 * SX, h = 880 * SX * SQ;
      var k = Math.min(VW / w, VH / h) * 0.94;
      cam.setAttribute('transform', 'translate(' + (VW - w * k) / 2 + ',' + (VH - h * k) / 2 + ') scale(' + k + ')');
    } else if (lastCam) {
      camTo(lastCam.x, lastCam.y);     // 關掉全島檢視就立刻回到剛才跟著的角色身上
    }
    return zoomOut;
  }
  function isZoomOut() { return zoomOut; }

  // ── 小地圖 ──
  function initMinimap(g, w, h) {
    g.innerHTML = '';
    var mw = 620 * SX, mh = 880 * SX * SQ;
    var k = Math.min(w / mw, h / mh);
    var inner = el('g', { transform: 'scale(' + k + ')' });
    var M = 'matrix(' + SX + ',0,0,' + (SX * SQ) + ',0,0)';
    inner.appendChild(el('rect', { width: mw, height: mh, fill: '#38b6ff' }));
    inner.appendChild(el('path', { d: ISLAND, transform: M, fill: '#86efac' }));
    inner.appendChild(el('path', { d: TRACK, transform: M, fill: 'none', stroke: '#fff', 'stroke-width': 20, 'stroke-opacity': .6 }));
    minimap.dots = el('g', {});
    inner.appendChild(minimap.dots);
    minimap.view = el('rect', { width: VW / ZOOM, height: VH / ZOOM, fill: 'none', stroke: '#fbbf24', 'stroke-width': 22 });
    inner.appendChild(minimap.view);
    g.appendChild(inner);
  }
  function updateMinimap(state) {
    if (!minimap.dots) return;
    minimap.dots.innerHTML = '';
    Object.keys(state.players).forEach(function (gid) {
      var p = state.players[gid], pos = POS[p.pos];
      if (!pos) return;
      var ch = p.charId ? global.charById(p.charId) : null;
      minimap.dots.appendChild(el('circle', { cx: pos.x, cy: pos.y, r: 56, fill: ch ? ch.color : '#94a3b8', stroke: '#fff', 'stroke-width': 10 }));
    });
  }

  global.RENDER = {
    init: init, drawBoard: drawBoard, drawPlayers: drawPlayers,
    placePiece: placePiece, hop: hop, startWalk: startWalk, stopWalk: stopWalk,
    focusOn: focusOn, camTo: camTo, setZoomOut: setZoomOut, isZoomOut: isZoomOut,
    initMinimap: initMinimap, updateMinimap: updateMinimap,
    preloadAvatars: preloadAvatars, hasAvatar: hasAvatar, avatarUrl: avatarUrl,
    setSpeed: setSpeed, setView: setView, mapBounds: mapBounds,
    flashCell: flashCell, POS: POS, VW: VW, VH: VH, el: el, shade: shade
  };
})(typeof window !== 'undefined' ? window : globalThis);
