/* 科技島大富翁 — 最小 service worker
 * 只為了讓瀏覽器把網頁當成「可安裝的 App」（加到主畫面後開啟就是滿版）。
 * 刻意「不攔截、不快取」任何請求：
 *   本專案的快取靠 ?v= 版本戳記管理（準備上傳.py 每次會換），
 *   如果這裡再做離線快取，很容易出現「畫面是新的但功能是舊的」那種很難查的問題。
 */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function () { /* 留空＝全部照常走網路 */ });
