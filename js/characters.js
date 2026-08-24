/* 科技島大富翁 — 22 位科學家角色與專屬卡
 * 每位角色每 10 輪自動獲得一張自己的專屬卡（CFG.charCardEvery）
 */
(function (global) {
  'use strict';

  // id 對應頭像檔名 images/characters/char_<num>_<id>.png
  var CHARACTERS = [
    { num: 1,  id: 'newton',     name: '牛頓',      card: 'apple',    emoji: '🍎', color: '#ef4444' },
    { num: 2,  id: 'archimedes', name: '阿基米德',  card: 'float',    emoji: '🛟', color: '#0ea5e9' },
    { num: 3,  id: 'hooke',      name: '虎克',      card: 'bounce',   emoji: '↩️', color: '#f97316' },
    { num: 4,  id: 'galileo',    name: '伽利略',    card: 'observe',  emoji: '🔭', color: '#8b5cf6' },
    { num: 5,  id: 'pascal',     name: '帕斯卡',    card: 'transfer', emoji: '🎭', color: '#a855f7' },
    { num: 6,  id: 'boyle',      name: '波以耳',    card: 'compress', emoji: '🗜️', color: '#14b8a6' },
    { num: 7,  id: 'watt',       name: '瓦特',      card: 'engine',   emoji: '🚂', color: '#64748b' },
    { num: 8,  id: 'faraday',    name: '法拉第',    card: 'induct',   emoji: '📡', color: '#22c55e' },
    { num: 9,  id: 'ohm',        name: '歐姆',      card: 'insulate', emoji: '🛡️', color: '#3b82f6' },
    { num: 10, id: 'ampere',     name: '安培',      card: 'blackout', emoji: '⚡', color: '#eab308' },
    { num: 11, id: 'joule',      name: '焦耳',      card: 'overheat', emoji: '🔥', color: '#dc2626' },
    { num: 12, id: 'edison',     name: '愛迪生',    card: 'massprod', emoji: '🏭', color: '#f59e0b' },
    { num: 13, id: 'tesla',      name: '特斯拉',    card: 'teleport', emoji: '🌀', color: '#06b6d4' },
    { num: 14, id: 'lavoisier',  name: '拉瓦節',    card: 'equalize', emoji: '🔄', color: '#ec4899' },
    { num: 15, id: 'dalton',     name: '道耳頓',    card: 'demolish', emoji: '💥', color: '#78716c' },
    { num: 16, id: 'mendeleev',  name: '門得列夫',  card: 'predict',  emoji: '🔮', color: '#7c3aed' },
    { num: 17, id: 'thomson',    name: '湯木生',    card: 'swap',     emoji: '🔀', color: '#0891b2' },
    { num: 18, id: 'rutherford', name: '拉塞福',    card: 'pierce',   emoji: '👻', color: '#94a3b8' },
    { num: 19, id: 'curie',      name: '居禮夫人',  card: 'radiate',  emoji: '☢️', color: '#84cc16' },
    { num: 20, id: 'avogadro',   name: '亞佛加厥',  card: 'twindice', emoji: '🎲', color: '#f472b6' },
    { num: 21, id: 'lee',        name: '李遠哲',    card: 'copycard', emoji: '🧬', color: '#10b981' },
    { num: 22, id: 'wu',         name: '吳健雄',    card: 'reverse',  emoji: '🎰', color: '#f43f5e' }
  ];

  CHARACTERS.forEach(function (c) {
    c.avatar = 'images/characters/char_' + (c.num < 10 ? '0' : '') + c.num + '_' + c.id + '.png';
  });

  function byId(id) {
    for (var i = 0; i < CHARACTERS.length; i++) if (CHARACTERS[i].id === id) return CHARACTERS[i];
    return null;
  }

  global.CHARACTERS = CHARACTERS;
  global.charById = byId;
})(typeof window !== 'undefined' ? window : globalThis);
