/* 科技島大富翁 — 老師端（投影白板）
 * 畫面只有地圖，所有資訊用 HUD 疊在上面
 * 老師端是「主機」：所有遊戲邏輯在這裡運算，平板只送動作意圖
 */
(function () {
  'use strict';

  var B = window.BOARD, E = window.ENGINE, Q = window.QUESTIONS,
      R = window.RENDER, S = window.STORE, CARD = window.CARDS;

  var state = null;
  var cfg = { classId: '智', slot: 1, chapters: [], groups: 9, maxRounds: 30,
              allowMerge: true, allowSabotage: true, solo: false, speed: 1, autoPilot: true };
  var roomCode = null;          // 這一場的房間代碼（投影給學生輸入）
  var online = {};              // gid -> 最後一次收到該組訊息的時間
  var ONLINE_TIMEOUT = 25000;   // 25 秒沒消息就視為沒有平板，改由電腦代打
  var timer = null, paused = false, busy = false, lobbyPump = null, gamePump = null;
  var $ = function (id) { return document.getElementById(id); };

  // ═══════════════════════════════════════
  // 設定畫面
  // ═══════════════════════════════════════
  function buildSetup() {
    var cp = $('classPicker');
    S.CLASSES.forEach(function (c) {
      var b = document.createElement('div');
      b.className = 'chip' + (c === cfg.classId ? ' on' : '');
      b.textContent = c + '班';
      b.onclick = function () {
        cfg.classId = c;
        [].forEach.call(cp.children, function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        refreshSlots();
      };
      cp.appendChild(b);
    });

    S.SLOTS.forEach(function (s) {
      var b = document.createElement('div');
      b.className = 'chip' + (s === cfg.slot ? ' on' : '');
      b.dataset.slot = s;
      b.onclick = function () {
        cfg.slot = s;
        [].forEach.call($('slotPicker').children, function (x) { x.classList.remove('on'); });
        b.classList.add('on');
      };
      $('slotPicker').appendChild(b);
    });
    refreshSlots();

    Q.CHAPTERS.forEach(function (ch) {
      var b = document.createElement('div');
      b.className = 'chip';
      b.textContent = ch.label;
      b.onclick = function () {
        b.classList.toggle('on');
        cfg.chapters = [].filter.call($('chapterPicker').children, function (x) { return x.classList.contains('on'); })
          .map(function (x) { return Q.CHAPTERS[[].indexOf.call($('chapterPicker').children, x)].file; });
        loadBank();
      };
      $('chapterPicker').appendChild(b);
    });

    $('animSpeed').onchange = function () { cfg.speed = +this.value; R.setSpeed(cfg.speed); };
    $('groupCount').onchange = function () { cfg.groups = +this.value; };
    $('maxRounds').onchange = function () { cfg.maxRounds = +this.value; };
    $('allowMerge').onchange = function () { cfg.allowMerge = this.checked; };
    $('allowSabotage').onchange = function () { cfg.allowSabotage = this.checked; };
    $('autoPilot').onchange = function () { cfg.autoPilot = this.checked; };

    $('btnNew').onclick = function () { startNew(false); };
    $('btnSolo').onclick = function () { startNew(true); };
    $('btnLoad').onclick = doLoad;
  }

  function refreshSlots() {
    var saves = S.listSaves().filter(function (x) { return x.classId === cfg.classId; });
    [].forEach.call($('slotPicker').children, function (el, i) {
      var s = saves[i];
      el.textContent = '槽 ' + (i + 1) + (s.empty ? '（空）' : '（第 ' + s.round + ' 輪）');
    });
  }

  function loadBank() {
    if (!cfg.chapters.length) { $('qCount').textContent = '尚未選擇章節'; return; }
    $('qCount').textContent = '載入中…';
    Q.load(cfg.chapters).then(function (r) {
      $('qCount').textContent = '已載入 ' + r.count + ' 題（' + r.chapters.join('、') + '）';
    }).catch(function (e) {
      $('qCount').textContent = '載入失敗：' + e.message;
    });
  }

  function msg(text, cls) {
    var m = $('setupMsg');
    m.textContent = text; m.className = 'msg ' + (cls || '');
  }

  function startNew(solo) {
    if (!cfg.chapters.length) { msg('請先勾選這次要考的章節', 'err'); return; }
    if (!Q.size()) { msg('題庫還沒載入完成，請稍候', 'err'); return; }
    cfg.solo = solo;
    state = E.createGame({
      groups: cfg.groups, classId: cfg.classId, slot: cfg.slot,
      maxRounds: cfg.maxRounds, chapters: cfg.chapters,
      seed: Date.now() % 2147483647
    });
    state.cfg = { allowMerge: cfg.allowMerge, allowSabotage: cfg.allowSabotage, solo: solo };
    openRoom(solo);
  }

  function doLoad() {
    var st = S.load(cfg.classId, cfg.slot);
    if (!st) { msg('這個存檔槽是空的', 'err'); return; }
    state = st;
    cfg.chapters = st.chapters || [];
    cfg.solo = (st.cfg && st.cfg.solo) || false;
    Q.load(cfg.chapters).then(function () {
      msg('讀取成功，第 ' + st.round + ' 輪，正在開房間…', 'ok');
      openRoom(cfg.solo);            // 續玩也要開新房間，學生才連得進來
    }).catch(function (e) { msg('題庫載入失敗：' + e.message, 'err'); });
  }

  /**
   * 開房間：產生一組 6 位數代碼投影給學生輸入。
   * 為什麼要代碼：如果用「班級＋存檔槽」當房間識別，兩位老師都選「智班槽1」就會撞在一起。
   */
  function openRoom(solo) {
    var gameId = S.makeGameId(cfg.classId, cfg.slot);

    function finish(code) {
      roomCode = code;
      S.initChannel(code);                  // 同一台電腦多分頁用代碼當頻道名
      goLobby();
    }

    if (!solo && S.firebaseReady()) {
      msg('連線中…', '');
      S.initFirebase().then(function () {
        S.setMode('firebase', gameId);
        S.watchActions(function (a) { handleAction(a); S.clearAction(a.gid); });
        return S.createRoom({ gameId: gameId, classId: cfg.classId,
                              slot: cfg.slot, groups: cfg.groups });
      }).then(function (code) {
        pushRemote();
        finish(code);
      }).catch(function (e) {
        msg('雲端連線失敗，改用本機模式：' + e.message, 'err');
        S.setMode('local', gameId);
        S.createRoom({}).then(finish);
      });
    } else {
      S.setMode('local', gameId);
      S.createRoom({}).then(finish);
    }
  }

  // ═══════════════════════════════════════
  // 選角等待
  // ═══════════════════════════════════════
  function goLobby() {
    $('setup').classList.add('hidden');
    $('lobby').classList.remove('hidden');
    $('roomCode').textContent = roomCode || '------';
    $('roomUrl').textContent = location.href.replace(/teacher\.html.*$/, 'player.html');
    renderLobby();
    pushRemote();
    clearInterval(lobbyPump);
    lobbyPump = setInterval(function () {
      var q = S.drainLocalQueue();
      if (q.length) { q.forEach(handleAction); renderLobby(); }
      pushRemote();                     // 定期廣播，晚加入的平板才收得到
    }, 700);
    $('btnAutoPick').onclick = autoPick;
    $('btnStart').onclick = startGame;
    if (cfg.solo) autoPick();
  }

  function renderLobby() {
    var grid = $('lobbyGrid');
    grid.innerHTML = '';
    var allPicked = true;
    Object.keys(state.players).forEach(function (gid) {
      var p = state.players[gid];
      var ch = p.charId ? window.charById(p.charId) : null;
      if (!ch) allPicked = false;
      var d = document.createElement('div');
      d.className = 'lobby-card' + (ch ? ' picked' : '');
      if (ch) {
        var url = 'images/characters/char_' + (ch.num < 10 ? '0' : '') + ch.num + '_' + ch.id + '_idle.png';
        d.innerHTML =
          '<div class="ph" style="width:100px;height:150px;display:flex;align-items:center;' +
          'justify-content:center;font-size:52px;background:' + ch.color + '33;border-radius:12px">' + ch.emoji + '</div>' +
          '<img src="' + url + '" style="display:none" alt="">' +
          '<div class="g">第 ' + p.num + ' 組</div><div class="c">' + ch.name + '</div>';
        var im = d.querySelector('img'), ph = d.querySelector('.ph');
        // 圖片若已在瀏覽器快取中，onload 不會再觸發，要另外檢查 complete
        if (im.complete && im.naturalWidth > 0) { im.style.display = 'block'; ph.style.display = 'none'; }
        else im.onload = function () { im.style.display = 'block'; ph.style.display = 'none'; };
      } else {
        d.innerHTML = '<div class="g">第 ' + p.num + ' 組</div><div class="w">等待選角…</div>';
      }
      grid.appendChild(d);
    });
    $('btnStart').disabled = !allPicked;
    var n = Object.keys(state.players).length, on = onlineCount();
    var hint = $('lobbyHint');
    if (hint) {
      hint.textContent = '目前 ' + on + ' / ' + n + ' 組的平板已連上'
        + (cfg.autoPilot ? '　·　沒有平板的組會由電腦代打，可以直接開始' : '');
    }
  }

  function autoPick() {
    var taken = {};
    Object.keys(state.players).forEach(function (g) { if (state.players[g].charId) taken[state.players[g].charId] = 1; });
    var pool = window.CHARACTERS.filter(function (c) { return !taken[c.id]; });
    Object.keys(state.players).forEach(function (gid) {
      if (state.players[gid].charId) return;
      var c = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
      if (c) E.pickCharacter(state, gid, c.id);
    });
    renderLobby();
  }

  // ═══════════════════════════════════════
  // 遊戲畫面
  // ═══════════════════════════════════════
  function startGame() {
    clearInterval(lobbyPump);
    $('lobby').classList.add('hidden');
    $('setup').classList.add('hidden');
    $('game').classList.remove('hidden');
    status('載入角色立繪…');
    R.preloadAvatars(window.CHARACTERS).then(function (r) {
      if (r.have < r.total) {
        status('提醒：' + (r.total - r.have) + ' 位角色還沒有立繪，先用色塊代替');
      }
      buildScene();
    });
  }

  function buildScene() {
    R.setSpeed(cfg.speed);
    R.init($('stage'));
    R.initMinimap($('mmG'), 300, 340);
    R.drawBoard(state);
    R.drawPlayers(state);
    R.updateMinimap(state);
    R.focusOn(Object.keys(state.players)[0], state);

    bindBar();
    bindCellClick();
    updateHUD();
    $('hudCode').textContent = roomCode ? '房間代碼 ' + roomCode : '';
    clearInterval(gamePump);
    gamePump = setInterval(function () {
      var q = S.drainLocalQueue();
      if (q.length) q.forEach(handleAction);
      pushRemote();                     // 心跳：平板隨時都能同步到最新狀態
    }, 900);
    status('準備好了，按「開始這一輪」出題　·　連線模式：' +
           (S.getMode() === 'firebase' ? '雲端（平板可跨裝置連入）' : '本機（只有這台電腦的分頁能連）'));
  }

  function bindBar() {
    $('btnNext').onclick = function () { if (!busy) nextRound(); };
    $('btnPause').onclick = function () {
      paused = !paused;
      $('btnPause').textContent = paused ? '▶ 繼續' : '⏸ 暫停講解';
      status(paused ? '已暫停，老師講解中' : '繼續');
    };
    $('btnRank').onclick = toggleRank;
    $('btnZoom').onclick = function () {
      var on = R.setZoomOut(!R.isZoomOut());
      $('btnZoom').textContent = on ? '🔍 回到跟隨' : '🗺️ 全島';
      if (!on && state.order.length) R.focusOn(E.currentGid(state) || Object.keys(state.players)[0], state);
    };
    $('btnSave').onclick = function () {
      var r = S.save(state);
      status(r.ok ? '已存檔到 ' + state.classId + '班 槽' + state.slot : r.msg);
    };
    $('btnFull').onclick = function () {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
    };
    $('btnEnd').onclick = endSession;
  }

  function bindCellClick() {
    $('stage').addEventListener('click', function (ev) {
      var t = ev.target;
      if (t.dataset && t.dataset.cell != null) showCellInfo(+t.dataset.cell);
    });
  }

  function status(t) { $('barStatus').textContent = t; }

  /** 把狀態同時推給：同機分頁（BroadcastChannel）與雲端（Firestore） */
  var pushTimer = null;
  function pushRemote() {
    S.broadcastState(state);
    if (S.getMode() === 'firebase') {
      clearTimeout(pushTimer);                 // 節流：避免每個小動作都寫一次 Firestore
      pushTimer = setTimeout(function () { S.pushState(state); }, 400);
    }
  }

  /** 這一組現在有沒有平板在線上？ */
  function isOnline(gid) {
    return online[gid] && (Date.now() - online[gid] < ONLINE_TIMEOUT);
  }
  /** 這一組要不要由電腦代打？（單機試玩＝全部代打；否則只代打沒平板的組） */
  function isBot(gid) {
    if (cfg.solo) return true;
    return cfg.autoPilot && !isOnline(gid);
  }
  function onlineCount() {
    return Object.keys(state.players).filter(isOnline).length;
  }

  function updateHUD() {
    $('hudRound').textContent = '第 ' + state.round + ' 輪 / ' + state.maxRounds;
    R.updateMinimap(state);
    pushRemote();                   // 把狀態推給各組平板
  }

  function showPlayerHUD(gid) {
    var p = state.players[gid], ch = window.charById(p.charId);
    $('hudPlayer').classList.remove('hidden');
    if (ch) {
      var av = $('hpAvatar');
      av.src = 'images/characters/char_' + (ch.num < 10 ? '0' : '') + ch.num + '_' + ch.id + '_idle.png';
      av.onerror = function () { av.style.visibility = 'hidden'; };
      av.onload = function () { av.style.visibility = 'visible'; };
    }
    $('hpName').textContent = p.name;
    $('hpCash').textContent = '$' + p.cash.toLocaleString();
    $('hpBank').textContent = '$' + p.bank.toLocaleString();
    $('hpRp').textContent = p.rp + ' 點';
  }

  function toast(text, ms) {
    var t = $('hudToast');
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.add('hidden'); }, ms || 2200);
  }

  function toggleRank() {
    var el = $('hudRank');
    if (!el.classList.contains('hidden')) { el.classList.add('hidden'); return; }
    var rows = E.ranking(state).map(function (x, i) {
      var p = state.players[x.gid];
      return '<div class="rank-row"><span class="no">' + (i + 1) + '</span>' +
             '<span class="nm">' + p.name + '</span>' +
             '<span class="wl">$' + x.wealth.toLocaleString() + '</span></div>';
    }).join('');
    el.innerHTML = '<h3>📊 目前戰況</h3>' + rows;
    el.classList.remove('hidden');
  }

  function showCellInfo(i) {
    var c = B.CELLS[i];
    if (c.type === 'land') {
      var owner = state.board.owner[i], lv = state.board.level[i] || 0;
      var op = owner ? state.players[owner].name : '無人持有';
      var rent = B.baseRent(i, lv, E.hasFullColor(state, i));
      toast(c.name + '　地主：' + op + '　' + B.LEVEL_NAME[lv] + '　過路費 $' + rent.toLocaleString(), 3600);
    } else {
      toast(c.name + '（' + c.place + '）', 2600);
    }
  }

  // ═══════════════════════════════════════
  // 一輪的流程
  // ═══════════════════════════════════════
  function nextRound() {
    if (state.phase === 'ended' || state.round >= state.maxRounds) { endSession(); return; }
    busy = true;
    $('hudOrder').classList.add('hidden');
    $('hudRank').classList.add('hidden');

    // 依當前玩家所在地價決定難度（越貴的地出越難的題）
    var lead = E.ranking(state)[0];
    var cell = B.CELLS[state.players[lead.gid].pos];
    var diff = cell.type === 'land' ? Q.difficultyForPrice(cell.price) : null;
    var q = Q.draw({ used: state.usedQuestions, difficulty: diff, rnd: Math.random });
    if (!q) { status('題庫沒有題目了'); busy = false; return; }
    q = Q.shuffleOptions(q, Math.random);

    E.startRound(state, q);
    updateHUD();
    showQuestion(q);
  }

  function showQuestion(q) {
    var box = $('hudQuestion');
    box.classList.remove('hidden');
    $('qText').textContent = q.text;
    $('qOptions').innerHTML = q.optionKeys.map(function (k) {
      return '<div class="q-opt" data-k="' + k + '"><span class="k">' + k + '</span><span>' + q.options[k] + '</span></div>';
    }).join('');
    renderLights();

    var total = q.seconds, left = total;
    $('qSec').textContent = left;
    $('qBar').style.width = '100%';
    status('作答中…（' + total + ' 秒）');

    clearInterval(timer);
    timer = setInterval(function () {
      if (paused) return;
      left--;
      $('qSec').textContent = Math.max(0, left);
      $('qBar').style.width = (left / total * 100) + '%';
      botAnswer(left, total);
      pumpActions();
      renderLights();
      if (left <= 0) { clearInterval(timer); doReveal(); }
    }, 1000);
  }

  function renderLights() {
    $('qLights').innerHTML = Object.keys(state.players).map(function (gid) {
      var p = state.players[gid], a = state.answers[gid];
      var cls = 'light';
      var mark = '⬜';
      if (p.frozen > 0) { mark = '⛔'; }
      else if (a) { cls += ' done'; mark = '✅'; }
      return '<div class="' + cls + '">' + mark + ' ' + p.num + '</div>';
    }).join('');
  }

  /** 沒有平板的組（或單機試玩）由電腦代答，答對率約 70% */
  function botAnswer(left, total) {
    Object.keys(state.players).forEach(function (gid) {
      if (!isBot(gid)) return;
      if (state.answers[gid] || state.players[gid].frozen > 0) return;
      if (Math.random() < 0.28) {
        var q = state.question;
        var correct = Math.random() < 0.7;
        var choice = correct ? q.answer : q.optionKeys.filter(function (k) { return k !== q.answer; })[0];
        E.submitAnswer(state, gid, choice, (total - left) * 1000 + Math.random() * 900);
      }
    });
  }

  /** 處理平板送來的動作 */
  function pumpActions() {
    S.drainLocalQueue().forEach(function (a) { handleAction(a); });
  }

  function handleAction(a) {
    if (!a || !a.gid) return;
    online[a.gid] = Date.now();       // 有訊息＝這組有平板在線上
    switch (a.type) {
      case 'answer': E.submitAnswer(state, a.gid, a.choice, a.timeMs); break;
      case 'hint': E.buyHint(state, a.gid, a.level); break;
      case 'card': E.playCard(state, a.gid, a.cardId, a.target); break;
      case 'buy': E.buyLand(state, a.gid, state.players[a.gid].pos); break;
      case 'build': E.build(state, a.gid, state.players[a.gid].pos, a.times); break;
      case 'merge': if (state.cfg.allowMerge) E.merge(state, a.gid, state.players[a.gid].pos); break;
      case 'deposit': E.deposit(state, a.gid, a.amount); break;
      case 'withdraw': E.withdraw(state, a.gid, a.amount); break;
      case 'loan': E.applyLoan(state, a.gid, a.amount); break;
      case 'repay': E.repayLoan(state, a.gid, a.amount); break;
      case 'shop': E.buyFromShop(state, a.gid, a.cardId); break;
      case 'fork': pendingFork = a.cell; break;
      case 'pick': E.pickCharacter(state, a.gid, a.charId); renderLobby(); break;
      case 'hello': break;            // 只是報到，記錄上線就好
    }
    pushRemote();
  }

  function doReveal() {
    var r = E.reveal(state);
    // 揭曉：標出正解與各組答案
    [].forEach.call($('qOptions').children, function (el) {
      if (el.dataset.k === r.answer) el.classList.add('correct');
    });
    $('qLights').innerHTML = Object.keys(state.players).map(function (gid) {
      var p = state.players[gid], a = state.answers[gid];
      var cls = 'light', mark = '⬜';
      if (p.frozen > 0) mark = '⛔';
      else if (a) { cls += a.correct ? ' correct' : ' wrong'; mark = (a.correct ? '⭕' : '❌') + a.choice; }
      return '<div class="' + cls + '">' + mark + ' ' + p.num + '</div>';
    }).join('');
    status('揭曉！正解 ' + r.answer + '　（可按「暫停講解」）');

    setTimeout(function () {
      if (!r.order.length) { status('這輪沒有人答對，直接結算'); finishRound(); return; }
      showOrder(r.order);
    }, 3000);
  }

  function showOrder(order) {
    var medals = ['🥇', '🥈', '🥉'];
    $('hudOrder').innerHTML = '<h3>本輪行動順序（答對且最快的先走）</h3><div class="order-list">' +
      order.map(function (gid, i) {
        var p = state.players[gid], a = state.answers[gid];
        return '<div class="order-item"><span class="medal">' + (medals[i] || (i + 1) + '.') + '</span>' +
               p.name + '<span class="t">' + (a.timeMs / 1000).toFixed(1) + '秒</span></div>';
      }).join('') + '</div>';
    $('hudOrder').classList.remove('hidden');
    setTimeout(function () {
      $('hudOrder').classList.add('hidden');
      $('hudQuestion').classList.add('hidden');
      runTurns();
    }, 2600);
  }

  // ═══════════════════════════════════════
  // 依序移動
  // ═══════════════════════════════════════
  var pendingFork = null;

  function runTurns() {
    var gid = E.currentGid(state);
    if (!gid) { finishRound(); return; }
    showPlayerHUD(gid);
    R.focusOn(gid, state);
    status(state.players[gid].name + ' 行動中' + (isBot(gid) ? '（電腦代打）' : ''));
    doTurn(gid).then(function () {
      var r = E.endTurn(state);
      updateHUD();
      if (r.roundEnd) finishRound(); else setTimeout(runTurns, 350);
    });
  }

  function doTurn(gid) {
    var p = state.players[gid];
    return rollDiceAnim(gid)
      .then(function () { return walkAll(gid); })
      .then(function () { return settleLanding(gid); });
  }

  function rollDiceAnim(gid) {
    return new Promise(function (res) {
      var r = E.rollDice(state, gid);
      var box = $('hudDice'), sum = $('diceSum');
      box.classList.remove('hidden'); sum.classList.add('hidden');
      var t0 = performance.now(), DUR = 900, done = false, safety;
      function finish() {
        if (done) return;
        done = true; clearTimeout(safety);
        drawDie($('die1'), 130, 120, 96, r.d1, 0);
        drawDie($('die2'), 290, 120, 96, r.d2, 0);
        sum.textContent = r.d1 + ' + ' + r.d2 + ' = ' + r.total;
        sum.classList.remove('hidden');
        setTimeout(function () { box.classList.add('hidden'); res(); }, 800);
      }
      // 保險：背景分頁 rAF 停擺時也要能結束，不然遊戲會卡死
      safety = setTimeout(finish, DUR + 900);
      function fr(t) {
        if (done) return;
        var k = Math.min(1, (t - t0) / DUR), ease = 1 - Math.pow(1 - k, 3);
        drawDie($('die1'), 130, 120, 96, 1 + Math.floor(Math.random() * 6), (1 - ease) * 520);
        drawDie($('die2'), 290, 120, 96, 1 + Math.floor(Math.random() * 6), -(1 - ease) * 460);
        if (k < 1) requestAnimationFrame(fr); else finish();
      }
      requestAnimationFrame(fr);
    });
  }

  var PIPS = { 1: [[.5, .5]], 2: [[.28, .28], [.72, .72]], 3: [[.28, .28], [.5, .5], [.72, .72]],
               4: [[.28, .28], [.72, .28], [.28, .72], [.72, .72]],
               5: [[.28, .28], [.72, .28], [.5, .5], [.28, .72], [.72, .72]],
               6: [[.28, .24], [.72, .24], [.28, .5], [.72, .5], [.28, .76], [.72, .76]] };
  function drawDie(g, cx, cy, s, v, rot) {
    var half = s / 2;
    g.innerHTML = '';
    g.setAttribute('transform', 'translate(' + cx + ',' + cy + ') rotate(' + (rot || 0) + ')');
    g.appendChild(R.el('rect', { x: -half, y: -half, width: s, height: s, rx: s * .19, fill: '#fefefe', stroke: '#cbd5e1', 'stroke-width': 3 }));
    PIPS[v].forEach(function (p) {
      g.appendChild(R.el('circle', { cx: -half + p[0] * s, cy: -half + p[1] * s, r: s * .095, fill: '#0f172a' }));
    });
  }

  function walkAll(gid) {
    var p = state.players[gid];
    R.startWalk(gid);
    function stepOnce() {
      if (p.stepsLeft <= 0) { R.stopWalk(gid); return Promise.resolve(); }
      var r = E.step(state, gid);
      if (r.needFork) {
        R.stopWalk(gid);
        return askFork(gid, r.options).then(function (choice) {
          var from = p.pos;
          E.commitStep(state, gid, choice);
          R.startWalk(gid);
          return R.hop(gid, from, choice).then(stepOnce);
        });
      }
      var from = r.moved ? p.prev : p.pos;
      return R.hop(gid, from, p.pos).then(function () {
        if (r.events) r.events.forEach(function (ev) {
          if (ev.type === 'barrier') toast('🚧 撞上工安圍籬，強制停下');
          if (ev.type === 'virusPass') toast('💣 病毒傳染給 ' + state.players[ev.to].name + '！');
          if (ev.type === 'godBuild') toast('🏗️ 建廠之神：經過自己的地自動升級');
        });
        return stepOnce();
      });
    }
    return stepOnce();
  }

  function askFork(gid, options) {
    return new Promise(function (res) {
      pendingFork = null;
      var names = options.map(function (o) { return B.CELLS[o].name; }).join(' 或 ');
      toast('⛰️ 岔路口：' + names + '（等該組選擇）', 3200);
      if (isBot(gid)) { setTimeout(function () { res(options[Math.floor(Math.random() * options.length)]); }, 900); return; }
      var t0 = Date.now();
      var iv = setInterval(function () {
        pumpActions();
        if (pendingFork != null && options.indexOf(pendingFork) >= 0) {
          clearInterval(iv); var c = pendingFork; pendingFork = null; res(c);
        } else if (Date.now() - t0 > 3500) {          // 逾時走主環
          clearInterval(iv); res(options[0]);
        }
      }, 200);
    });
  }

  function settleLanding(gid) {
    var out = E.landOn(state, gid);
    var p = state.players[gid];
    var cell = B.CELLS[p.pos];
    var lines = [];

    out.events.forEach(function (ev) {
      if (ev.type === 'rent') lines.push('付過路費 $' + ev.amount.toLocaleString() + ' 給 ' + state.players[ev.owner].name);
      if (ev.type === 'rp') lines.push('研發點數 +' + ev.amount);
      if (ev.type === 'tax') lines.push('繳營所稅 $' + ev.amount.toLocaleString());
      if (ev.type === 'pool') lines.push('領走補助池 $' + ev.amount.toLocaleString());
      if (ev.type === 'jail') lines.push('被押去檢調約談所，停 1 輪');
      if (ev.type === 'pardon') lines.push('用免罪卡躲過稽查');
      if (ev.type === 'god') lines.push('被' + ev.name + '附身 3 輪');
      if (ev.type === 'news') lines.push(ev.text);
      if (ev.type === 'card') lines.push('抽到一張卡片');
      if (ev.type === 'license') lines.push('用技術授權卡免付過路費');
      if (ev.type === 'bounce') lines.push('彈回卡把 $' + ev.amount.toLocaleString() + ' 拿回來');
      if (ev.type === 'radiation') lines.push('踩到輻射區，扣 $' + ev.amount.toLocaleString());
      if (ev.type === 'shop') lines.push('進入創投商店（第 ' + p.num + ' 組購買中…）');
      if (ev.type === 'bank') lines.push('來到銀行，可以存提款或申請貸款');
    });

    // 買地／蓋廠：單機模式自動決策，多人模式等平板
    if (out.canBuy) {
      if (isBot(gid)) {
        if (p.cash - out.buyPrice > 15000 && E.buyLand(state, gid, p.pos).ok) lines.push('買下 ' + cell.name);
      } else lines.push('可以買下 ' + cell.name + '（$' + out.buyPrice.toLocaleString() + '）');
    }
    if (out.canBuild) {
      if (isBot(gid)) {
        var r = E.build(state, gid, p.pos, 99);
        if (r.ok) lines.push('蓋到 ' + B.LEVEL_NAME[r.level]);
      } else lines.push('可以蓋廠（每級 $' + out.upgradeCost.toLocaleString() + '）');
    }

    R.drawBoard(state);
    R.drawPlayers(state);
    Object.keys(state.players).forEach(function (g) { R.placePiece(g, state.players[g].pos, 0); });
    R.focusOn(gid, state);
    showPlayerHUD(gid);

    if (lines.length) toast(p.num + '組｜' + lines.join('　·　'), 2800);
    return new Promise(function (res) { setTimeout(res, lines.length ? 1600 : 500); });
  }

  function finishRound() {
    var r = E.endRound(state);
    updateHUD();
    R.drawBoard(state);
    R.drawPlayers(state);
    var interest = r.events.filter(function (e) { return e.type === 'interest' && e.amount > 0; });
    if (interest.length) toast('🏦 銀行發放存款利息（' + interest.length + ' 組）', 2000);
    r.events.forEach(function (e) {
      if (e.type === 'virusBoom') toast('💥 ' + state.players[e.gid].name + ' 身上的病毒爆炸！' + e.cells.length + ' 座廠房降級', 3200);
      if (e.type === 'charCard') toast('🎴 ' + state.players[e.gid].name + ' 獲得角色專屬卡', 1600);
    });
    S.save(state);
    busy = false;
    if (r.ended) { endSession(); return; }
    status('第 ' + state.round + ' 輪結束，按「開始這一輪」繼續');
  }

  function endSession() {
    clearInterval(timer);
    clearInterval(gamePump);
    S.save(state);
    var rank = E.ranking(state);
    $('hudQuestion').classList.add('hidden');
    $('hudRank').innerHTML = '<h3>🏆 本節結束 · 目前總財富排名</h3>' +
      rank.map(function (x, i) {
        var p = state.players[x.gid];
        return '<div class="rank-row"><span class="no">' + (i + 1) + '</span>' +
               '<span class="nm">' + p.name + '</span>' +
               '<span class="wl">$' + x.wealth.toLocaleString() + '</span></div>';
      }).join('') +
      '<div style="margin-top:14px;font-size:14px;color:#93a4bb">已自動存檔，下次可以接著玩。期末再看總財富定勝負。</div>';
    $('hudRank').classList.remove('hidden');
    status('本節結束，已存檔');
    busy = true;
  }

  // ═══════════════════════════════════════
  window.addEventListener('DOMContentLoaded', buildSetup);
})();
