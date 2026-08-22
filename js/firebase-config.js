/* 科技島大富翁 — Firebase 設定
 *
 * 專案：tech-island-monopoly（2026-08-22 建立，與其他專案分開，
 * 完全不會影響煉金學園與我的科技業之路）
 *
 * ⚠️ 這段設定本來就設計為可公開（Google 官方說明），放在 GitHub 上沒關係。
 * 真正的安全靠 Firestore 安全規則把關 —— 規則內容見 firestore.rules。
 *
 * ⚠️【還沒確認】firestore.rules 在 2026-08-22～23 又改了三次
 *   （主機綁定 host、到期日延到 2028-08-31、換電腦門檻 6 小時→10 分鐘），
 *   這些改動**尚未確認是否已貼到 Firebase 主控台發布**。
 *   本地檔案寫得再嚴，沒發布就等於沒有。發布後請把這段註解改掉。
 */
window.FIREBASE_CONFIG = {
  apiKey: 'AIzaSyD_GeNzfsXOP0hljJ4LcuKErgc1vmjuYJM',
  authDomain: 'tech-island-monopoly.firebaseapp.com',
  projectId: 'tech-island-monopoly',
  storageBucket: 'tech-island-monopoly.firebasestorage.app',
  messagingSenderId: '321154661178',
  appId: '1:321154661178:web:a92b083cbfbf4c8d796e03'
};
