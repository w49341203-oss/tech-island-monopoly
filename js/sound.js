/* 科技島大富翁 — 音效
 *
 * 全部用 Web Audio 即時合成，不使用任何音檔：
 *   · 不用下載、不占空間、不會有授權問題
 *   · 離線也響得出來，舊平板也跑得動
 *
 * 瀏覽器規定：使用者「碰過畫面」之後才准出聲，
 * 所以第一次點任何按鈕時才會真正啟動（unlock）。
 */
(function (global) {
  'use strict';

  var ctx = null;
  var master = null;
  var ready = false;
  var LS_KEY = 'techisland:sound';

  // 預設：白板要有聲音；平板預設靜音（全班九台一起響會很吵）
  var enabled = true;
  var volume = 0.7;

  function loadPref(defaultOn) {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw == null) { enabled = defaultOn; return; }
      var o = JSON.parse(raw);
      enabled = !!o.on;
      if (typeof o.vol === 'number') volume = o.vol;
    } catch (e) { enabled = defaultOn; }
  }

  function savePref() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ on: enabled, vol: volume })); } catch (e) {}
  }

  /** 第一次被使用者的動作觸發時才建立音訊環境（iPad Safari 硬性規定） */
  function unlock() {
    if (ready) return;
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
      ready = true;
    } catch (e) { ready = false; }
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  function on() { return enabled && ready && ctx; }

  // ── 基本積木 ──────────────────────────────

  /** 單音：可以滑音（slideTo），用包絡線避免爆音 */
  function tone(o) {
    if (!on()) return;
    var t0 = ctx.currentTime + (o.at || 0);
    var dur = o.dur || 0.18;
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.freq, t0);
    if (o.slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.slideTo), t0 + dur);

    var peak = (o.gain == null ? 0.3 : o.gain);
    var atk = o.attack == null ? 0.008 : o.attack;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    var node = osc;
    if (o.filter) {
      var f = ctx.createBiquadFilter();
      f.type = o.filter;
      f.frequency.value = o.filterFreq || 1200;
      osc.connect(f); node = f;
    }
    node.connect(g); g.connect(master);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  }

  var noiseBuf = null;
  function getNoise() {
    if (noiseBuf) return noiseBuf;
    var len = Math.floor(ctx.sampleRate * 1.2);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = noiseBuf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }

  /** 雜訊：做撞擊、爆炸、沙沙聲用 */
  function noise(o) {
    if (!on()) return;
    var t0 = ctx.currentTime + (o.at || 0);
    var dur = o.dur || 0.2;
    var src = ctx.createBufferSource();
    src.buffer = getNoise();
    var f = ctx.createBiquadFilter();
    f.type = o.filter || 'bandpass';
    f.frequency.setValueAtTime(o.freq || 1000, t0);
    if (o.slideTo) f.frequency.exponentialRampToValueAtTime(Math.max(30, o.slideTo), t0 + dur);
    f.Q.value = o.q == null ? 1 : o.q;
    var g = ctx.createGain();
    var peak = o.gain == null ? 0.25 : o.gain;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t0); src.stop(t0 + dur + 0.02);
  }

  /** 一串音符：[[頻率, 何時開始, 長度]] */
  function melody(notes, o) {
    o = o || {};
    notes.forEach(function (n) {
      tone({ freq: n[0], at: n[1], dur: n[2] == null ? 0.14 : n[2],
             type: o.type || 'triangle', gain: o.gain == null ? 0.26 : o.gain });
    });
  }

  // 音名 → 頻率（只列用得到的）
  var N = {
    C4: 261.6, D4: 293.7, E4: 329.6, F4: 349.2, G4: 392.0, A4: 440.0, B4: 493.9,
    C5: 523.3, D5: 587.3, E5: 659.3, F5: 698.5, G5: 784.0, A5: 880.0, B5: 987.8,
    C6: 1046.5, E6: 1318.5, G6: 1568.0,
    G3: 196.0, A3: 220.0, C3: 130.8, E3: 164.8, F3: 174.6
  };

  // ── 各種音效 ──────────────────────────────
  var LIB = {

    /** 介面點擊 */
    click: function () { tone({ freq: 900, dur: 0.05, type: 'square', gain: 0.12 }); },

    /** 新的一輪開始：柔和提示鐘 */
    round: function () {
      melody([[N.C5, 0, 0.16], [N.G5, 0.1, 0.26]], { type: 'sine', gain: 0.22 });
    },

    /** 道具時間開始：神秘上行 */
    itemPhase: function () {
      melody([[N.D5, 0, 0.12], [N.F5, 0.08, 0.12], [N.A5, 0.16, 0.3]], { type: 'triangle', gain: 0.2 });
    },

    /** 題目出現：吸引注意的雙音 */
    question: function () {
      melody([[N.E5, 0, 0.13], [N.B5, 0.11, 0.3]], { type: 'sine', gain: 0.26 });
    },

    /** 倒數滴答（一般） */
    tick: function () { tone({ freq: 1100, dur: 0.045, type: 'square', gain: 0.08 }); },

    /** 倒數剩 5 秒：比較急促 */
    tickFast: function () { tone({ freq: 1500, dur: 0.06, type: 'square', gain: 0.16 }); },

    /** 時間到 */
    timeUp: function () {
      tone({ freq: 440, slideTo: 180, dur: 0.5, type: 'sawtooth', gain: 0.2, filter: 'lowpass', filterFreq: 1400 });
    },

    /** 答對：明亮的上行三音 */
    right: function () {
      melody([[N.C5, 0, 0.11], [N.E5, 0.09, 0.11], [N.G5, 0.18, 0.28]], { type: 'triangle', gain: 0.3 });
      tone({ freq: N.C6, at: 0.18, dur: 0.3, type: 'sine', gain: 0.14 });
    },

    /** 答錯：低沉下行 */
    wrong: function () {
      tone({ freq: 300, slideTo: 150, dur: 0.32, type: 'square', gain: 0.16, filter: 'lowpass', filterFreq: 900 });
      tone({ freq: 150, at: 0.05, slideTo: 90, dur: 0.3, type: 'sawtooth', gain: 0.12, filter: 'lowpass', filterFreq: 600 });
    },

    /** 擲骰：骰子在桌上滾 */
    dice: function () {
      for (var i = 0; i < 7; i++) {
        noise({ at: i * 0.075, dur: 0.055, filter: 'bandpass', freq: 2400 + Math.random() * 1800, q: 3, gain: 0.30 });
      }
    },

    /** 骰子落定 */
    diceStop: function () {
      noise({ dur: 0.12, filter: 'lowpass', freq: 1400, slideTo: 300, gain: 0.3 });
      tone({ freq: 220, slideTo: 140, dur: 0.14, type: 'sine', gain: 0.2 });
    },

    /** 走一格 */
    step: function () {
      tone({ freq: 660, slideTo: 880, dur: 0.06, type: 'triangle', gain: 0.13 });
    },

    /** 買地成功 */
    buy: function () {
      melody([[N.G4, 0, 0.1], [N.C5, 0.08, 0.1], [N.E5, 0.16, 0.24]], { type: 'triangle', gain: 0.26 });
      noise({ at: 0.02, dur: 0.1, filter: 'bandpass', freq: 3000, q: 2, gain: 0.1 });
    },

    /** 蓋廠房／升級：敲擊 + 上揚 */
    build: function () {
      noise({ dur: 0.09, filter: 'lowpass', freq: 900, slideTo: 200, gain: 0.32 });
      tone({ freq: 300, at: 0.06, slideTo: 700, dur: 0.26, type: 'square', gain: 0.16, filter: 'lowpass', filterFreq: 1600 });
    },

    /** 收到錢：硬幣叮噹 */
    income: function () {
      melody([[N.E5, 0, 0.09], [N.G5, 0.06, 0.09], [N.C6, 0.13, 0.22]], { type: 'sine', gain: 0.24 });
    },

    /** 付錢出去：悶悶的下行 */
    pay: function () {
      melody([[N.A4, 0, 0.1], [N.F4, 0.08, 0.1], [N.C4, 0.17, 0.26]], { type: 'triangle', gain: 0.2 });
    },

    /** 出牌／道具生效：閃亮 */
    card: function () {
      melody([[N.A5, 0, 0.08], [N.C6, 0.05, 0.08], [N.E6, 0.1, 0.08], [N.G6, 0.15, 0.22]],
             { type: 'sine', gain: 0.18 });
    },

    /** 破壞類道具打到人 */
    hit: function () {
      noise({ dur: 0.18, filter: 'bandpass', freq: 1800, slideTo: 260, q: 1.2, gain: 0.3 });
      tone({ freq: 200, slideTo: 70, dur: 0.24, type: 'sawtooth', gain: 0.18, filter: 'lowpass', filterFreq: 700 });
    },

    /** 爆炸（定時炸彈） */
    boom: function () {
      noise({ dur: 0.7, filter: 'lowpass', freq: 2200, slideTo: 60, gain: 0.42 });
      tone({ freq: 120, slideTo: 32, dur: 0.65, type: 'sawtooth', gain: 0.28, filter: 'lowpass', filterFreq: 500 });
    },

    /** 被擋下來（絕緣卡） */
    block: function () {
      tone({ freq: 1400, slideTo: 1400, dur: 0.1, type: 'square', gain: 0.14 });
      noise({ at: 0.03, dur: 0.22, filter: 'bandpass', freq: 5000, q: 6, gain: 0.16 });
    },

    /** 進監獄／檢調約談 */
    jail: function () {
      noise({ dur: 0.3, filter: 'lowpass', freq: 700, slideTo: 90, gain: 0.36 });
      melody([[N.E3, 0.06, 0.3], [N.C3, 0.2, 0.42]], { type: 'sawtooth', gain: 0.16 });
    },

    /** 進醫院 */
    hospital: function () {
      melody([[N.A4, 0, 0.22], [N.F4, 0.2, 0.22], [N.A4, 0.4, 0.22], [N.F4, 0.6, 0.28]],
             { type: 'sine', gain: 0.16 });
    },

    /** 好神附身 */
    godGood: function () {
      melody([[N.C5, 0, 0.12], [N.E5, 0.08, 0.12], [N.G5, 0.16, 0.12], [N.C6, 0.24, 0.4]],
             { type: 'sine', gain: 0.24 });
      tone({ freq: N.G6, at: 0.3, dur: 0.5, type: 'sine', gain: 0.1 });
    },

    /** 壞神附身 */
    godBad: function () {
      melody([[N.A4, 0, 0.16], [N.G4, 0.13, 0.16], [N.F3, 0.26, 0.45]], { type: 'sawtooth', gain: 0.16 });
      noise({ at: 0.1, dur: 0.5, filter: 'bandpass', freq: 400, q: 2, gain: 0.12 });
    },

    /** 地震卡 */
    quake: function () {
      noise({ dur: 1.0, filter: 'lowpass', freq: 300, slideTo: 45, gain: 0.34 });
      tone({ freq: 60, slideTo: 30, dur: 1.0, type: 'sawtooth', gain: 0.2, filter: 'lowpass', filterFreq: 300 });
    },

    /** 均富卡：全體重新洗牌的感覺 */
    equalize: function () {
      for (var i = 0; i < 6; i++) {
        tone({ freq: 400 + i * 130, at: i * 0.05, dur: 0.12, type: 'sine', gain: 0.16 });
      }
      tone({ freq: N.C5, at: 0.34, dur: 0.4, type: 'triangle', gain: 0.22 });
    },

    /** 本節結束／頒獎 */
    fanfare: function () {
      melody([[N.C5, 0, 0.15], [N.E5, 0.13, 0.15], [N.G5, 0.26, 0.15],
              [N.C6, 0.39, 0.5], [N.G5, 0.42, 0.5], [N.E5, 0.45, 0.5]],
             { type: 'triangle', gain: 0.26 });
      noise({ at: 0.39, dur: 0.55, filter: 'bandpass', freq: 6000, q: 1.5, gain: 0.12 });
    },

    /** 有人破產／負債 */
    broke: function () {
      melody([[N.G4, 0, 0.16], [N.E4, 0.14, 0.16], [N.C4, 0.28, 0.16], [N.G3, 0.42, 0.5]],
             { type: 'triangle', gain: 0.2 });
    },

    /** 有平板連進來 */
    join: function () {
      melody([[N.G4, 0, 0.09], [N.C5, 0.07, 0.2]], { type: 'sine', gain: 0.2 });
    },

    /** 警告（存檔失敗、雲端出問題） */
    warn: function () {
      tone({ freq: 700, dur: 0.12, type: 'square', gain: 0.18 });
      tone({ freq: 700, at: 0.18, dur: 0.12, type: 'square', gain: 0.18 });
    }
  };

  /** 播一個音效。名稱打錯不會壞，只是沒聲音。 */
  function play(name) {
    if (!enabled) return;
    unlock();
    if (!on()) return;
    var fn = LIB[name];
    if (fn) { try { fn(); } catch (e) {} }
  }

  function setEnabled(v) {
    enabled = !!v;
    if (enabled) { unlock(); play('click'); }
    savePref();
    return enabled;
  }
  function isEnabled() { return enabled; }
  function setVolume(v) {
    volume = Math.min(1, Math.max(0, v));
    if (master) master.gain.value = volume;
    savePref();
  }
  function getVolume() { return volume; }
  function names() { return Object.keys(LIB); }

  /**
   * 自我檢測：把每個音效放進「離線算圖」跑一遍，實際量出音量峰值。
   * 用途是確認每個音效真的發得出聲音——沒報錯不等於有聲音，
   * 打錯一個參數就可能變成一片安靜，光看程式碼看不出來。
   * 回傳 [{ name, peak }]，peak 是 0～1 的音量峰值。
   */
  function selfTest() {
    var OAC = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    if (!OAC) return Promise.resolve(null);

    var saveCtx = ctx, saveMaster = master, saveReady = ready, saveEnabled = enabled, saveNoise = noiseBuf;
    var list = Object.keys(LIB);

    return list.reduce(function (chain, name) {
      return chain.then(function (acc) {
        var oc = new OAC(1, 44100 * 2, 44100);
        ctx = oc;
        master = oc.createGain();
        master.gain.value = 1;
        master.connect(oc.destination);
        ready = true; enabled = true; noiseBuf = null;
        try { LIB[name](); } catch (e) {
          acc.push({ name: name, peak: 0, error: e.message });
          return acc;
        }
        return oc.startRendering().then(function (buf) {
          var ch = buf.getChannelData(0), peak = 0;
          for (var i = 0; i < ch.length; i++) {
            var v = ch[i] < 0 ? -ch[i] : ch[i];
            if (v > peak) peak = v;
          }
          acc.push({ name: name, peak: Math.round(peak * 1000) / 1000 });
          return acc;
        });
      });
    }, Promise.resolve([])).then(function (rows) {
      ctx = saveCtx; master = saveMaster; ready = saveReady; enabled = saveEnabled; noiseBuf = saveNoise;
      return rows;
    });
  }

  global.SOUND = {
    init: loadPref, unlock: unlock, play: play, selfTest: selfTest,
    setEnabled: setEnabled, isEnabled: isEnabled,
    setVolume: setVolume, getVolume: getVolume,
    names: names
  };
})(typeof window !== 'undefined' ? window : globalThis);
