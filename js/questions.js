/* 科技島大富翁 — 題庫載入與出題
 * 題庫來源：questions/*.json（八年級從一千零一夢同步；九年級 2026-08 Codex 補完全冊，共 809 題）
 * 欄位：chapter / section / difficulty / question / options{A,B,C,D} / answer / hints[3] / imageUrl
 */
(function (global) {
  'use strict';

  // 老師端勾選用的章節清單（file 是檔名，不含 .json）
  var CHAPTERS = [
    { file: '8-1',  label: '八上 ch1 基本測量' },
    { file: '8-2',  label: '八上 ch2 物質的世界' },
    { file: '8-3',  label: '八上 ch3 波動與聲音' },
    { file: '8-4',  label: '八上 ch4 光與色' },
    { file: '8-5',  label: '八上 ch5 溫度與熱' },
    { file: '8-6',  label: '八上 ch6 元素與化合物' },
    { file: '8下-1', label: '八下 ch1 認識物質的世界' },
    { file: '8下-2', label: '八下 ch2 化學反應' },
    { file: '8下-3', label: '八下 ch3 反應速率與平衡' },
    { file: '8下-4', label: '八下 ch4 有機化合物' },
    { file: '8下-5', label: '八下 ch5 力與運動' },
    { file: '8下-6', label: '八下 ch6 力矩與功' },
    { file: '9-1',  label: '九上 ch1 直線運動' },
    { file: '9-2',  label: '九上 ch2 力與運動' },
    { file: '9-3',  label: '九上 ch3 功與能量' },
    { file: '9-4',  label: '九上 ch4 基本電學' },
    { file: '9下-1', label: '九下 ch1 電流的熱效應與生活用電' },
    { file: '9下-2', label: '九下 ch2 電與磁' },
    { file: '9下-3', label: '九下 ch3 能源與科技生活' },
    { file: 'final-10', label: '總複習（跨章）' }
  ];

  // 難度 → 作答秒數（2026-08-22 調整：10 秒太趕，一般題改 15 秒、計算題 20 秒）
  var SECONDS = { basic: 15, concept: 15, calc: 20 };

  var bank = [];        // 已載入的題目
  var loaded = [];      // 已載入哪些章節
  var loadToken = 0;    // 防競態：老師連續勾選章節時，舊的載入結果要丟棄

  /** 載入勾選的章節。files: ['8-1','8-2'] */
  function load(files, baseDir) {
    baseDir = baseDir || 'questions/';
    var myToken = ++loadToken;
    var uniq = files.filter(function (f, i) { return files.indexOf(f) === i; });  // 去重
    var collected = [], done = [];

    var jobs = uniq.map(function (f) {
      return fetch(baseDir + f + '.json')
        .then(function (r) { if (!r.ok) throw new Error(f + ' 載入失敗'); return r.json(); })
        .then(function (arr) {
          if (!Array.isArray(arr)) throw new Error(f + ' 格式不是題目陣列');
          arr.forEach(function (q) {
            // 防護：舊題庫可能缺欄位
            if (!q || !q.question || !q.options || !q.answer) return;
            // 帶附圖的題先跳過：圖檔不在本專案（一千零一夢同步殘留的欄位），
            // 抽到會變成「如圖所示」卻沒有圖，全班無法作答
            if (q.imageUrl) return;
            q._file = f;
            if (!q.hints) q.hints = [];
            collected.push(q);
          });
          done.push(f);
        });
    });

    return Promise.all(jobs).then(function () {
      if (myToken !== loadToken) {          // 已經有更新的載入，這批作廢
        return { count: bank.length, chapters: loaded, stale: true };
      }
      bank = collected; loaded = done;
      return { count: bank.length, chapters: loaded };
    });
  }

  /** 已載入的題數 */
  function size() { return bank.length; }

  /**
   * 抽一題。
   * opts.used      已出過的題目 id 陣列（全部出完會自動重來）
   * opts.difficulty 指定難度（可省略）
   * opts.rnd       亂數函式（存檔續玩要可重現）
   */
  function draw(opts) {
    opts = opts || {};
    var rnd = opts.rnd || Math.random;
    var used = opts.used || [];
    var pool = bank;

    if (opts.difficulty) {
      var byDiff = bank.filter(function (q) { return q.difficulty === opts.difficulty; });
      if (byDiff.length) pool = byDiff;
    }
    var fresh = pool.filter(function (q) { return used.indexOf(q.id) < 0; });
    if (!fresh.length) fresh = pool;               // 全部出完了就重來
    if (!fresh.length) return null;

    var q = fresh[Math.floor(rnd() * fresh.length)];
    return normalize(q);
  }

  /** 依地價決定難度：越貴的地出越難的題 */
  function difficultyForPrice(price) {
    if (!price) return null;
    if (price >= 4000) return 'calc';
    if (price >= 2000) return 'concept';
    return 'basic';
  }

  /** 轉成引擎與 UI 用的格式 */
  function normalize(q) {
    var keys = Object.keys(q.options);
    return {
      id: q.id,
      text: q.question,
      optionKeys: keys,
      options: q.options,
      answer: q.answer,
      hints: q.hints || [],
      difficulty: q.difficulty,
      chapter: q.chapter,
      section: q.section,
      imageUrl: q.imageUrl || null,
      seconds: SECONDS[q.difficulty] || 15
    };
  }

  /** 把選項順序打亂（防止學生背「答案都是 B」）*/
  function shuffleOptions(q, rnd) {
    rnd = rnd || Math.random;
    var keys = q.optionKeys.slice();
    for (var i = keys.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var t = keys[i]; keys[i] = keys[j]; keys[j] = t;
    }
    var newOpts = {}, newAnswer = null;
    var letters = ['A', 'B', 'C', 'D', 'E', 'F'];
    keys.forEach(function (k, i) {
      newOpts[letters[i]] = q.options[k];
      if (k === q.answer) newAnswer = letters[i];
    });
    return Object.assign({}, q, {
      options: newOpts,
      optionKeys: keys.map(function (_, i) { return letters[i]; }),
      answer: newAnswer
    });
  }

  global.QUESTIONS = {
    CHAPTERS: CHAPTERS, SECONDS: SECONDS,
    load: load, size: size, draw: draw,
    difficultyForPrice: difficultyForPrice,
    shuffleOptions: shuffleOptions,
    _bank: function () { return bank; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
