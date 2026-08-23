/* 科技島大富翁 — 地圖資料與路網
 * 52 格主環 + 3 格海外支線 + 6 格山區（三條橫貫公路）= 61 格
 * 數值依據：數值設定.md
 */
(function (global) {
  'use strict';

  // 色系定義（同色系集滿 → 過路費 ×2）
  var COLORS = {
    ic:   { name: 'IC 設計',   hex: '#3b82f6' },
    fab:  { name: '晶圓製造',  hex: '#10b981' },
    mem:  { name: '記憶體',    hex: '#f59e0b' },
    pkg:  { name: '封裝測試',  hex: '#f97316' },
    sys:  { name: '系統組裝',  hex: '#ef4444' },
    opt:  { name: '光電工控',  hex: '#a855f7' },
    tel:  { name: '電信',      hex: '#06b6d4' },
    ovs:  { name: '海外廠',    hex: '#6366f1' }
  };

  // 格子型態
  // land 買地 / shop 創投商店 / bank 銀行 / subsidy 國科會補助 / chest 寶箱
  // packet 點數包 / patent 專利局 / news 新聞快報 / god 產業風向 / tax 國稅局
  // pool 政府補助池 / audit 稽查 / jail 檢調約談所 / hosp 醫院 / airport 機場
  // fork 岔路口 / mountain 山區

  function L(color, price, name, place) {
    return { type: 'land', color: color, price: price, name: name, place: place };
  }
  function F(type, name, place) {
    return { type: type, name: name, place: place || '' };
  }

  var CELLS = [
    /* 00 */ F('god', '產業風向', '台北101'),
    /* 01 */ L('tel', 2800, '中華電信', '台北'),
    /* 02 */ L('tel', 2200, '台灣大哥大', '台北'),
    /* 03 */ L('sys', 1200, '和碩', '內湖'),
    /* 04 */ L('sys', 2600, '華碩', '內湖'),
    /* 05 */ L('opt', 1600, '研華', '汐止'),
    /* 06 */ F('patent', '專利局', '南港'),
    /* 07 */ L('sys', 5800, '鴻海', '土城'),
    /* 08 */ L('sys', 2400, '廣達', '林口'),
    /* 09 */ F('airport', '桃園機場', '桃園'),          // 岔路：北橫 / 海外支線
    /* 10 */ L('mem', 1300, '華邦電', '桃園'),
    /* 11 */ F('shop', '創投商店', '新竹'),
    /* 12 */ L('ic', 1000, '聯詠', '竹北'),
    /* 13 */ L('ic', 1400, '瑞昱', '竹科'),
    /* 14 */ L('ic', 4500, '聯發科', '竹科'),
    /* 15 */ F('chest', '機會寶箱', '竹科'),
    /* 16 */ L('fab', 1600, '力積電', '竹科'),
    /* 17 */ L('fab', 2200, '聯電', '竹科'),
    /* 18 */ L('fab', 6000, '台積電', '竹科'),
    /* 19 */ L('mem', 1500, '旺宏', '竹科'),
    /* 20 */ L('mem', 2000, '群聯', '苗栗'),
    /* 21 */ F('shop', '創投商店', '苗栗'),
    /* 22 */ F('fork', '中橫岔路口', '台中'),           // 岔路：中橫
    /* 23 */ L('opt', 4200, '大立光', '台中'),
    /* 24 */ L('opt', 3600, '台達電', '中科'),
    /* 25 */ F('god', '產業風向', '彰化'),
    /* 26 */ L('sys', 1400, '緯創', '彰化'),
    /* 27 */ F('bank', '銀行', '雲林'),
    /* 28 */ L('sys', 1200, '仁寶', '嘉義'),
    /* 29 */ F('shop', '創投商店', '嘉義'),
    /* 30 */ L('pkg', 5000, '南科先進封裝', '台南'),
    /* 31 */ L('mem', 1800, '南亞科', '台南'),
    /* 32 */ F('fork', '南橫岔路口', '台南'),           // 岔路：南橫
    /* 33 */ L('pkg', 3800, '日月光', '高雄'),
    /* 34 */ L('pkg', 1800, '力成', '高雄'),
    /* 35 */ F('tax', '國稅局', '屏東'),
    /* 36 */ F('audit', '稽查', '屏東'),
    /* 37 */ F('jail', '檢調約談所', '墾丁'),
    /* 38 */ F('fork', '南橫岔路口', '台東'),           // 岔路：南橫另一端
    /* 39 */ F('god', '產業風向', '台東'),
    /* 40 */ F('subsidy', '國科會補助', '花蓮'),
    /* 41 */ F('pool', '政府補助池', '太魯閣'),         // 岔路：中橫另一端
    /* 42 */ F('hosp', '花蓮慈濟醫院', '花蓮'),
    /* 43 */ F('chest', '機會寶箱', '花蓮'),
    /* 44 */ F('fork', '蘇花／北橫岔路口', '蘇澳'),     // 岔路：北橫另一端
    /* 45 */ L('tel', 2000, '遠傳', '宜蘭'),
    /* 46 */ F('patent', '專利局', '宜蘭'),
    /* 47 */ F('shop', '創投商店', '宜蘭'),
    /* 48 */ F('subsidy', '國科會補助', '基隆'),
    /* 49 */ F('bank', '銀行', '基隆'),
    /* 50 */ F('news', '新聞快報', '基隆'),
    /* 51 */ F('shop', '創投商店', '台北'),
    // ── 海外支線（從桃園機場進入，單向繞回）──
    /* 52 */ L('ovs', 4800, '日本熊本廠', '海外'),
    /* 53 */ L('ovs', 5200, '德國德勒斯登廠', '海外'),
    /* 54 */ L('ovs', 5500, '美國亞利桑那廠', '海外'),
    // ── 山區（三條橫貫公路，沒有地可買）──
    /* 55 */ F('chest', '北橫 巴陵', '桃園'),
    /* 56 */ F('subsidy', '北橫 棲蘭', '宜蘭'),
    /* 57 */ F('packet', '中橫 梨山', '台中'),
    /* 58 */ F('chest', '中橫 合歡山', '南投'),
    /* 59 */ F('subsidy', '南橫 梅山', '高雄'),
    /* 60 */ F('packet', '南橫 埡口', '台東')
  ];

  var RING = 52;          // 主環格數（0~51）

  // ── 路網 ──
  // 主環單向前進；三條橫貫公路雙向通行；海外支線單向。
  // 移動規則：可以走到相鄰任一格，但不能立刻走回剛剛來的那一格。
  var ADJ = {};
  for (var i = 0; i < RING; i++) ADJ[i] = [(i + 1) % RING];
  for (var j = RING; j < CELLS.length; j++) ADJ[j] = [];

  function link2(a, b) { ADJ[a].push(b); ADJ[b].push(a); }

  link2(9, 55); link2(55, 56); link2(56, 44);      // 北橫：桃園 ⇄ 蘇澳
  link2(22, 57); link2(57, 58); link2(58, 41);     // 中橫：台中 ⇄ 太魯閣
  link2(32, 59); link2(59, 60); link2(60, 38);     // 南橫：台南 ⇄ 台東
  ADJ[9].push(52); ADJ[52] = [53]; ADJ[53] = [54]; ADJ[54] = [10];  // 海外支線（單向）

  var FORKS = Object.keys(ADJ).filter(function (k) { return ADJ[k].length > 1; }).map(Number);

  // 同色系索引
  var SAME_COLOR = {};
  CELLS.forEach(function (c, idx) {
    if (c.type !== 'land') return;
    SAME_COLOR[idx] = CELLS.map(function (d, k) {
      return (d.type === 'land' && d.color === c.color) ? k : -1;
    }).filter(function (k) { return k >= 0; });
  });

  // ── 數值公式（數值設定.md）──
  var RENT_RATE = 0.20;          // 空地過路費 = 地價 × 20%
  var UPGRADE_RATE = 2.00;       // 每級蓋廠費 = 地價 × 200%
  var LEVEL_MULT = [1, 3, 6, 10, 16, 25];
  // 等級名稱要通用：地圖上有電信、IC 設計、系統組裝等各種公司，
  // 不是每一家都是晶圓廠，所以不能用「晶圓廠」當最高級的名字。
  var LEVEL_NAME = ['空地（未開發）', '① 研發中心', '② 小型工廠', '③ 大型工廠', '④ 企業總部', '⑤ 產業龍頭'];

  function upgradeCost(idx) { return Math.round(CELLS[idx].price * UPGRADE_RATE); }

  /** 過路費（不含神明加成，那部分在 engine 處理） */
  function baseRent(idx, level, ownerHasFullColor) {
    var r = CELLS[idx].price * RENT_RATE * LEVEL_MULT[level];
    if (ownerHasFullColor) r *= 2;
    return Math.round(r);
  }

  /** 這塊地目前的現值（買地 + 已投入的建築） */
  function landValue(idx, level) {
    return CELLS[idx].price + upgradeCost(idx) * level;
  }

  // ── 開局隨機起始位置：主環切 N 段，每組在自己那段隨機一格 ──
  var BAD_START = { 36: 1, 37: 1, 42: 1 };   // 稽查、檢調、醫院不能當起始格
  function randomStarts(n, rnd) {
    rnd = rnd || Math.random;
    var seg = RING / n, out = [];
    for (var g = 0; g < n; g++) {
      var idx, tries = 0;
      do {
        idx = Math.floor(g * seg + rnd() * seg) % RING;
        tries++;
      } while ((BAD_START[idx] || out.indexOf(idx) >= 0) && tries < 60);
      out.push(idx);
    }
    return out;
  }

  global.BOARD = {
    CELLS: CELLS, RING: RING, ADJ: ADJ, FORKS: FORKS, COLORS: COLORS,
    SAME_COLOR: SAME_COLOR, LEVEL_MULT: LEVEL_MULT, LEVEL_NAME: LEVEL_NAME,
    RENT_RATE: RENT_RATE, UPGRADE_RATE: UPGRADE_RATE,
    upgradeCost: upgradeCost, baseRent: baseRent, landValue: landValue,
    randomStarts: randomStarts,
    JAIL: 37, HOSP: 42
  };
})(typeof window !== 'undefined' ? window : globalThis);
