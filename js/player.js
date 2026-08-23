/* 科技島大富翁 — 平板端（每組一台）
 * 只顯示自己的資訊：手牌、資產、商店、銀行都只有自己看得到
 * 白板上只會顯示「第 X 組購買中…」，不會洩漏內容
 */
(function () {
  'use strict';

  var B = window.BOARD, E = window.ENGINE, S = window.STORE, CARD = window.CARDS;
  var $ = function (id) { return document.getElementById(id); };

  var my = { code: '', gid: null, gameId: null };

  /**
   * 這台平板的識別碼（存在瀏覽器裡，重新整理也不會變）。
   * 用來讓老師端分辨「同一組的兩台裝置」，一組只認第一台。
   */
  var myDev = (function () {
    try {
      var v = localStorage.getItem('techisland:dev');
      if (!v) { v = 'd' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
                localStorage.setItem('techisland:dev', v); }
      return v;
    } catch (e) { return 'd' + Math.random().toString(36).slice(2, 10); }
  })();
  var state = null;
  // 平板跟老師電腦的時鐘差多少（正值＝平板比較快）。
  // 所有倒數都是「老師端的絕對時間戳 - 現在時間」算的，
  // 平板的錶快 40 秒的話，道具時間一開始就會被判定超時、整節課出不了牌。
  // 老師端每次推送狀態都帶著自己的時間（hostAt），拿來校正就好。
  var clockSkew = 0;
  function hostNow() { return Date.now() - clockSkew; }
  var answered = false, lastRound = -1, lastPhase = '';
  var selectedCard = null, hintLevel = 0;

  // ═══════════════════════════════════════
  // 加入
  // ═══════════════════════════════════════
  var room = null;      // 查到的房間資訊（含這一場開了幾組）

  // ── 只在內容真的改變時才重畫 ──
  // 老師端每 0.7 秒廣播一次狀態，如果每次都把 DOM 砍掉重建，
  // 學生正在點的按鈕會被換掉，畫面也會一直閃，根本按不到。
  var sig = {};
  function changed(key, value) {
    if (sig[key] === value) return false;
    sig[key] = value;
    return true;
  }
  function resetSig() { sig = {}; }

  function buildJoin() {
    var codeInput = $('jCode');
    codeInput.addEventListener('input', function () {
      this.value = this.value.replace(/[^0-9]/g, '').slice(0, 6);
    });
    codeInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') doFind(); });

    $('btnFind').onclick = doFind;
    $('btnJoin').onclick = doJoin;
    $('btnLeavePick').onclick = leaveRoom;
    $('btnBack').onclick = function () {
      $('step2').classList.add('hidden');
      $('step1').classList.remove('hidden');
      pmsg('joinMsg', '', '');
    };

    // 記住上次輸入的代碼，重新整理不用再打一次
    try {
      var saved = JSON.parse(localStorage.getItem('techisland:me') || 'null');
      if (saved && saved.code) { my.code = saved.code; codeInput.value = saved.code; }
    } catch (e) {}
  }

  /** 第一步：用代碼查房間，拿到這一場實際開了幾組 */
  function doFind() {
    var code = ($('jCode').value || '').trim();
    if (code.length !== 6) { pmsg('joinMsg', '請輸入白板上的 6 位數編號', 'err'); return; }
    my.code = code;
    S.initChannel(code);                    // 同一台電腦多分頁用代碼當頻道
    S.onLocalState(onState);

    if (!S.firebaseReady()) {
      room = { gameId: 'local_' + code, groups: 10, local: true };
      S.setMode('local', room.gameId);
      showGroupPicker('本機模式（同一台電腦才連得到）');
      return;
    }

    pmsg('joinMsg', '查詢中…', '');
    $('btnFind').disabled = true;
    S.initFirebase().then(function () {
      // ⚠️ 一定要先切到雲端模式，findRoom 才會真的去查 Firestore。
      // 否則它會走本機分支回傳一個假房間，畫面顯示「已連上」但其實根本沒連到。
      S.setMode('firebase', null);
      return S.findRoom(code);
    }).then(function (r) {
      $('btnFind').disabled = false;
      if (!r) {
        pmsg('joinMsg', '找不到這個編號。請再確認一次白板上的數字，' +
                        '也要確認老師已經按下「開新遊戲」了', 'err');
        return;
      }
      if (r.live === false) {
        pmsg('joinMsg', '編號 ' + code + ' 是之前的舊場次，老師現在沒有開著。' +
                        '請確認白板上顯示的編號。', 'err');
        return;
      }
      room = r;
      S.setMode('firebase', r.gameId);
      // 先讀一次現在的狀態，才知道哪幾組已經有平板了
      S.loadCloud(code).then(function (st) {
        showGroupPicker('找到了！這一場有 ' + (r.groups || 9) + ' 組', st && st.seats);
      }).catch(function () { showGroupPicker('找到了！這一場有 ' + (r.groups || 9) + ' 組'); });
    }).catch(function (e) {
      $('btnFind').disabled = false;
      pmsg('joinMsg', '連線失敗：' + e.message, 'err');
    });
  }

  /** 第二步：只列出這一場實際開的組別，避免選到不存在的組 */
  function showGroupPicker(info, seats) {
    $('step1').classList.add('hidden');
    $('step2').classList.remove('hidden');
    $('foundInfo').textContent = info;
    pmsg('joinMsg', '', '');

    var n = (room && room.groups) || 9;
    var box = $('jGroup');
    box.innerHTML = '';
    my.gid = null;
    $('btnJoin').disabled = true;
    seats = seats || {};

    for (var i = 1; i <= n; i++) (function (k) {
      var s = seats['g' + k];
      // 已經被別台平板佔走的組別不能選（超過 3 分鐘沒動靜的視為空出來）。
      // 白板不再把裝置代號廣播出來（那等於冒充別組的鑰匙），
      // 改成比對不可逆的短代碼：拿自己的裝置代號算同一條公式就知道是不是自己。
      var myTag = window.ENGINE ? window.ENGINE.devTag(myDev) : '';
      var taken = s && (s.taken || s.dev) && (s.who || s.dev) !== (s.who != null ? myTag : myDev) &&
                  (Date.now() - (s.at || 0) < 180000);
      var b = chip('第 ' + k + ' 組' + (taken ? '（已有平板）' : ''), false, function () {
        if (taken) {
          pmsg('joinMsg', '第 ' + k + ' 組已經有一台平板了，請選別組', 'err');
          return;
        }
        my.gid = 'g' + k;
        markOne(box, b);
        $('btnJoin').disabled = false;
      });
      if (taken) { b.style.opacity = '.45'; b.style.cursor = 'not-allowed'; }
      box.appendChild(b);
    })(i);
  }

  /** 選好組別，正式加入 */
  function doJoin() {
    if (!my.gid) { pmsg('joinMsg', '請先點選你們是第幾組', 'err'); return; }
    localStorage.setItem('techisland:me', JSON.stringify({ code: my.code, gid: my.gid }));
    S.watchState(onState);
    send({ type: 'hello' });
    heartbeat();
    pmsg('joinMsg', '已加入第 ' + my.gid.slice(1) + ' 組，等待老師端…', 'ok');
  }

  function chip(text, on, fn) {
    var b = document.createElement('div');
    b.className = 'chip' + (on ? ' on' : '');
    b.textContent = text;
    b.onclick = fn;
    return b;
  }
  function markOne(parent, el) {
    [].forEach.call(parent.children, function (x) { x.classList.remove('on'); });
    el.classList.add('on');
  }
  function pmsg(id, text, cls) {
    var m = $(id); m.textContent = text; m.className = 'pl-msg ' + (cls || '');
  }
  /** 送出動作給老師端。失敗一定要顯示出來，不然學生按了沒反應卻不知道為什麼 */
  function send(action) {
    if (!my.gid) {
      // 心跳是背景自動送的，還沒選組別時不該跳錯誤訊息嚇到學生
      if (action && action.type !== 'hello') {
        pmsg('joinMsg', '還沒選組別，無法送出', 'err');
      }
      return Promise.resolve();
    }
    action = Object.assign({ dev: myDev, nonce: state ? state.nonce : undefined }, action);
    // 節流：同一種動作 800ms 內只送一次（心跳除外）。
    // 學生連點按鈕就是連續的雲端寫入，額度會被白白吃掉。
    if (action.type !== 'hello') {
      var tk = action.type + '|' + (action.cardId || '');
      var nowT = Date.now();
      send._last = send._last || {};
      if (send._last[tk] && nowT - send._last[tk] < 800) return Promise.resolve();
      send._last[tk] = nowT;
    }
    return S.sendAction(my.gid, action).catch(function (e) {
      console.warn('[send] ' + action.type + ' 失敗：' + e.message);
      var box = document.getElementById('pick').classList.contains('hidden') ? 'handMsg' : 'pickMsg';
      pmsg(box, '送出失敗：' + e.message + '（請確認網路，或按重新整理）', 'err');
      throw e;
    });
  }

  /**
   * 離開這一場，回到輸入編號的畫面。
   * 老師重開新的一場時，平板還綁在舊場次的選角畫面上，以前完全沒有退路
   * （連線警告只有「重新整理」，但重新整理會自動回到舊的那一間）。
   * 用「清掉綁定 + 重新載入」最乾淨：所有監聽與計時器一次歸零。
   */
  function leaveRoom() {
    try { localStorage.removeItem('techisland:me'); } catch (e) {}
    location.href = location.pathname;    // 重新載入（不帶任何參數）
  }

  /** 每 10 秒報到一次，老師端才知道這組的平板還在線上（沒在線的組會由電腦代打） */
  var hbTimer = null;
  function heartbeat() {
    clearInterval(hbTimer);
    // 心跳每次都是一筆雲端寫入，不能太密；但太稀疏又會被誤判成「這組沒有平板」，
    // 老師端就會叫電腦代打，出一張學生沒選過的牌。
    // 折衷：15 秒一次，老師端逾時放寬到 120 秒（可以連漏 7 次）。
    hbTimer = setInterval(function () { send({ type: 'hello' }); }, 15000);
    // 平板被放下、切到別的 App、或 iPad 鎖屏時，瀏覽器會把定時器凍結，
    // 心跳就斷了。切回前景時立刻補報到一次，避免被當成離線。
    if (!window.__visBound) {
      window.__visBound = true;
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden && my.gid) send({ type: 'hello' });
      });
    }
  }

  // ═══════════════════════════════════════
  // 收到老師端狀態
  // ═══════════════════════════════════════
  var lastSeq = -1, lastNonce = null;
  /**
   * 手牌、買到的提示、感應卡看到的答案，現在都不在公開狀態裡了
   * （以前整包廣播給全班，任何人按 F12 就看得到別組的牌和沒付錢的提示）。
   * 白板改成放進 st.priv 這個「一組一份」的區塊，這裡接回原本的位置，
   * 下面的畫面程式就完全不用改。
   */
  function graftPrivate(st) {
    if (!st || !st.priv || !my.gid) return st;
    var mine = st.priv[my.gid];
    var me = st.players && st.players[my.gid];
    if (!mine || !me) return st;
    me.cards = mine.cards || [];
    me.buff = me.buff || {};
    if (mine.peek) me.buff.peek = mine.peek;
    st.myHints = mine.hints || [];
    st.allCards = mine.allCards || null;      // 觀測卡：這一輪看得到全部人的手牌
    st.myReject = mine.reject || null;        // 被拒絕的操作原因（「點數不足」…）
    return st;
  }

  // 操作被白板拒絕時顯示原因。只顯示 8 秒內的新訊息，
  // 而且同一則只顯示一次（狀態每秒都會重送，不能每次都跳）。
  var lastRejectAt = 0;
  function showReject(st) {
    var r = st.myReject;
    if (!r || !r.at || r.at === lastRejectAt) return;
    if (Date.now() - (r.at - clockSkew) > 8000) return;
    lastRejectAt = r.at;
    pmsg('handMsg', '⚠️ ' + r.msg, 'err');
  }

  /**
   * 座位被別台平板佔走時要講出來。
   * 白板一組只認一台平板（先到先贏），第二台送的任何動作都會被忽略 ——
   * 但以前那一台完全不知道，畫面看起來正常、按什麼都沒反應（無聲的殭屍機）。
   * 白板廣播的座位表帶著「不可逆代碼」，拿自己的裝置代號算一次就知道
   * 佔位的是不是自己。不是自己、而且對方 3 分鐘內有動靜 → 顯示警告與離開鍵。
   * （對方超過 3 分鐘沒動靜時白板會讓我接手，警告就自動消失。）
   */
  function checkSeat(st) {
    var w = $('seatWarn');
    if (!w || !my.gid || !st.seats) return;
    var s = st.seats[my.gid];
    var myTag = window.ENGINE ? window.ENGINE.devTag(myDev) : '';
    var occupied = s && s.who && s.who !== myTag &&
                   (Date.now() - clockSkew) - (s.at || 0) < 180000;
    if (occupied && !w._shown) {
      w._shown = true;
      w.innerHTML = '⚠️ 第 ' + my.gid.slice(1) + ' 組已經有另一台平板在操作了，這一台按什麼都不會生效。<br>' +
                    '<button id="seatLeave">⬅ 回到輸入編號，改選別組</button>' +
                    '<span style="font-size:12px;opacity:.8">　（如果那一台壞了，等 3 分鐘就能用這一台接手）</span>';
      w.classList.remove('hidden');
      var b = document.getElementById('seatLeave');
      if (b) b.onclick = leaveRoom;
    } else if (!occupied && w._shown) {
      w._shown = false;
      w.classList.add('hidden');
    }
  }

  function onState(st) {
    if (!st || !st.players) return;
    if (typeof st.hostAt === 'number') clockSkew = Date.now() - st.hostAt;
    checkSeat(st);
    st = graftPrivate(st);
    // 換了新的一場遊戲（識別碼不同）就整個重置。
    // 沒有這一段的話，上一場遊戲留在雲端／本機的舊狀態會跟新遊戲互相蓋來蓋去，
    // 造成畫面一直跳（一下選角、一下選好）。
    if (st.nonce && st.nonce !== lastNonce) {
      lastNonce = st.nonce;
      lastSeq = -1;
      resetSig();
      pickSent = false;
      picking = null;
      answered = false;
    }
    // 忽略晚到的舊狀態，否則畫面會倒退（選好角色又跳回選角、資產變回舊值）。
    // 但如果連續好幾次都被擋掉，代表序號對不上（例如老師端重開過），
    // 這時要放棄比對接受新狀態，否則這台平板會永遠停在舊畫面。
    if (typeof st._seq === 'number') {
      if (st._seq < lastSeq) {
        seqDrops++;
        if (seqDrops < 8) return;
        seqDrops = 0;                  // 卡太久了，重新同步
      } else {
        seqDrops = 0;
      }
      lastSeq = st._seq;
    }
    state = st;
    window.__ps = st;                 // 診斷用：可在主控台檢查平板收到的狀態
    window.__psAt = Date.now();
    lastStateAt = Date.now();
    if (connBad) { connBad = false; $('connWarn').classList.add('hidden'); }
    if (!my.gid) return;
    // 上一節是 9 組、這一節老師只開 6 組時，記著自己是第 8 組的平板會找不到自己。
    // 以前是無聲 return，那台平板整節課停在「正在回到遊戲…」，學生完全不知道怎麼辦。
    // 這一組的座位被別台平板佔著（例如兩台同時選了第 1 組），我就要退出來
    var seat = state.seats && state.seats[my.gid];
    if (seat && seat.dev && seat.dev !== myDev) {
      show('join');
      $('step1').classList.remove('hidden');
      $('step2').classList.add('hidden');
      pmsg('joinMsg', '第 ' + my.gid.slice(1) + ' 組已經有另一台平板在用了，請改選別組', 'err');
      try { localStorage.removeItem('techisland:me'); } catch (e) {}
      my.gid = null;
      return;
    }
    if (!state.players[my.gid]) {
      show('join');
      pmsg('joinMsg', '這一場沒有第 ' + my.gid.slice(1) + ' 組（老師這次開的組數比較少），請重新選組別', 'err');
      try { localStorage.removeItem('techisland:me'); } catch (e) {}
      my.gid = null;
      return;
    }
    var me = state.players[my.gid];

    // 老師按了「結束本節」：學生端要回到起始畫面，
    // 不然平板會一直停在遊戲畫面，學生以為還能操作。
    if (state.phase === 'ended') {
      if (!endedShown) {
        endedShown = true;
        stopDecideTimer();
        clearInterval(bannerTimer);
        showEndedScreen();
      }
      return;
    }
    endedShown = false;

    if (!me.charId) { showPick(); return; }

    // 這裡以前用簽章擋住重複呼叫，結果只要進過一次選角畫面就再也回不到遊戲畫面
    //（那台平板整節課停在選角，題目當然不會出現）。show() 只是切 class，直接每次呼叫。
    if (sig.screen !== 'play') { resetSig(); sig.screen = 'play'; }

    // 地圖是整片蓋住畫面的遮罩。除了答題之外，「輪到自己行動」與「道具時間」
    // 也要自動收掉 —— 不然學生開著地圖研究，買地按鈕出現了他看不到，
    // 老師就會空等這一組。
    var mustSee = (state.decide && state.decide.gid === my.gid) ||
                  (state.phase === 'item' && state.itemUntil != null);
    if (mustSee && sig.autoClosed !== state.phase + '|' + (state.decide && state.decide.gid)) {
      sig.autoClosed = state.phase + '|' + (state.decide && state.decide.gid);
      var mp = $('mapPanel');
      if (mp && !mp.classList.contains('hidden')) mp.classList.add('hidden');
    }
    show('play');

    // ══════════════════════════════════════════════════════
    // 【順序很重要】階段提示與題目要最先畫。
    // 以前它們排在手牌、資產、銀行後面，只要前面任何一行出錯（某個欄位缺了、
    // 某一格資料怪怪的），整個函式就中斷 —— 這台平板會停在上一個階段，
    // 變成「別組已經在答題，他還顯示休息中或道具時間」。
    // 現在最重要的兩件事先畫，而且每一段都各自包起來，壞一段不影響其他段。
    // ══════════════════════════════════════════════════════
    guard('階段提示', function () { renderPhaseBanner(); });

    if (state.phase === 'question') {
      guard('題目', function () {
        // 地圖／戰況是整片蓋住畫面的面板，題目出來時一定要收掉，
        // 否則那台平板整片還是地圖，學生會說「我這邊沒有出現題目」。
        var mp = $('mapPanel');
        if (mp && !mp.classList.contains('hidden')) {
          mp.classList.add('hidden');
          var mi = $('mapInfo'); if (mi) mi.classList.add('hidden');
        }
        // 用題號判斷是不是新的一題（預測卡會在同一輪換題，用輪次判斷會漏掉）
        var qid = state.question ? String(state.question.id) : '';
        if (qid !== lastQid) {
          lastQid = qid;
          answered = false; hintLevel = 0; $('hintBox').textContent = '';
        }
        renderQuestion(me);
      });
      sig.qcard = 'show';
    } else {
      guard('收題目', function () {
        if (changed('qcard', 'hide')) {
          $('qCard').classList.add('hidden');
          // 作答時間過了就把按鈕鎖住，避免學生以為還能改答案
          [].forEach.call($('qOpts').children, function (b) { b.disabled = true; });
        }
      });
    }

    // ── 以下都是輔助資訊，各自獨立，壞一個不會擋住上面的題目 ──
    guard('上方資訊', function () { renderTop(me); });
    guard('被拒訊息', function () { showReject(state); });

    guard('手牌', function () {
      var sigHand = (me.cards || []).map(function (c) { return c.id + (c.char ? '*' : ''); }).join(',') +
                  '|' + ((state.myHints || []).length) +
                    '|' + (me.playedThisRound || 0);
      if (changed('hand', sigHand)) renderHand(me);
    });

    guard('資產', function () {
      var sigAssets = E.landsOf(state, my.gid).map(function (i) {
        return i + ':' + (state.board.level[i] || 0);
      }).join(',');
      if (changed('assets', sigAssets)) renderAssets(me);
    });

    guard('銀行', function () {
      var here = B.CELLS[me.pos];
      if (changed('bank', (here && here.type === 'bank') ? 'yes' : 'no')) renderBank(me);
    });

    guard('行動選項', function () {
      var sigAct = state.phase + '|' + E.currentGid(state) + '|' + me.pos + '|' +
                   (me.stepsLeft || 0) + '|' + (state.board.owner[me.pos] || '-') + '|' +
                   (state.board.level[me.pos] || 0) + '|' +
                   (state.decide ? state.decide.gid : '-') + '|' + me.cash + '|' + me.rp +
                   '|' + ((me.cards || []).length);
      if (changed('action', sigAct)) renderAction(me);
    });

    lastRound = state.round;
    lastPhase = state.phase;
  }

  /**
   * 把每一段畫面更新包起來。
   * 之前發生過：某一段重畫時拋錯，後面所有段落跟著不執行，
   * 學生看到的就是「卡片點了沒反應」。包起來之後最多只有那一小塊沒更新。
   */
  function guard(where, fn) {
    try { fn(); } catch (e) {
      if (!guard.seen[where]) {
        guard.seen[where] = 1;
        console.error('[科技島] ' + where + ' 更新失敗：', e);
      }
    }
  }
  guard.seen = {};

  function show(which) {
    ['rejoin', 'join', 'pick', 'play', 'ended'].forEach(function (id) {
      var el = $(id);
      if (el) el.classList.toggle('hidden', id !== which);
    });
  }

  // ═══════════════════════════════════════
  // 選角
  // ═══════════════════════════════════════
  var picking = null, pickSent = false;
  var endedShown = false;

  /** 本節結束：收起遊戲畫面，顯示「這一節結束了」與這一場的編號 */
  function showEndedScreen() {
    var me = state.players[my.gid] || {};
    var rank = E.ranking(state).map(function (x, i) {
      var p = state.players[x.gid];
      return '<div class="mp-row' + (x.gid === my.gid ? ' mine' : '') + '">' +
             '<b style="min-width:24px">' + (i + 1) + '</b>' +
             '<span class="mp-name">' + p.name + '</span>' +
             '<span class="mp-right"><b>$' + x.wealth.toLocaleString() + '</b></span></div>';
    }).join('');
    show('ended');
    $('endedBody').innerHTML =
      '<div class="ended-big">🏆 這一節結束了</div>' +
      '<div class="ended-sub">' + (me.name || '') + '　最終總財富 $' +
      ((E.wealth(state, my.gid)) || 0).toLocaleString() + '</div>' +
      '<div class="ended-rank">' + rank + '</div>' +
      '<div class="ended-code">下次上課的編號　<b>' + (state.code || '') + '</b></div>' +
      '<button id="btnEndedBack" class="opt-btn" style="margin-top:16px">回到首頁</button>';
    var b = document.getElementById('btnEndedBack');
    if (b) b.onclick = function () {
      try { localStorage.removeItem('techisland:me'); } catch (e) {}
      location.reload();
    };
  }

  function showPick() {
    show('pick');
    var taken = {};
    Object.keys(state.players).forEach(function (g) {
      if (state.players[g].charId) taken[state.players[g].charId] = state.players[g].num;
    });

    // 已經送出選角，就不要再重建畫面（等老師端確認即可）
    if (pickSent) return;
    // 別組的選角狀況沒變就不重建，否則畫面會一直閃、點不到
    if (!changed('pick', Object.keys(taken).sort().join(',') + '|' + picking)) return;

    var grid = $('pickGrid');
    grid.innerHTML = '';
    window.CHARACTERS.forEach(function (c) {
      var card = document.createElement('div');
      var isTaken = !!taken[c.id];
      card.className = 'pick-card' + (isTaken ? ' taken' : '') + (picking === c.id ? ' on' : '');
      var cd = CARD.get(c.card, true);
      // 還沒有立繪的角色用 emoji 色塊代替
      var url = 'images/characters/char_' + (c.num < 10 ? '0' : '') + c.num + '_' + c.id + '_idle.png';
      card.innerHTML =
        '<div class="ph" style="height:110px;display:flex;align-items:center;justify-content:center;' +
        'font-size:46px;background:' + c.color + '33;border-radius:10px">' + c.emoji + '</div>' +
        '<img src="' + url + '" style="display:none" alt="">' +
        '<div class="n">' + c.name + '</div>' +
        '<div class="cd">' + (cd ? cd.emoji + ' ' + cd.name : '') + '</div>' +
        (isTaken ? '<div class="cd">第 ' + taken[c.id] + ' 組已選</div>' : '');
      var im = card.querySelector('img'), ph = card.querySelector('.ph');
      // 圖片若已在快取中，onload 不會再觸發，要另外檢查 complete
      if (im.complete && im.naturalWidth > 0) { im.style.display = 'block'; ph.style.display = 'none'; }
      else im.onload = function () { im.style.display = 'block'; ph.style.display = 'none'; };
      if (!isTaken) card.onclick = function () {
        picking = c.id;
        [].forEach.call(grid.children, function (x) { x.classList.remove('on'); });
        card.classList.add('on');
        $('btnPickOk').disabled = false;
        pmsg('pickMsg', c.name + '　專屬卡：' + (cd ? cd.name + '　' + cd.desc : ''), '');
      };
      grid.appendChild(card);
    });
    $('btnPickOk').onclick = function () {
      if (!picking) return;
      pickSent = true;
      send({ type: 'pick', charId: picking });
      $('btnPickOk').disabled = true;
      $('btnPickOk').textContent = '已送出，等待老師端…';
      pmsg('pickMsg', '已送出，等待老師端確認…', 'ok');
      // 5 秒還沒生效就讓學生可以重試（網路不穩時不會卡死）
      setTimeout(function () {
        if (state && state.players[my.gid] && !state.players[my.gid].charId) {
          pickSent = false;
          $('btnPickOk').disabled = false;
          $('btnPickOk').textContent = '再試一次';
          pmsg('pickMsg', '還沒收到老師端的回應，請再按一次', 'err');
          sig.pick = null;
        }
      }, 5000);
    };
  }

  // ═══════════════════════════════════════
  // 上方資訊
  // ═══════════════════════════════════════
  // ── 地圖一覽：學生要能查地價、誰的地、蓋幾級、過路費多少 ──
  var mapFilter = 'all';
  /**
   * 全螢幕。
   * Android 平板與電腦用瀏覽器的全螢幕 API 就可以；
   * iPad 的 Safari 不一定給網頁用，那就改教學生用「加入主畫面」，
   * 從主畫面圖示打開一樣是滿版無網址列。
   */
  function goFullscreenP() {
    var el = document.documentElement;
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      var exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) { try { exit.call(document); } catch (e) {} }
      paintFsBtn();
      return;
    }
    var req = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (!req) { showAddToHomeTip(); return; }
    try {
      var p = req.call(el);
      if (p && p.catch) p.catch(function () { showAddToHomeTip(); });
    } catch (e) { showAddToHomeTip(); }
    setTimeout(paintFsBtn, 400);
  }

  function paintFsBtn() {
    var b = $('btnFullP');
    if (!b) return;
    var full = !!(document.fullscreenElement || document.webkitFullscreenElement);
    b.textContent = full ? '⛶ 離開全螢幕' : '⛶ 全螢幕';
  }

  /** iPad 不給全螢幕時，教學生用「加入主畫面」（效果一樣，而且下次開更快） */
  function showAddToHomeTip() {
    if (document.getElementById('fsTipP')) return;
    var d = document.createElement('div');
    d.id = 'fsTipP';
    d.className = 'fs-tip-p';
    d.innerHTML =
      '<b>這台平板沒辦法直接全螢幕</b><br>' +
      '改用這個方法一樣可以滿版：<br>' +
      '① 按瀏覽器下方（或上方）的<b>分享</b>按鈕 <br>' +
      '② 選<b>「加入主畫面」</b><br>' +
      '③ 之後從主畫面的圖示打開，就沒有網址列了' +
      '<br><button id="fsTipClose">知道了</button>';
    document.body.appendChild(d);
    document.getElementById('fsTipClose').onclick = function () { d.remove(); };
  }


  /** 從程式檔的網址讀出這次上傳的版本戳記，顯示在畫面上。
   *  沒有這個的話，改完上傳卻忘了在平板重新整理時，會以為「修了還是沒好」。 */
  function buildStamp() {
    var tags = document.querySelectorAll('script[src*=".js?v="]');
    for (var i = 0; i < tags.length; i++) {
      var m = (tags[i].getAttribute('src') || '').match(/v=([\d-]+)/);
      if (m) return m[1];
    }
    return '?';
  }

  function bindFullP() {
    var b = $('btnFullP');
    if (!b || b._bound) return;
    b._bound = true;
    b.onclick = goFullscreenP;
    paintFsBtn();
    document.addEventListener('fullscreenchange', paintFsBtn);
    document.addEventListener('webkitfullscreenchange', paintFsBtn);
  }

  function bindMuteP() {
    bindFullP();
    var b = $('btnMuteP');
    if (!b || b._bound) return;
    b._bound = true;
    function paint() { b.textContent = SOUND.isEnabled() ? '🔊' : '🔇'; }
    paint();
    b.onclick = function () { SOUND.setEnabled(!SOUND.isEnabled()); paint(); };
  }

  function bindItemDone() {
    bindMuteP();
    var b = $('btnItemDone');
    if (!b || b._bound) return;
    b._bound = true;
    b.onclick = function () {
      send({ type: 'itemDone' });
      b.disabled = true;
      b.textContent = '✓ 已表示不出牌，等其他組';
    };
  }

  function bindMapButtons() {
    bindItemDone();
    var b = $('btnMap');
    if (!b || b._bound) return;
    b._bound = true;
    b.onclick = function () { $('mapPanel').classList.remove('hidden'); showMapView('map'); };
    $('btnMapClose').onclick = function () { $('mapPanel').classList.add('hidden'); };
    $('tabMap').onclick = function () { showMapView('map'); };
    $('tabList').onclick = function () { showMapView('list'); };
    $('mpZoomIn').onclick = function () { zoomMap(1.45); };
    $('mpZoomOut').onclick = function () { zoomMap(1 / 1.45); };
    $('mpWhole').onclick = function () { fitWholeMap(); };
    $('mpMe').onclick = function () { focusMapOnMe(); };
    [].forEach.call(document.querySelectorAll('.mp-f'), function (f) {
      f.onclick = function () {
        mapFilter = f.dataset.f;
        [].forEach.call(document.querySelectorAll('.mp-f'), function (x) { x.classList.remove('on'); });
        f.classList.add('on');
        renderMap();
      };
    });
    $('btnRankP').onclick = function () {
      // 觀測卡：這一輪看得到全部人的存款與手牌（平常只看得到現金與地數）
      var spy = state.allCards;
      var rows = E.ranking(state).map(function (x, i) {
        var p = state.players[x.gid];
        var extra = '';
        if (spy) {
          var hand = spy[x.gid] || [];
          extra = '<div class="mp-spy">🏦 存款 $' + (p.bank || 0).toLocaleString() +
                  '　🎴 手牌 ' + hand.length + ' 張' +
                  (hand.length
                    ? '：' + hand.map(function (c) {
                        var def = CARD.get(c.id, true);
                        return def ? (def.emoji + def.name) : c.id;
                      }).join('、')
                    : '（空的）') + '</div>';
        }
        return '<div class="mp-row' + (x.gid === my.gid ? ' mine' : '') + '">' +
               '<b style="min-width:26px">' + (i + 1) + '</b>' +
               '<span class="mp-name">' + p.name + '</span>' +
               '<span class="mp-right"><b>$' + x.wealth.toLocaleString() + '</b><br>' +
               '現金 $' + p.cash.toLocaleString() + '　地 ' + E.landsOf(state, x.gid).length + ' 塊</span>' +
               extra + '</div>';
      }).join('');
      if (spy) {
        rows = '<div class="pl-msg" style="background:#0b3a5e;color:#e0f2fe">' +
               '🔭 觀測卡生效中：這一輪看得到全部人的存款與手牌</div>' + rows;
      }
      $('mapPanel').classList.remove('hidden');
      showMapView('list');
      $('mapList').innerHTML = rows;
      $('mapFilters').classList.add('hidden');
      $('tabList').classList.remove('on');
    };
  }

  // ═══════════════════════════════════════
  // 地圖：可以用手指拖曳的真地圖 + 清單兩個分頁
  // ═══════════════════════════════════════
  var seqDrops = 0;                 // 連續被序號擋掉幾次（太多次就重新同步）
  var lastQid = '';                 // 上一題的題號，用來判斷是不是換了新題目
  var mapView = 'map';
  var mapReady = false;
  var mv = { x: 0, y: 0, k: 0.6 };

  function showMapView(v) {
    mapView = v;
    var isMap = (v === 'map');
    $('mapCanvas').classList.toggle('hidden', !isMap);
    $('mapList').classList.toggle('hidden', isMap);
    $('mapFilters').classList.toggle('hidden', isMap);
    $('tabMap').classList.toggle('on', isMap);
    $('tabList').classList.toggle('on', !isMap);
    if (isMap) renderMapCanvas(); else renderMap();
  }

  /** 整張地圖剛好塞滿畫面時的縮放倍率 */
  function fitK() {
    var bd = window.RENDER.mapBounds();
    return Math.min(window.RENDER.VW / (bd.x2 - bd.x1),
                    window.RENDER.VH / (bd.y2 - bd.y1)) * 0.95;
  }

  function clampMapView() {
    var bd = window.RENDER.mapBounds();
    var halfW = window.RENDER.VW / (2 * mv.k), halfH = window.RENDER.VH / (2 * mv.k);
    // 地圖比畫面小的時候就置中，比畫面大的時候才限制不要滑出去
    mv.x = (bd.x2 - bd.x1 <= halfW * 2) ? (bd.x1 + bd.x2) / 2
         : Math.min(Math.max(mv.x, bd.x1 + halfW), bd.x2 - halfW);
    mv.y = (bd.y2 - bd.y1 <= halfH * 2) ? (bd.y1 + bd.y2) / 2
         : Math.min(Math.max(mv.y, bd.y1 + halfH), bd.y2 - halfH);
  }

  function applyMapView() {
    clampMapView();
    window.RENDER.setView(mv.x, mv.y, mv.k);
  }

  function zoomMap(f) {
    mv.k = Math.min(Math.max(mv.k * f, fitK()), 2.4);
    applyMapView();
  }

  function fitWholeMap() {
    var bd = window.RENDER.mapBounds();
    mv.x = (bd.x1 + bd.x2) / 2; mv.y = (bd.y1 + bd.y2) / 2; mv.k = fitK();
    applyMapView();
  }

  function focusMapOnMe() {
    var me = state && state.players[my.gid];
    var pos = me && window.RENDER.POS[me.pos];
    if (!pos) return;
    mv.x = pos.x; mv.y = pos.y; mv.k = Math.max(1.1, fitK());
    applyMapView();
    showCellCard(me.pos);
  }

  function renderMapCanvas() {
    if (!state) return;
    var svg = $('pMapSvg');
    if (!mapReady) {
      window.RENDER.init(svg);
      bindMapDrag(svg);
      mapReady = true;
      window.RENDER.drawBoard(state);
      fitWholeMap();
    } else {
      window.RENDER.drawBoard(state);
      applyMapView();
    }
    drawMapPieces();
    var tip = $('mapTip');
    if (tip) { tip.style.opacity = '1'; setTimeout(function () { tip.style.opacity = '0'; }, 4000); }
  }

  /** 各組現在站在哪裡（用角色符號標，不載入立繪，平板才不會卡） */
  function drawMapPieces() {
    var svg = $('pMapSvg'), cam = svg.querySelector('#cam');
    if (!cam) return;
    var g = svg.querySelector('#pPieces');
    if (!g) { g = window.RENDER.el('g', { id: 'pPieces' }); cam.appendChild(g); }
    g.style.pointerEvents = 'none';
    g.innerHTML = '';
    Object.keys(state.players).forEach(function (gid) {
      var p = state.players[gid], pos = window.RENDER.POS[p.pos];
      if (!pos || !p.charId) return;
      var ch = window.charById(p.charId);
      var isMe = (gid === my.gid);
      g.appendChild(window.RENDER.el('circle', {
        cx: pos.x, cy: pos.y - 78, r: 48, fill: ch.color,
        stroke: isMe ? '#fbbf24' : '#ffffff', 'stroke-width': isMe ? 13 : 7
      }));
      var t = window.RENDER.el('text', {
        x: pos.x, y: pos.y - 60, 'text-anchor': 'middle', 'font-size': 48
      });
      t.textContent = ch.emoji;
      g.appendChild(t);

      // 狀態標記：白板看得到誰有炸彈、誰被神附身，平板也要看得到
      var marks = [];
      if (p.virus > 0) marks.push('💣');
      if (p.god) marks.push((window.ENGINE.godById(p.god) || {}).emoji || '👼');
      if (p.frozen > 0) marks.push('⛔');
      if (p.shield) marks.push('🛡️');
      if (marks.length) {
        var mt = window.RENDER.el('text', {
          x: pos.x + 52, y: pos.y - 120, 'text-anchor': 'middle', 'font-size': 44,
          stroke: '#ffffff', 'stroke-width': 6, 'paint-order': 'stroke'
        });
        mt.textContent = marks.join('');
        g.appendChild(mt);
      }
      var n = window.RENDER.el('text', {
        x: pos.x, y: pos.y - 138, 'text-anchor': 'middle',
        'font-size': 40, 'font-weight': 800, fill: '#0b1220',
        stroke: '#ffffff', 'stroke-width': 8, 'paint-order': 'stroke'
      });
      n.textContent = p.num + '組';
      g.appendChild(n);
    });
  }

  function bindMapDrag(svg) {
    var drag = null;
    svg.addEventListener('pointerdown', function (e) {
      drag = { x: e.clientX, y: e.clientY, cx: mv.x, cy: mv.y, moved: 0 };
      try { svg.setPointerCapture(e.pointerId); } catch (err) {}
    });
    svg.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var r = svg.getBoundingClientRect();
      if (!r.width) return;
      var unit = (window.RENDER.VW / r.width) / mv.k;   // 螢幕 1 px 等於地圖幾單位
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
      mv.x = drag.cx - dx * unit;
      mv.y = drag.cy - dy * unit;
      applyMapView();
    });
    function finish(e) {
      var tap = drag && drag.moved < 10;
      drag = null;
      if (!tap) return;
      var t = document.elementFromPoint(e.clientX, e.clientY);
      var idx = t && t.getAttribute && t.getAttribute('data-cell');
      if (idx != null) showCellCard(+idx);
      else $('mapInfo').classList.add('hidden');
    }
    svg.addEventListener('pointerup', finish);
    svg.addEventListener('pointercancel', function () { drag = null; });
  }

  /** 點一格，右下角跳出這一格的詳細資料 */
  function showCellCard(i) {
    var c = B.CELLS[i], box = $('mapInfo');
    var owner = state.board.owner[i], lv = state.board.level[i] || 0;
    var html = '<b>' + i + '　' + c.name + '</b>' +
               (c.place ? '　<span style="color:var(--dim)">' + c.place + '</span>' : '') + '<br>';
    if (c.type === 'land') {
      var rent = B.baseRent(i, lv, E.hasFullColor(state, i));
      if (owner) {
        var ch = state.players[owner].charId ? window.charById(state.players[owner].charId) : null;
        html += '地主：' + (ch ? ch.emoji + ' ' : '') + state.players[owner].name +
                (owner === my.gid ? '（我的地）' : '') + '<br>' +
                B.LEVEL_NAME[lv] + '　過路費 <b>$' + rent.toLocaleString() + '</b>';
      } else {
        html += '還沒人買　售價 <b>$' + c.price.toLocaleString() + '</b><br>' +
                '空地租 $' + Math.round(c.price * B.RENT_RATE).toLocaleString();
      }
    } else {
      html += cellDesc(c);
    }
    box.innerHTML = html;
    box.classList.remove('hidden');
  }

  function renderMap() {
    var rows = [];
    B.CELLS.forEach(function (c, i) {
      var owner = state.board.owner[i];
      var lv = state.board.level[i] || 0;
      var isMine = owner === my.gid;

      if (mapFilter === 'land' && c.type !== 'land') return;
      if (mapFilter === 'mine' && !isMine) return;
      if (mapFilter === 'free' && (c.type !== 'land' || owner)) return;

      var right, dot;
      if (c.type === 'land') {
        var rent = B.baseRent(i, lv, E.hasFullColor(state, i));
        dot = B.COLORS[c.color].hex;
        right = owner
          ? '<b>過路費 $' + rent.toLocaleString() + '</b><br>' +
            state.players[owner].name + '　' + B.LEVEL_NAME[lv]
          : '<b>售價 $' + c.price.toLocaleString() + '</b><br>還沒人買　空地租 $' +
            Math.round(c.price * B.RENT_RATE).toLocaleString();
      } else {
        dot = '#64748b';
        right = '<span style="color:var(--dim)">' + cellDesc(c) + '</span>';
      }
      rows.push('<div class="mp-row' + (isMine ? ' mine' : '') +
        (c.type === 'land' && !owner ? ' free' : '') + '">' +
        '<span class="mp-dot" style="background:' + dot + '"></span>' +
        '<span style="min-width:26px;color:#64748b">' + i + '</span>' +
        '<span><span class="mp-name">' + c.name + '</span>' +
        '<br><span class="mp-place">' + (c.place || '') + '</span></span>' +
        '<span class="mp-right">' + right + '</span></div>');
    });
    $('mapList').innerHTML = rows.join('') ||
      '<div class="pl-msg" style="padding:20px;text-align:center">沒有符合的格子</div>';
  }

  function cellDesc(c) {
    var m = {
      shop: '創投商店：用點數買卡', bank: '銀行：存提款、貸款',
      subsidy: '國科會補助 +40 點', chest: '寶箱 +100 點', packet: '點數包 +60 點',
      patent: '專利局：抽一張卡', news: '新聞快報：隨機事件',
      god: '產業風向：神明附身 3 輪', tax: '國稅局：繳總資產 5%',
      pool: '政府補助池：領走累積稅金', audit: '稽查：直接送檢調',
      jail: '檢調約談所：停 1 輪', hosp: '醫院：停 1 輪',
      airport: '桃園機場：可飛海外廠', fork: '岔路口：隨機決定走哪一條',
      mountain: '山區'
    };
    return m[c.type] || '';
  }

  function bindLeave() {
    bindMapButtons();
    var b = $('btnLeave');
    if (!b || b._bound) return;
    b._bound = true;
    b.onclick = function () {
      if (!confirm('要離開這一組嗎？\n（離開後要重新輸入編號）')) return;
      localStorage.removeItem('techisland:me');
      location.reload();
    };
  }

  function renderTop(me) {
    bindLeave();
    var ch = window.charById(me.charId);
    if (ch) {
      var img = $('myAvatar');
      var url = 'images/characters/char_' + (ch.num < 10 ? '0' : '') + ch.num + '_' + ch.id + '_idle.png';
      if (img.dataset.url !== url) {
        img.dataset.url = url;
        img.style.visibility = 'hidden';
        img.onerror = function () { img.style.visibility = 'hidden'; };
        img.onload = function () { img.style.visibility = 'visible'; };
        img.src = url;
        if (img.complete && img.naturalWidth > 0) img.style.visibility = 'visible';
      }
    }
    $('myName').textContent = me.name;
    $('myCash').textContent = '$' + me.cash.toLocaleString();
    $('myBank').textContent = '$' + me.bank.toLocaleString();
    $('myRp').textContent = me.rp + ' 點';
    $('myLoanWrap').classList.toggle('hidden', !me.loan);
    $('myLoan').textContent = '$' + me.loan.toLocaleString();
    $('myPos').textContent = '📍 ' + B.CELLS[me.pos].name;

    var s = [];
    if (me.frozen > 0) s.push('⛔ 停機中');
    if (me.god) {
      var g = E.GODS.filter(function (x) { return x.id === me.god; })[0];
      if (g) s.push(g.emoji + ' ' + g.name + '（' + me.godTurns + ' 輪）');
    }
    if (me.virus > 0) s.push('💣 中毒！' + me.virus + ' 輪後爆炸，快去經過別人身邊甩鍋');
    if (me.cash < 0) s.push('⚠️ 現金為負，不能買地蓋廠');
    $('myState').textContent = s.length ? '　' + s.join('　') : '';
  }

  // ═══════════════════════════════════════
  // 答題
  // ═══════════════════════════════════════
  var qStart = 0;
  function renderQuestion(me) {
    var q = state.question;
    if (!q) return;
    $('qCard').classList.remove('hidden');
    $('qRound').textContent = state.round;

    // 識別字串要帶上輪次：同一題在不同輪再次出現時，按鈕必須重建，
    // 否則會沿用上一輪結束時被鎖住的按鈕，學生點不下去。
    var qkey = String(q.id) + '|' + state.round;
    if ($('qText').dataset.qid !== qkey) {
      $('qText').dataset.qid = qkey;
      $('qText').textContent = q.text;
      qStart = Date.now();
      var box = $('qOpts');
      box.innerHTML = '';
      q.optionKeys.forEach(function (k) {
        var b = document.createElement('button');
        b.className = 'opt-btn';
        b.innerHTML = '<span class="k">' + k + '</span><span>' + q.options[k] + '</span>';
        b.onclick = function () {
          if (answered || me.frozen > 0) return;
          answered = true;
          [].forEach.call(box.children, function (x) { x.disabled = true; });
          // 立刻鎖住提示，不要等下一次畫面更新才鎖
          ['btnHint', 'btnHint2'].forEach(function (id) {
            var hb = $(id);
            if (hb) { hb.disabled = true; hb.style.opacity = '.4'; hb.onclick = null; }
          });
          b.classList.add('sel');
          send({ type: 'answer', choice: k, timeMs: Date.now() - qStart });
          $('qLeft').textContent = '已送出，等其他組…';
        };
        box.appendChild(b);
      });
      // 學生多半捲到下面在看手牌，新題目出現要主動捲回來，不然等於沒看到
      try { $('qCard').scrollIntoView({ block: 'start', behavior: 'smooth' }); }
      catch (e) { window.scrollTo(0, 0); }
    }
    if (me.frozen > 0) {
      $('qLeft').textContent = '停機中，這輪不能作答';
      [].forEach.call($('qOpts').children, function (x) { x.disabled = true; });
    } else if (!answered) {
      $('qLeft').textContent = '快作答！答對才能骰骰子';
    }

    if (state.allCards) {
      var rb = $('btnRankP');
      if (rb) rb.textContent = '🔭 戰況（看得到手牌）';
    } else {
      var rb2 = $('btnRankP');
      if (rb2) rb2.textContent = '📊 戰況';
    }
    if (me.buff && me.buff.peek) {
      pmsg('hintBox', '📡 感應卡：這一題的正確答案是 ' + me.buff.peek, 'ok');
    } else if (state.myHints && state.myHints.length) {
      // 已經買到的提示（提示內容只會送給付過錢的那一組）
      pmsg('hintBox', state.myHints.map(function (h, i) {
        return '💡 提示 ' + (i + 1) + '：' + h;
      }).join('\n'), 'ok');
    }

    // 已經作答就把提示鎖起來：提示要花錢，答完再買也沒用，
    // 而且學生很容易在等其他組時不小心點到，白白扣錢。
    // 提示是「一段一段往下買」的：買到第幾段由白板決定，平板只負責按。
    // 以前兩顆按鈕都固定送 level 0，等於可以一直重複買同一段、一直扣錢。
    var bought = (state.myHints && state.myHints.length) || 0;
    var total = (state.question && state.question.hintCount) || 0;
    var soldOut = bought >= total;
    var lockHint = answered || me.frozen > 0 || soldOut;
    ['btnHint', 'btnHint2'].forEach(function (id, i) {
      var b = $(id);
      if (!b) return;
      if (i === 1) { b.classList.add('hidden'); return; }   // 只留一顆，按一次買下一段
      b.classList.remove('hidden');
      var cost = E.CFG.hintCost[Math.min(bought, E.CFG.hintCost.length - 1)] || 0;
      b.textContent = soldOut
        ? '提示已全部買完'
        : '💡 買第 ' + (bought + 1) + ' 個提示（$' + cost.toLocaleString() + '）';
      b.disabled = lockHint;
      b.style.opacity = lockHint ? '.4' : '';
      b.onclick = lockHint ? null : function () { doHint(); };
    });
  }

  function doHint() {
    if (answered) { pmsg('hintBox', '已經作答了，提示買了也沒用', 'err'); return; }
    if (state.phase !== 'question') { pmsg('hintBox', '現在不是作答時間', 'err'); return; }
    var bought = (state.myHints && state.myHints.length) || 0;
    var total = (state.question && state.question.hintCount) || 0;
    if (bought >= total) { pmsg('hintBox', '這題沒有更多提示了', 'err'); return; }
    var cost = E.CFG.hintCost[Math.min(bought, E.CFG.hintCost.length - 1)] || 0;
    if (state.players[my.gid].cash < cost) { pmsg('hintBox', '現金不足', 'err'); return; }
    $('btnHint').disabled = true;
    pmsg('hintBox', '⏳ 購買中…', '');
    send({ type: 'hint' });
  }

  // ═══════════════════════════════════════
  // 輪到我行動時的選項
  // ═══════════════════════════════════════
  function renderAction(me) {
    var waitingMe = state.decide && state.decide.gid === my.gid;
    var isMyTurn = (state.phase === 'moving' && E.currentGid(state) === my.gid) || waitingMe;
    var card = $('actCard'), body = $('actBody');
    var cell = B.CELLS[me.pos];
    var html = [];

    if (!isMyTurn) {
      // 不是我的回合，但仍可看資訊
      card.classList.add('hidden');
      stopDecideTimer();
      return;
    }

    // 還在走路的時候不可以出現任何操作按鈕。
    // 走路中平板會即時收到每一格的狀態，按鈕就會一格一格冒出來，
    // 學生可以趁機把路過的地買走、順便逛商店 —— 引擎已經擋掉了，
    // 但畫面上還是不該給他們按，不然會變成「我明明按了卻沒反應」。
    if (me.stepsLeft > 0 && !waitingMe) {
      card.classList.remove('hidden');
      stopDecideTimer();
      $('actTitle').textContent = '移動中…　還要走 ' + me.stepsLeft + ' 步';
      body.innerHTML = '<div class="pl-msg">🚶 走完停下來之後才能買地、蓋廠、逛商店</div>';
      return;
    }

    card.classList.remove('hidden');
    $('actTitle').textContent = '輪到你了 · ' + cell.name;
    if (waitingMe) startDecideTimer(state.decide.until); else stopDecideTimer();

    // 岔路口現在是隨機決定的（讓玩家選的話，沒人會自願走進對手蓋滿廠房的那一條），
    // 這裡只告知，不給選項
    var opts = E.nextOptions(state, my.gid);
    if (me.stepsLeft > 0 && opts.length > 1) {
      html.push('<div class="pl-msg">⛰️ 前面是岔路口，走哪一條由電腦隨機決定</div>');
    }

    // 買地
    if (cell.type === 'land' && !state.board.owner[me.pos]) {
      if (me.god === 'stock') {
        // 被庫存之神附身時買地一律流標。引擎會擋，但按鈕還亮著的話
        // 學生只會覺得「我明明按了卻沒反應」，要直接講清楚原因。
        html.push('<div class="pl-msg">📉 被庫存之神附身，這段期間買地一律流標，' +
                  '要等附身結束（還有 ' + (me.godTurns || 0) + ' 輪）</div>');
      } else {
        var price = me.god === 'grant' ? Math.round(cell.price / 2) : cell.price;
        html.push('<button class="opt-btn" data-act="buy">🏗️ 買下 ' + cell.name +
                  '（$' + price.toLocaleString() + '）</button>');
      }
    }
    // 蓋廠
    if (state.board.owner[me.pos] === my.gid) {
      var lv = state.board.level[me.pos] || 0;
      if (lv < 5) {
        var c1 = B.upgradeCost(me.pos);
        var canAll = Math.min(5 - lv, Math.floor(me.cash / c1));
        html.push('<button class="opt-btn" data-act="build1">🏭 蓋一級（$' + c1.toLocaleString() +
                  '）目前 ' + B.LEVEL_NAME[lv] + '</button>');
        if (canAll > 1) html.push('<button class="opt-btn" data-act="buildall">🏭🏭 一次蓋到滿（' +
                  canAll + ' 級，$' + (c1 * canAll).toLocaleString() + '）</button>');
      }
    }
    // 併購
    if (cell.type === 'land' && state.board.owner[me.pos] && state.board.owner[me.pos] !== my.gid &&
        state.cfg && state.cfg.allowMerge) {
      var cur = B.landValue(me.pos, state.board.level[me.pos] || 0);
      html.push('<button class="opt-btn" data-act="merge">🏢 併購這塊地（$' +
                (cur * 2).toLocaleString() + '）</button>');
    }
    // 商店
    if (cell.type === 'shop') {
      html.push('<div class="pl-msg">🏪 創投商店　<b>不限時間，慢慢挑</b>　' +
                '（白板上只會顯示「行動中」，別人看不到你買什麼）<br>' +
                '買好之後按最下面的「🛒 我買完了」，老師才會換下一組。</div>');
      html.push('<div class="shop-grid">' + shopShelf().map(function (c) {
        var afford = me.rp >= c.cost;
        return '<div class="hand-card' + (afford ? '' : ' taken') + '" data-shop="' + c.id + '">' +
               '<div class="e">' + c.emoji + '</div><div class="n">' + c.name + '</div>' +
               '<div class="d">' + c.desc + '</div>' +
               '<div class="c">' + c.cost + ' 點' + (afford ? '' : '（點數不足）') + '</div></div>';
      }).join('') + '</div>');
    }
    if (!html.length) html.push('<div class="pl-msg">這一格沒有可以做的事，按下面的按鍵告訴老師就好</div>');
    if (waitingMe) {
      var isShop = (cell.type === 'shop');
      html.push('<button class="opt-btn" data-act="skip" style="color:#ffffff;background:' +
                (isShop ? '#166534' : '#334155') + '">' +
                (isShop ? '🛒 我買完了' : '✓ 我好了') + '</button>');
    }

    body.innerHTML = html.join('');
    body.querySelectorAll('[data-fork]').forEach(function (b) {
      b.onclick = function () { send({ type: 'fork', cell: +b.dataset.fork }); b.disabled = true; };
    });
    body.querySelectorAll('[data-act]').forEach(function (b) {
      b.onclick = function () {
        var a = b.dataset.act;
        if (a === 'buy') send({ type: 'buy' });
        if (a === 'build1') send({ type: 'build', times: 1 });
        if (a === 'buildall') send({ type: 'build', times: 99 });
        if (a === 'merge') send({ type: 'merge' });
        if (a === 'skip') {
          send({ type: 'skip' });
          // 換不換人是老師按的。這裡要講清楚，不然學生會以為沒送出一直按。
          b.textContent = '✅ 已告訴老師，等老師換下一位';
          b.style.background = '#166534';
          b.style.color = '#ffffff';
        }
        b.disabled = true;
      };
    });
    body.querySelectorAll('[data-shop]').forEach(function (b) {
      b.onclick = function () {
        var id = b.dataset.shop;
        var meNow = state.players[my.gid];
        var cdef = shopShelf().filter(function (c) { return c.id === id; })[0];
        // 買不起、手牌滿：本地就擋下來講原因，不要送出又假裝成功
        if (!cdef) return;
        if ((meNow.cards || []).length >= 8) { pmsg('handMsg', '⚠️ 手牌已滿（上限 8 張），先用掉再買', 'err'); return; }
        if (meNow.rp < cdef.cost) { pmsg('handMsg', '⚠️ 研發點數不足（要 ' + cdef.cost + ' 點）', 'err'); return; }
        if (b.dataset.cooling) return;      // 冷卻中不重送（防連點連寫雲端）
        b.dataset.cooling = '1';
        b.style.opacity = .4;
        setTimeout(function () { delete b.dataset.cooling; b.style.opacity = ''; }, 1500);
        send({ type: 'shop', cardId: id });
      };
    });
  }

  // ═══════════════════════════════════════
  // 連線看門狗
  // 收不到老師端的訊息時，畫面上要直接講出來。
  // 以前這種情況只會「畫面靜止」，老師和學生都以為是遊戲壞了，
  // 其實是這一台的連線斷了而已。
  // ═══════════════════════════════════════
  var lastStateAt = 0;
  var connBad = false;
  var STALE_MS = 15000;              // 15 秒沒收到任何狀態就算不對勁

  function startConnWatch() {
    setInterval(function () {
      if (!my.gid || !lastStateAt) return;                 // 還沒進遊戲不用管
      var gap = Date.now() - lastStateAt;
      if (gap < STALE_MS) return;
      if (!connBad) {
        connBad = true;
        var w = $('connWarn');
        w.innerHTML = '⚠️ 收不到老師端的訊息（已經 <b id="connSec">' +
                      Math.round(gap / 1000) + '</b> 秒）<br>正在自動重新連線…' +
                      '<br><button id="connReload">還是不行？點我重新整理</button>' +
                      '<button id="connLeave" style="margin-left:8px">老師開了新的一場？回到輸入編號</button>';
        w.classList.remove('hidden');
        var rb = document.getElementById('connReload');
        if (rb) rb.onclick = function () { location.reload(); };
        var lb = document.getElementById('connLeave');
        if (lb) lb.onclick = leaveRoom;
        tryReconnect();
      }
      var el = document.getElementById('connSec');
      if (el) el.textContent = Math.round(gap / 1000);
    }, 2000);
  }

  var reconnectAt = 0;
  function tryReconnect() {
    if (Date.now() - reconnectAt < 8000) return;           // 不要一直重連
    reconnectAt = Date.now();
    try {
      if (room && room.gameId && S.getMode() === 'firebase') {
        S.setMode('firebase', room.gameId);
        S.watchState(onState);                             // 重新掛監聽（會先取消舊的）
        send({ type: 'hello' });
      }
    } catch (e) {}
  }

  /** 最上方的階段提示：現在是道具時間？答題時間？還是別組在行動？ */
  var bannerTimer = null;
  function renderPhaseBanner() {
    var el = $('phaseBanner');
    if (!el) return;
    clearInterval(bannerTimer);
    // 「✓ 這輪不出牌了」的顯示控制要放在最前面：
    // 下面一堆 early return（暫停、休息、公布效果…）會跳過後半段，
    // 按鈕就會停留在上一個道具階段的狀態，掛在畫面上讓學生白按。
    var doneBtn0 = $('btnItemDone');
    if (doneBtn0) {
      var showDone0 = state.phase === 'item' && state.itemUntil != null && !state.paused;
      doneBtn0.classList.toggle('hidden', !showDone0);
    }
    if (state.paused) {
      el.className = 'phase-banner';
      el.textContent = '⏸ 老師暫停中　請看白板';
      return;
    }
    if (state.phase === 'ended') {
      el.className = 'phase-banner';
      el.textContent = '🏆 本節結束　看白板上的排名';
      return;
    }
    // 遊戲還沒真正開始（第 0 輪）就不要顯示休息／時間到之類的訊息，
    // 學生剛進來看到「時間到，正在等老師端」會以為壞掉了。
    if (state.phase === 'break' && !(state.round > 0)) {
      el.className = 'phase-banner';
      el.textContent = '⏳ 等待老師開始';
      return;
    }
    if (state.phase === 'break') {
      el.className = 'phase-banner';
      if (state.breakUntil == null) {
        el.textContent = '☕ 休息中　等老師開始下一輪';
      } else {
        var tickBreak = function () {
          if (state.breakUntil == null) { el.textContent = '☕ 休息中'; return; }
          var s = Math.max(0, Math.ceil((state.breakUntil - hostNow()) / 1000));
          // 倒數到 0 還沒收到新狀態，代表這台平板暫時沒收到老師端的訊息。
          // 卡在「0 秒」會讓學生以為當機，講明白在等什麼比較好。
          el.textContent = s > 0 ? ('☕ 休息中　' + s + ' 秒後開始下一輪')
                                 : '☕ 時間到，正在等老師端…';
        };
        tickBreak();
        bannerTimer = setInterval(tickBreak, 500);
      }
      return;
    }
    if (state.phase === 'cast' || (state.phase === 'item' && state.itemUntil == null)) {
      el.className = 'phase-banner';
      el.textContent = '📣 正在公布各組的道具效果…';
      return;
    }
    var doneBtn = $('btnItemDone');
    if (doneBtn) {
      var showDone = state.phase === 'item' && state.itemUntil != null;
      if (showDone && !(state.itemReady && state.itemReady[my.gid])) {
        doneBtn.disabled = false;
        doneBtn.textContent = '✓ 這輪不出牌了';
      }
    }
    if (state.phase === 'item') {
      el.className = 'phase-banner item';
      var tick = function () {
        var left = Math.max(0, Math.ceil((state.itemUntil - hostNow()) / 1000));
        el.textContent = '🎴 道具時間　' + left + ' 秒　（本輪還可出 ' +
          Math.max(0, 2 - (state.players[my.gid].playedThisRound || 0)) + ' 張）';
        if (left <= 0) clearInterval(bannerTimer);
      };
      tick(); bannerTimer = setInterval(tick, 500);
    } else if (state.phase === 'question') {
      el.className = 'phase-banner q';
      el.textContent = '✏️ 答題時間　答對才能骰骰子';
    } else if (state.phase === 'moving') {
      var cur = E.currentGid(state);
      el.className = 'phase-banner';
      el.textContent = cur === my.gid ? '🎲 輪到你行動' :
        '⏳ ' + (state.players[cur] ? state.players[cur].name : '別組') + ' 行動中';
    } else {
      el.className = 'phase-banner';
      el.textContent = '⏳ 等待下一輪';
    }
  }

  // ── 決定時間倒數：讓學生知道還剩幾秒 ──
  var decideTimer = null;
  function startDecideTimer(until) {
    stopDecideTimer();
    var here = B.CELLS[state.players[my.gid].pos].name;
    // until 一律是 null：換下一位由老師按鍵決定，平板這邊不倒數，
    // 學生就不會因為「剩 2 秒」而慌張亂按。
    if (until == null) {
      $('actTitle').textContent = '輪到你了 · ' + here + '　（不限時間，做完按最下面的按鍵）';
      return;
    }
    function tick() {
      var left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      $('actTitle').textContent = '輪到你了 · ' + here + '　⏱ ' + left + ' 秒';
      if (left <= 0) stopDecideTimer();
    }
    tick();
    decideTimer = setInterval(tick, 300);
  }
  function stopDecideTimer() {
    if (decideTimer) { clearInterval(decideTimer); decideTimer = null; }
  }

  /** 商店貨架：由狀態種子決定，每次進去都不一樣但老師端與平板一致。
   *  老師關閉破壞類道具時，那幾張不上架（引擎也會拒賣，兩邊一致）。 */
  function shopShelf() {
    var seed = (state.round * 31 + state.players[my.gid].pos * 7 + 13) % 9973;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    var shelf = CARD.shelf(10, rnd);
    if (state.cfg && state.cfg.allowSabotage === false) {
      shelf = shelf.filter(function (c) { return CARD.SABOTAGE.indexOf(c.id) < 0; });
    }
    return shelf;
  }

  // ═══════════════════════════════════════
  // 手牌
  // ═══════════════════════════════════════
  function renderHand(me) {
    // 注意：下面這行會整段重寫 h3，所以 handCount 這個 span 要一起帶著 id 重建，
    // 否則第二次進來就找不到節點、整個函式當場拋錯，學生會變成點卡片沒反應。
    var used = me.playedThisRound || 0;
    var h3 = $('handList').parentNode.querySelector('h3');
    me.cards = me.cards || [];
    if (h3) h3.innerHTML = '🎴 我的手牌（<span id="handCount">' + me.cards.length + '</span>/8）　' +
      '<span style="font-size:14px;color:' + (used >= 2 ? 'var(--bad)' : 'var(--dim)') + '">' +
      '本輪已出 ' + used + '/2 張</span>';
    var box = $('handList');
    box.innerHTML = '';
    me.cards.forEach(function (c, i) {
      var def = CARD.get(c.id, c.char);
      if (!def) return;
      var d = document.createElement('div');
      d.className = 'hand-card' + (selectedCard === i ? ' on' : '');
      d.innerHTML = '<div class="e">' + def.emoji + '</div>' +
                    '<div class="n">' + def.name + (c.char ? ' ★' : '') + '</div>' +
                    '<div class="d">' + def.desc + '</div>' +
                    '<div class="c">' + (def.when || '自己的行動階段') + '</div>';
      d.onclick = function () { selectCard(i, def, c); };
      box.appendChild(d);
    });
    if (!me.cards.length) box.innerHTML = '<div class="pl-msg">手上還沒有卡片</div>';
  }

  function selectCard(i, def, card) {
    if (!state || state.phase === 'setup') {
      pmsg('handMsg', '遊戲開始後才能使用卡片和道具', 'err');
      return;
    }
    if (state.phase === 'break') {
      pmsg('handMsg', '現在是休息時間，下一輪開始的「道具時間」才能出牌', 'err');
      return;
    }
    // 公布效果的動畫還在播，這時出的牌會被排到「下一輪」才生效，
    // 學生會覺得莫名其妙（下一輪沒碰平板卻公布他用了卡）。直接擋掉。
    if (state.phase === 'cast') {
      pmsg('handMsg', '正在公布這一輪的道具效果，請等下一輪再出牌', 'err');
      return;
    }
    if (state.phase === 'item' && state.itemUntil != null && hostNow() > state.itemUntil + 1500) {
      pmsg('handMsg', '道具時間結束了，下一輪再出牌', 'err');
      return;
    }
    if (def.timing === 'onQuestion' && state.phase !== 'question') {
      pmsg('handMsg', '「' + def.name + '」要在作答時間使用', 'err');
      return;
    }
    if ((state.players[my.gid].playedThisRound || 0) >= 2) {
      pmsg('handMsg', '這一輪已經出過 2 張了，下一輪再出', 'err');
      return;
    }
    if (def.when === '自動觸發') {
      pmsg('handMsg', '「' + def.name + '」會在需要的時候自動生效，不用主動使用', '');
      return;
    }
    selectedCard = i;
    guard('手牌', function () { renderHand(state.players[my.gid]); });
    // 良率控制器：要先選點數（2～12）
    if (card.id === 'dice') {
      pickTarget('這一輪要走幾步？（道具時間結束後公布）',
        [2,3,4,5,6,7,8,9,10,11,12].map(function (n) {
          return { label: n + ' 步', value: { steps: n } };
        }), card.id);
      return;
    }
    if (!def.needTarget) {
      pmsg('handMsg', '要使用「' + def.name + '」嗎？' + def.desc, '');
      askConfirm(function () { send({ type: 'card', cardId: card.id }); selectedCard = null; });
      return;
    }
    if (def.needTarget === 'player') {
      var opts = Object.keys(state.players).filter(function (g) { return g !== my.gid; });
      pickTarget('對哪一組使用？', opts.map(function (g) {
        return { label: state.players[g].name, value: { gid: g } };
      }), card.id);
    } else if (def.needTarget === 'ownLand') {
      var mine = E.landsOf(state, my.gid);
      pickTarget('選你自己的一塊地', mine.map(function (i2) {
        return { label: B.CELLS[i2].name + '（' + B.LEVEL_NAME[state.board.level[i2] || 0] + '）', value: { cell: i2 } };
      }), card.id);
    } else if (def.needTarget === 'enemyLand') {
      var theirs = [];
      for (var k in state.board.owner) if (state.board.owner[k] !== my.gid) theirs.push(+k);
      pickTarget('選對手的一塊地', theirs.map(function (i2) {
        return { label: B.CELLS[i2].name + '（' + state.players[state.board.owner[i2]].name + '）', value: { cell: i2 } };
      }), card.id);
    } else if (def.needTarget === 'cell') {
      pickTarget('選一格', B.CELLS.map(function (c2, i2) {
        var owner = state.board.owner[i2];
        var extra = c2.type === 'land'
          ? '（' + (owner ? state.players[owner].name + ' ' + B.LEVEL_NAME[state.board.level[i2] || 0]
                          : '無人 $' + c2.price.toLocaleString()) + '）'
          : '';
        return { label: i2 + ' ' + c2.name + extra, value: { cell: i2 } };
      }), card.id);
    } else if (def.needTarget === 'color') {
      pickTarget('選一個園區', Object.keys(B.COLORS).map(function (k) {
        return { label: B.COLORS[k].name, value: { color: k } };
      }), card.id);
    }
  }

  function pickTarget(title, options, cardId) {
    var box = $('handMsg');
    box.className = 'pl-msg';
    box.innerHTML = '<b>' + title + '</b><br>' + options.map(function (o, i) {
      return '<button class="opt-btn" style="margin-top:6px" data-t="' + i + '">' + o.label + '</button>';
    }).join('') + '<button class="opt-btn" style="margin-top:6px" data-cancel="1">取消</button>';
    box.querySelectorAll('[data-t]').forEach(function (b) {
      b.onclick = function () {
        if (b.disabled) return;
        box.querySelectorAll('button').forEach(function (x) { x.disabled = true; });
        send({ type: 'card', cardId: cardId, target: options[+b.dataset.t].value });
        box.innerHTML = state.phase === 'item'
          ? '✅ 已出牌，等道具時間結束後公布效果'
          : '已送出';
        selectedCard = null;
      };
    });
    var c = box.querySelector('[data-cancel]');
    if (c) c.onclick = function () { box.innerHTML = ''; selectedCard = null; renderHand(state.players[my.gid]); };
  }

  function askConfirm(fn) {
    var box = $('handMsg');
    var b = document.createElement('button');
    b.className = 'opt-btn'; b.style.marginTop = '8px'; b.textContent = '確定使用';
    b.onclick = function () {
      fn();
      box.innerHTML = state.phase === 'item'
        ? '✅ 已出牌，等道具時間結束後公布效果'
        : '已送出';
    };
    box.appendChild(b);
  }

  // ═══════════════════════════════════════
  // 資產與銀行
  // ═══════════════════════════════════════
  function renderAssets(me) {
    var mine = E.landsOf(state, my.gid);
    $('assetCount').textContent = mine.length;
    var box = $('assetList');
    box.innerHTML = mine.length ? mine.map(function (i) {
      var c = B.CELLS[i], lv = state.board.level[i] || 0;
      var rent = B.baseRent(i, lv, E.hasFullColor(state, i));
      return '<div class="asset-row"><span class="dot" style="background:' + B.COLORS[c.color].hex + '"></span>' +
             c.name + '<span class="lv">' + B.LEVEL_NAME[lv] + '　過路費 $' + rent.toLocaleString() + '</span></div>';
    }).join('') : '<div class="pl-msg">還沒有買到任何地</div>';
  }

  function renderBank(me) {
    var atBank = B.CELLS[me.pos].type === 'bank';
    // 光站在銀行格還不夠：引擎要求「輪到自己、走完停下」才辦得了，
    // 按鈕亮著但按了沒反應，學生會以為壞掉 —— 條件跟引擎一致才誠實
    var myTurnHere = atBank && state.decide && state.decide.gid === my.gid;
    $('bankHint').textContent = myTurnHere
      ? '你現在在銀行，可以存提款與貸款。存款每輪 3% 利息，但貸款期間不發利息。'
      : (atBank ? '在銀行了！等輪到你行動時就能辦理'
                : '要停在銀行格（雲林、基隆），輪到自己行動時才能辦理');
    ['btnDeposit', 'btnWithdraw', 'btnLoan', 'btnRepay'].forEach(function (id) { $(id).disabled = !myTurnHere; });

    // ⚠️ 按下當下才讀取最新餘額。原本把 me 綁死在閉包裡，
    //    畫面幾輪沒重畫的話會用到舊的餘額上限。
    $('btnDeposit').onclick = function () {
      var p = state.players[my.gid];
      amountPrompt('要存多少？', p.cash, function (v) { send({ type: 'deposit', amount: v }); });
    };
    $('btnWithdraw').onclick = function () {
      var p = state.players[my.gid];
      amountPrompt('要提多少？', p.bank, function (v) { send({ type: 'withdraw', amount: v }); });
    };
    $('btnLoan').onclick = function () {
      var p = state.players[my.gid];
      var cap = 0;
      E.landsOf(state, my.gid).forEach(function (i) { cap += B.landValue(i, state.board.level[i] || 0); });
      cap = Math.floor(cap * 0.5) - p.loan;
      amountPrompt('要借多少？（上限 $' + Math.max(0, cap).toLocaleString() + '，手續費 10%）', Math.max(0, cap),
        function (v) { send({ type: 'loan', amount: v }); });
    };
    $('btnRepay').onclick = function () {
      var p = state.players[my.gid];
      amountPrompt('要還多少？', Math.min(p.loan, p.cash + p.bank), function (v) { send({ type: 'repay', amount: v }); });
    };
  }

  function amountPrompt(title, max, fn) {
    var v = prompt(title + '\n（最多 ' + max.toLocaleString() + '）', String(Math.floor(max)));
    if (v == null) return;
    var n = Math.floor(Number(v));
    if (!isFinite(n) || n <= 0) { alert('請輸入正整數'); return; }
    if (n > max) { alert('超過上限'); return; }
    fn(n);
  }

  /**
   * 平板重新整理（或不小心關掉分頁再開）之後，自動回到原本那一組。
   * 上課時學生誤觸重整很常見，如果每次都要重打代碼會很浪費時間。
   */
  function autoRejoin() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem('techisland:me') || 'null'); } catch (e) {}
    if (!saved || !saved.code || !saved.gid) return false;

    my.code = saved.code;
    my.gid = saved.gid;
    show('rejoin');
    $('rejoinInfo').textContent = '編號 ' + saved.code + '　第 ' + saved.gid.slice(1) + ' 組';

    $('btnCancelRejoin').onclick = function () {
      localStorage.removeItem('techisland:me');
      my.gid = null;
      show('join');
      $('jCode').value = saved.code;
    };

    S.initChannel(saved.code);
    S.onLocalState(onState);

    function ok() {
      S.watchState(onState);
      send({ type: 'hello' });
      heartbeat();
    }

    if (!S.firebaseReady()) {
      S.setMode('local', 'local_' + saved.code);
      ok();
      // 本機模式收不到就退回輸入畫面
      setTimeout(function () {
        if (!state) { show('join'); pmsg('joinMsg', '連不到老師端，請重新輸入編號', 'err'); }
      }, 4000);
      return true;
    }

    S.initFirebase().then(function () {
      S.setMode('firebase', null);
      return S.findRoom(saved.code);
    }).then(function (r) {
      if (!r || r.live === false) {
        show('join');
        $('jCode').value = saved.code;
        pmsg('joinMsg', '上一場已經結束了，請輸入白板上的新編號', 'err');
        return;
      }
      room = r;
      S.setMode('firebase', r.gameId);
      ok();
    }).catch(function (e) {
      show('join');
      $('jCode').value = saved.code;
      pmsg('joinMsg', '重新連線失敗：' + e.message, 'err');
    });
    return true;
  }

  window.addEventListener('DOMContentLoaded', function () {
    // 平板預設「靜音」：一個班九台同時響會吵到聽不見老師講話，
    // 想開的組自己按右上角的喇叭就好。
    SOUND.init(false);
    startConnWatch();
    var pv = document.getElementById('plVer');
    if (pv) pv.textContent = '版本 ' + buildStamp();
    buildJoin();
    autoRejoin();
  });
})();
