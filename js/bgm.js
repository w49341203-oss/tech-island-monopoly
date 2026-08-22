/* 科技島大富翁 — 背景音樂
 *
 * 音樂檔案放在 audio/ 資料夾，檔名固定（見 audio/放這裡.txt）。
 * 設計原則：
 *   · 檔案不存在也不會出錯，只是沒有音樂（老師還沒放歌也能正常上課）
 *   · 換曲時淡出淡入，不會突然切斷
 *   · 音量比音效小很多，不會蓋過老師講話
 */
(function (global) {
  'use strict';

  var TRACKS = {
    lobby: 'audio/bgm_lobby.mp3',       // 大廳：等各組連線、選角色
    game:  'audio/bgm_game.mp3',        // 遊戲進行中（會播最久，最重要）
    quiz:  'audio/bgm_quiz.mp3',        // 答題倒數（緊張感）
    win:   'audio/bgm_win.mp3'          // 本節結束、頒獎
  };

  var el = null, cur = null, prev = null, fadeTimer = null;
  var enabled = true;
  var VOL = 0.28;                        // 背景音樂要小聲，不能蓋過老師的聲音
  var LS_KEY = 'techisland:bgm';
  var missing = {};                      // 記住哪些檔案不存在，不要一直重試

  function loadPref() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw != null) enabled = JSON.parse(raw).on !== false;
    } catch (e) {}
    // 開場先確認哪幾首真的有放。
    // 不先問的話，切到一首沒放的曲子時會先把正在播的停掉、再發現檔案不存在，
    // 結果就是「音樂放一放突然不見，而且再也不會回來」。
    check().then(function (rows) {
      rows.forEach(function (r) { if (!r.ok) missing[r.name] = 1; });
    });
  }
  function savePref() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ on: enabled })); } catch (e) {}
  }

  function ensure() {
    if (el) return el;
    el = new Audio();
    el.loop = true;
    el.preload = 'none';
    el.volume = 0;
    el.addEventListener('error', function () {
      if (!cur) return;
      missing[cur] = 1;                 // 記住這首有問題，以後不要再切過來
      var back = prev;                  // 退回上一首還會響的
      cur = null;
      if (back && !missing[back]) play(back);
    });
    return el;
  }

  function fadeTo(target, ms, done) {
    clearInterval(fadeTimer);
    var a = ensure();
    var from = a.volume, steps = Math.max(1, Math.round(ms / 50)), i = 0;
    fadeTimer = setInterval(function () {
      i++;
      a.volume = Math.min(1, Math.max(0, from + (target - from) * (i / steps)));
      if (i >= steps) { clearInterval(fadeTimer); if (done) done(); }
    }, 50);
  }

  /** 換一首。同一首就不重播，避免每輪重新開始。 */
  function play(name) {
    if (!enabled) return;
    var src = TRACKS[name];
    // 這首沒放（或載入失敗）就什麼都不做，讓現在這首繼續放，不要換成無聲
    if (!src || missing[name]) return;
    if (cur === name && el && !el.paused) return;
    var a = ensure();

    function start() {
      if (cur && cur !== name) prev = cur;
      cur = name;
      a.src = src;
      a.volume = 0;
      var pr = a.play();
      if (pr && pr.catch) {
        // 瀏覽器規定要先有使用者動作才准播放；擋下來就安靜等下一次
        pr.catch(function () {});
      }
      fadeTo(VOL, 700);
    }

    if (cur && el && !el.paused) fadeTo(0, 450, start);
    else start();
  }

  function stop() {
    if (!el) return;
    fadeTo(0, 450, function () { el.pause(); cur = null; });
  }

  function setEnabled(v) {
    enabled = !!v;
    savePref();
    if (!enabled) stop();
    return enabled;
  }
  function isEnabled() { return enabled; }
  function setVolume(v) { VOL = Math.min(1, Math.max(0, v)); if (el) el.volume = VOL; }

  /** 檢查哪幾首音樂檔案真的存在（老師可以自己確認有沒有放對） */
  function check() {
    return Promise.all(Object.keys(TRACKS).map(function (k) {
      return fetch(TRACKS[k], { method: 'HEAD' })
        .then(function (r) { return { name: k, file: TRACKS[k], ok: r.ok }; })
        .catch(function () { return { name: k, file: TRACKS[k], ok: false }; });
    }));
  }

  /** 現在的播放狀況（除錯用：在主控台輸入 BGM.now() 就看得到） */
  function now() {
    return {
      現在播放: cur,
      檔案: cur ? TRACKS[cur] : null,
      有在響: !!(el && !el.paused),
      音量: el ? Math.round(el.volume * 100) / 100 : null,
      已播秒數: el ? Math.round(el.currentTime) : null,
      總長度: el && el.duration ? Math.round(el.duration) : null,
      開關: enabled,
      找不到的檔案: Object.keys(missing)
    };
  }

  global.BGM = {
    init: loadPref, play: play, stop: stop, check: check, now: now,
    setEnabled: setEnabled, isEnabled: isEnabled, setVolume: setVolume,
    TRACKS: TRACKS
  };
})(typeof window !== 'undefined' ? window : globalThis);
