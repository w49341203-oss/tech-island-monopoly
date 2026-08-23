/* 科技島大富翁 — 語音播報（只在老師端／白板）
 *
 * 用瀏覽器內建的語音合成（Web Speech API）：
 *   · 完全免費，不呼叫任何 API，不會產生費用
 *   · 離線也講得出來（用的是電腦本身的語音）
 *   · 全班聽白板的喇叭，平板不出聲
 *
 * 用途：讓全班知道「現在輪到誰」「哪塊地被誰買走了」，
 *      不用一直盯著白板上的小字。
 */
(function (global) {
  'use strict';

  var LS_KEY = 'techisland:speak';
  var level = 'key';          // off = 關閉 / key = 重點 / all = 詳細
  var voice = null;
  var ready = false;
  var lastText = '';
  var lastAt = 0;

  // 中文數字（組別、輪次都在 1~40 之間）
  var CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  function num2cn(n) {
    n = Math.round(n);
    if (n < 0) return '負' + num2cn(-n);
    if (n <= 10) return CN[n] || String(n);
    if (n < 20) return '十' + CN[n - 10];
    if (n < 100) return CN[Math.floor(n / 10)] + '十' + (n % 10 ? CN[n % 10] : '');
    if (n < 1000) {
      var h = Math.floor(n / 100), rest = n % 100;
      if (!rest) return CN[h] + '百';
      if (rest < 10) return CN[h] + '百零' + CN[rest];
      return CN[h] + '百' + num2cn(rest);
    }
    return String(n);
  }

  /** 金額唸成「三萬五千」這種聽得懂的說法，不要一位一位唸數字 */
  function money2cn(n) {
    n = Math.round(Math.abs(n));
    if (n === 0) return '零元';
    // 用無條件捨去而不是四捨五入：寧可少講也不要講出比實際多的數字
    //（$116,500 講成「十一萬七千」是錯的，講「十一萬六千」才對）
    if (n >= 10000) {
      var w = Math.floor(n / 10000), rest = n % 10000;
      var t = Math.floor(rest / 1000);
      return num2cn(w) + '萬' + (t ? num2cn(t) + '千' : '') + '元';
    }
    if (n >= 1000) {
      var k = Math.floor(n / 1000), r2 = n % 1000;
      var h = Math.floor(r2 / 100);
      return num2cn(k) + '千' + (h ? num2cn(h) + '百' : '') + '元';
    }
    if (n >= 100) return num2cn(Math.floor(n / 100)) + '百元';
    return num2cn(n) + '元';
  }

  /** 廠房等級的名稱有 ①②③ 和英文，唸出來很怪，換成講得順的說法 */
  var LEVEL_SAY = ['空地', '研發中心', '小型工廠', '大型工廠', '企業總部', '產業龍頭'];
  function levelSay(lv) { return LEVEL_SAY[lv] || ('第' + num2cn(lv) + '級'); }

  /** 「第 3 組 · 牛頓」→「第三組 牛頓」 */
  function groupSay(p) {
    if (!p) return '';
    var ch = p.charId && global.charById ? global.charById(p.charId) : null;
    return '第' + num2cn(p.num) + '組' + (ch ? '，' + ch.name : '');
  }

  function loadPref() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw != null) level = JSON.parse(raw).level || 'key';
    } catch (e) {}
    pickVoice();
    // 語音清單在有些瀏覽器是非同步載入的，要等它通知才選得到中文聲音
    if (global.speechSynthesis && typeof global.speechSynthesis.onvoiceschanged !== 'undefined') {
      global.speechSynthesis.onvoiceschanged = pickVoice;
    }
  }
  function savePref() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ level: level })); } catch (e) {}
  }

  /** 挑一個中文聲音，優先台灣的 */
  function pickVoice() {
    if (!global.speechSynthesis) return;
    var list = [];
    try { list = global.speechSynthesis.getVoices() || []; } catch (e) { return; }
    if (!list.length) return;
    function find(re) {
      for (var i = 0; i < list.length; i++) {
        if (re.test(list[i].lang) || re.test(list[i].name)) return list[i];
      }
      return null;
    }
    voice = find(/zh[-_]TW|cmn-Hant|Hanhan|Yating|Taiwan/i)
         || find(/zh[-_]HK|Hant/i)
         || find(/zh/i);
    ready = !!voice;
  }

  function available() { return !!(global.speechSynthesis); }
  function voiceName() { return voice ? (voice.name + '（' + voice.lang + '）') : '（找不到中文語音）'; }

  /**
   * 講一句話。
   * important=true 的會插隊（例如「輪到第三組」），其餘的太多就跳過，
   * 免得語音排隊排到下一輪還在講上一輪的事。
   */
  function say(text, important) {
    if (level === 'off' || !text) return;
    if (!available()) return;
    // 同一句話兩秒內不重複（狀態重畫可能會呼叫兩次）
    if (text === lastText && Date.now() - lastAt < 2000) return;
    lastText = text; lastAt = Date.now();

    if (!voice) pickVoice();
    try {
      if (important) global.speechSynthesis.cancel();      // 重要的直接插隊
      else if (global.speechSynthesis.pending) return;      // 已經有東西排隊就別再擠
      var u = new SpeechSynthesisUtterance(text);
      if (voice) { u.voice = voice; u.lang = voice.lang; }
      else u.lang = 'zh-TW';
      u.rate = 1.05;        // 稍微快一點，教室節奏才不會拖
      u.pitch = 1.0;
      u.volume = 1.0;
      global.speechSynthesis.speak(u);
    } catch (e) {}
  }

  /** 只有「詳細」模式才講的內容 */
  function sayDetail(text) { if (level === 'all') say(text, false); }

  function stop() { try { global.speechSynthesis.cancel(); } catch (e) {} }

  function setLevel(v) {
    level = v;
    savePref();
    if (level === 'off') stop();
    return level;
  }
  function getLevel() { return level; }

  global.SPEAK = {
    init: loadPref, say: say, sayDetail: sayDetail, stop: stop,
    setLevel: setLevel, getLevel: getLevel,
    available: available, voiceName: voiceName,
    num2cn: num2cn, money2cn: money2cn, levelSay: levelSay, groupSay: groupSay
  };
})(typeof window !== 'undefined' ? window : globalThis);
