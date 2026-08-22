/* 科技島大富翁 — 遊戲邏輯引擎
 * 純邏輯、可序列化、無 DOM 依賴（Node 也能跑，方便自動化測試）
 * 規格：工作紀錄.md　數值：數值設定.md
 *
 * 一輪的流程：
 *   startRound  出題（全班同時作答，10 秒／難題 15 秒）
 *   submitAnswer 各組送出答案（記錄用時）
 *   reveal      時間到，同時揭曉，決定行動順序（答對且用時最短者先走）
 *   走：nextStep / chooseFork（逐格移動，遇岔路暫停等選擇）
 *   endTurn     該組行動結束，換下一組
 *   endRound    全部走完，結算利息／附身／病毒／回合狀態
 */
(function (global) {
  'use strict';

  var B = global.BOARD;
  var CARD = global.CARDS;
  var CHARS = global.CHARACTERS;

  // ── 數值（數值設定.md）──
  var CFG = {
    startCash: 100000,
    bankRate: 0.03,          // 存款每輪 3% 利息
    loanFee: 0.10,           // 貸款手續費 10%
    loanTerm: 15,            // 貸款期限（輪）
    taxRate: 0.05,           // 國稅局：總資產 5%
    hintCost: [500, 1000, 1500],
    rpWrong: 15,             // 答錯：原地研發
    rpLab: 2,                // 每座研發中心（≥①級）每輪產出
    rpSubsidy: 40,
    rpChest: 100,
    rpPacket: 60,
    rpNews: 25,
    mergerMult: 2,           // 併購 = 現值 ×2
    radiationDamage: 5000,
    virusFuse: 5,            // 病毒倒數
    virusRadius: 2,          // 爆炸範圍（前後各 N 格）
    godTurns: 3,
    charCardEvery: 5,        // 每 5 輪發一張角色專屬卡
    handLimit: 8,
    shopShelf: 10,
    answerSec: 10,
    answerSecHard: 15,
    maxRounds: 30
  };

  var GODS = [
    { id: 'order',  name: '訂單之神', emoji: '📈', desc: '踩到別人的地完全不用付過路費' },
    { id: 'grant',  name: '補助之神', emoji: '🎁', desc: '每輪送卡片、買地半價還附贈蓋一層、蓋房多一級' },
    { id: 'build',  name: '建廠之神', emoji: '🏗️', desc: '每經過自己的地自動升一級' },
    { id: 'stock',  name: '庫存之神', emoji: '📉', desc: '買地必流標、手上卡片掉一半' },
    { id: 'fx',     name: '匯損之神', emoji: '💸', desc: '每輪扣 $1,000、付過路費加倍' }
  ];

  function rnd(state) {
    // 可重現的亂數（存檔續玩時序列一致）
    state.seed = (state.seed * 1103515245 + 12345) & 0x7fffffff;
    return state.seed / 0x7fffffff;
  }
  function pick(state, arr) { return arr[Math.floor(rnd(state) * arr.length)]; }
  function log(state, text, kind) {
    state.log.push({ r: state.round, t: text, k: kind || 'info' });
    if (state.log.length > 300) state.log.shift();
  }

  // ─────────────────────────────────────────
  // 建立遊戲
  // ─────────────────────────────────────────
  function createGame(opts) {
    opts = opts || {};
    var n = opts.groups || 9;
    var state = {
      version: 1,
      classId: opts.classId || '智',
      slot: opts.slot || 1,
      seed: opts.seed || 20260822,
      round: 0,
      maxRounds: opts.maxRounds || CFG.maxRounds,
      chapters: opts.chapters || [],
      phase: 'setup',
      players: {},
      order: [],
      turnIndex: 0,
      question: null,
      answers: {},
      board: { owner: {}, level: {}, barrier: {}, radiation: {}, quakeColor: null },
      pool: 0,
      lastCardPlayed: null,
      usedQuestions: [],
      log: []
    };
    var starts = B.randomStarts(n, function () { return rnd(state); });
    for (var i = 0; i < n; i++) {
      var gid = 'g' + (i + 1);
      state.players[gid] = {
        gid: gid, num: i + 1, charId: null, name: '第 ' + (i + 1) + ' 組',
        cash: CFG.startCash, bank: 0, rp: 0,
        pos: starts[i], prev: -1,
        cards: [], loan: 0, loanDue: 0,
        frozen: 0, jailed: false,
        god: null, godTurns: 0,
        virus: 0,
        alliance: {},
        buff: {},
        stat: { rentPaid: 0, rentEarned: 0, correct: 0, wrong: 0 }
      };
    }
    log(state, '遊戲建立，' + n + ' 組隨機分散在地圖各處', 'sys');
    return state;
  }

  /** 選角（不可重複） */
  function pickCharacter(state, gid, charId) {
    for (var k in state.players) {
      if (state.players[k].charId === charId) return { ok: false, msg: '這位科學家已經被選走了' };
    }
    var c = global.charById(charId);
    if (!c) return { ok: false, msg: '找不到這位科學家' };
    state.players[gid].charId = charId;
    state.players[gid].name = '第 ' + state.players[gid].num + ' 組 · ' + c.name;
    // 開局手牌：四大道具隨機 3 張 + 1 張自己的專屬卡
    var tools = CARD.TOOLS.slice();
    var hand = [];
    for (var i = 0; i < 3; i++) hand.push({ id: tools[Math.floor(rnd(state) * tools.length)].id });
    hand.push({ id: c.card, char: true });
    state.players[gid].cards = hand;
    return { ok: true };
  }

  // ─────────────────────────────────────────
  // 資產計算
  // ─────────────────────────────────────────
  function landsOf(state, gid) {
    var out = [];
    for (var k in state.board.owner) if (state.board.owner[k] === gid) out.push(+k);
    return out;
  }
  function hasFullColor(state, idx) {
    var owner = state.board.owner[idx];
    if (!owner) return false;
    var same = B.SAME_COLOR[idx] || [];
    for (var i = 0; i < same.length; i++) if (state.board.owner[same[i]] !== owner) return false;
    return true;
  }
  function wealth(state, gid) {
    var p = state.players[gid];
    var w = p.cash + p.bank - p.loan;
    landsOf(state, gid).forEach(function (i) { w += B.landValue(i, state.board.level[i] || 0); });
    return Math.round(w);
  }
  function ranking(state) {
    return Object.keys(state.players)
      .map(function (g) { return { gid: g, wealth: wealth(state, g) }; })
      .sort(function (a, b) { return b.wealth - a.wealth; });
  }

  // ─────────────────────────────────────────
  // 金錢
  // ─────────────────────────────────────────
  function payTo(state, fromGid, toGid, amount) {
    var p = state.players[fromGid];
    // 現金不足時，存款自動代扣（避免卡關；均富卡仍只看現金）
    if (p.cash < amount && p.bank > 0) {
      var take = Math.min(p.bank, amount - p.cash);
      p.bank -= take; p.cash += take;
    }
    p.cash -= amount;
    if (toGid) state.players[toGid].cash += amount;
    else state.pool += amount;
    return amount;
  }

  function applyLoan(state, gid, amount) {
    var p = state.players[gid];
    var cap = 0;
    landsOf(state, gid).forEach(function (i) { cap += B.landValue(i, state.board.level[i] || 0); });
    cap = Math.floor(cap * 0.5) - p.loan;
    if (amount > cap) return { ok: false, msg: '超過額度上限（地產總值的 50%），最多可借 $' + Math.max(0, cap).toLocaleString() };
    if (amount <= 0) return { ok: false, msg: '金額不正確' };
    p.cash += amount;
    p.loan += Math.round(amount * (1 + CFG.loanFee));
    p.loanDue = state.round + CFG.loanTerm;
    log(state, p.name + ' 申請貸款 $' + amount.toLocaleString() + '（含手續費需還 $' + p.loan.toLocaleString() + '）', 'loan');
    return { ok: true };
  }

  function repayLoan(state, gid, amount) {
    var p = state.players[gid];
    amount = Math.min(amount, p.loan, p.cash + p.bank);
    if (amount <= 0) return { ok: false, msg: '沒有可還的金額' };
    payTo(state, gid, null, amount);
    state.pool -= amount;              // 還款不進補助池
    p.loan -= amount;
    if (p.loan <= 0) { p.loan = 0; p.loanDue = 0; }
    return { ok: true };
  }

  // ─────────────────────────────────────────
  // 回合流程
  // ─────────────────────────────────────────
  function startRound(state, question) {
    state.round++;
    state.phase = 'question';
    state.question = question;
    state.answers = {};
    state.order = [];
    state.turnIndex = 0;
    state.board.quakeColor = null;
    if (question && question.id) state.usedQuestions.push(question.id);
    log(state, '第 ' + state.round + ' 輪開始', 'round');
    return state;
  }

  function submitAnswer(state, gid, choice, timeMs) {
    if (state.phase !== 'question') return { ok: false, msg: '現在不是作答時間' };
    if (state.answers[gid]) return { ok: false, msg: '已經作答過了' };   // 防連點／重複送出
    var p = state.players[gid];
    if (p.frozen > 0) return { ok: false, msg: '停機中，這輪不能行動' };
    state.answers[gid] = { choice: choice, timeMs: timeMs, correct: null };
    return { ok: true };
  }

  /** 時間到，揭曉並決定行動順序：答對 + 用時最短者先走 */
  function reveal(state) {
    state.phase = 'reveal';
    var ans = state.question ? state.question.answer : null;
    var acts = [];
    for (var gid in state.players) {
      var p = state.players[gid];
      if (p.frozen > 0) { p.frozen--; if (p.frozen === 0) p.jailed = false; continue; }
      var a = state.answers[gid];
      var correct = !!(a && a.choice === ans);
      if (a) a.correct = correct;
      if (correct) {
        p.stat.correct++;
        acts.push({ gid: gid, timeMs: a.timeMs });
      } else {
        p.stat.wrong++;
        p.rp += CFG.rpWrong;                     // 原地研發：答錯的補償
        log(state, p.name + ' 答錯，原地研發 +' + CFG.rpWrong + ' 點', 'wrong');
      }
    }
    acts.sort(function (x, y) { return x.timeMs - y.timeMs; });
    state.order = acts.map(function (a) { return a.gid; });
    state.turnIndex = 0;
    state.phase = state.order.length ? 'moving' : 'settle';
    return { order: state.order, answer: ans };
  }

  function currentGid(state) { return state.order[state.turnIndex] || null; }

  // ─────────────────────────────────────────
  // 移動
  // ─────────────────────────────────────────
  function nextOptions(state, gid) {
    var p = state.players[gid];
    var cand = (B.ADJ[p.pos] || [(p.pos + 1) % B.RING]).filter(function (x) { return x !== p.prev; });
    return cand.length ? cand : (B.ADJ[p.pos] || [(p.pos + 1) % B.RING]);
  }

  function rollDice(state, gid) {
    var p = state.players[gid];
    var d1 = 1 + Math.floor(rnd(state) * 6), d2 = 1 + Math.floor(rnd(state) * 6);
    var total = d1 + d2;
    if (p.buff.twindice) { total += 1 + Math.floor(rnd(state) * 6) + 1 + Math.floor(rnd(state) * 6); delete p.buff.twindice; }
    if (p.buff.overheat) { total *= 2; delete p.buff.overheat; }
    if (p.buff.engine > 0) { total += 2; }
    if (p.buff.halfdice) { total = Math.floor(total / 2); delete p.buff.halfdice; }
    if (p.buff.reverse) { total = (7 - d1) + (7 - d2); delete p.buff.reverse; }
    p.stepsLeft = Math.max(1, total);
    return { d1: d1, d2: d2, total: p.stepsLeft };
  }

  function setSteps(state, gid, n) {         // 良率控制器：自選點數
    state.players[gid].stepsLeft = Math.max(2, Math.min(12, n));
    return state.players[gid].stepsLeft;
  }

  /** 走一格。回傳 {moved, to, needFork, options, stopped, arrived} */
  function step(state, gid) {
    var p = state.players[gid];
    if (!p.stepsLeft || p.stepsLeft <= 0) return { arrived: true };
    var opts = nextOptions(state, gid);
    if (opts.length > 1) return { needFork: true, options: opts };
    return commitStep(state, gid, opts[0]);
  }

  function commitStep(state, gid, to) {
    var p = state.players[gid];
    var events = [];

    // 建廠之神：經過自己的地自動升一級
    if (p.god === 'build' && state.board.owner[to] === gid && (state.board.level[to] || 0) < 5) {
      state.board.level[to] = (state.board.level[to] || 0) + 1;
      events.push({ type: 'godBuild', cell: to, level: state.board.level[to] });
    }
    // 病毒傳染：中毒者經過的第一個玩家接手
    if (p.virus > 0) {
      for (var g in state.players) {
        if (g !== gid && state.players[g].pos === to && state.players[g].virus === 0) {
          state.players[g].virus = p.virus; p.virus = 0;
          events.push({ type: 'virusPass', from: gid, to: g });
          log(state, '💣 病毒從 ' + p.name + ' 傳染給 ' + state.players[g].name + '！', 'virus');
          break;
        }
      }
    }
    p.prev = p.pos; p.pos = to; p.stepsLeft--;

    // 工安圍籬：走到就強制停下
    if (state.board.barrier[to]) {
      delete state.board.barrier[to];
      p.stepsLeft = 0;
      events.push({ type: 'barrier', cell: to });
      log(state, '🚧 ' + p.name + ' 撞上工安圍籬，強制停下', 'event');
    }
    return { moved: true, to: to, events: events, arrived: p.stepsLeft <= 0 };
  }

  // ─────────────────────────────────────────
  // 落地
  // ─────────────────────────────────────────
  function landOn(state, gid) {
    var p = state.players[gid];
    var idx = p.pos;
    var cell = B.CELLS[idx];
    var out = { cell: idx, type: cell.type, events: [] };

    // 輻射
    if (state.board.radiation[idx] > 0) {
      payTo(state, gid, null, CFG.radiationDamage);
      out.events.push({ type: 'radiation', amount: CFG.radiationDamage });
      log(state, '☢️ ' + p.name + ' 踩到輻射區，扣 $' + CFG.radiationDamage.toLocaleString(), 'bad');
    }

    switch (cell.type) {
      case 'land': return landCell(state, gid, idx, out);
      case 'shop':
        out.shop = CARD.shelf(CFG.shopShelf, function () { return rnd(state); }).map(function (c) { return c.id; });
        out.events.push({ type: 'shop' });
        break;
      case 'bank':
        out.events.push({ type: 'bank' });
        break;
      case 'subsidy': p.rp += CFG.rpSubsidy; out.events.push({ type: 'rp', amount: CFG.rpSubsidy }); break;
      case 'chest':   p.rp += CFG.rpChest;   out.events.push({ type: 'rp', amount: CFG.rpChest }); break;
      case 'packet':  p.rp += CFG.rpPacket;  out.events.push({ type: 'rp', amount: CFG.rpPacket }); break;
      case 'patent': {
        var card = pick(state, CARD.CARDS);
        if (p.cards.length < CFG.handLimit) {
          p.cards.push({ id: card.id });
          out.events.push({ type: 'card', id: card.id });
          log(state, '📜 ' + p.name + ' 在專利局抽到「' + card.name + '」', 'card');
        } else out.events.push({ type: 'handFull' });
        break;
      }
      case 'news': {
        var ev = pick(state, NEWS);
        ev.apply(state, gid);
        out.events.push({ type: 'news', text: ev.text });
        log(state, '📰 ' + p.name + '：' + ev.text, 'event');
        break;
      }
      case 'god': {
        var g = pick(state, GODS);
        p.god = g.id; p.godTurns = CFG.godTurns;
        if (g.id === 'stock') p.cards = p.cards.slice(0, Math.ceil(p.cards.length / 2));
        if (g.id === 'grant' && p.cards.length < CFG.handLimit) p.cards.push({ id: pick(state, CARD.CARDS).id });
        out.events.push({ type: 'god', id: g.id, name: g.name });
        log(state, g.emoji + ' ' + p.name + ' 被' + g.name + '附身 ' + CFG.godTurns + ' 輪', 'god');
        break;
      }
      case 'tax': {
        var tax = Math.max(0, Math.round(wealth(state, gid) * CFG.taxRate));
        payTo(state, gid, null, tax);
        out.events.push({ type: 'tax', amount: tax });
        log(state, '💸 ' + p.name + ' 繳營所稅 $' + tax.toLocaleString(), 'bad');
        break;
      }
      case 'pool': {
        var got = state.pool; state.pool = 0; p.cash += got;
        out.events.push({ type: 'pool', amount: got });
        log(state, '💰 ' + p.name + ' 領走政府補助池 $' + got.toLocaleString(), 'good');
        break;
      }
      case 'audit': {
        if (removeCard(p, 'pardon')) {
          out.events.push({ type: 'pardon' });
          log(state, '🎫 ' + p.name + ' 用免罪卡躲過稽查', 'good');
        } else {
          p.pos = B.JAIL; p.prev = -1; p.frozen = 1; p.jailed = true;
          out.events.push({ type: 'jail' });
          log(state, '🚨 ' + p.name + ' 被押去檢調約談所，停 1 輪', 'bad');
        }
        break;
      }
      case 'jail': case 'hosp': case 'fork': case 'airport': case 'mountain':
        out.events.push({ type: cell.type });
        break;
    }
    return out;
  }

  function landCell(state, gid, idx, out) {
    var p = state.players[gid];
    var cell = B.CELLS[idx];
    var owner = state.board.owner[idx];

    if (!owner) {
      if (p.god === 'stock') { out.events.push({ type: 'godFail' }); return out; }   // 庫存之神：買地必流標
      var price = p.god === 'grant' ? Math.round(cell.price / 2) : cell.price;
      out.canBuy = p.cash >= price;
      out.buyPrice = price;
      out.events.push({ type: 'vacant', price: price });
      return out;
    }
    if (owner === gid) {
      out.canBuild = (state.board.level[idx] || 0) < 5;
      out.upgradeCost = B.upgradeCost(idx);
      out.level = state.board.level[idx] || 0;
      out.events.push({ type: 'own' });
      return out;
    }
    // 別人的地
    if (p.alliance[owner] > 0) { out.events.push({ type: 'alliance' }); return out; }
    if (state.board.quakeColor === cell.color) { out.events.push({ type: 'quake' }); return out; }
    if (p.buff.pierce) { out.events.push({ type: 'pierce' }); return out; }
    if (p.god === 'order') { out.events.push({ type: 'godOrder' }); return out; }
    if (removeCard(p, 'license')) {
      out.events.push({ type: 'license' });
      log(state, '📄 ' + p.name + ' 用技術授權卡免付過路費', 'card');
      return out;
    }

    var rent = B.baseRent(idx, state.board.level[idx] || 0, hasFullColor(state, idx));
    if (p.god === 'fx') rent *= 2;
    var op = state.players[owner];
    if (op.god === 'order') rent *= 2;
    if (op.buff.surge) rent *= 2;
    if (op.buff.brownout) rent = Math.round(rent / 2);
    rent = Math.round(rent);

    payTo(state, gid, owner, rent);
    p.stat.rentPaid += rent; op.stat.rentEarned += rent;
    out.rent = rent; out.owner = owner;
    out.events.push({ type: 'rent', amount: rent, owner: owner });
    log(state, p.name + ' 踩到 ' + op.name + ' 的' + cell.name + '，付了 $' + rent.toLocaleString(), 'rent');

    if (removeCard(p, 'bounce', true)) {      // 虎克：彈回卡
      state.players[owner].cash -= rent; p.cash += rent;
      out.events.push({ type: 'bounce', amount: rent });
      log(state, '↩️ ' + p.name + ' 用彈回卡把 $' + rent.toLocaleString() + ' 拿回來了', 'card');
    }

    // 併購：付 2 倍現值強制買下
    var cur = B.landValue(idx, state.board.level[idx] || 0);
    out.canMerge = p.cash >= cur * CFG.mergerMult;
    out.mergePrice = cur * CFG.mergerMult;
    return out;
  }

  // ── 買地 / 蓋廠 / 併購 ──
  function buyLand(state, gid, idx) {
    var p = state.players[gid], cell = B.CELLS[idx];
    if (cell.type !== 'land' || state.board.owner[idx]) return { ok: false, msg: '這塊地不能買' };
    if (p.cash < 0) return { ok: false, msg: '現金為負時不能買地' };
    var price = p.god === 'grant' ? Math.round(cell.price / 2) : cell.price;
    if (p.cash < price) return { ok: false, msg: '現金不足' };
    p.cash -= price;
    state.board.owner[idx] = gid;
    state.board.level[idx] = (p.god === 'grant') ? 1 : 0;    // 補助之神：買地附贈蓋一層
    log(state, p.name + ' 買下 ' + cell.name + ' $' + price.toLocaleString(), 'buy');
    return { ok: true, price: price, level: state.board.level[idx] };
  }

  /** 蓋廠：必須停在自己的地上（大富翁原味），但錢夠可一次蓋到滿 */
  function build(state, gid, idx, times) {
    var p = state.players[gid];
    if (state.board.owner[idx] !== gid) return { ok: false, msg: '這不是你的地' };
    if (p.pos !== idx) return { ok: false, msg: '必須停在自己的地上才能蓋' };
    if (p.cash < 0) return { ok: false, msg: '現金為負時不能蓋廠' };
    var cost = B.upgradeCost(idx), built = 0;
    times = times || 99;
    while (built < times && (state.board.level[idx] || 0) < 5 && p.cash >= cost) {
      p.cash -= cost;
      state.board.level[idx] = (state.board.level[idx] || 0) + 1;
      built++;
      if (p.god === 'grant' && state.board.level[idx] < 5) state.board.level[idx]++;  // 補助之神多蓋一級
    }
    if (!built) return { ok: false, msg: '現金不足或已滿級' };
    log(state, p.name + ' 在 ' + B.CELLS[idx].name + ' 蓋到 ' + B.LEVEL_NAME[state.board.level[idx]], 'build');
    return { ok: true, built: built, level: state.board.level[idx], spent: cost * built };
  }

  function merge(state, gid, idx) {
    var p = state.players[gid], owner = state.board.owner[idx];
    if (!owner || owner === gid) return { ok: false, msg: '不能併購這塊地' };
    var cur = B.landValue(idx, state.board.level[idx] || 0), bid = cur * CFG.mergerMult;
    if (p.cash < bid) return { ok: false, msg: '現金不足（需要 $' + bid.toLocaleString() + '）' };
    p.cash -= bid; state.players[owner].cash += bid;
    state.board.owner[idx] = gid;
    log(state, '🏢 ' + p.name + ' 以 $' + bid.toLocaleString() + ' 併購了 ' + B.CELLS[idx].name, 'merge');
    return { ok: true, price: bid };
  }

  // ── 銀行 ──
  function deposit(state, gid, amount) {
    var p = state.players[gid];
    if (B.CELLS[p.pos].type !== 'bank') return { ok: false, msg: '要停在銀行才能存款' };
    amount = Math.min(amount, p.cash);
    if (amount <= 0) return { ok: false, msg: '沒有可存的現金' };
    p.cash -= amount; p.bank += amount;
    return { ok: true, amount: amount };
  }
  function withdraw(state, gid, amount) {
    var p = state.players[gid];
    if (B.CELLS[p.pos].type !== 'bank') return { ok: false, msg: '要停在銀行才能提款' };
    amount = Math.min(amount, p.bank);
    if (amount <= 0) return { ok: false, msg: '沒有可提的存款' };
    p.bank -= amount; p.cash += amount;
    return { ok: true, amount: amount };
  }

  // ── 商店 ──
  function buyFromShop(state, gid, cardId) {
    var p = state.players[gid];
    if (B.CELLS[p.pos].type !== 'shop') return { ok: false, msg: '要停在創投商店才能買' };
    if (p.cards.length >= CFG.handLimit) return { ok: false, msg: '手牌已滿（上限 ' + CFG.handLimit + ' 張）' };
    var def = CARD.get(cardId);
    if (!def) return { ok: false, msg: '沒有這張卡' };
    if (p.rp < def.cost) return { ok: false, msg: '研發點數不足' };
    p.rp -= def.cost;
    p.cards.push({ id: cardId });
    log(state, '🏪 ' + p.name + ' 買了「' + def.name + '」（' + def.cost + ' 點）', 'card');
    return { ok: true, card: cardId };
  }

  function sellCard(state, gid, cardId) {
    var p = state.players[gid];
    if (!removeCard(p, cardId)) return { ok: false, msg: '手上沒有這張卡' };
    var def = CARD.get(cardId);
    var back = Math.floor((def.cost || 0) / 2);
    p.rp += back;
    return { ok: true, rp: back };
  }

  function removeCard(p, cardId, charOnly) {
    for (var i = 0; i < p.cards.length; i++) {
      if (p.cards[i].id === cardId && (!charOnly || p.cards[i].char)) { p.cards.splice(i, 1); return true; }
    }
    return false;
  }
  function hasCard(p, cardId) {
    return p.cards.some(function (c) { return c.id === cardId; });
  }

  // ── 提示（求救）──
  function buyHint(state, gid, level) {
    var p = state.players[gid];
    if (!state.question || !state.question.hints) return { ok: false, msg: '這題沒有提示' };
    var cost = CFG.hintCost[level] || 0;
    if (p.cash < cost) return { ok: false, msg: '現金不足' };
    payTo(state, gid, null, cost);      // 錢進政府補助池
    return { ok: true, hint: state.question.hints[level], cost: cost };
  }

  // ─────────────────────────────────────────
  // 卡片效果
  // ─────────────────────────────────────────
  function playCard(state, gid, cardId, target) {
    var p = state.players[gid];
    var def = CARD.get(cardId, true);
    if (!def) return { ok: false, msg: '沒有這張卡' };
    if (!hasCard(p, cardId)) return { ok: false, msg: '手上沒有這張卡' };

    var tp = (target && target.gid) ? state.players[target.gid] : null;
    // 歐姆的絕緣卡：擋下對手對你使用的卡
    if (tp && tp.gid !== gid && hasCard(tp, 'insulate')) {
      removeCard(tp, 'insulate'); removeCard(p, cardId);
      log(state, '🛡️ ' + tp.name + ' 用絕緣卡擋下了 ' + p.name + ' 的「' + def.name + '」', 'card');
      return { ok: true, blocked: true };
    }

    var r = { ok: true };
    switch (cardId) {
      case 'equalize': {
        var total = 0, n = 0;
        for (var k in state.players) { total += state.players[k].cash; n++; }
        var avg = Math.round(total / n);
        for (var k2 in state.players) state.players[k2].cash = avg;
        log(state, '🔄 ' + p.name + ' 打出均富卡！全體現金平分為 $' + avg.toLocaleString() + '（存款不受影響）', 'big');
        r.avg = avg;
        break;
      }
      case 'bailout': p.cash += 20000; break;
      case 'surge': p.buff.surge = 1; break;
      case 'pierce': p.buff.pierce = 1; break;
      case 'overheat': p.buff.overheat = 1; break;
      case 'twindice': p.buff.twindice = 1; break;
      case 'reverse': p.buff.reverse = 1; break;
      case 'engine': p.buff.engine = 3; break;
      case 'observe': p.buff.observe = 1; break;
      case 'float': if (p.cash < 0) p.cash = 0; break;
      case 'apple': if (tp) tp.buff.halfdice = 1; break;
      case 'blackout': {
        if (!tp) return { ok: false, msg: '要指定一組' };
        if (removeCard(tp, 'pardon')) { r.blocked = true; break; }
        tp.frozen = Math.max(tp.frozen, 1);
        break;
      }
      case 'brownout': if (tp) tp.buff.brownout = 1; break;
      case 'alliance': {
        if (!tp) return { ok: false, msg: '要指定一組' };
        p.alliance[tp.gid] = 3; tp.alliance[gid] = 3;
        break;
      }
      case 'swap': {
        if (!tp) return { ok: false, msg: '要指定一組' };
        var t = p.pos; p.pos = tp.pos; tp.pos = t;
        p.prev = -1; tp.prev = -1;
        break;
      }
      case 'compress': {
        if (!tp) return { ok: false, msg: '要指定一組' };
        tp.pos = ((tp.pos - 5) % B.RING + B.RING) % B.RING; tp.prev = -1;
        break;
      }
      case 'teleport': {
        if (!target || target.cell == null) return { ok: false, msg: '要指定一格' };
        p.pos = target.cell; p.prev = -1;
        r.landAgain = true;
        break;
      }
      case 'transfer': {
        if (!tp) return { ok: false, msg: '要指定一組' };
        if (p.virus > 0) { tp.virus = p.virus; p.virus = 0; }
        if (p.god === 'stock' || p.god === 'fx') { tp.god = p.god; tp.godTurns = p.godTurns; p.god = null; p.godTurns = 0; }
        if (p.frozen > 0) { tp.frozen = p.frozen; p.frozen = 0; }
        break;
      }
      case 'massprod': {
        if (!target || target.cell == null) return { ok: false, msg: '要指定自己的一塊地' };
        if (state.board.owner[target.cell] !== gid) return { ok: false, msg: '那不是你的地' };
        if ((state.board.level[target.cell] || 0) >= 5) return { ok: false, msg: '已經滿級了' };
        state.board.level[target.cell] = (state.board.level[target.cell] || 0) + 1;
        break;
      }
      case 'demolish': {
        if (!target || target.cell == null) return { ok: false, msg: '要指定對手的一塊地' };
        if (!state.board.owner[target.cell] || state.board.owner[target.cell] === gid) return { ok: false, msg: '要選對手的地' };
        if ((state.board.level[target.cell] || 0) <= 0) return { ok: false, msg: '那塊地還沒蓋房子' };
        state.board.level[target.cell]--;
        break;
      }
      case 'poach': {
        if (!target || target.cell == null) return { ok: false, msg: '要指定對手的一塊地' };
        var o = state.board.owner[target.cell];
        if (!o || o === gid) return { ok: false, msg: '要選對手的地' };
        var amt = B.baseRent(target.cell, state.board.level[target.cell] || 0, hasFullColor(state, target.cell));
        payTo(state, o, gid, amt);
        r.amount = amt;
        break;
      }
      case 'quake': {
        if (!target || !target.color) return { ok: false, msg: '要指定一個色系' };
        state.board.quakeColor = target.color;
        break;
      }
      case 'radiate': {
        if (!target || target.cell == null) return { ok: false, msg: '要指定一格' };
        state.board.radiation[target.cell] = 3;
        break;
      }
      case 'barrier': {
        if (!target || target.cell == null) return { ok: false, msg: '要指定一格' };
        state.board.barrier[target.cell] = 1;
        break;
      }
      case 'robot': {
        var pos = p.pos;
        for (var s = 1; s <= 10; s++) {
          var nx = (B.ADJ[pos] || [(pos + 1) % B.RING])[0];
          delete state.board.barrier[nx];
          delete state.board.radiation[nx];
          for (var g2 in state.players) if (state.players[g2].pos === nx) { state.players[g2].god = null; state.players[g2].godTurns = 0; }
          pos = nx;
        }
        break;
      }
      case 'virus': {
        if (!tp) return { ok: false, msg: '要指定一組' };
        tp.virus = CFG.virusFuse;
        break;
      }
      case 'dice': r.chooseSteps = true; break;
      case 'induct': r.peekAnswer = state.question ? state.question.answer : null; break;
      case 'predict': r.rerollQuestion = true; break;
      case 'copycard': {
        if (!state.lastCardPlayed) return { ok: false, msg: '目前還沒有人打出過卡片' };
        removeCard(p, cardId);
        p.cards.push({ id: state.lastCardPlayed });
        log(state, '🧬 ' + p.name + ' 複製了「' + (CARD.get(state.lastCardPlayed, true) || {}).name + '」', 'card');
        return { ok: true, copied: state.lastCardPlayed };
      }
      case 'license': case 'pardon': case 'insulate': case 'bounce':
        return { ok: false, msg: '這張卡會在需要時自動生效，不用主動使用' };
      default:
        return { ok: false, msg: '這張卡還沒實作：' + cardId };
    }

    removeCard(p, cardId);
    state.lastCardPlayed = cardId;
    log(state, p.name + ' 使用「' + def.name + '」' + (tp ? ' → ' + tp.name : ''), 'card');
    return r;
  }

  // ─────────────────────────────────────────
  // 新聞快報事件
  // ─────────────────────────────────────────
  var NEWS = [
    { text: 'AI 需求爆發，獲得 $15,000 訂單', apply: function (s, g) { s.players[g].cash += 15000; } },
    { text: '匯率大幅波動，損失 $8,000', apply: function (s, g) { payTo(s, g, null, 8000); } },
    { text: '獲得政府研發補助 +80 點', apply: function (s, g) { s.players[g].rp += 80; } },
    { text: '缺工潮，支付加班費 $5,000', apply: function (s, g) { payTo(s, g, null, 5000); } },
    { text: '技術突破，隨機一塊自有地免費升一級', apply: function (s, g) {
        var mine = landsOf(s, g).filter(function (i) { return (s.board.level[i] || 0) < 5; });
        if (mine.length) s.board.level[mine[0]] = (s.board.level[mine[0]] || 0) + 1; } },
    { text: '專利訴訟敗訴，賠償 $12,000', apply: function (s, g) { payTo(s, g, null, 12000); } },
    { text: '接到大廠追加訂單，獲得 $20,000', apply: function (s, g) { s.players[g].cash += 20000; } },
    { text: '園區限電，這輪收益減半', apply: function (s, g) { s.players[g].buff.brownout = 1; } }
  ];

  // ─────────────────────────────────────────
  // 回合結算
  // ─────────────────────────────────────────
  function endTurn(state) {
    state.turnIndex++;
    if (state.turnIndex >= state.order.length) { state.phase = 'settle'; return { roundEnd: true }; }
    return { roundEnd: false, gid: currentGid(state) };
  }

  function endRound(state) {
    var events = [];
    for (var gid in state.players) {
      var p = state.players[gid];

      // 銀行存款利息（貸款期間不發，照大富翁4）
      if (p.bank > 0 && p.loan === 0) {
        var itr = Math.round(p.bank * CFG.bankRate);
        p.cash += itr;
        events.push({ gid: gid, type: 'interest', amount: itr });
      }
      // 研發中心產出
      var labs = landsOf(state, gid).filter(function (i) { return (state.board.level[i] || 0) >= 1; }).length;
      if (labs) p.rp += labs * CFG.rpLab;

      // 神明附身倒數
      if (p.godTurns > 0) {
        if (p.god === 'fx') payTo(state, gid, null, 1000);
        if (p.god === 'grant' && p.cards.length < CFG.handLimit) p.cards.push({ id: pick(state, CARD.CARDS).id });
        p.godTurns--;
        if (p.godTurns === 0) { p.god = null; }
      }
      // 病毒倒數與爆炸
      if (p.virus > 0) {
        p.virus--;
        if (p.virus === 0) {
          var hit = [];
          for (var d = -CFG.virusRadius; d <= CFG.virusRadius; d++) {
            var c = ((p.pos + d) % B.RING + B.RING) % B.RING;
            if (state.board.level[c] > 0) { state.board.level[c]--; hit.push(c); }
          }
          p.frozen = Math.max(p.frozen, 1);
          events.push({ gid: gid, type: 'virusBoom', cells: hit });
          log(state, '💥 ' + p.name + ' 身上的勒索病毒爆炸！周圍 ' + hit.length + ' 座廠房降級，本人停機一輪', 'big');
        }
      }
      // 同盟倒數
      for (var a in p.alliance) { p.alliance[a]--; if (p.alliance[a] <= 0) delete p.alliance[a]; }
      // 引擎卡倒數
      if (p.buff.engine > 0) { p.buff.engine--; if (!p.buff.engine) delete p.buff.engine; }
      // 一次性 buff 清除
      ['surge', 'pierce', 'brownout', 'observe'].forEach(function (b) { delete p.buff[b]; });

      // 貸款到期：現金不足就自動賣掉最便宜的廠抵債
      if (p.loan > 0 && state.round >= p.loanDue) {
        var need = p.loan;
        if (p.cash + p.bank >= need) { repayLoan(state, gid, need); }
        else {
          var mine = landsOf(state, gid).sort(function (x, y) { return B.CELLS[x].price - B.CELLS[y].price; });
          while (p.loan > 0 && mine.length) {
            var sell = mine.shift();
            p.cash += B.landValue(sell, state.board.level[sell] || 0);
            delete state.board.owner[sell]; delete state.board.level[sell];
            log(state, '⚠️ ' + p.name + ' 貸款到期，強制賣出 ' + B.CELLS[sell].name + ' 抵債', 'bad');
            if (p.cash >= p.loan) { repayLoan(state, gid, p.loan); }
          }
        }
      }
      // 角色專屬卡：每 5 輪發一張
      if (state.round % CFG.charCardEvery === 0 && p.charId && p.cards.length < CFG.handLimit) {
        var c = global.charById(p.charId);
        p.cards.push({ id: c.card, char: true });
        events.push({ gid: gid, type: 'charCard', id: c.card });
      }
    }
    // 輻射倒數
    for (var rc in state.board.radiation) {
      state.board.radiation[rc]--;
      if (state.board.radiation[rc] <= 0) delete state.board.radiation[rc];
    }
    state.phase = (state.round >= state.maxRounds) ? 'ended' : 'waiting';
    return { events: events, ended: state.phase === 'ended' };
  }

  global.ENGINE = {
    CFG: CFG, GODS: GODS, NEWS: NEWS,
    createGame: createGame, pickCharacter: pickCharacter,
    startRound: startRound, submitAnswer: submitAnswer, reveal: reveal,
    currentGid: currentGid, nextOptions: nextOptions, rollDice: rollDice, setSteps: setSteps,
    step: step, commitStep: commitStep, landOn: landOn,
    buyLand: buyLand, build: build, merge: merge,
    deposit: deposit, withdraw: withdraw, applyLoan: applyLoan, repayLoan: repayLoan,
    buyFromShop: buyFromShop, sellCard: sellCard, buyHint: buyHint,
    playCard: playCard, endTurn: endTurn, endRound: endRound,
    wealth: wealth, ranking: ranking, landsOf: landsOf, hasFullColor: hasFullColor,
    hasCard: hasCard, removeCard: removeCard
  };
})(typeof window !== 'undefined' ? window : globalThis);
