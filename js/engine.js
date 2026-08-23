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
    rpNews: 80,                  // 新聞快報的研發補助（原本事件寫死 80、這裡寫 25，以實際為準統一）
    mergerMult: 2,           // 併購 = 現值 ×2
    radiationDamage: 5000,
    virusFuse: 5,            // 病毒倒數
    virusRadius: 2,          // 爆炸範圍（前後各 N 格）
    godTurns: 3,
    charCardEvery: 10,       // 每 10 輪發一張角色專屬卡（5 輪太密，手牌累積到用不完）
    handLimit: 8,
    shopShelf: 10,
    answerSec: 15,
    answerSecHard: 20,
    maxRounds: 30
  };

  var GODS = [
    { id: 'order',  name: '訂單之神', emoji: '📈', good: true,  desc: '踩到別人的地完全不用付過路費；自己的地收過路費 ×2' },
    { id: 'grant',  name: '補助之神', emoji: '🎁', good: true,  desc: '每輪送卡片、買地半價還附贈蓋一層、蓋房多一級' },
    { id: 'build',  name: '建廠之神', emoji: '🏗️', good: true,  desc: '每經過自己的地自動升一級' },
    { id: 'stock',  name: '庫存之神', emoji: '📉', good: false, desc: '買地必流標、手上卡片掉一半' },
    { id: 'fx',     name: '匯損之神', emoji: '💸', good: false, desc: '每輪扣 $1,000、付過路費加倍' }
  ];
  /**
   * 幫神明挑一個降落的格子：只降在土地格或產業風向格
   * （站在商店、醫院上會把那些格子的圖示擋住），而且一格只站一尊。
   */
  function godLandingCell(state) {
    // 也避開有人正站著的格子：神明跟角色疊在同一格，畫面會重疊看不清，
    // 而且看起來像「神明馬上又黏到人身上」
    var occupied = {};
    for (var og in state.players) occupied[state.players[og].pos] = true;
    var cands = [];
    B.CELLS.forEach(function (c, i) {
      if ((c.type === 'land' || c.type === 'god') && !state.board.gods[i] && !occupied[i]) cands.push(i);
    });
    if (!cands.length) return null;
    return cands[Math.floor(rnd(state) * cands.length)];
  }

  function godById(id) {
    for (var i = 0; i < GODS.length; i++) if (GODS[i].id === id) return GODS[i];
    return null;
  }

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
      // 這一場的識別碼：平板用它分辨「換了新的一場」，把舊遊戲的畫面狀態整個重置
      nonce: opts.nonce || (Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36)),
      code: opts.code || '',        // 這一場的 6 位數編號（＝學生輸入的房間代碼＝存檔名字）
      label: opts.label || '',      // 老師自己取的名字（例如「七年三班」），可留空
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
      board: { owner: {}, level: {}, barrier: {}, radiation: {}, quakeColor: null, gods: {} },
      pool: 0,
      lastCardPlayed: null,
      usedQuestions: [],
      log: []
    };
    // 神明是「浮動」的：五尊各自隨機降落在地圖上（不固定在產業風向格），
    // 踩到有神明的格子就被附身，附身結束後神明再隨機搬家。
    // 學生遠遠就看得到哪一格站著哪一尊、值不值得走過去。
    GODS.forEach(function (g) {
      var cell = godLandingCell(state);
      if (cell != null) state.board.gods[cell] = g.id;
    });
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
  function pickCharacter(state, gid, charId, opts) {
    // 只能在開賽前選。遊戲開始後還能改的話，等於可以換一張新的專屬卡、重抽一手牌。
    if (state.round > 0 || (state.phase !== 'setup' && state.phase !== 'waiting')) {
      return { ok: false, msg: '遊戲已經開始了，不能換角色' };
    }
    if (state.players[gid] && state.players[gid].charId) {
      // 老師端可以在開賽前幫任何一組「換」角色（opts.change）：
      // 只換角色與那張專屬卡，三張道具牌保留 —— 不能藉由換角色重抽道具。
      if (!(opts && opts.change)) return { ok: false, msg: '你已經選好角色了' };
      var nc = global.charById(charId);
      if (!nc) return { ok: false, msg: '找不到這位科學家' };
      for (var k0 in state.players) {
        if (k0 !== gid && state.players[k0].charId === charId) {
          return { ok: false, msg: '這位科學家已經被別組選走了' };
        }
      }
      var pl = state.players[gid];
      pl.cards = pl.cards.filter(function (c) { return !c.char; });   // 收回舊的專屬卡
      pl.cards.push({ id: nc.card, char: true });
      pl.charId = charId;
      pl.name = '第 ' + pl.num + ' 組 · ' + nc.name;
      log(state, '🔁 第 ' + pl.num + ' 組換角色為 ' + nc.name, 'info');
      return { ok: true, changed: true };
    }
    for (var k in state.players) {
      if (state.players[k].charId === charId) return { ok: false, msg: '這位科學家已經被選走了' };
    }
    var c = global.charById(charId);
    if (!c) return { ok: false, msg: '找不到這位科學家' };
    state.players[gid].charId = charId;
    state.players[gid].name = '第 ' + state.players[gid].num + ' 組 · ' + c.name;
    // 開局手牌：四大道具中隨機抽 3「種」（每種一張、不重複）+ 1 張自己的專屬卡
    // 用抽走的方式取樣，才不會出現同一種道具好幾張
    var tools = CARD.TOOLS.slice();
    var hand = [];
    for (var i = 0; i < 3; i++) {
      hand.push({ id: tools.splice(Math.floor(rnd(state) * tools.length), 1)[0].id });
    }
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

  /**
   * 把外面送進來的金額變成安全的正整數，不合格就回 null（呼叫端要擋掉）。
   *
   * 為什麼一定要有這一關：平板是學生自己的裝置，送上來的可能是字串、小數、
   * 負數、NaN，或乾脆不帶這個欄位。而 JavaScript 有兩個很坑的行為：
   *   · 比較時會偷偷把字串轉成數字：'1' > 0 是 true，所以檢查會通過
   *   · 相加時卻是字串相接：97200 + '1' 會變成 '972001'（現金瞬間變十倍）
   *   · Math.min(undefined, x) 是 NaN，而 NaN 跟任何數字比都是 false，
   *     所以「錢不夠就不能買」那類檢查會全部放行 —— 現金變成 NaN 之後，
   *     買地、併購全部免費。
   * 實測（tools/測試引擎.js 第 26 節）確認這兩條路都真的走得通。
   */
  function money(v) {
    if (typeof v !== 'number') return null;      // 只收真正的數字，不收字串
    if (!isFinite(v)) return null;               // NaN、Infinity 一律擋掉
    v = Math.floor(v);                           // 不收小數，避免出現 $99999.3
    if (v <= 0) return null;
    if (v > 1e9) return null;                    // 明顯不合理的天文數字
    return v;
  }

  function applyLoan(state, gid, amount) {
    var blk_ = actionBlocked(state, gid);
    if (blk_) return { ok: false, msg: blk_ };
    var p = state.players[gid];
    var cap = 0;
    landsOf(state, gid).forEach(function (i) { cap += B.landValue(i, state.board.level[i] || 0); });
    cap = Math.floor(cap * 0.5) - p.loan;
    amount = money(amount);
    if (amount == null) return { ok: false, msg: '金額不正確（要正整數）' };
    if (amount > cap) return { ok: false, msg: '超過額度上限（地產總值的 50%），最多可借 $' + Math.max(0, cap).toLocaleString() };
    p.cash += amount;
    p.loan += Math.round(amount * (1 + CFG.loanFee));
    p.loanDue = state.round + CFG.loanTerm;
    log(state, p.name + ' 申請貸款 $' + amount.toLocaleString() + '（含手續費需還 $' + p.loan.toLocaleString() + '）', 'loan');
    return { ok: true };
  }

  function repayLoan(state, gid, amount) {
    var blk_ = actionBlocked(state, gid);
    if (blk_) return { ok: false, msg: blk_ };
    var p = state.players[gid];
    amount = money(amount);
    if (amount == null) return { ok: false, msg: '金額不正確（要正整數）' };
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
    state.questionAt = Date.now();       // 白板自己的出題時間（用來校正平板送來的作答用時）
    state.hintLevel = {};                // 新的一題，提示重新開始買
    state.question = question;
    state.answers = {};
    state.order = [];
    state.turnIndex = 0;
    // 註：地震卡設的 quakeColor 不在這裡清。
    // 卡片是在「道具時間」打出的，而道具時間就在 startRound 之前，
    // 以前在這裡清掉等於這張 140 點的卡 100% 沒有效果（實測確認）。
    // 改成在 endRound 清，剛好讓它生效整整一輪。
    if (question && question.id) state.usedQuestions.push(question.id);
    log(state, '第 ' + state.round + ' 輪開始', 'round');
    return state;
  }

  /**
   * 送出答案。
   * 第四個參數 timeMs 是平板自己算的用時 —— 現在完全不採用（留著只是相容舊呼叫）。
   * 第五個參數 nowMs 只給自動化測試用來模擬「誰先按下去」；
   * 老師端呼叫時不會帶，所以平板永遠改不到行動順序。
   */
  function submitAnswer(state, gid, choice, timeMs, nowMs) {
    if (state.phase !== 'question') return { ok: false, msg: '現在不是作答時間' };
    if (state.answers[gid]) return { ok: false, msg: '已經作答過了' };   // 防連點／重複送出
    var p = state.players[gid];
    if (p.frozen > 0) return { ok: false, msg: '停機中，這輪不能行動' };
    // 選項要真的是這一題有的（送 'Z' 或一個物件進來都不算數）
    var keys = (state.question && state.question.optionKeys) || ['A', 'B', 'C', 'D'];
    if (keys.indexOf(choice) < 0) return { ok: false, msg: '沒有這個選項' };

    // 作答用時是平板自己算的 —— 學生送 -999999 就永遠排第一個行動、
    // 永遠先挑到好地（實測確認排在真的 1.2 秒答對的人前面）。
    // 這裡用白板自己的時鐘當上限校正，再夾在合理範圍內。
    // 行動順序完全用白板自己的時鐘算，不採用平板送上來的數字。
    // 只要有一部分採信平板，學生送 0 或負數就永遠排第一個行動、永遠先挑到好地
    //（實測確認排在真的 1.2 秒答對的組前面）。
    // 白板收到訊息的時間已經包含了網路延遲，但全班在同一個 wifi 上，
    // 這個延遲對每一組都差不多，不會造成不公平。
    var limit = ((state.question && state.question.seconds) || 15) * 1000;
    var now = (typeof nowMs === 'number' && isFinite(nowMs)) ? nowMs : Date.now();
    var t = state.questionAt ? (now - state.questionAt) : limit;
    t = Math.max(250, Math.min(t, limit));
    state.answers[gid] = { choice: choice, timeMs: Math.round(t), correct: null };
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
    // 用了瞬移卡的人，就算這題答錯也要讓他移動（卡都花掉了），排在最後
    for (var g2 in state.players) {
      var p2 = state.players[g2];
      if (p2.buff && p2.buff.warpTo != null && p2.frozen <= 0 &&
          state.order.indexOf(g2) < 0) {
        state.order.push(g2);
      }
    }
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

  /**
   * 反向路網：這一格的「前一格」有哪些。
   * 地圖不是單純的一圈 —— 61 格裡只有 0~51 是主環，52~54 是海外支線、
   * 55~60 是三條橫貫公路。用 %52 硬算會把山區的人算到完全無關的地方
   * （實測：站在日本熊本廠被壓縮卡推 5 格，人會出現在創投商店）。
   */
  var RADJ = null;
  function radj() {
    if (RADJ) return RADJ;
    RADJ = {};
    Object.keys(B.ADJ).forEach(function (from) {
      (B.ADJ[from] || []).forEach(function (to) {
        (RADJ[to] = RADJ[to] || []).push(+from);
      });
    });
    return RADJ;
  }

  /** 沿著路往回走 n 格（走不動就停在原地） */
  function backSteps(state, pos, n) {
    var r = radj();
    for (var i = 0; i < n; i++) {
      var prev = r[pos];
      if (!prev || !prev.length) break;
      pos = prev.length === 1 ? prev[0] : prev[Math.floor(rnd(state) * prev.length)];
    }
    return pos;
  }

  /** 沿著路網找出「距離這一格 n 格以內」的所有格子（前後都算） */
  function nearbyCells(pos, n) {
    var r = radj(), seen = {}, frontier = [pos];
    seen[pos] = true;
    for (var d = 0; d < n; d++) {
      var next = [];
      frontier.forEach(function (c) {
        (B.ADJ[c] || []).concat(r[c] || []).forEach(function (x) {
          if (!seen[x]) { seen[x] = true; next.push(x); }
        });
      });
      frontier = next;
    }
    return Object.keys(seen).map(Number);
  }

  function rollDice(state, gid) {
    var p = state.players[gid];
    var d1 = 1 + Math.floor(rnd(state) * 6), d2 = 1 + Math.floor(rnd(state) * 6);
    var total = d1 + d2;
    // 良率控制器：這一輪用自己指定的點數
    if (p.buff.fixedDice) {
      total = p.buff.fixedDice;
      delete p.buff.fixedDice;
      d1 = Math.min(6, Math.max(1, Math.floor(total / 2)));
      d2 = total - d1;
      p.stepsLeft = total;
      return { d1: d1, d2: d2, total: total, fixed: true };
    }
    // 記下用到了哪些加成，白板才寫得出「3 + 4 = 7 → 過熱卡 ×2 → 14」
    var mods = [];
    if (p.buff.twindice) {
      total += 1 + Math.floor(rnd(state) * 6) + 1 + Math.floor(rnd(state) * 6);
      delete p.buff.twindice; mods.push('加倍骰卡 再加兩顆');
    }
    if (p.buff.overheat) { total *= 2; delete p.buff.overheat; mods.push('過熱卡 ×2'); }
    if (p.buff.engine > 0) { total += 2; mods.push('引擎卡 +2'); }
    if (p.buff.halfdice) { total = Math.floor(total / 2); delete p.buff.halfdice; mods.push('落地卡 ÷2'); }
    // 逆轉卡：點數不變、方向反轉（原本的「點數反轉」期望值跟沒用一樣，完全沒意義）
    if (p.buff.reverse) { delete p.buff.reverse; p.buff.walkBack = 1; mods.push('逆轉卡 反方向走'); }
    p.stepsLeft = Math.max(1, total);
    return { d1: d1, d2: d2, total: p.stepsLeft, mods: mods };
  }

  function setSteps(state, gid, n) {         // 良率控制器：自選點數
    state.players[gid].stepsLeft = Math.max(2, Math.min(12, n));
    return state.players[gid].stepsLeft;
  }

  /**
   * 岔路口隨機選一條。
   * 為什麼不讓玩家選：有選擇權的話，沒有人會自願走進對手蓋滿廠房的那一條，
   * 岔路就失去風險、只剩下抄近路的功能。改成隨機才有賭一把的緊張感。
   */
  function pickFork(state, options) {
    return options[Math.floor(rnd(state) * options.length)];
  }

  /** 走一格。回傳 {moved, to, needFork, options, stopped, arrived} */
  function step(state, gid) {
    var p = state.players[gid];
    if (!p.stepsLeft || p.stepsLeft <= 0) return { arrived: true };
    // 逆轉卡：反方向走（沿反向路網一次退一格，病毒傳染、圍籬等路過效果照常）
    if (p.buff.walkBack) {
      return commitStep(state, gid, backSteps(state, p.pos, 1));
    }
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

    delete p.buff.walkBack;      // 反方向走只影響這一次移動，落地就結束

    // 神明是浮動的：任何格子上有神明，停下來就被附身（神明跟著人走）
    state.board.gods = state.board.gods || {};
    if (state.board.gods[idx]) {
      var gGod = godById(state.board.gods[idx]);
      delete state.board.gods[idx];              // 神明離開格子，跟著這個人
      p.god = gGod.id; p.godTurns = CFG.godTurns;
      if (gGod.id === 'stock') p.cards = p.cards.slice(0, Math.ceil(p.cards.length / 2));
      if (gGod.id === 'grant' && p.cards.length < CFG.handLimit) p.cards.push({ id: pick(state, CARD.CARDS).id });
      out.events.push({ type: 'god', id: gGod.id, name: gGod.name, good: !!gGod.good });
      log(state, gGod.emoji + ' ' + p.name + ' 被' + gGod.name + '附身 ' + CFG.godTurns + ' 輪', 'god');
    }

    switch (cell.type) {
      case 'land': return landCell(state, gid, idx, out);
      case 'shop':
        out.shop = shopShelfFor(state, idx);
        out.events.push({ type: 'shop' });
        break;
      case 'bank':
        out.events.push({ type: 'bank' });
        break;
      case 'subsidy': p.rp += CFG.rpSubsidy; out.events.push({ type: 'rp', amount: CFG.rpSubsidy }); break;
      case 'chest': {
        // 機會寶箱：抽一件好事（大富翁的「機會」，偏好運）
        var ch = pick(state, CHANCE);
        ch.apply(state, gid);
        out.events.push({ type: 'chance', text: ch.text });
        log(state, '🎁 ' + p.name + '：' + ch.text, 'event');
        break;
      }
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
        // 神明是浮動的（附身邏輯在上面的通用檢查）。
        // 走到這裡代表這一格現在沒有神明——產業風向格只是神明常出沒的地標。
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
      case 'jail':
        // 只是停在這一格＝路過探監，不罰。
        // （真的被關是踩到「稽查」那一格，事件是 jail，兩者不能共用同一個名稱，
        //   否則白板會顯示「停 1 輪」但實際上沒有關到人。）
        out.events.push({ type: 'visit' });
        log(state, '👀 ' + p.name + ' 路過探監，沒事', 'info');
        break;
      case 'hosp': {
        // 住院：這一輪不能行動（跟被關一樣，只是原因不同）
        if (removeCard(p, 'pardon')) {
          out.events.push({ type: 'pardon' });
          log(state, '🎫 ' + p.name + ' 用免罪卡出院了', 'good');
        } else {
          p.frozen = Math.max(p.frozen, 1);
          out.events.push({ type: 'hospital' });
          log(state, '🏥 ' + p.name + ' 送醫住院，停 1 輪', 'bad');
        }
        break;
      }
      case 'fork': case 'airport': case 'mountain':
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
    // 地主被關在檢調所或住院中，收不到過路費（規則文件與大富翁4皆如此）
    if (op.frozen > 0) {
      out.events.push({ type: 'ownerFrozen', owner: owner });
      log(state, '🏥 ' + op.name + ' 停機中，收不到 ' + p.name + ' 的過路費', 'info');
      return out;
    }
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
  /**
   * 這一組現在能不能做「買地／蓋廠／併購／銀行／買卡」這種需要輪到自己的動作。
   *
   * 為什麼要在引擎裡擋：學生的平板是他們自己的裝置，按鈕顯不顯示擋不住有心人，
   * 改一下網頁程式就能送出任何訊息。真正的防線一定要在這裡。
   *
   * 實測過的四種鑽漏洞方式（修正前全部會成功）：
   *   1. 還在走路（剩幾步沒走完）就按買地 → 把路過的地買走
   *   2. 別組行動時亂按 → 在不是自己的回合買地
   *   3. 道具階段亂按 → 隨時都能買
   *   4. 被關在檢調所／住院中還能操作
   */
  function actionBlocked(state, gid) {
    var p = state.players[gid];
    if (!p) return '沒有這一組';
    if (state.phase !== 'moving' && state.phase !== 'settle') return '現在不是行動時間';
    if (currentGid(state) !== gid) return '還沒輪到你';
    if (p.stepsLeft > 0) return '還在移動中，走完才能操作';
    if (p.frozen > 0) return '停機中不能操作';
    return null;
  }

  function buyLand(state, gid, idx) {
    var blocked = actionBlocked(state, gid);
    if (blocked) return { ok: false, msg: blocked };
    // 庫存之神：買地必流標。以前只有白板的提示文字有擋，引擎沒擋，
    // 平板上的買地按鈕照樣出現、按下去也真的買到了。
    if (state.players[gid] && state.players[gid].god === 'stock') {
      return { ok: false, msg: '被庫存之神附身，這段期間買地一律流標' };
    }
    var p = state.players[gid], cell = B.CELLS[idx];
    if (idx !== p.pos) return { ok: false, msg: '只能買自己站著的那一格' };
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
    var blk_ = actionBlocked(state, gid);
    if (blk_) return { ok: false, msg: blk_ };
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
    var blk_ = actionBlocked(state, gid);
    if (blk_) return { ok: false, msg: blk_ };
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
    var blk_ = actionBlocked(state, gid);
    if (blk_) return { ok: false, msg: blk_ };
    var p = state.players[gid];
    if (B.CELLS[p.pos].type !== 'bank') return { ok: false, msg: '要停在銀行才能存款' };
    amount = money(amount);
    if (amount == null) return { ok: false, msg: '金額不正確（要正整數）' };
    amount = Math.min(amount, p.cash);
    if (amount <= 0) return { ok: false, msg: '沒有可存的現金' };
    p.cash -= amount; p.bank += amount;
    return { ok: true, amount: amount };
  }
  function withdraw(state, gid, amount) {
    var blk_ = actionBlocked(state, gid);
    if (blk_) return { ok: false, msg: blk_ };
    var p = state.players[gid];
    if (B.CELLS[p.pos].type !== 'bank') return { ok: false, msg: '要停在銀行才能提款' };
    amount = money(amount);
    if (amount == null) return { ok: false, msg: '金額不正確（要正整數）' };
    amount = Math.min(amount, p.bank);
    if (amount <= 0) return { ok: false, msg: '沒有可提的存款' };
    p.bank -= amount; p.cash += amount;
    return { ok: true, amount: amount };
  }

  // ── 商店 ──
  /**
   * 這一格、這一輪的貨架長什麼樣。
   * 用固定算式算出來（不是隨機抽），白板、平板、引擎三邊才會拿到同一份，
   * 引擎才有辦法擋掉「買不在架上的卡」。
   */
  function shopShelfFor(state, pos) {
    var seed = ((state.round || 0) * 31 + pos * 7 + 13) % 9973;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    return CARD.shelf(CFG.shopShelf, rnd).map(function (c) { return c.id; });
  }

  function buyFromShop(state, gid, cardId) {
    var blk_ = actionBlocked(state, gid);
    if (blk_) return { ok: false, msg: blk_ };
    var p = state.players[gid];
    if (B.CELLS[p.pos].type !== 'shop') return { ok: false, msg: '要停在創投商店才能買' };
    if (p.cards.length >= CFG.handLimit) return { ok: false, msg: '手牌已滿（上限 ' + CFG.handLimit + ' 張）' };
    // 只能買「公共卡」。角色專屬卡的 cost 統一是 0（本來就不是用買的），
    // 以前 CARD.get 找不到公共卡時會退回去找專屬卡，於是 0 點就能把
    // 瞬移卡、絕緣卡、複製卡整批搬回家 —— 實測一次可以買到手牌上限。
    // 貨架賣的是「公共卡＋道具卡」（SHOP_POOL）。之前只查公共卡，
    // 結果貨架上陳列的勒索病毒、巡檢機器人等道具卡買不到，點了也沒反應。
    var def = null;
    for (var ci = 0; ci < CARD.SHOP_POOL.length; ci++) {
      if (CARD.SHOP_POOL[ci].id === cardId) { def = CARD.SHOP_POOL[ci]; break; }
    }
    if (!def) return { ok: false, msg: '創投商店沒有賣這張卡' };
    // 負債中不能買卡（規則文件明定；也防止破產的組還在囤卡）
    if (p.cash < 0) return { ok: false, msg: '現金是負的，先處理債務才能買卡' };
    // 老師關閉破壞類道具時，商店也不賣（不然點數白花）
    if (state.cfg && state.cfg.allowSabotage === false && CARD.SABOTAGE.indexOf(cardId) >= 0) {
      return { ok: false, msg: '這節課老師關閉了破壞類道具' };
    }
    // 而且只能買「這次貨架上真的有陳列」的那幾張，不能指定買任何一張
    var shelf = shopShelfFor(state, p.pos);
    if (shelf.indexOf(cardId) < 0) return { ok: false, msg: '這張卡不在這次的貨架上' };
    if (!(p.rp >= def.cost)) return { ok: false, msg: '研發點數不足' };
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
  function buyHint(state, gid, level) {   // level 參數留著相容舊呼叫，實際上不採用
    var p = state.players[gid];
    // 提示要花錢。答完之後買了也沒用，非作答時間更不該能買 ——
    // 學生很容易在等其他組時不小心點到，白白扣錢。
    if (state.phase !== 'question') return { ok: false, msg: '現在不是作答時間' };
    if (state.answers && state.answers[gid]) return { ok: false, msg: '已經作答了，提示買了也沒用' };
    if (p.frozen > 0) return { ok: false, msg: '停機中不能買提示' };
    if (!state.question || !state.question.hints) return { ok: false, msg: '這題沒有提示' };

    // 提示是一段一段往下買的。以前平板送什麼 level 就買什麼，
    // 而平板上的按鈕永遠送 0 —— 等於同一段可以一直重複買，每按一次扣一次錢。
    state.hintLevel = state.hintLevel || {};
    var have = state.hintLevel[gid] || 0;
    if (have >= state.question.hints.length) return { ok: false, msg: '提示已經全部買完了' };
    level = have;                       // 只能買下一段，平板送什麼都不算數

    var cost = CFG.hintCost[level] || 0;
    if (!(p.cash >= cost)) return { ok: false, msg: '現金不足' };
    payTo(state, gid, null, cost);      // 錢進政府補助池
    state.hintLevel[gid] = have + 1;
    return { ok: true, hint: state.question.hints[level], cost: cost, level: level };
  }

  // ─────────────────────────────────────────
  // 卡片效果
  // ─────────────────────────────────────────
  function playCard(state, gid, cardId, target) {
    var p = state.players[gid];
    var def = CARD.get(cardId, true);
    if (!def) return { ok: false, msg: '沒有這張卡' };
    if (!hasCard(p, cardId)) return { ok: false, msg: '手上沒有這張卡' };

    // 指定的目標要真的存在。平板可以送任何東西上來，
    // 送一個不存在的格號（例如 9999）會讓後面的程式讀到 undefined，
    // 整個白板就當在那裡，全班的遊戲一起停住。
    if (target) {
      if (target.cell != null) {
        if (typeof target.cell !== 'number' || !isFinite(target.cell) ||
            target.cell < 0 || target.cell >= B.CELLS.length ||
            Math.floor(target.cell) !== target.cell) {
          return { ok: false, msg: '沒有這一格' };
        }
      }
      if (target.gid != null && !state.players[target.gid]) {
        return { ok: false, msg: '沒有這一組' };
      }
      if (target.color != null && B.COLORS && B.COLORS.indexOf) {
        // 色系要是地圖上真的有的
        var okColor = B.CELLS.some(function (c) { return c.color === target.color; });
        if (!okColor) return { ok: false, msg: '沒有這個園區' };
      }
    }

    // 停機中（被關、住院）不能出牌 —— 規則文件明定「完全不能動作」。
    // 唯一例外是嫁禍卡：它的用途就是把停機轉給別人。
    if (p.frozen > 0 && cardId !== 'transfer') {
      return { ok: false, msg: '停機中不能出牌（嫁禍卡除外）' };
    }
    // 遊戲還沒開始（選角、等待階段）不能出牌——防止學生在大廳就互丟道具
    // 只擋選角／等待開始的階段。道具階段時 round 可能還是 0（第一輪還沒開始），
    // 不能用 round 判斷，否則第一輪的道具時間會出不了牌。
    if (state.phase === 'setup') {
      return { ok: false, msg: '遊戲開始後才能使用卡片和道具' };
    }
    // 輪間休息時不能出牌：這時出的牌會跳過「排隊依序播放」直接生效，
    // 變成誰手快誰佔便宜，也讓白板上看不到效果。
    if (state.phase === 'break') {
      return { ok: false, msg: '休息時間不能出牌，等下一輪的道具時間' };
    }
    if (state.phase === 'ended') return { ok: false, msg: '這一節已經結束了' };
    // 答題專用卡（感應卡、預測卡）只能在作答時間使用
    if (def.timing === 'onQuestion' && state.phase !== 'question') {
      return { ok: false, msg: '「' + def.name + '」要在作答時間使用' };
    }
    // 其餘卡片隨時都能出：學生在等別組行動時就能規劃出牌，不佔用自己的回合時間。
    // 骰前生效的卡（過熱／雙骰／逆轉／引擎／良率控制器）會存成 buff，輪到自己骰時自動套用。

    var tp = (target && target.gid) ? state.players[target.gid] : null;

    // 歐姆的絕緣卡：擋下對手「針對你」使用的卡。
    // 以前只看 target.gid，所以拆廠卡、挖角卡（指定的是「對手的一塊地」）、
    // 輻射卡、工安圍籬（指定的是「一格」）全部照樣打穿，
    // 而卡片說明寫的是「擋下對手對你使用的下一張卡片或道具」。
    var victim = tp;
    if (!victim && target && target.cell != null) {
      // 指定一塊地：受害的是那塊地的主人；沒有主人就看誰站在上面
      var own = state.board.owner[target.cell];
      if (own && state.players[own]) victim = state.players[own];
      if (!victim) {
        for (var vg in state.players) {
          if (state.players[vg].pos === target.cell) { victim = state.players[vg]; break; }
        }
      }
    }
    // 善意的卡不該被擋（同盟卡本來是要跟對方結盟的，擋了還白白吃掉一張絕緣卡）
    var FRIENDLY = ['alliance'];
    if (victim && victim.gid !== gid && FRIENDLY.indexOf(cardId) < 0 && hasCard(victim, 'insulate')) {
      removeCard(victim, 'insulate'); removeCard(p, cardId);
      log(state, '🛡️ ' + victim.name + ' 用絕緣卡擋下了 ' + p.name + ' 的「' + def.name + '」', 'card');
      return { ok: true, blocked: true };
    }

    var r = { ok: true };
    switch (cardId) {
      case 'equalize': {
        var total = 0, ids = [];
        for (var k in state.players) { total += state.players[k].cash; ids.push(k); }
        // 用「無條件捨去＋餘數逐一分配」，總額一毛不差（四捨五入會憑空多錢或蒸發）
        var avg = Math.floor(total / ids.length);
        var rem = total - avg * ids.length;
        ids.forEach(function (k2, i2) { state.players[k2].cash = avg + (i2 < rem ? 1 : 0); });
        log(state, '🔄 ' + p.name + ' 打出均富卡！全體現金平分為 $' + avg.toLocaleString() + '（存款不受影響）', 'big');
        r.avg = avg;
        break;
      }
      case 'bailout': p.cash += 20000; break;
      case 'surge': p.buff.surge = 1; break;
      case 'pierce': p.buff.pierce = 1; break;
      case 'overheat': p.buff.overheat = 1; break;
      case 'twindice': p.buff.twindice = 1; break;
      case 'reverse': p.buff.reverse = 1; break;   // 擲骰時轉成 walkBack（反方向走）
      case 'engine': p.buff.engine = 3; break;
      case 'observe': p.buff.observe = 1; p.rp += 40; break;
      case 'float': {
        // 雙模式：負債時把負現金與貸款一筆勾銷；正常時領急難救助金。
        // （原本只有負債能用 —— 現金幾乎不會變負，等於一張永遠用不到的卡）
        if (p.cash < 0) {
          p.cash = 0;
          p.loan = 0; p.loanDue = 0;
          r.floatMode = '債務歸零';
        } else {
          p.cash += 8000;
          r.floatMode = '獲得 $8,000 急難救助金';
        }
        break;
      }
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
        // 沿著路往回推 5 格。以前直接對 52 取餘數，人在山區或海外支線時
        // 會被算到地圖另一頭（實測：熊本廠 → 創投商店）。
        tp.pos = backSteps(state, tp.pos, 5); tp.prev = -1; tp.stepsLeft = 0;
        r.landAgainFor = tp.gid;     // 推過去之後要結算那一格（跟瞬移卡同一個道理）
        break;
      }
      case 'teleport': {
        if (!target || target.cell == null) return { ok: false, msg: '要指定一格' };
        // 不立刻移動：記下目的地，等這一輪輪到他行動時才傳送過去並結算那一格。
        // 這樣才會走完整的落地流程（可以買地、付過路費、觸發事件），
        // 而且這一輪不用再擲骰 —— 瞬移就是他這一輪的移動。
        p.buff.warpTo = target.cell;
        r.warpTo = target.cell;
        break;
      }
      case 'transfer': {
        if (!tp) return { ok: false, msg: '要指定一組' };
        if (p.virus > 0) {
          // 對方已經中毒的話，取比較快爆炸的那個倒數（覆蓋會等於幫他延後爆炸）
          tp.virus = tp.virus > 0 ? Math.min(tp.virus, p.virus) : p.virus;
          p.virus = 0;
        }
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
        // 從自己站的這一格開始掃（含自己），一路往前 10 格。
        // 以前漏掉兩件事：起點那一格沒掃（自救會失敗）、
        // 玩家身上的勒索病毒沒清（說明明明寫了會清）。
        var pos = p.pos;
        for (var s = 0; s <= 10; s++) {
          delete state.board.barrier[pos];
          delete state.board.radiation[pos];
          for (var g2 in state.players) {
            if (state.players[g2].pos === pos) {
              state.players[g2].god = null; state.players[g2].godTurns = 0;
              state.players[g2].virus = 0;
            }
          }
          pos = (B.ADJ[pos] || [(pos + 1) % B.RING])[0];
        }
        break;
      }
      case 'virus': {
        if (!tp) return { ok: false, msg: '要指定一組' };
        tp.virus = CFG.virusFuse;
        break;
      }
      case 'dice': {
        // 良率控制器：平板送出時要一起帶 steps（2~12），下次輪到自己就用這個點數
        var st = target && target.steps;
        if (!st || st < 2 || st > 12) return { ok: false, msg: '請選擇 2～12 的點數' };
        p.buff.fixedDice = st;
        r.fixedDice = st;
        break;
      }
      case 'induct': {
        r.peekAnswer = state.question ? state.question.answer : null;
        p.buff.peek = r.peekAnswer;      // 存進狀態，該組的平板才顯示得出來
        break;
      }
      case 'predict': r.rerollQuestion = true; break;
      case 'copycard': {
        if (!state.lastCardPlayed) return { ok: false, msg: '目前還沒有人打出過卡片' };
        // 複製卡自己會離手，所以手牌不會超過上限；但保險起見還是檢查
        if (p.cards.length > CFG.handLimit) return { ok: false, msg: '手牌已滿' };
        var copiedDef = CARD.get(state.lastCardPlayed, true) || {};
        removeCard(p, cardId);
        // 帶上 char 旗標：複製到角色專屬卡時，出牌時才找得到正確的卡片定義
        p.cards.push({ id: state.lastCardPlayed, char: !!copiedDef.owner });
        log(state, '🧬 ' + p.name + ' 複製了「' + (copiedDef.name || state.lastCardPlayed) + '」', 'card');
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
  // 機會寶箱的事件池（偏好運——大富翁的「機會」）
  var CHANCE = [
    { text: '挖到寶！獲得 $10,000', apply: function (s, g) { s.players[g].cash += 10000; } },
    { text: '研發靈感大爆發，研發點數 +' + CFG.rpChest, apply: function (s, g) { s.players[g].rp += CFG.rpChest; } },
    { text: '創投看好你們，抽到一張卡片', apply: function (s, g) {
        var p2 = s.players[g];
        if (p2.cards.length < CFG.handLimit) p2.cards.push({ id: pick(s, CARD.CARDS).id }); } },
    { text: '產品大賣，獲得 $15,000', apply: function (s, g) { s.players[g].cash += 15000; } },
    { text: '政府表揚模範企業，獲得 $8,000 與 ' + CFG.rpPacket + ' 點',
      apply: function (s, g) { s.players[g].cash += 8000; s.players[g].rp += CFG.rpPacket; } },
    { text: '工程師士氣大振，隨機一塊自有地免費升一級', apply: function (s, g) {
        var mine = landsOf(s, g).filter(function (i) { return (s.board.level[i] || 0) < 5; });
        if (mine.length) s.board.level[mine[Math.floor(rnd(s) * mine.length)]] += 1; } },
    { text: '匯率有利，獲得 $12,000', apply: function (s, g) { s.players[g].cash += 12000; } }
  ];

  var NEWS = [
    { text: 'AI 需求爆發，獲得 $15,000 訂單', apply: function (s, g) { s.players[g].cash += 15000; } },
    { text: '匯率大幅波動，損失 $8,000', apply: function (s, g) { payTo(s, g, null, 8000); } },
    { text: '獲得政府研發補助 +' + CFG.rpNews + ' 點', apply: function (s, g) { s.players[g].rp += CFG.rpNews; } },
    { text: '缺工潮，支付加班費 $5,000', apply: function (s, g) { payTo(s, g, null, 5000); } },
    { text: '技術突破，隨機一塊自有地免費升一級', apply: function (s, g) {
        var mine = landsOf(s, g).filter(function (i) { return (s.board.level[i] || 0) < 5; });
        if (mine.length) s.board.level[mine[0]] = (s.board.level[mine[0]] || 0) + 1; } },
    { text: '專利訴訟敗訴，賠償 $12,000', apply: function (s, g) { payTo(s, g, null, 12000); } },
    { text: '接到大廠追加訂單，獲得 $20,000', apply: function (s, g) { s.players[g].cash += 20000; } },
    { text: '園區限電，這輪收益減半', apply: function (s, g) { s.players[g].buff.brownout = 1; } },
    { text: '股價大漲，獲得 $10,000', apply: function (s, g) { s.players[g].cash += 10000; } },
    { text: '機台故障，維修費 $6,000', apply: function (s, g) { payTo(s, g, null, 6000); } },
    { text: '挖到人才，研發點數 +50', apply: function (s, g) { s.players[g].rp += 50; } },
    { text: '被駭客勒索，支付 $10,000 贖金', apply: function (s, g) { payTo(s, g, null, 10000); } }
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

      // 神明附身倒數。結束時神明離開這個人，隨機降落在地圖上另一個格子
      //（神明是浮動的，不會回到固定位置）。
      if (p.godTurns > 0) {
        if (p.god === 'fx') payTo(state, gid, null, 1000);
        if (p.god === 'grant' && p.cards.length < CFG.handLimit) p.cards.push({ id: pick(state, CARD.CARDS).id });
        p.godTurns--;
        if (p.godTurns === 0) {
          var leavingGod = p.god;
          p.god = null;
          var landAt = godLandingCell(state);
          if (landAt != null) {
            state.board.gods[landAt] = leavingGod;
            var lg = godById(leavingGod);
            log(state, (lg ? lg.emoji + ' ' + lg.name : '神明') + ' 離開 ' + p.name +
                       '，降落在 ' + B.CELLS[landAt].name, 'god');
            events.push({ type: 'godMove', id: leavingGod, cell: landAt });
          }
        }
      }
      // 病毒倒數與爆炸
      if (p.virus > 0) {
        p.virus--;
        if (p.virus === 0) {
          // 沿著路網找附近的格子。以前用 %52 硬算，人在南橫爆炸卻是北部的
          // 鴻海、廣達降級 —— 全班會看不懂發生什麼事。
          var hit = [];
          nearbyCells(p.pos, CFG.virusRadius).forEach(function (c) {
            if (state.board.level[c] > 0) { state.board.level[c]--; hit.push(c); }
          });
          // 被炸到要送醫：直接移到花蓮慈濟醫院並住院一輪。
          // 原本只是原地停一輪，醫院那一格等於沒有存在意義。
          p.pos = B.HOSP; p.prev = -1; p.stepsLeft = 0;
          p.frozen = Math.max(p.frozen, 1);
          events.push({ gid: gid, type: 'virusBoom', cells: hit, toHospital: true });
          log(state, '💥 ' + p.name + ' 身上的勒索病毒爆炸！周圍 ' + hit.length +
                     ' 座廠房降級，本人送醫住院一輪', 'big');
        }
      }
      // 同盟倒數
      for (var a in p.alliance) { p.alliance[a]--; if (p.alliance[a] <= 0) delete p.alliance[a]; }
      // 引擎卡倒數
      if (p.buff.engine > 0) { p.buff.engine--; if (!p.buff.engine) delete p.buff.engine; }
      // 一次性 buff 清除（當輪有效的那幾種）。
      // 骰子類的卡（過熱、雙骰、逆轉、落地、良率控制器）依卡片說明是
      // 「下一次擲骰時生效」，所以保留到真的擲骰才消耗 ——
      // 答錯或停機那一輪沒擲骰，卡的效果會順延，不會白出。
      // 白板骰子畫面會把算式寫清楚（3 + 4 = 7 → 過熱卡 ×2 → 14），不會看不懂。
      ['surge', 'pierce', 'brownout', 'observe', 'peek']
        .forEach(function (b) { delete p.buff[b]; });

      // 貸款到期：現金不足就自動賣掉最便宜的廠抵債。
      // 這裡不能走 repayLoan()——那是給玩家按的，會先檢查「輪到你了沒、
      // 站在銀行沒」，系統結算永遠不會通過，結果變成：錢夠也還不掉、
      // 錢不夠會把土地全部賣光但債還在，之後利息永久凍結（實際發生過）。
      if (p.loan > 0 && state.round >= p.loanDue) {
        var settle = function () {
          var pay = Math.min(p.loan, p.cash + p.bank);
          if (pay <= 0) return;
          var fromCash = Math.min(pay, p.cash);
          p.cash -= fromCash;
          p.bank -= (pay - fromCash);
          p.loan -= pay;
          if (p.loan <= 0) { p.loan = 0; p.loanDue = 0; }
        };
        settle();
        if (p.loan > 0) {
          var mine = landsOf(state, gid).sort(function (x, y) { return B.CELLS[x].price - B.CELLS[y].price; });
          while (p.loan > 0 && mine.length) {
            var sell = mine.shift();
            p.cash += B.landValue(sell, state.board.level[sell] || 0);
            delete state.board.owner[sell]; delete state.board.level[sell];
            log(state, '⚠️ ' + p.name + ' 貸款到期，強制賣出 ' + B.CELLS[sell].name + ' 抵債', 'bad');
            settle();
          }
        }
        if (p.loan > 0) log(state, '💸 ' + p.name + ' 資產賣光仍欠 $' + p.loan.toLocaleString() + '，下輪繼續追討', 'bad');
      }
      // 角色專屬卡：每 10 輪發一張
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
    state.board.quakeColor = null;      // 地震只停產一輪
    state.phase = (state.round >= state.maxRounds) ? 'ended' : 'waiting';
    return { events: events, ended: state.phase === 'ended' };
  }

  /**
   * 給平板看的公開狀態。
   *
   * 這份東西會原封不動送到全班每一台平板，學生按 F12 就看得到整包內容，
   * 所以「不該被看到的」一定要在這裡拿掉，光是畫面上不顯示是沒有用的。
   * 以前只拿掉了正確答案，其他四樣照樣廣播出去（實測全部可以撈到）：
   *   · 三段付費提示（第三段幾乎等於公布答案，等於提示不用花錢買）
   *   · 感應卡偷看到的答案（存在 players.gX.buff.peek）
   *   · 作答期間別組選了什麼（可以直接抄多數決）
   *   · 別組的手牌（本來就該是秘密）與座位鎖的裝置代號（等於冒充別組的鑰匙）
   */
  function publicState(state) {
    var pub = JSON.parse(JSON.stringify(state));

    if (pub.question) {
      delete pub.question.answer;
      // 提示只送給「已經花錢買了」的那一組（放在下面的私人區），
      // 這裡只告訴大家「這一題總共有幾段提示可以買」
      pub.question.hintCount = (state.question.hints || []).length;
      delete pub.question.hints;
    }
    delete pub.questionAt;

    // 作答還沒結束之前，只送「有沒有交卷」，不送選了什麼
    if (pub.phase === 'question' && pub.answers) {
      Object.keys(pub.answers).forEach(function (g) {
        pub.answers[g] = { answered: true, timeMs: pub.answers[g].timeMs };
      });
    }

    Object.keys(pub.players || {}).forEach(function (g) {
      var p = pub.players[g];
      if (p.buff) delete p.buff.peek;                 // 感應卡看到的答案不外流
      // 手牌是秘密：只送張數，內容改由下面的「私人區」單獨送給本人。
      // 但「有沒有絕緣卡」是刻意公開的（地圖上的盾牌標記，要讓全班
      // 知道打這一組會被擋），所以留一個旗標，平板的地圖才畫得出來。
      p.shield = (state.players[g].cards || []).some(function (c) { return c.id === 'insulate'; });
      p.handCount = (p.cards || []).length;
      delete p.cards;
    });

    // 被拒絕的操作訊息（「點數不足」「還沒輪到你」…）也放進私人區，
    // 平板才能顯示原因 —— 以前全部無聲吞掉，學生只覺得「按了沒反應」。
    // 私人區：每一組只放自己的東西。
    // 註：這份文件是全班共用的，所以一個真的會寫程式的學生還是有辦法
    //     撈到別人的私人區。真正的防線在「這些資料改不了分數」——
    //     手牌內容被看到最多是資訊優勢，改不了任何數值。
    pub.priv = {};
    Object.keys(state.players || {}).forEach(function (g) {
      var sp = state.players[g];
      pub.priv[g] = {
        cards: JSON.parse(JSON.stringify(sp.cards || [])),
        peek: (sp.buff && sp.buff.peek) || null,
        hints: hintsFor(state, g),
        reject: (state.rejects && state.rejects[g]) || null
      };
      // 觀測卡：這一輪看得到全部人的手牌（卡片說明就是這樣寫的）
      if (sp.buff && sp.buff.observe) {
        pub.priv[g].allCards = {};
        Object.keys(state.players).forEach(function (o) {
          pub.priv[g].allCards[o] = JSON.parse(JSON.stringify(state.players[o].cards || []));
        });
      }
    });

    delete pub.rejects;                 // 各組被拒的原因只放各自的私人區，不整包廣播
    if (pub.seats) {
      // 座位鎖的裝置代號等於「冒充這一組」的鑰匙，不可以直接發給全班。
      // 但平板選組畫面需要知道「這一組是不是被別台佔走」，
      // 所以發一個算得出來、還原不回去的短代碼（雜湊），
      // 平板拿自己的裝置代號算同一條公式就能比對是不是自己。
      Object.keys(pub.seats).forEach(function (g) {
        var seat = state.seats[g] || {};
        pub.seats[g] = { taken: true, who: devTag(seat.dev), at: seat.at || 0 };
      });
    }
    return pub;
  }

  /** 裝置代號 → 不可逆的 6 碼標籤（平板端用同一條公式比對自己） */
  function devTag(dev) {
    if (!dev) return '';
    var h = 5381;
    var s = String(dev);
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36).slice(0, 6);
  }

  /** 這一組已經買到的提示（沒買就是空的） */
  function hintsFor(state, gid) {
    var q = state.question;
    if (!q || !q.hints) return [];
    var lv = (state.hintLevel && state.hintLevel[gid]) || 0;
    return q.hints.slice(0, lv);
  }

  global.ENGINE = {
    CFG: CFG, GODS: GODS, godById: godById, NEWS: NEWS, CHANCE: CHANCE, publicState: publicState,
    createGame: createGame, pickCharacter: pickCharacter,
    startRound: startRound, submitAnswer: submitAnswer, reveal: reveal,
    currentGid: currentGid, nextOptions: nextOptions, rollDice: rollDice, setSteps: setSteps,
    step: step, commitStep: commitStep, landOn: landOn, pickFork: pickFork,
    buyLand: buyLand, build: build, merge: merge,
    deposit: deposit, withdraw: withdraw, applyLoan: applyLoan, repayLoan: repayLoan,
    buyFromShop: buyFromShop, sellCard: sellCard, buyHint: buyHint,
    playCard: playCard, endTurn: endTurn, endRound: endRound,
    wealth: wealth, ranking: ranking, landsOf: landsOf, hasFullColor: hasFullColor,
    hasCard: hasCard, removeCard: removeCard, money: money, shopShelfFor: shopShelfFor,
    backSteps: backSteps, nearbyCells: nearbyCells, devTag: devTag
  };
})(typeof window !== 'undefined' ? window : globalThis);
