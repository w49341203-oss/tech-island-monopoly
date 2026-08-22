/* 科技島大富翁 — 平板端（每組一台）
 * 只顯示自己的資訊：手牌、資產、商店、銀行都只有自己看得到
 * 白板上只會顯示「第 X 組購買中…」，不會洩漏內容
 */
(function () {
  'use strict';

  var B = window.BOARD, E = window.ENGINE, S = window.STORE, CARD = window.CARDS;
  var $ = function (id) { return document.getElementById(id); };

  var my = { code: '', gid: null, gameId: null };
  var state = null;
  var answered = false, lastRound = -1, lastPhase = '';
  var selectedCard = null, hintLevel = 0;

  // ═══════════════════════════════════════
  // 加入
  // ═══════════════════════════════════════
  var room = null;      // 查到的房間資訊（含這一場開了幾組）

  function buildJoin() {
    var codeInput = $('jCode');
    codeInput.addEventListener('input', function () {
      this.value = this.value.replace(/[^0-9]/g, '').slice(0, 6);
    });
    codeInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') doFind(); });

    $('btnFind').onclick = doFind;
    $('btnJoin').onclick = doJoin;
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
    if (code.length !== 6) { pmsg('joinMsg', '請輸入白板上的 6 位數房間代碼', 'err'); return; }
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
        pmsg('joinMsg', '找不到這個房間。請再確認一次白板上的代碼，' +
                        '也要確認老師已經按下「開新遊戲」了', 'err');
        return;
      }
      room = r;
      S.setMode('firebase', r.gameId);
      showGroupPicker('找到房間了！這一場有 ' + (r.groups || 9) + ' 組');
    }).catch(function (e) {
      $('btnFind').disabled = false;
      pmsg('joinMsg', '連線失敗：' + e.message, 'err');
    });
  }

  /** 第二步：只列出這一場實際開的組別，避免選到不存在的組 */
  function showGroupPicker(info) {
    $('step1').classList.add('hidden');
    $('step2').classList.remove('hidden');
    $('foundInfo').textContent = info;
    pmsg('joinMsg', '', '');

    var n = (room && room.groups) || 9;
    var box = $('jGroup');
    box.innerHTML = '';
    my.gid = null;
    $('btnJoin').disabled = true;

    for (var i = 1; i <= n; i++) (function (k) {
      var b = chip('第 ' + k + ' 組', false, function () {
        my.gid = 'g' + k;
        markOne(box, b);
        $('btnJoin').disabled = false;
      });
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
  function send(action) { S.sendAction(my.gid, action); }

  /** 每 10 秒報到一次，老師端才知道這組的平板還在線上（沒在線的組會由電腦代打） */
  var hbTimer = null;
  function heartbeat() {
    clearInterval(hbTimer);
    hbTimer = setInterval(function () { send({ type: 'hello' }); }, 10000);
  }

  // ═══════════════════════════════════════
  // 收到老師端狀態
  // ═══════════════════════════════════════
  function onState(st) {
    state = st;
    if (!my.gid || !state.players[my.gid]) return;
    var me = state.players[my.gid];

    if (!me.charId) { showPick(); return; }
    show('play');
    renderTop(me);
    renderHand(me);
    renderAssets(me);
    renderBank(me);

    if (state.phase === 'question') {
      if (state.round !== lastRound) { answered = false; hintLevel = 0; $('hintBox').textContent = ''; }
      renderQuestion(me);
    } else {
      $('qCard').classList.add('hidden');
    }
    renderAction(me);
    lastRound = state.round;
    lastPhase = state.phase;
  }

  function show(which) {
    ['join', 'pick', 'play'].forEach(function (id) {
      $(id).classList.toggle('hidden', id !== which);
    });
  }

  // ═══════════════════════════════════════
  // 選角
  // ═══════════════════════════════════════
  var picking = null;
  function showPick() {
    show('pick');
    var taken = {};
    Object.keys(state.players).forEach(function (g) {
      if (state.players[g].charId) taken[state.players[g].charId] = state.players[g].num;
    });
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
      send({ type: 'pick', charId: picking });
      pmsg('pickMsg', '已送出，等待老師端確認…', 'ok');
    };
  }

  // ═══════════════════════════════════════
  // 上方資訊
  // ═══════════════════════════════════════
  function renderTop(me) {
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

    if ($('qText').dataset.qid !== q.id) {
      $('qText').dataset.qid = q.id;
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
          b.classList.add('sel');
          send({ type: 'answer', choice: k, timeMs: Date.now() - qStart });
          $('qLeft').textContent = '已送出，等其他組…';
        };
        box.appendChild(b);
      });
    }
    if (me.frozen > 0) {
      $('qLeft').textContent = '停機中，這輪不能作答';
      [].forEach.call($('qOpts').children, function (x) { x.disabled = true; });
    } else if (!answered) {
      $('qLeft').textContent = '快作答！答對才能骰骰子';
    }

    $('btnHint').onclick = function () { doHint(0); };
    $('btnHint2').onclick = function () { doHint(hintLevel < 1 ? 1 : 2); };
  }

  function doHint(level) {
    var q = state.question;
    if (!q || !q.hints || !q.hints[level]) { pmsg('hintBox', '這題沒有更多提示了', 'err'); return; }
    var cost = E.CFG.hintCost[level];
    if (state.players[my.gid].cash < cost) { pmsg('hintBox', '現金不足', 'err'); return; }
    hintLevel = level + 1;
    send({ type: 'hint', level: level });
    pmsg('hintBox', '💡 ' + q.hints[level] + '（花了 $' + cost.toLocaleString() + '）', 'ok');
  }

  // ═══════════════════════════════════════
  // 輪到我行動時的選項
  // ═══════════════════════════════════════
  function renderAction(me) {
    var isMyTurn = state.phase === 'moving' && E.currentGid(state) === my.gid;
    var card = $('actCard'), body = $('actBody');
    var cell = B.CELLS[me.pos];
    var html = [];

    if (!isMyTurn) {
      // 不是我的回合，但仍可看資訊
      card.classList.add('hidden');
      return;
    }
    card.classList.remove('hidden');
    $('actTitle').textContent = '輪到你了 · ' + cell.name;

    // 岔路
    var opts = E.nextOptions(state, my.gid);
    if (me.stepsLeft > 0 && opts.length > 1) {
      html.push('<div class="pl-msg">⛰️ 岔路口！選擇要走哪一條（3 秒內）</div>');
      opts.forEach(function (o) {
        html.push('<button class="opt-btn" data-fork="' + o + '">往 ' + B.CELLS[o].name +
                  '（' + B.CELLS[o].place + '）</button>');
      });
    }

    // 買地
    if (cell.type === 'land' && !state.board.owner[me.pos]) {
      var price = me.god === 'grant' ? Math.round(cell.price / 2) : cell.price;
      html.push('<button class="opt-btn" data-act="buy">🏗️ 買下 ' + cell.name +
                '（$' + price.toLocaleString() + '）</button>');
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
      html.push('<div class="pl-msg">🏪 創投商店（白板上只會顯示「購買中」，別人看不到你買什麼）</div>');
      html.push('<div class="shop-grid">' + shopShelf().map(function (c) {
        var afford = me.rp >= c.cost;
        return '<div class="hand-card' + (afford ? '' : ' taken') + '" data-shop="' + c.id + '">' +
               '<div class="e">' + c.emoji + '</div><div class="n">' + c.name + '</div>' +
               '<div class="d">' + c.desc + '</div>' +
               '<div class="c">' + c.cost + ' 點' + (afford ? '' : '（點數不足）') + '</div></div>';
      }).join('') + '</div>');
    }
    if (!html.length) html.push('<div class="pl-msg">這一格沒有可以做的事，等老師端播完就換下一組</div>');

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
        b.disabled = true;
      };
    });
    body.querySelectorAll('[data-shop]').forEach(function (b) {
      b.onclick = function () { send({ type: 'shop', cardId: b.dataset.shop }); b.style.opacity = .4; };
    });
  }

  /** 商店貨架：由狀態種子決定，每次進去都不一樣但老師端與平板一致 */
  function shopShelf() {
    var seed = (state.round * 31 + state.players[my.gid].pos * 7 + 13) % 9973;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    return CARD.shelf(10, rnd);
  }

  // ═══════════════════════════════════════
  // 手牌
  // ═══════════════════════════════════════
  function renderHand(me) {
    $('handCount').textContent = me.cards.length;
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
    selectedCard = i;
    renderHand(state.players[my.gid]);
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
        return { label: i2 + ' ' + c2.name, value: { cell: i2 } };
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
        send({ type: 'card', cardId: cardId, target: options[+b.dataset.t].value });
        box.innerHTML = '已送出';
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
    b.onclick = function () { fn(); box.innerHTML = '已送出'; };
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
    $('bankHint').textContent = atBank
      ? '你現在在銀行，可以存提款與貸款。存款每輪 3% 利息，但貸款期間不發利息。'
      : '要停在銀行格（雲林、基隆）才能存提款與申請貸款';
    ['btnDeposit', 'btnWithdraw', 'btnLoan', 'btnRepay'].forEach(function (id) { $(id).disabled = !atBank; });

    $('btnDeposit').onclick = function () { amountPrompt('要存多少？', me.cash, function (v) { send({ type: 'deposit', amount: v }); }); };
    $('btnWithdraw').onclick = function () { amountPrompt('要提多少？', me.bank, function (v) { send({ type: 'withdraw', amount: v }); }); };
    $('btnLoan').onclick = function () {
      var cap = 0;
      E.landsOf(state, my.gid).forEach(function (i) { cap += B.landValue(i, state.board.level[i] || 0); });
      cap = Math.floor(cap * 0.5) - me.loan;
      amountPrompt('要借多少？（上限 $' + Math.max(0, cap).toLocaleString() + '，手續費 10%）', Math.max(0, cap),
        function (v) { send({ type: 'loan', amount: v }); });
    };
    $('btnRepay').onclick = function () { amountPrompt('要還多少？', Math.min(me.loan, me.cash + me.bank), function (v) { send({ type: 'repay', amount: v }); }); };
  }

  function amountPrompt(title, max, fn) {
    var v = prompt(title + '\n（最多 ' + max.toLocaleString() + '）', String(Math.floor(max)));
    if (v == null) return;
    var n = Math.floor(Number(v));
    if (!isFinite(n) || n <= 0) { alert('請輸入正整數'); return; }
    if (n > max) { alert('超過上限'); return; }
    fn(n);
  }

  window.addEventListener('DOMContentLoaded', buildJoin);
})();
