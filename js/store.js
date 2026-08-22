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

  var CLASSES = ['智', '仁', '勇', '信', '義', '和', '平', '誠'];
  var SLOTS = [1, 2, 3];
  var LS_PREFIX = 'techisland:';

  var mode = 'local';
  var db = null, gameId = null, unsub = null, actionUnsub = null;

  // ── Firebase 設定 ──
  // 設定值放在 js/firebase-config.js（Helen 建立專案後填那個檔案就好，不用動這裡）
  // ⚠️ config 本來就設計為可公開，安全靠 Firestore 規則把關。
  function cfgOf() { return global.FIREBASE_CONFIG || null; }

  function key(classId, slot) { return LS_PREFIX + classId + ':' + slot; }

  /** 列出所有存檔槽的摘要 */
  function listSaves() {
    var out = [];
    CLASSES.forEach(function (c) {
      SLOTS.forEach(function (s) {
        var raw = localStorage.getItem(key(c, s));
        if (!raw) { out.push({ classId: c, slot: s, empty: true }); return; }
        try {
          var st = JSON.parse(raw);
          out.push({
            classId: c, slot: s, empty: false,
            round: st.round, maxRounds: st.maxRounds,
            groups: Object.keys(st.players).length,
            savedAt: st._savedAt || null
          });
        } catch (e) { out.push({ classId: c, slot: s, empty: true, broken: true }); }
      });
    });
    return out;
  }

  function saveLocal(state) {
    state._savedAt = new Date().toISOString();
    try {
      localStorage.setItem(key(state.classId, state.slot), JSON.stringify(state));
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: '存檔失敗：' + e.message };
    }
  }

  function loadLocal(classId, slot) {
    var raw = localStorage.getItem(key(classId, slot));
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function clearSlot(classId, slot) {
    localStorage.removeItem(key(classId, slot));
  }

  /** ⚠️ 一鍵重置：只給換屆用，要密碼 + 二次確認 */
  function resetAll() {
    CLASSES.forEach(function (c) { SLOTS.forEach(function (s) { clearSlot(c, s); }); });
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

  function setMode(m, id) { mode = m; gameId = id || gameId; }
  function getMode() { return mode; }

  /** 老師端：把整份狀態推上去（一次寫入） */
  function pushState(state) {
    if (mode !== 'firebase' || !db) return Promise.resolve();
    return db.collection('games').doc(gameId)
      .set(JSON.parse(JSON.stringify(state)))
      .catch(function (e) { console.warn('[STORE] 寫入失敗：', e.message); });
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
    if (bc) { try { bc.postMessage({ kind: 'state', payload: JSON.parse(JSON.stringify(state)) }); } catch (e) {} }
  }
  function drainLocalQueue() { var q = localQueue; localQueue = []; return q; }

  function makeGameId(classId, slot) {
    return 'techisland_' + classId + '_' + slot;
  }

  global.STORE = {
    CLASSES: CLASSES, SLOTS: SLOTS,
    listSaves: listSaves, save: saveLocal, load: loadLocal,
    clearSlot: clearSlot, resetAll: resetAll,
    firebaseReady: firebaseReady, initFirebase: initFirebase,
    setMode: setMode, getMode: getMode, makeGameId: makeGameId,
    pushState: pushState, watchState: watchState,
    initChannel: initChannel, onLocalState: onLocalState, broadcastState: broadcastState,
    sendAction: sendAction, watchActions: watchActions, clearAction: clearAction,
    drainLocalQueue: drainLocalQueue
  };
})(typeof window !== 'undefined' ? window : globalThis);
