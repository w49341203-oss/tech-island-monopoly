/* 科技島大富翁 — 存檔與連線層
 *
 * 兩種模式：
 *   local     只用瀏覽器 localStorage（單機試玩、老師自己測試用）
 *   firebase  老師端當主機，平板端把「動作意圖」寫進 actions，老師端處理後更新主文件
 *
 * Firestore 結構（一份主文件，用 onSnapshot 監聽 → 讀取次數最省）：
 *   games/{gameId}                  完整遊戲狀態
 *   games/{gameId}/actions/{gid}    平板送出的動作意圖（老師端處理後清除）
 *
 * 額度估算：9 組 × 30 輪，每輪寫 1 次主文件 = 270 寫／局
 *           監聽者 10 台 × 270 = 2,700 讀／局，一天四節課約 10,800 讀，遠低於免費額度 5 萬。
 */
(function (global) {
  'use strict';

  // 舊版用「班級＋存檔槽」當識別，全世界只有 24 種組合，
  // 兩位不認識的老師選到同一組就會共用同一份雲端資料、互相蓋掉。
  // 現在改成 Kahoot 那樣：每一場自己有一組 6 位數編號，編號就是這一場的身分證。
  var OLD_CLASSES = ['智', '仁', '勇', '信', '義', '和', '平', '誠'];   // 只用來搬舊存檔
  var OLD_SLOTS = [1, 2, 3];
  var LS_PREFIX = 'techisland:';
  var LS_GAME = 'techisland:game:';        // 新的存檔位置：techisland:game:{編號}
  var ROOM_ALIVE_MS = 6 * 3600 * 1000;     // 房間多久沒動靜就算「這場沒在進行」

  var mode = 'local';
  var db = null, gameId = null, unsub = null, actionUnsub = null;

  // ── Firebase 設定 ──
  // 設定值放在 js/firebase-config.js（建立專案後填那個檔案就好，不用動這裡）
  // ⚠️ config 本來就設計為可公開，安全靠 Firestore 規則把關。
  function cfgOf() { return global.FIREBASE_CONFIG || null; }

  function gameKey(code) { return LS_GAME + String(code); }

  /** 產生一組 6 位數編號 */
  function makeCode() { return String(Math.floor(100000 + Math.random() * 900000)); }

  /**
   * 把舊版「班級＋存檔槽」的存檔搬到新的編號制。
   * 老師之前存的進度不能不見，所以搬過來時保留原本的名字（例如「智班 槽1」）讓她認得出來。
   */
  function migrateOldSaves() {
    var moved = 0;
    OLD_CLASSES.forEach(function (c) {
      OLD_SLOTS.forEach(function (s) {
        var oldKey = LS_PREFIX + c + ':' + s;
        var raw = localStorage.getItem(oldKey);
        if (!raw) return;
        try {
          var st = JSON.parse(raw);
          st.code = st.code || makeCode();
          st.label = st.label || (c + '班 槽' + s + '（舊存檔）');
          localStorage.setItem(gameKey(st.code), JSON.stringify(st));
          localStorage.removeItem(oldKey);
          moved++;
        } catch (e) { /* 壞掉的舊存檔就留著別動，免得誤刪 */ }
      });
    });
    return moved;
  }

  /** 列出這台電腦上存過的所有場次，最近玩過的排前面 */
  function listSaves() {
    migrateOldSaves();
    var out = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (!k || k.indexOf(LS_GAME) !== 0) continue;
      try {
        var st = JSON.parse(localStorage.getItem(k));
        out.push({
          code: st.code || k.slice(LS_GAME.length),
          label: st.label || '',
          round: st.round || 0,
          maxRounds: st.maxRounds || 0,
          groups: Object.keys(st.players || {}).length,
          chapters: st.chapters || [],
          savedAt: st._savedAt || null
        });
      } catch (e) { /* 壞掉的存檔略過不顯示 */ }
    }
    out.sort(function (a, b) { return String(b.savedAt || '').localeCompare(String(a.savedAt || '')); });
    return out;
  }

  function saveLocal(state) {
    if (!state || !state.code) return { ok: false, msg: '這一場沒有編號，存不了檔' };
    state._savedAt = new Date().toISOString();
    try {
      localStorage.setItem(gameKey(state.code), JSON.stringify(state));
      return { ok: true };
    } catch (e) {
      // 空間滿了是最常見的原因，要講白話讓老師知道怎麼處理
      var full = /quota|exceeded/i.test(e.name + ' ' + e.message);
      return { ok: false, msg: full ? '存檔失敗：瀏覽器空間滿了，請先刪掉用不到的舊場次'
                                    : '存檔失敗：' + e.message };
    }
  }

  function loadLocal(code) {
    var raw = localStorage.getItem(gameKey(code));
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function deleteSave(code) { localStorage.removeItem(gameKey(code)); }

  /** ⚠️ 一鍵重置：刪掉這台電腦上所有場次，只給換屆用 */
  function resetAll() {
    var keys = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && (k.indexOf(LS_GAME) === 0 || k.indexOf(LS_PREFIX) === 0)) keys.push(k);
    }
    keys.forEach(function (k) { localStorage.removeItem(k); });
    return keys.length;
  }

  // ─────────────────────────────────────────
  // Firebase（老師端主機模式）
  // ─────────────────────────────────────────
  function firebaseReady() {
    var c = cfgOf();
    return !!(c && c.projectId && c.projectId !== '請填入你的-projectId');
  }

  function initFirebase() {
    if (!firebaseReady()) return Promise.reject(new Error('尚未設定 Firebase（請填 js/firebase-config.js）'));
    if (db) return Promise.resolve(db);
    return new Promise(function (res, rej) {
      if (!global.firebase) { rej(new Error('Firebase SDK 沒載入，請確認網路正常')); return; }
      try {
        if (!global.firebase.apps.length) global.firebase.initializeApp(cfgOf());
      } catch (e) { rej(e); return; }
      global.firebase.auth().signInAnonymously()
        .then(function () { db = global.firebase.firestore(); res(db); })
        .catch(function (e) {
          rej(new Error('匿名登入失敗：' + e.message + '（Firebase 主控台要開啟「匿名」登入方式）'));
        });
    });
  }

  /** 這台電腦的匿名身分。雲端用它認出「這一場是誰開的」，別人就改不動。 */
  function uid() {
    try { return global.firebase.auth().currentUser.uid; } catch (e) { return null; }
  }

  function setMode(m, id) { mode = m; gameId = id || gameId; }
  function getMode() { return mode; }

  var onWriteError = null;
  function setWriteErrorHandler(fn) { onWriteError = fn; }

  /** 老師端：把整份狀態推上去（一次寫入） */
  function pushState(state) {
    if (mode !== 'firebase' || !db) return Promise.resolve();
    var payload = JSON.parse(JSON.stringify(state));
    // 蓋上「這一場是我開的」印記。雲端規則會擋掉不是主機的人寫入，
    // 學生就算打開瀏覽器主控台也改不了金幣和地產。
    payload.host = uid();
    payload.hostAt = Date.now();
    return db.collection('games').doc(gameId)
      .set(payload)
      .catch(function (e) {
        console.warn('[STORE] 寫入失敗：', e.message);
        // 靜靜失敗最可怕：白板照跑、平板卻停住，老師完全不知道。
        if (onWriteError) onWriteError(e);
      });
  }

  /** 平板端：監聽遊戲狀態 */
  function watchState(cb) {
    if (mode !== 'firebase' || !db) return function () {};
    unsub = db.collection('games').doc(gameId).onSnapshot(function (doc) {
      if (doc.exists) cb(doc.data());
    });
    return unsub;
  }

  /** 平板端：送出動作意圖 */
  function sendAction(gid, action) {
    if (mode !== 'firebase' || !db) {
      var payload = Object.assign({ gid: gid }, action);
      if (bc) { try { bc.postMessage({ kind: 'action', payload: payload }); } catch (e) {} }
      else localQueue.push(payload);
      return Promise.resolve();
    }
    // 雲端模式：只寫 Firestore，不走 BroadcastChannel
    if (!gameId) {
      return Promise.reject(new Error('還沒連上房間（gameId 是空的）'));
    }
    return db.collection('games').doc(gameId).collection('actions').doc(gid)
      .set(Object.assign({ gid: gid, at: Date.now() }, action));
  }

  /** 老師端：監聽平板送來的動作 */
  function watchActions(cb) {
    if (mode !== 'firebase' || !db) return function () {};
    actionUnsub = db.collection('games').doc(gameId).collection('actions')
      .onSnapshot(function (snap) {
        snap.docChanges().forEach(function (ch) {
          if (ch.type === 'added' || ch.type === 'modified') cb(ch.doc.data());
        });
      });
    return actionUnsub;
  }

  /** 老師端：處理完後清掉該組的動作 */
  function clearAction(gid) {
    if (mode !== 'firebase' || !db) return Promise.resolve();
    return db.collection('games').doc(gameId).collection('actions').doc(gid).delete();
  }

  // ── 本機模式：同一台電腦的多分頁同步（老師自己用一台筆電開多個分頁測試）──
  var localQueue = [];
  var bc = null;
  function initChannel(id) {
    if (typeof BroadcastChannel === 'undefined') return null;
    try {
      bc = new BroadcastChannel('techisland:' + id);
      bc.onmessage = function (ev) {
        var m = ev.data;
        if (m.kind === 'action') localQueue.push(m.payload);
        else if (m.kind === 'state' && stateCb) stateCb(m.payload);
      };
    } catch (e) { bc = null; }
    return bc;
  }
  var stateCb = null;
  function onLocalState(cb) { stateCb = cb; }
  function broadcastState(state) {
    // ⚠️ 雲端模式時不要再用 BroadcastChannel 廣播。
    // 兩個來源同時推狀態，序號會互相擋掉，造成平板收不到最新畫面。
    if (mode === 'firebase') return;
    if (bc) { try { bc.postMessage({ kind: 'state', payload: JSON.parse(JSON.stringify(state)) }); } catch (e) {} }
  }
  function drainLocalQueue() { var q = localQueue; localQueue = []; return q; }

  /** 雲端資料的檔名＝場次編號，全世界不會撞 */
  function makeGameId(code) {
    return 'techisland_' + String(code);
  }

  // ─────────────────────────────────────────
  // 房間代碼
  // 為什麼需要：如果用「班級＋存檔槽」當房間識別，兩位老師都選「智班槽1」就會撞在一起，
  // 兩班學生會連到同一場遊戲、資料互相蓋掉。改用每場獨立的 6 位數代碼就不會撞。
  // ─────────────────────────────────────────
  /**
   * 開新遊戲時：抽一組沒有人用過的編號。
   * 6 位數有 90 萬組，抽到別人用過的就再抽，最多重試 8 次。
   */
  function reserveCode(tries) {
    tries = tries || 0;
    var code = makeCode();
    if (mode !== 'firebase' || !db || tries >= 8) return Promise.resolve(code);
    return db.collection('rooms').doc(code).get().then(function (doc) {
      return doc.exists ? reserveCode(tries + 1) : code;
    }).catch(function () { return code; });
  }

  /**
   * 老師端：把這一場登記到雲端，學生輸入編號才查得到。
   * 續玩時用同一組編號，所以同一個班整學期輸入的號碼都一樣。
   */
  function openRoom(code, info) {
    if (mode !== 'firebase' || !db) return Promise.resolve(String(code));
    return db.collection('rooms').doc(String(code)).set({
      gameId: makeGameId(code),
      groups: (info && info.groups) || 0,
      createdAt: (info && info.createdAt) || Date.now(),
      lastSeen: Date.now(),
      host: uid()
    }).then(function () { return String(code); });
  }

  /** 老師端：告訴雲端「這一場還在進行」，學生端才知道現在連得上 */
  function touchRoom(code) {
    if (mode !== 'firebase' || !db || !code) return Promise.resolve();
    return db.collection('rooms').doc(String(code))
             .set({ lastSeen: Date.now(), host: uid() }, { merge: true })
             .catch(function () {});
  }

  /** 平板端：用編號查這一場 */
  function findRoom(code) {
    if (mode !== 'firebase' || !db) {
      // 本機模式：沒有雲端可查，直接用編號當房間 id（同一台電腦多分頁測試用）
      return Promise.resolve({ gameId: 'local_' + code, local: true, live: true });
    }
    return db.collection('rooms').doc(String(code)).get().then(function (doc) {
      if (!doc.exists) return null;
      var d = doc.data();
      // 老師沒開著的舊場次不要讓學生連進去，否則畫面會卡在那裡不動
      d.live = (Date.now() - (d.lastSeen || d.createdAt || 0)) < ROOM_ALIVE_MS;
      return d;
    });
  }

  /** 老師端換一台電腦時：直接從雲端把上次的進度撈回來 */
  function loadCloud(code) {
    if (!db) return Promise.resolve(null);
    return db.collection('games').doc(makeGameId(code)).get().then(function (doc) {
      return doc.exists ? doc.data() : null;
    }).catch(function () { return null; });
  }

  /** 診斷用：把內部狀態挖出來，方便查「為什麼沒送到」這類問題 */
  function debugState() {
    return { mode: mode, gameId: gameId, hasDb: !!db,
             hasChannel: !!bc, channelName: bc ? bc.name : null,
             queueLength: localQueue.length };
  }

  global.STORE = {
    _debug: debugState,
    makeCode: makeCode, reserveCode: reserveCode,
    listSaves: listSaves, save: saveLocal, load: loadLocal,
    deleteSave: deleteSave, resetAll: resetAll, loadCloud: loadCloud,
    firebaseReady: firebaseReady, initFirebase: initFirebase, uid: uid,
    setWriteErrorHandler: setWriteErrorHandler,
    setMode: setMode, getMode: getMode, makeGameId: makeGameId,
    pushState: pushState, watchState: watchState,
    initChannel: initChannel, onLocalState: onLocalState, broadcastState: broadcastState,
    openRoom: openRoom, touchRoom: touchRoom, findRoom: findRoom,
    sendAction: sendAction, watchActions: watchActions, clearAction: clearAction,
    drainLocalQueue: drainLocalQueue
  };
})(typeof window !== 'undefined' ? window : globalThis);
