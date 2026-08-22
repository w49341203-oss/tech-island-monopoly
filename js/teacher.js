/* 科技島大富翁 — 老師端（投影白板）
 * 畫面只有地圖，所有資訊用 HUD 疊在上面
 * 老師端是「主機」：所有遊戲邏輯在這裡運算，平板只送動作意圖
 */
(function () {
  'use strict';

  var B = window.BOARD, E = window.ENGINE, Q = window.QUESTIONS,
      R = window.RENDER, S = window.STORE, CARD = window.CARDS;

  var state = null;
  var cfg = { chapters: [], groups: 9, maxRounds: 30, breakSec: 60,
              allowMerge: true, allowSabotage: true, solo: false, speed: 1, autoPilot: true,
              decideSec: 8, itemSec: 30 };
  var greeted = {};             // 哪幾組已經響過「連進來」的提示音
  var everOnline = {};          // 哪幾組「整場曾經」連上過平板（斷線也算數）
  var lastActionAt = {};        // 每組最後處理過的動作時間戳（防止同一筆被執行兩次）
  var roomCode = null;          // 這一場的房間代碼（投影給學生輸入）
  var online = {};              // gid -> 最後一次收到該組訊息的時間
  // 平板每 15 秒回報一次。放到 120 秒代表可以連漏 7 次才判定離線 ——
  // 學生把平板放下、iPad 鎖屏時定時器會被凍結，抓太緊會誤判成「這組沒平板」，
  // 電腦就會代打出一張沒人選過的牌。
  var ONLINE_TIMEOUT = 120000;
  var timer = null, paused = false, busy = false, lobbyPump = null, gamePump = null;

  // 各階段的倒數計時器都登記在這裡。按「結束本節」時要能一次全部停掉，
  // 否則休息面板會留在畫面上跟排名疊在一起，遊戲也會在背景偷偷跑下一輪。
  var phaseTimers = [];
  var sessionOver = false;

  function regTimer(id) { phaseTimers.push(id); return id; }
  function clearPhaseTimers() {
    phaseTimers.forEach(function (id) { clearInterval(id); clearTimeout(id); });
    phaseTimers = [];
  }
  /** 把所有會蓋在地圖上的面板收起來 */
  function hideAllPanels() {
    ['hudBreak', 'hudItemPhase', 'hudCast', 'hudQuestion', 'hudOrder', 'hudDice', 'hudPlayer']
      .forEach(function (id) { var e = $(id); if (e) e.classList.add('hidden'); });
  }
  // 「開放破壞類道具」開關關掉時，這些卡片道具一律無效
  var SABOTAGE_CARDS = ['virus', 'barrier', 'demolish', 'quake', 'blackout',
                        'radiate', 'apple', 'compress', 'brownout'];
  var $ = function (id) { return document.getElementById(id); };

  // ═══════════════════════════════════════
  // 設定畫面
  // ═══════════════════════════════════════
  function buildSetup() {
    refreshSaves();

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

    $('breakSec').onchange = function () { cfg.breakSec = +this.value; };
    $('decideSec').onchange = function () { cfg.decideSec = +this.value; };
    $('animSpeed').onchange = function () { cfg.speed = +this.value; R.setSpeed(cfg.speed); };
    $('groupCount').onchange = function () { cfg.groups = +this.value; };
    $('maxRounds').onchange = function () { cfg.maxRounds = +this.value; };
    $('allowMerge').onchange = function () { cfg.allowMerge = this.checked; };
    $('allowSabotage').onchange = function () { cfg.allowSabotage = this.checked; };
    $('autoPilot').onchange = function () { cfg.autoPilot = this.checked; };

    $('btnNew').onclick = function () { goFullscreen(); startNew(false); };
    $('btnSolo').onclick = function () { goFullscreen(); startNew(true); };
    $('btnLoadCode').onclick = function () {
      var code = ($('codeInput').value || '').replace(/\D/g, '');
      if (code.length !== 6) { msg('請輸入 6 位數的場次編號', 'err'); return; }
      goFullscreen();
      doLoad(code);
    };
    $('codeInput').onkeydown = function (e) { if (e.key === 'Enter') $('btnLoadCode').click(); };
  }

  /** 這台電腦存過的場次，最近玩的排前面；點一下就接續 */
  function refreshSaves() {
    var box = $('savePicker');
    box.innerHTML = '';
    var saves = S.listSaves();
    if (!saves.length) {
      box.innerHTML = '<span class="hint">這台電腦還沒有存過的場次</span>';
      return;
    }
    saves.forEach(function (s) {
      var b = document.createElement('div');
      b.className = 'chip save-chip';
      var when = s.savedAt ? s.savedAt.slice(5, 10).replace('-', '/') : '';
      b.innerHTML = '<b>' + s.code + '</b>　第 ' + s.round + ' 輪 · ' + s.groups + ' 組' +
                    (s.label ? '<br><span style="font-size:12px;opacity:.75">' + s.label + '</span>' : '') +
                    (when ? '<br><span style="font-size:12px;opacity:.6">' + when + ' 玩過</span>' : '') +
                    '<span class="del" title="刪掉這一場">✕</span>';
      b.onclick = function (e) {
        if (e.target.classList.contains('del')) {
          if (!confirm('確定要刪掉編號 ' + s.code + ' 這一場嗎？（第 ' + s.round + ' 輪的進度會消失）')) return;
          S.deleteSave(s.code);
          refreshSaves();
          return;
        }
        goFullscreen();
        doLoad(s.code);
      };
      box.appendChild(b);
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
    msg('正在開新場次…', '');

    // 先跟雲端要一組沒有人用過的編號，這組編號就是這一場的身分證：
    // 學生輸入它進場、雲端資料用它當檔名、本機存檔也用它。
    var prep = (!solo && S.firebaseReady())
      ? S.initFirebase().then(function () { S.setMode('firebase', null); return S.reserveCode(); })
                        .catch(function () { return S.makeCode(); })
      : Promise.resolve(S.makeCode());

    prep.then(function (code) {
      state = E.createGame({
        groups: cfg.groups, code: code,
        maxRounds: cfg.maxRounds, chapters: cfg.chapters,
        seed: Date.now() % 2147483647
      });
      state.cfg = { allowMerge: cfg.allowMerge, allowSabotage: cfg.allowSabotage, solo: solo };
      openRoom(solo);
    });
  }

  /**
   * 舊存檔補欄位。
   * 遊戲一直在加新功能，之前存的檔可能沒有新欄位；
   * 這裡先一次補齊，避免讀了舊檔玩到一半才因為少一個欄位當掉。
   */
  function migrateSave(st) {
    st.board = st.board || {};
    ['owner', 'level', 'barrier', 'radiation'].forEach(function (k) {
      if (!st.board[k]) st.board[k] = {};
    });
    st.cfg = st.cfg || {};
    st.chapters = st.chapters || [];
    st.answers = st.answers || {};
    st.order = st.order || [];
    st.itemReady = {};
    st.pendingCards = [];
    Object.keys(st.players || {}).forEach(function (g) {
      var p = st.players[g];
      p.buff = p.buff || {};
      p.cards = p.cards || [];
      p.cash = p.cash || 0;
      p.bank = p.bank || 0;
      p.rp = p.rp || 0;
      p.loan = p.loan || 0;
      p.playedThisRound = 0;
    });
    return st;
  }

  function doLoad(code) {
    code = String(code || '');
    var local = S.load(code);
    if (local) { finishLoad(local, code); return; }

    // 本機沒有這一場（例如換了一台電腦），就問雲端
    msg('這台電腦沒有這一場，正在向雲端查詢…', '');
    if (!S.firebaseReady()) { msg('找不到編號 ' + code + ' 的存檔', 'err'); return; }
    S.initFirebase().then(function () {
      S.setMode('firebase', S.makeGameId(code));
      return S.loadCloud(code);
    }).then(function (cloud) {
      if (!cloud || !cloud.players) { msg('雲端也找不到編號 ' + code + ' 這一場', 'err'); return; }
      msg('從雲端找到了！第 ' + (cloud.round || 0) + ' 輪', 'ok');
      finishLoad(cloud, code);
    }).catch(function (e) {
      msg('雲端查詢失敗：' + e.message, 'err');
    });
  }

  function finishLoad(st, code) {
    state = migrateSave(st);
    state.code = code;
    if (!state.nonce) state.nonce = Date.now().toString(36);   // 舊存檔沒有識別碼，補上
    state.nonce = state.nonce + '_r';         // 換一個識別碼，平板才知道是新的一場連線

    // 續玩：組數、角色、資產全部沿用存檔，不用重選。
    // 章節可以換（這次要考哪幾章由老師決定），沒勾就沿用存檔原本的。
    cfg.groups = Object.keys(st.players).length;
    cfg.solo = false;
    if (cfg.chapters.length) state.chapters = cfg.chapters;
    else cfg.chapters = st.chapters || [];
    if (!cfg.chapters.length) { msg('請先勾選這次要考的章節', 'err'); return; }

    // 這一節的回合數重新算：從目前輪數再往後跑 maxRounds 輪
    state.maxRounds = st.round + cfg.maxRounds;
    state.cfg = state.cfg || {};
    state.cfg.allowMerge = cfg.allowMerge;
    state.cfg.allowSabotage = cfg.allowSabotage;
    state.phase = 'waiting';

    msg('讀取成功：編號 ' + code + '、第 ' + st.round + ' 輪、' + cfg.groups + ' 組', 'ok');
    Q.load(cfg.chapters).then(function () {
      openRoom(false);            // 續玩也要開新房間，學生才連得進來
    }).catch(function (e) { msg('題庫載入失敗：' + e.message, 'err'); });
  }

  /**
   * 開房間：產生一組 6 位數代碼投影給學生輸入。
   * 為什麼要代碼：如果用「班級＋存檔槽」當房間識別，兩位老師都選「智班槽1」就會撞在一起。
   */
  function openRoom(solo) {
    sessionOver = false;
    clearPhaseTimers();
    online = {}; everOnline = {}; greeted = {}; lastActionAt = {};   // 新的一場重新認人
    var code = state.code;
    var gameId = S.makeGameId(code);

    function finish(c) {
      roomCode = c;
      S.initChannel(c);                     // 同一台電腦多分頁用編號當頻道名
      goLobby();
    }

    if (!solo && S.firebaseReady()) {
      msg('連線中…', '');
      S.initFirebase().then(function () {
        S.setMode('firebase', gameId);
        S.setWriteErrorHandler(function (e) {
          var denied = /permission|insufficient/i.test(e.message || '');
          toast(denied
            ? '⚠️ 雲端拒絕寫入：這一場正被另一台電腦開著，請關掉那一台再試'
            : '⚠️ 雲端連線有問題，平板可能看不到最新畫面', 6000);
        });
        S.watchActions(function (a) { handleAction(a); S.clearAction(a.gid); });
        return S.openRoom(code, { groups: cfg.groups });
      }).then(function () {
        pushRemote();
        finish(code);
      }).catch(function (e) {
        // 連不上雲端時要講清楚：這種狀況學生是連不進來的，不能讓老師以為投影出去就好
        msg('連不上雲端，這一場只能單機玩（學生的平板連不進來）：' + e.message, 'err');
        S.setMode('local', gameId);
        cfg.solo = true;
        finish(code);
      });
    } else {
      S.setMode('local', gameId);
      finish(code);
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

    var resuming = state.round > 0;
    $('lobbyTitle').textContent = resuming
      ? '續玩第 ' + state.round + ' 輪　·　角色與資產都保留'
      : '然後選擇你們的科學家';
    $('btnStart').textContent = resuming ? '大家都連上了，繼續遊戲' : '全部選好了，開始遊戲';
    $('btnAutoPick').style.display = resuming ? 'none' : '';

    renderLobby();
    pushRemote();
    clearInterval(lobbyPump);
    lobbyPump = setInterval(function () {
      var q = S.drainLocalQueue();
      if (q.length) { q.forEach(handleAction); renderLobby(); }
      pushRemote();                     // 定期廣播，晚加入的平板才收得到
    }, 700);
    bindMute();
    BGM.play('lobby');
    $('btnAutoPick').onclick = autoPick;
    $('btnStart').onclick = function () { goFullscreen(); startGame(); };
    if (cfg.solo) autoPick();
  }

  function bindMute() {
    var b = $('btnMute');
    if (!b || b._bound) return;
    b._bound = true;
    function paint() { b.textContent = SOUND.isEnabled() ? '🔊' : '🔇'; }
    paint();
    b.onclick = function () {
      var on = !SOUND.isEnabled();
      SOUND.setEnabled(on);
      BGM.setEnabled(on);
      if (on) BGM.play(bgmForPhase()); else BGM.stop();
      paint();
    };
  }

  /** 現在該放哪一首 */
  function bgmForPhase() {
    if (!state) return 'lobby';
    if (state.phase === 'ended') return 'win';
    if (state.phase === 'question') return 'quiz';
    if (!$('game') || $('game').classList.contains('hidden')) return 'lobby';
    return 'game';
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
      var extra = state.round > 0
        ? '<div class="w">💰 $' + p.cash.toLocaleString() + '　🏭 ' +
          E.landsOf(state, gid).length + ' 塊地</div>'
        : '';
      if (ch) {
        var url = 'images/characters/char_' + (ch.num < 10 ? '0' : '') + ch.num + '_' + ch.id + '_idle.png';
        d.innerHTML =
          '<div class="ph" style="width:100px;height:150px;display:flex;align-items:center;' +
          'justify-content:center;font-size:52px;background:' + ch.color + '33;border-radius:12px">' + ch.emoji + '</div>' +
          '<img src="' + url + '" style="display:none" alt="">' +
          '<div class="g">第 ' + p.num + ' 組</div><div class="c">' + ch.name + '</div>' + extra;
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
    $('hudCode').textContent = roomCode ? '場次編號 ' + roomCode : '';
    clearInterval(gamePump);
    gamePump = setInterval(function () {
      var q = S.drainLocalQueue();
      if (q.length) q.forEach(handleAction);
      pushRemote();                     // 心跳：平板隨時都能同步到最新狀態
    }, 900);
    BGM.play('game');
    status('連線模式：' + (S.getMode() === 'firebase' ? '雲端（平板可跨裝置連入）' : '本機'));
    setTimeout(runRound, 1200);        // 自動開始，不用按按鈕
  }

  var autoPaused = false;

  function bindBar() {
    $('btnPause').onclick = function () {
      autoPaused = !autoPaused;
      $('btnPause').textContent = autoPaused ? '▶ 繼續' : '⏸ 暫停';
      status(autoPaused ? '已暫停（這一輪跑完會停在這裡）' : '繼續自動進行');
      if (!autoPaused && !busy) runRound();
    };
    $('btnRank').onclick = toggleRank;
    $('btnZoom').onclick = function () {
      var on = R.setZoomOut(!R.isZoomOut());
      $('btnZoom').textContent = on ? '🔍 回到跟隨' : '🗺️ 全島';
      if (!on && state.order.length) R.focusOn(E.currentGid(state) || Object.keys(state.players)[0], state);
    };
    $('btnSave').onclick = function () {
      var r = autoSave();
      if (r.ok) status('已存檔（編號 ' + state.code + '）');
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

  /**
   * 進入全螢幕。瀏覽器規定只能由使用者的點擊觸發，
   * 所以綁在「開新遊戲／開始遊戲」這些按鈕上。失敗就顯示一個提示讓老師手動點。
   */
  function goFullscreen() {
    var el = document.documentElement;
    if (document.fullscreenElement) return;
    var req = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (!req) return;
    try {
      var p = req.call(el);
      if (p && p.catch) p.catch(function () { showFsTip(); });
    } catch (e) { showFsTip(); }
  }

  function showFsTip() {
    if (document.getElementById('fsTip')) return;
    var tip = document.createElement('div');
    tip.id = 'fsTip';
    tip.className = 'fs-tip';
    tip.textContent = '⛶ 點這裡切換全螢幕（投影建議全螢幕）';
    tip.onclick = function () { goFullscreen(); tip.remove(); };
    document.body.appendChild(tip);
    setTimeout(function () { if (tip.parentNode) tip.remove(); }, 12000);
  }

  /** 把狀態同時推給：同機分頁（BroadcastChannel）與雲端（Firestore） */
  var pushTimer = null;
  var lastPushSig = '';

  function pushRemote() {
    // 序號：平板同時從雲端和同機分頁收狀態，晚到的舊狀態如果覆蓋新的，
    // 畫面會倒退（例如選好角色又跳回選角）。加序號讓平板能分辨新舊。
    // 用時間當序號基準：萬一老師不小心開了兩個分頁，兩邊的序號才比得出先後，
    // 不會讓平板整批丟掉其中一邊的狀態（畫面就會卡在舊的那一份）。
    state._seq = Math.max((state._seq || 0) + 1, Date.now());
    window.__pushCalls = (window.__pushCalls || 0) + 1;
    window.__st = state;                       // 診斷用
    // 送出去的是「公開版」狀態：不含正確答案，防止學生開主控台偷看
    S.broadcastState(E.publicState(state));
    if (S.getMode() === 'firebase') {
      clearTimeout(pushTimer);                 // 節流：避免每個小動作都寫一次 Firestore
      pushTimer = setTimeout(function () {
        var pub = E.publicState(state);
        delete pub.log;                        // 訊息紀錄只有白板在看，平板用不到，別浪費流量

        // 心跳每 0.9 秒跑一次，但大部分時候畫面根本沒變。
        // 內容一樣就不要再寫一次 —— 這件事決定了 Firebase 免費額度夠不夠用：
        // 每寫一次，全班每台平板就要讀一次，寫太勤一節課就把一整天的額度用光。
        // 比對時要忽略這些欄位：它們一直在變，但平板畫面上完全用不到，
        // 為了它們多寫一次雲端，全班每台平板就要多讀一次，非常不划算。
        // （欄位本身還是照送，換電腦續玩時需要它們）
        var vol = {};
        ['_seq', 'seed', '_savedAt', 'usedQuestions'].forEach(function (k) {
          vol[k] = pub[k]; delete pub[k];
        });
        var sig = JSON.stringify(pub);
        Object.keys(vol).forEach(function (k) { pub[k] = vol[k]; });
        if (sig === lastPushSig) return;

        window.__pushWrites = (window.__pushWrites || 0) + 1;
        S.pushState(pub).then(function (ok) {
          // 只有真的寫進去才記住簽章。
          // 以前不管成不成功都先記起來，網路瞬斷的那一次如果剛好是「題目出現」，
          // 全班就整輪看不到題目，而且永遠不會補送。
          if (ok) { lastPushSig = sig; window.__pushOk = (window.__pushOk || 0) + 1; }
          else { window.__pushErr = '寫入被拒或失敗'; }
        });
      }, 400);
    }
  }

  /**
   * 電腦代打的組也要會用道具。
   * 不然一個班如果平板不夠，沒平板的那幾組手牌會愈積愈多卻從來不出，白白吃虧。
   */
  function botPlayCards() {
    Object.keys(state.players).forEach(function (gid) {
      if (!isBot(gid)) return;
      // 只要這一組整場曾經連上過平板，就永遠不幫他們出牌。
      // 平板只要漏兩次心跳（分頁切到背景、網路卡一下）就會被判定離線，
      // 這時電腦代打會出一張學生沒選過的牌，學生會完全不知道發生什麼事。
      // 少出一張牌沒關係，出了一張沒人選的牌才是災難。
      if (everOnline[gid] && !cfg.solo) return;
      var p = state.players[gid];
      if (!p.cards.length) return;
      if (Math.random() < 0.45) return;          // 不是每輪都出，留一點變化
      var pick = botPickCard(gid);
      if (pick) {
        handleAction({ type: 'card', gid: gid, cardId: pick.id, target: pick.target, bot: true });
      }
    });
  }

  /** 幫代打的組挑一張現在出得掉的卡，順便配好目標 */
  function botPickCard(gid) {
    var p = state.players[gid];
    var others = Object.keys(state.players).filter(function (g) { return g !== gid; });
    var pool = p.cards.slice().sort(function () { return Math.random() - 0.5; });

    for (var i = 0; i < pool.length; i++) {
      var c = pool[i], def = CARD.get(c.id, c.char);
      if (!def) continue;
      if (def.when === '自動觸發' || def.timing === 'onQuestion') continue;
      if (state.cfg && state.cfg.allowSabotage === false && SABOTAGE_CARDS.indexOf(c.id) >= 0) continue;

      var target = null;
      if (c.id === 'dice') {
        target = { steps: 2 + Math.floor(Math.random() * 11) };
      } else if (def.needTarget === 'player') {
        if (!others.length) continue;
        target = { gid: others[Math.floor(Math.random() * others.length)] };
      } else if (def.needTarget === 'ownLand') {
        var mine = E.landsOf(state, gid);
        if (!mine.length) continue;
        target = { cell: mine[Math.floor(Math.random() * mine.length)] };
      } else if (def.needTarget === 'enemyLand') {
        var foe = [];
        B.CELLS.forEach(function (cc, k) {
          var o = state.board.owner[k];
          if (o && o !== gid) foe.push(k);
        });
        if (!foe.length) continue;
        target = { cell: foe[Math.floor(Math.random() * foe.length)] };
      } else if (def.needTarget === 'cell') {
        target = { cell: (p.pos + 1 + Math.floor(Math.random() * 8)) % B.CELLS.length };
      } else if (def.needTarget === 'color') {
        var cols = Object.keys(B.COLORS);
        target = { color: cols[Math.floor(Math.random() * cols.length)] };
      }
      return { id: c.id, target: target };
    }
    return null;
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

  /** 道具階段：把誰用了什麼卡顯示在白板上（她要看得到效果） */
  function announceCard(text) {
    var log = $('ipLog');
    if (log && !$('hudItemPhase').classList.contains('hidden')) {
      var d = document.createElement('div');
      d.textContent = text;
      log.insertBefore(d, log.firstChild);
      while (log.children.length > 6) log.removeChild(log.lastChild);
    }
    toast(text, 2200);
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
  /** 一輪的完整流程：道具階段 → 出題 → 揭曉 → 依序行動 → 結算 → 自動下一輪 */
  function runRound() {
    if (sessionOver) { busy = false; return; }
    if (autoPaused) { busy = false; return; }
    if (state.phase === 'ended' || state.round >= state.maxRounds) { endSession(); return; }
    busy = true;
    $('hudOrder').classList.add('hidden');
    $('hudRank').classList.add('hidden');
    roundBreak().then(itemPhase).then(nextRound);
  }

  /**
   * 輪與輪之間的休息。
   * 上課實測太趕——學生還在看白板發生什麼事，下一輪就開始了。
   * 預設倒數 60 秒，老師也可以設成「手動」，講解完再按下一輪。
   * 倒數中隨時可以按「開始下一輪」提早進入，不用等完。
   */
  function roundBreak() {
    if (state.round === 0) return Promise.resolve();     // 第一輪不用休息，直接開始
    var sec = cfg.breakSec == null ? 60 : cfg.breakSec;
    var manual = (sec === 0);

    var box = $('hudBreak');
    $('bkTitle').textContent = '第 ' + state.round + ' 輪結束';
    $('bkRank').innerHTML = E.ranking(state).slice(0, 5).map(function (x, i) {
      var p = state.players[x.gid];
      return '<div class="bk-p' + (i === 0 ? ' top' : '') + '">' +
             (i === 0 ? '🥇 ' : (i + 1) + '. ') + p.name +
             '　$' + x.wealth.toLocaleString() + '</div>';
    }).join('');

    // 平板上也要看得到現在在休息，不然學生會以為當機了
    state.phase = 'break';
    state.breakUntil = manual ? null : (Date.now() + sec * 1000);
    pushRemote();

    box.classList.remove('hidden');
    status(manual ? '休息中（等老師按下一輪）' : '休息 ' + sec + ' 秒');

    return new Promise(function (resolve) {
      var left = sec, iv = null, done = false;

      function finish() {
        if (done) return;
        done = true;
        clearInterval(iv);
        box.classList.add('hidden');
        delete state.breakUntil;
        state.phase = 'waiting';
        pushRemote();          // 立刻告訴平板休息結束，不要等下一次心跳才更新
        SOUND.play('click');
        resolve();
      }

      $('btnNextRound').onclick = finish;

      if (manual) {
        $('bkSec').textContent = '等老師按「開始下一輪」';
        $('bkSec').classList.add('manual');
        $('bkHint').textContent = '可以趁現在講解上一題，學生也能看地圖';
        // 手動模式也要持續處理平板送來的動作（例如查看地圖、銀行操作）
        iv = regTimer(setInterval(function () { pumpActions(); pushRemote(); }, 900));
        return;
      }

      $('bkSec').classList.remove('manual');
      $('bkSec').textContent = left;
      $('bkHint').textContent = '休息一下，時間到會自動開始（想提早開始就按下面的按鈕）';
      iv = regTimer(setInterval(function () {
        pumpActions();
        if (autoPaused) return;
        left--;
        $('bkSec').textContent = Math.max(0, left);
        if (left <= 5 && left > 0) SOUND.play('tickFast');
        pushRemote();
        if (left <= 0) finish();
      }, 1000));
    });
  }

  /** 道具階段：固定秒數，各組在平板上出牌，白板顯示倒數與誰用了什麼 */
  function itemPhase() {
    if (sessionOver) return Promise.resolve();
    // 全班都沒有平板連進來（單機試玩）就不用等 30 秒，直接短暫帶過
    var anyTablet = Object.keys(state.players).some(isOnline);
    var sec = anyTablet ? (cfg.itemSec || 30) : 4;
    if (!sec) return Promise.resolve();
    var box = $('hudItemPhase');
    $('ipLog').innerHTML = '';
    box.classList.remove('hidden');
    state.phase = 'item';
    state.itemUntil = Date.now() + sec * 1000;
    state.itemReady = {};
    state.pendingCards = [];      // 防呆：上一輪如果有殘留，不要帶到這一輪才播
    Object.keys(state.players).forEach(function (g) { state.players[g].playedThisRound = 0; });
    SOUND.play('itemPhase');
    botPlayCards();                       // 沒有平板的組由電腦幫忙出牌
    pushRemote();
    status('道具時間　' + sec + ' 秒');

    return new Promise(function (resolve) {
      var left = sec;
      $('ipSec').textContent = left;
      var iv = regTimer(setInterval(function () {
        pumpActions();
        if (autoPaused) return;
        left--;

        // 在線的組全部表態完就提早結束（沒有平板的組不算，他們不會出牌）
        var onlineGids = Object.keys(state.players).filter(isOnline);
        var allReady = onlineGids.length > 0 && onlineGids.every(function (g) {
          return state.itemReady[g] || (state.players[g].playedThisRound || 0) >= 2;
        });
        if (allReady) left = 0;

        $('ipSec').textContent = Math.max(0, left);
        var waiting = onlineGids.filter(function (g) {
          return !state.itemReady[g] && (state.players[g].playedThisRound || 0) < 2;
        });
        $('ipHint').textContent = onlineGids.length
          ? (waiting.length ? '等待 ' + waiting.map(function (g) { return state.players[g].num + '組'; }).join('、')
                            : '大家都好了！')
          : '目前沒有平板連進來，由電腦代打';

        if (left <= 0) {
          clearInterval(iv);
          box.classList.add('hidden');
          delete state.itemUntil;
          // 這一段是在播放效果動畫（每張 2.6 秒，九張可能播 20 秒以上）。
          // 階段要換掉，否則這期間學生點的牌會被排進佇列、拖到「下一輪」才公布——
          // 那一輪學生根本沒碰平板，白板卻說他用了卡。
          state.phase = 'cast';
          pushRemote();        // 立刻告訴平板道具時間結束
          castQueuedCards().then(resolve);
        }
      }, 1000));
    });
  }

  /**
   * 依「出牌先後順序」一張一張播放道具效果。
   * 每張顯示：誰出的、什麼卡、效果說明、實際結果，然後才真的生效。
   */
  function castQueuedCards() {
    var queue = state.pendingCards || [];
    state.pendingCards = [];
    if (!queue.length) return Promise.resolve();

    var box = $('hudCast');
    status('公布道具效果…');

    return queue.reduce(function (chain, item, idx) {
      return chain.then(function () {
        var p = state.players[item.gid];
        var def = CARD.get(item.cardId, item.char);
        if (!p || !def) return;

        // 放回手牌讓 playCard 正常走一次完整流程（它會再移除）
        p.cards.push({ id: item.cardId, char: item.char });
        var r = E.playCard(state, item.gid, item.cardId, item.target);

        var tgt = '';
        if (item.target) {
          if (item.target.gid && state.players[item.target.gid]) tgt = '→ ' + state.players[item.target.gid].name;
          else if (item.target.cell != null) tgt = '→ ' + B.CELLS[item.target.cell].name;
          else if (item.target.color && B.COLORS[item.target.color]) tgt = '→ ' + B.COLORS[item.target.color].name + '園區';
          else if (item.target.steps) tgt = '→ 指定 ' + item.target.steps + ' 點';
        }

        $('castNo').textContent = '道具效果　' + (idx + 1) + ' / ' + queue.length;
        $('castWho').textContent = p.name + '　' + tgt;
        $('castCard').textContent = def.emoji + ' ' + def.name;
        $('castDesc').textContent = def.desc;
        $('castResult').textContent = castResultText(r, def, item);
        SOUND.play(cardSound(def, r));
        box.classList.remove('hidden');

        R.drawBoard(state); R.drawPlayers(state); R.updateMinimap(state);
        pushRemote();
        return new Promise(function (res) { setTimeout(res, 2600); });
      });
    }, Promise.resolve()).then(function () {
      box.classList.add('hidden');
      pushRemote();
    });
  }

  /**
   * 白板上要寫出「這張卡到底做了什麼」。
   * 除了有實際金額的幾張之外，一律直接用卡片自己的說明文字——
   * 這樣以後改卡片效果時，白板上的字會自動跟著對，不會變成錯的舊說明。
   */
  /** 哪一種卡配哪一種聲音（破壞類要聽得出來被打到了） */
  function cardSound(def, r) {
    if (r && r.blocked) return 'block';
    if (def.id === 'quake') return 'quake';
    if (def.id === 'equalize') return 'equalize';
    if (def.id === 'virus' || def.id === 'demolish' || def.id === 'blackout' ||
        def.id === 'brownout' || def.id === 'radiate' || def.id === 'transfer' ||
        def.id === 'compress' || def.id === 'apple') return 'hit';
    if (def.id === 'massprod') return 'build';
    if (def.id === 'bailout' || def.id === 'poach') return 'income';
    return 'card';
  }

  function castResultText(r, def, item) {
    if (!r) return '';
    if (r.blocked) return '🛡️ 被對方的絕緣卡擋下來了！（絕緣卡是自動觸發，不用學生點）';
    if (!r.ok) return '⚠️ ' + (r.msg || '沒有生效');

    // 有具體數字的，報數字最清楚
    if (def.id === 'equalize') return '全體現金平分為 $' + (r.avg || 0).toLocaleString();
    if (def.id === 'poach')    return '搶走 $' + (r.amount || 0).toLocaleString();
    if (def.id === 'bailout')  return '獲得 $20,000';
    if (def.id === 'dice')     return '這一輪走 ' + (r.fixedDice || (item.target && item.target.steps)) + ' 步';

    var t = item.target || {};
    var where = '';
    if (t.gid && state.players[t.gid]) where = '對 ' + state.players[t.gid].name + '　';
    else if (t.cell != null && B.CELLS[t.cell]) where = B.CELLS[t.cell].name + '　';
    else if (t.color && B.COLORS[t.color]) where = B.COLORS[t.color].name + '園區　';
    // 白板只停 2.6 秒，說明取「第一句」就好，太長全班讀不完
    var short = String(def.desc || '').split('。')[0];
    if (short.length > 34) short = short.slice(0, 34) + '…';
    return where + short + '。';
  }

  function nextRound() {
    if (sessionOver) return;
    if (state.phase === 'ended' || state.round >= state.maxRounds) { endSession(); return; }
    SOUND.play('round');
    BGM.play('game');
    busy = true;

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

  /** 預測卡發動：換掉這一題，全班重新作答 */
  function redrawQuestion() {
    var q = Q.draw({ used: state.usedQuestions, rnd: Math.random });
    if (!q) return;
    q = Q.shuffleOptions(q, Math.random);
    clearInterval(timer);
    state.question = q;
    state.answers = {};
    if (q.id) state.usedQuestions.push(q.id);
    showQuestion(q);
    toast('🔮 預測卡發動！換一題重新作答', 2600);
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
    SOUND.play('question');
    BGM.play('quiz');

    clearInterval(timer);
    timer = setInterval(function () {
      left--;
      $('qSec').textContent = Math.max(0, left);
      $('qBar').style.width = (left / total * 100) + '%';
      // 最後 5 秒滴答變急促，全班會自然安靜下來看白板
      if (left > 0) SOUND.play(left <= 5 ? 'tickFast' : 'tick');
      botAnswer(left, total);
      pumpActions();
      renderLights();
      if (left <= 0) { clearInterval(timer); SOUND.play('timeUp'); doReveal(); }
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
      if (everOnline[gid] && !cfg.solo) return;   // 有平板的組不代答，讓學生自己來
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
    // 收到不屬於這一場的組別代號就丟掉（以前會直接當掉整個白板）
    if (!state || !state.players || !state.players[a.gid]) return;
    if (!a.bot) {
      online[a.gid] = Date.now();          // 有訊息＝這組有平板在線上
      everOnline[a.gid] = true;            // 整場記著：這組是有平板的真人組
      // 平板網路瞬斷重連時，Firestore 會把還沒刪掉的動作重新送一次。
      // 同一筆時間戳只認第一次，否則同一張牌會被打出兩次。
      if (a.at) {
        if (lastActionAt[a.gid] >= a.at) return;
        lastActionAt[a.gid] = a.at;
      }
    }
    switch (a.type) {
      case 'answer': E.submitAnswer(state, a.gid, a.choice, a.timeMs); break;
      case 'hint': E.buyHint(state, a.gid, a.level); break;
      case 'card': {
        if (state.cfg && state.cfg.allowSabotage === false && SABOTAGE_CARDS.indexOf(a.cardId) >= 0) {
          break;                                 // 老師關閉了破壞類道具
        }
        var pl = state.players[a.gid];
        if ((pl.playedThisRound || 0) >= 2) break;   // 每輪最多出 2 張
        var cdef = CARD.get(a.cardId, true);
        var isChar = pl.cards.some(function (c) { return c.id === a.cardId && c.char; });
        if (!E.hasCard(pl, a.cardId)) break;

        // 道具時間已經結束（正在公布效果、或倒數已過）就不再收牌
        if (state.phase === 'cast') break;
        if (state.phase === 'item' && state.itemUntil && Date.now() > state.itemUntil + 1500) break;

        // 道具階段：先排隊，等階段結束再依「出牌先後」一張一張播放。
        // 這樣全班看得到誰用了什麼、發生什麼事，也不會有人搶快佔便宜。
        if (state.phase === 'item') {
          pl.playedThisRound = (pl.playedThisRound || 0) + 1;
          E.removeCard(pl, a.cardId, isChar);        // 先收走，避免同一張重複出
          state.pendingCards = state.pendingCards || [];
          state.pendingCards.push({ gid: a.gid, cardId: a.cardId, char: isChar, target: a.target });
          announceCard(pl.num + '組　已出牌（等一下公布）');
          break;
        }

        pl.playedThisRound = (pl.playedThisRound || 0) + 1;
        var tgtName = a.target && a.target.gid && state.players[a.target.gid]
                      ? ' → ' + state.players[a.target.gid].name : '';
        announceCard(pl.num + '組　' + (cdef ? cdef.emoji + ' ' + cdef.name : a.cardId) + tgtName);
        var cardResult = E.playCard(state, a.gid, a.cardId, a.target);
        if (cardResult && cardResult.ok && cardResult.rerollQuestion && state.phase === 'question') {
          redrawQuestion();                      // 門得列夫的預測卡：全班換一題重新作答
        }
        if (cardResult && cardResult.ok && cardResult.landAgain) {
          // 瞬移卡：傳送過去之後要真的觸發那一格的效果（買地／過路費／事件）
          var lr = E.landOn(state, a.gid);
          R.drawBoard(state); R.drawPlayers(state);
          R.focusOn(a.gid, state);
          toast(state.players[a.gid].num + '組 瞬移到 ' + B.CELLS[state.players[a.gid].pos].name, 2400);
        }
        if (cardResult && cardResult.ok && cardResult.fixedDice) {
          toast(state.players[a.gid].num + '組 良率控制器：下次骰 ' + cardResult.fixedDice + ' 點', 2400);
        }
        break;
      }
      case 'buy': {
        var rb = E.buyLand(state, a.gid, state.players[a.gid].pos);
        if (rb.ok) { SOUND.play('buy'); toast(state.players[a.gid].num + '組 買下 ' + B.CELLS[state.players[a.gid].pos].name, 2000); }
        markDecided(a.gid);
        break;
      }
      case 'build': {
        var rr = E.build(state, a.gid, state.players[a.gid].pos, a.times);
        if (rr.ok) { SOUND.play('build'); toast(state.players[a.gid].num + '組 蓋到 ' + B.LEVEL_NAME[rr.level], 2000); }
        markDecided(a.gid);
        break;
      }
      case 'merge': {
        if (state.cfg.allowMerge) {
          var rm = E.merge(state, a.gid, state.players[a.gid].pos);
          if (rm.ok) toast(state.players[a.gid].num + '組 併購了 ' + B.CELLS[state.players[a.gid].pos].name, 2200);
        }
        markDecided(a.gid);
        break;
      }
      case 'skip': markDecided(a.gid); break;
      case 'itemDone': {                       // 道具時間：這一組表示不出牌了
        state.itemReady = state.itemReady || {};
        state.itemReady[a.gid] = true;
        break;
      }
      case 'deposit': E.deposit(state, a.gid, a.amount); break;
      case 'withdraw': E.withdraw(state, a.gid, a.amount); break;
      case 'loan': E.applyLoan(state, a.gid, a.amount); break;
      case 'repay': E.repayLoan(state, a.gid, a.amount); break;
      case 'shop': E.buyFromShop(state, a.gid, a.cardId); break;   // 買卡不結束決定，可以連買
      case 'fork': pendingFork = a.cell; break;
      case 'pick': E.pickCharacter(state, a.gid, a.charId); renderLobby(); break;
      case 'hello':
        // 第一次報到時響一聲，老師就知道又有一組平板連進來了
        if (!greeted[a.gid]) { greeted[a.gid] = 1; SOUND.play('join'); }
        break;
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
    var anyRight = Object.keys(state.answers).some(function (g) {
      return state.answers[g] && state.answers[g].correct;
    });
    SOUND.play(anyRight ? 'right' : 'wrong');
    BGM.play('game');                    // 答題結束，回到平常的背景音樂
    status('揭曉！正解 ' + r.answer);

    setTimeout(function () {
      if (!r.order.length) { status('這輪沒有人答對，直接結算'); finishRound(); return; }
      showOrder(r.order);
    }, 1800);
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
    }, 1500);
  }

  // ═══════════════════════════════════════
  // 依序移動
  // ═══════════════════════════════════════
  var pendingFork = null;
  var decision = null;          // { gid: 'g1', done: false }

  function markDecided(gid) {
    if (decision && decision.gid === gid) decision.done = true;
  }

  /**
   * 落地之後，如果這一組有平板而且有事情可以做（買地／蓋廠／併購／逛商店），
   * 就等他決定。原本只等 1.6 秒，學生根本來不及按。
   */
  function waitForDecision(gid, hasChoice) {
    if (!hasChoice || isBot(gid)) return Promise.resolve();
    var ms = (cfg.decideSec || 8) * 1000;
    var deadline = Date.now() + ms;
    decision = { gid: gid, done: false };
    state.decide = { gid: gid, until: deadline };     // 讓平板知道在等誰、還剩多久
    pushRemote();

    return new Promise(function (resolve) {
      var iv = setInterval(function () {
        pumpActions();
        var left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        status(state.players[gid].name + ' 決定中…　' + left + ' 秒');
        if (decision.done || Date.now() >= deadline) {
          clearInterval(iv);
          decision = null;
          delete state.decide;
          pushRemote();
          resolve();
        }
      }, 250);
    });
  }

  function runTurns() {
    var gid = E.currentGid(state);
    if (!gid) { finishRound(); return; }
    showPlayerHUD(gid);
    R.focusOn(gid, state);
    status(state.players[gid].name + ' 行動中' + (isBot(gid) ? '（電腦代打）' : ''));
    doTurn(gid).then(function () {
      var r = E.endTurn(state);
      updateHUD();
      if (r.roundEnd) finishRound(); else setTimeout(runTurns, 150);
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
      SOUND.play('dice');
      var t0 = performance.now(), DUR = 700, done = false, safety;
      function finish() {
        if (done) return;
        done = true; clearTimeout(safety);
        SOUND.play('diceStop');
        drawDie($('die1'), 130, 120, 96, r.d1, 0);
        drawDie($('die2'), 290, 120, 96, r.d2, 0);
        sum.textContent = r.fixed ? ('🎲 良率控制器指定 ' + r.total + ' 點')
                                   : (r.d1 + ' + ' + r.d2 + ' = ' + r.total);
        sum.classList.remove('hidden');
        setTimeout(function () { box.classList.add('hidden'); res(); }, 500);
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
      SOUND.play('step');
      return R.hop(gid, from, p.pos).then(function () {
        if (r.events) r.events.forEach(function (ev) {
          if (ev.type === 'barrier') { SOUND.play('hit'); toast('🚧 撞上工安圍籬，強制停下'); }
          if (ev.type === 'virusPass') { SOUND.play('hit'); toast('💣 病毒傳染給 ' + state.players[ev.to].name + '！'); }
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

  /** 踩到格子會發生的事，各配一個聲音 */
  function landingSound(ev) {
    switch (ev.type) {
      case 'rent': case 'tax': case 'radiation': return 'pay';
      case 'pool': case 'rp': case 'card': case 'bounce': return 'income';
      case 'jail': return 'jail';
      case 'license': case 'pardon': return 'block';
      case 'god': return (ev.bad ? 'godBad' : 'godGood');
      case 'news': return 'card';
      default: return '';
    }
  }

  function settleLanding(gid) {
    var out = E.landOn(state, gid);
    var p = state.players[gid];
    var cell = B.CELLS[p.pos];
    var lines = [];

    out.events.forEach(function (ev) {
      SOUND.play(landingSound(ev));
      if (ev.type === 'rent') lines.push('付過路費 $' + ev.amount.toLocaleString() + ' 給 ' + state.players[ev.owner].name);
      if (ev.type === 'rp') lines.push('研發點數 +' + ev.amount);
      if (ev.type === 'tax') lines.push('繳營所稅 $' + ev.amount.toLocaleString());
      if (ev.type === 'pool') lines.push('領走補助池 $' + ev.amount.toLocaleString());
      if (ev.type === 'jail') lines.push('被押去檢調約談所，停 1 輪');
      if (ev.type === 'pardon') lines.push('用免罪卡躲過稽查（自動觸發）');
      if (ev.type === 'god') lines.push('被' + ev.name + '附身 3 輪');
      if (ev.type === 'news') lines.push(ev.text);
      if (ev.type === 'card') lines.push('抽到一張卡片');
      if (ev.type === 'license') lines.push('用技術授權卡免付過路費（自動觸發）');
      if (ev.type === 'bounce') lines.push('彈回卡把 $' + ev.amount.toLocaleString() + ' 拿回來（自動觸發）');
      if (ev.type === 'radiation') lines.push('踩到輻射區，扣 $' + ev.amount.toLocaleString());
      if (ev.type === 'shop') lines.push('進入創投商店（第 ' + p.num + ' 組購買中…）');
      if (ev.type === 'bank') lines.push('來到銀行，可以存提款或申請貸款');
    });

    // 有沒有需要這一組自己決定的事？
    var hasChoice = false;
    var reallyBot = isBot(gid) && !(everOnline[gid] && !cfg.solo);
    if (out.canBuy) {
      if (reallyBot) {
        if (p.cash - out.buyPrice > 15000 && E.buyLand(state, gid, p.pos).ok) lines.push('買下 ' + cell.name);
      } else { hasChoice = true; lines.push('可以買下 ' + cell.name + '（$' + out.buyPrice.toLocaleString() + '）'); }
    }
    if (out.canBuild) {
      if (reallyBot) {
        var r = E.build(state, gid, p.pos, 99);
        if (r.ok) lines.push('蓋到 ' + B.LEVEL_NAME[r.level]);
      } else { hasChoice = true; lines.push('可以蓋廠（每級 $' + out.upgradeCost.toLocaleString() + '）'); }
    }
    if (out.canMerge && state.cfg && state.cfg.allowMerge && !isBot(gid)) hasChoice = true;
    if (cell.type === 'shop' && !isBot(gid)) hasChoice = true;
    if (cell.type === 'bank' && !isBot(gid)) hasChoice = true;

    R.drawBoard(state);
    R.drawPlayers(state);
    Object.keys(state.players).forEach(function (g) { R.placePiece(g, state.players[g].pos, 0); });
    R.focusOn(gid, state);
    showPlayerHUD(gid);
    pushRemote();

    if (lines.length) toast(p.num + '組｜' + lines.join('　·　'), 2800);

    return waitForDecision(gid, hasChoice).then(function () {
      R.drawBoard(state);
      R.drawPlayers(state);
      showPlayerHUD(gid);
      return new Promise(function (res) { setTimeout(res, hasChoice ? 300 : (lines.length ? 1200 : 400)); });
    });
  }

  function finishRound() {
    var r = E.endRound(state);
    updateHUD();
    R.drawBoard(state);
    R.drawPlayers(state);
    var interest = r.events.filter(function (e) { return e.type === 'interest' && e.amount > 0; });
    if (interest.length) toast('🏦 銀行發放存款利息（' + interest.length + ' 組）', 2000);
    r.events.forEach(function (e) {
      if (e.type === 'virusBoom') { SOUND.play('boom'); toast('💥 ' + state.players[e.gid].name + ' 身上的病毒爆炸！' + e.cells.length + ' 座廠房降級', 3200); }
      if (e.type === 'charCard') toast('🎴 ' + state.players[e.gid].name + ' 獲得角色專屬卡', 1600);
    });
    autoSave();
    busy = false;
    if (r.ended) { endSession(); return; }
    status('第 ' + state.round + ' 輪結束');
    setTimeout(function () { if (!autoPaused) runRound(); }, 900);   // 自動下一輪
  }

  /** 自動存檔。存不進去一定要講，不能讓老師以為存好了、下週才發現整節課不見 */
  function autoSave() {
    var r = S.save(state);
    if (!r.ok) {
      SOUND.play('warn');
      status('⚠️ ' + r.msg);
      toast('⚠️ ' + r.msg, 6000);
    }
    S.touchRoom(state.code);       // 順便告訴雲端這一場還在進行
    return r;
  }

  function endSession() {
    if (sessionOver) return;              // 連按兩次不要重複結算
    sessionOver = true;
    clearInterval(timer);
    clearInterval(gamePump);
    clearPhaseTimers();                   // 休息倒數、道具倒數、決定倒數全部停掉
    hideAllPanels();                      // 免得排名跟休息面板疊在一起
    delete state.breakUntil;
    delete state.itemUntil;
    state.phase = 'ended';
    pushRemote();                         // 平板也要知道這一節結束了
    autoSave();
    var rank = E.ranking(state);
    $('hudQuestion').classList.add('hidden');
    $('hudRank').innerHTML = '<h3>🏆 本節結束 · 目前總財富排名</h3>' +
      rank.map(function (x, i) {
        var p = state.players[x.gid];
        return '<div class="rank-row"><span class="no">' + (i + 1) + '</span>' +
               '<span class="nm">' + p.name + '</span>' +
               '<span class="wl">$' + x.wealth.toLocaleString() + '</span></div>';
      }).join('') +
      '<div class="rank-code">下次接續請輸入編號　' + state.code + '</div>' +
      '<div style="margin-top:10px;font-size:14px;color:#93a4bb">已自動存檔，下次可以接著玩。期末再看總財富定勝負。</div>' +
      '<div class="rank-actions">' +
        '<button id="btnBackHome" class="big primary">回到首頁</button>' +
      '</div>';
    $('hudRank').classList.remove('hidden');
    SOUND.play('fanfare');
    BGM.play('win');
    status('本節結束，已存檔');
    busy = true;
    $('btnBackHome').onclick = backToSetup;
  }

  /**
   * 回到首頁（設定畫面）。
   * 本節結束後老師通常要換班或收工，以前只能重新整理才回得去。
   */
  function backToSetup() {
    SOUND.play('click');
    BGM.stop();
    clearInterval(timer);
    clearInterval(gamePump);
    clearInterval(lobbyPump);
    clearTimeout(pushTimer);
    clearPhaseTimers();
    hideAllPanels();
    sessionOver = false;                  // 放掉旗標，才能再開新的一場
    autoPaused = false;
    busy = false;
    roomCode = null;
    $('hudRank').classList.add('hidden');
    $('hudQuestion').classList.add('hidden');
    $('hudItemPhase').classList.add('hidden');
    $('hudCast').classList.add('hidden');
    $('game').classList.add('hidden');
    $('lobby').classList.add('hidden');
    $('setup').classList.remove('hidden');
    refreshSaves();                       // 剛剛那一場會出現在清單最上面
    msg('本節已存檔（編號 ' + (state && state.code ? state.code : '') + '）', 'ok');
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(function () {});
    }
  }

  // ═══════════════════════════════════════
  window.addEventListener('DOMContentLoaded', function () {
    SOUND.init(true);            // 白板接喇叭，預設開音效
    BGM.init();
    buildSetup();
  });
})();
