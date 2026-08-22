/* 科技島大富翁 — 卡片與道具
 * 分兩套系統（照大富翁4）：
 *   道具 tool ── 放到地圖上、影響「移動」
 *   卡片 card ── 影響「錢、地產、狀態」
 * 另有 22 張角色專屬卡（char），每 5 輪自動發一張給該角色
 *
 * needTarget: null | 'player' | 'cell' | 'ownLand' | 'enemyLand' | 'color'
 * timing: 'anytime'（自己的行動階段）| 'onPay'（被收過路費時）| 'onQuestion'（答題階段）
 */
(function (global) {
  'use strict';

  function C(o) { o.kind = o.kind || 'card'; o.needTarget = o.needTarget || null;
                  o.timing = o.timing || 'anytime'; return o; }

  // ── 四大道具（開局隨機發 3 張）──
  var TOOLS = [
    C({ id: 'barrier', kind: 'tool', name: '工安圍籬', emoji: '🚧', cost: 70,
        needTarget: 'cell',
        desc: '在路上任一格放置圍籬。走到這一格的人強制停下，該輪不再前進。',
        when: '自己的行動階段' }),
    C({ id: 'robot', kind: 'tool', name: '巡檢機器人', emoji: '🤖', cost: 90,
        desc: '清除前方 10 格內的所有障礙——圍籬、勒索病毒，連好神壞神都一起清掉。',
        when: '自己的行動階段' }),
    C({ id: 'virus', kind: 'tool', name: '勒索病毒', emoji: '💣', cost: 120,
        needTarget: 'player',
        desc: '感染指定對手，倒數 5 輪後爆炸。中毒者移動時經過的第一個玩家會接手病毒（倒數不重置）。爆炸時該位置前後各 2 格內廠房降 1 級、中毒者停機一輪。',
        when: '自己的行動階段' }),
    C({ id: 'dice', kind: 'tool', name: '良率控制器', emoji: '🎲', cost: 160,
        desc: '這一輪不用擲骰，自己指定要走幾步（2～12）。',
        when: '擲骰之前' })
  ];

  // ── 公共卡片（創投商店隨機陳列 10 張，一次買 1 張）──
  var CARDS = [
    C({ id: 'observe', name: '觀測卡', emoji: '🔭', cost: 20,
        desc: '看光全部人的現金、存款、資產與手牌，持續到本輪結束。' }),
    C({ id: 'induct', name: '感應卡', emoji: '📡', cost: 30, timing: 'onQuestion',
        desc: '偷看下一題的正確答案。', when: '答題階段' }),
    C({ id: 'license', name: '技術授權卡', emoji: '📄', cost: 40, timing: 'onPay',
        desc: '免付一次過路費。', when: '被收過路費時' }),
    C({ id: 'brownout', name: '跳電卡', emoji: '⚡', cost: 50, needTarget: 'player',
        desc: '指定一組，他下一輪的所有收益減半。' }),
    C({ id: 'pardon', name: '免罪卡', emoji: '🎫', cost: 60,
        desc: '抵銷一次「被押去檢調約談所」或「被斷電卡停機」。手上有就自動生效。',
        when: '自動觸發' }),
    C({ id: 'poach', name: '挖角卡', emoji: '🎯', cost: 80, needTarget: 'enemyLand',
        desc: '搶走對手一塊地這一輪的收益，直接進自己口袋。' }),
    C({ id: 'bailout', name: '政府紓困卡', emoji: '💵', cost: 90,
        desc: '立刻獲得 $20,000。' }),
    C({ id: 'surge', name: '訂單暴增卡', emoji: '📈', cost: 100,
        desc: '這一輪自己收到的過路費全部 ×2。' }),
    C({ id: 'massprod', name: '量產卡', emoji: '🏭', cost: 110, needTarget: 'ownLand',
        desc: '指定自己的一塊地，免費升一級（不用付蓋廠費，也不用踩到）。' }),
    C({ id: 'alliance', name: '同盟卡', emoji: '🤝', cost: 120, needTarget: 'player',
        desc: '與指定對手結盟 3 輪，期間互相不收過路費。' }),
    C({ id: 'demolish', name: '拆廠卡', emoji: '💥', cost: 130, needTarget: 'enemyLand',
        desc: '指定對手的一塊地，強制降一級。' }),
    C({ id: 'quake', name: '地震卡', emoji: '🌊', cost: 140, needTarget: 'color',
        desc: '指定一個色系園區，該園區所有廠房停產一輪（該輪不能收過路費）。' }),
    C({ id: 'blackout', name: '斷電卡', emoji: '🔌', cost: 180, needTarget: 'player',
        desc: '指定一組，停機一輪不能行動（對方有免罪卡可抵銷）。' }),
    C({ id: 'equalize', name: '均富卡', emoji: '🔄', cost: 200,
        desc: '全體玩家的「現金」平分。⚠️ 只平分現金，不動銀行存款——想反制就要提早把錢存進銀行。' })
  ];

  // ── 角色專屬卡（每 5 輪自動發一張）──
  var CHAR_CARDS = [
    C({ id: 'apple', name: '落地卡', emoji: '🍎', owner: '牛頓', needTarget: 'player',
        desc: '指定一組，他下一輪的骰點減半（無條件捨去）。' }),
    C({ id: 'float', name: '浮起卡', emoji: '🛟', owner: '阿基米德',
        desc: '現金為負時使用，債務一次歸零。' }),
    C({ id: 'bounce', name: '彈回卡', emoji: '↩️', owner: '虎克', timing: 'onPay',
        desc: '這次付出去的過路費，全額退回自己口袋。', when: '被收過路費時' }),
    C({ id: 'observe', name: '觀測卡', emoji: '🔭', owner: '伽利略',
        desc: '看光全部人的現金、存款、資產與手牌。' }),
    C({ id: 'transfer', name: '嫁禍卡', emoji: '🎭', owner: '帕斯卡', needTarget: 'player',
        desc: '把自己身上的負面狀態（勒索病毒、壞神附身、停機）轉給指定對手。' }),
    C({ id: 'compress', name: '壓縮卡', emoji: '🗜️', owner: '波以耳', needTarget: 'player',
        desc: '把指定對手往後推 5 格。' }),
    C({ id: 'engine', name: '引擎卡', emoji: '🚂', owner: '瓦特',
        desc: '接下來三輪，自己的骰點都 +2。' }),
    C({ id: 'induct', name: '感應卡', emoji: '📡', owner: '法拉第', timing: 'onQuestion',
        desc: '偷看下一題的正確答案。', when: '答題階段' }),
    C({ id: 'insulate', name: '絕緣卡', emoji: '🛡️', owner: '歐姆',
        desc: '擋下對手對你使用的下一張卡片或道具。手上有就自動生效。', when: '自動觸發' }),
    C({ id: 'blackout', name: '斷電卡', emoji: '🔌', owner: '安培', needTarget: 'player',
        desc: '指定一組，停機一輪不能行動。' }),
    C({ id: 'overheat', name: '過熱卡', emoji: '🔥', owner: '焦耳',
        desc: '這一輪的骰點 ×2。', when: '擲骰之前' }),
    C({ id: 'massprod', name: '量產卡', emoji: '🏭', owner: '愛迪生', needTarget: 'ownLand',
        desc: '指定自己的一塊地，免費升一級。' }),
    C({ id: 'teleport', name: '瞬移卡', emoji: '🌀', owner: '特斯拉', needTarget: 'cell',
        desc: '立刻移動到地圖上任何一格（會觸發該格效果）。' }),
    C({ id: 'equalize', name: '均富卡', emoji: '🔄', owner: '拉瓦節',
        desc: '全體玩家的「現金」平分。只平分現金，不動銀行存款。' }),
    C({ id: 'demolish', name: '拆廠卡', emoji: '💥', owner: '道耳頓', needTarget: 'enemyLand',
        desc: '指定對手的一塊地，強制降一級。' }),
    C({ id: 'predict', name: '預測卡', emoji: '🔮', owner: '門得列夫', timing: 'onQuestion',
        desc: '這一輪換掉一題不想答的題目，重新抽一題。', when: '答題階段' }),
    C({ id: 'swap', name: '換位卡', emoji: '🔀', owner: '湯木生', needTarget: 'player',
        desc: '和指定對手交換位置。' }),
    C({ id: 'pierce', name: '穿透卡', emoji: '👻', owner: '拉塞福',
        desc: '這一輪踩到任何人的地都不用付過路費。' }),
    C({ id: 'radiate', name: '輻射卡', emoji: '☢️', owner: '居禮夫人', needTarget: 'cell',
        desc: '指定一格佈下輻射，三輪內誰踩到誰扣 $5,000。' }),
    C({ id: 'twindice', name: '雙骰卡', emoji: '🎲', owner: '亞佛加厥',
        desc: '這一輪擲兩次骰，走兩次的總和。', when: '擲骰之前' }),
    C({ id: 'copycard', name: '複製卡', emoji: '🧬', owner: '李遠哲',
        desc: '複製全場上一張被打出的卡片，立刻使用。' }),
    C({ id: 'reverse', name: '逆轉卡', emoji: '🎰', owner: '吳健雄',
        desc: '讓自己這一輪的骰子結果反轉（1↔6、2↔5、3↔4）。', when: '擲骰之後' })
  ];
  CHAR_CARDS.forEach(function (c) { c.kind = 'char'; c.cost = 0; });

  // 商店販售的品項 = 公共卡片 + 四大道具
  var SHOP_POOL = CARDS.concat(TOOLS);

  var ALL = {};
  TOOLS.concat(CARDS).forEach(function (c) { ALL[c.id] = c; });
  var CHAR_BY_ID = {};
  CHAR_CARDS.forEach(function (c) { CHAR_BY_ID[c.id] = c; });

  /** 取得卡片定義：先找角色專屬卡，再找公共卡／道具 */
  function get(id, isChar) {
    if (isChar && CHAR_BY_ID[id]) return CHAR_BY_ID[id];
    return ALL[id] || CHAR_BY_ID[id] || null;
  }

  /** 商店隨機陳列 N 張（不重複） */
  function shelf(n, rnd) {
    rnd = rnd || Math.random;
    var pool = SHOP_POOL.slice(), out = [];
    n = Math.min(n, pool.length);
    for (var i = 0; i < n; i++) {
      out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
    }
    return out;
  }

  global.CARDS = {
    TOOLS: TOOLS, CARDS: CARDS, CHAR_CARDS: CHAR_CARDS, SHOP_POOL: SHOP_POOL,
    get: get, shelf: shelf, HAND_LIMIT: 8
  };
})(typeof window !== 'undefined' ? window : globalThis);
