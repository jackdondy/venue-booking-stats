// 预约记录采集：在页面中解析表格 DOM，按唯一键去重后写入 chrome.storage.local
(function () {
  if (window.__bookingStatsInjected) return;
  window.__bookingStatsInjected = true;

  var KEY = 'records';
  var RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
  var RE_TIME = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/;
  var RE_PAY = /^(已支付|未支付|已退款|支付中|退款中)$/;
  var RE_STATUS = /^(正常|已取消|已完成)$/;

  function cellText(td) {
    return (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // "19号 21:00-22:00,19号 21:00-22:00" -> 分钟数（多时段累加，跨零点按 +24h 处理）
  function toMinutes(text) {
    var m = 0, x;
    var re = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g;
    while ((x = re.exec(text))) {
      var s = (+x[1]) * 60 + (+x[2]);
      var e = (+x[3]) * 60 + (+x[4]);
      if (e <= s) e += 1440;
      m += (e - s);
    }
    return m;
  }

  // 按单元格内容特征识别列，避免依赖固定列序
  function parseRow(tr) {
    var tds = tr.children;
    if (!tds || tds.length < 6) return null;

    var no = '', venue = '', date = '', time = '', pay = '', status = '', amount = '';
    for (var i = 0; i < tds.length; i++) {
      if (tds[i].tagName !== 'TD') continue;
      var t = cellText(tds[i]);
      if (!t) continue;
      if (!date && RE_DATE.test(t)) { date = t; continue; }
      if (!time && RE_TIME.test(t)) { time = t; continue; }
      if (!pay && RE_PAY.test(t)) { pay = t; continue; }
      if (!status && RE_STATUS.test(t)) { status = t; continue; }
      if (!venue && /校区|馆|球|场/.test(t)) { venue = t; continue; }
      if (!no && /预约|D\d{6,}/.test(t)) { no = t; continue; }
      if (!amount && /元|￥|¥/.test(t)) { amount = t; }
    }

    if (!date || !time || !venue) return null;
    var minutes = toMinutes(time);
    if (minutes <= 0) return null;

    return {
      id: [no, venue, date, time].join('|'),
      no: no,
      venue: venue,
      date: date,
      month: date.slice(0, 7),
      time: time,
      minutes: minutes,
      pay: pay,
      status: status,
      amount: amount,
      url: location.href
    };
  }

  function scan() {
    var out = [];
    var trs = document.querySelectorAll('tr');
    for (var i = 0; i < trs.length; i++) {
      var r = parseRow(trs[i]);
      if (r) out.push(r);
    }
    return out;
  }

  function loadRecords() {
    return new Promise(function (res) {
      chrome.storage.local.get([KEY], function (o) { res(o[KEY] || []); });
    });
  }

  function saveRecords(list) {
    return new Promise(function (res) {
      chrome.storage.local.set({ records: list, updatedAt: Date.now() }, res);
    });
  }

  function merge(found) {
    return loadRecords().then(function (cur) {
      var map = {};
      cur.forEach(function (r) { map[r.id] = r; });
      var added = 0;
      found.forEach(function (r) {
        if (!map[r.id]) { map[r.id] = r; added++; }
      });
      var list = Object.keys(map).map(function (k) { return map[k]; });
      var done = added > 0 ? saveRecords(list) : Promise.resolve();
      return done.then(function () {
        return { found: found.length, added: added, total: list.length };
      });
    });
  }

  var POLL_MS = 3000;
  var catching = false;
  // 自动操作门控：只有用户在 popup 点「开始抓取」后才允许自动点「200 条/页」与「下一页」。
  // 打开页面时该值为 false，插件不会点击任何分页控件。
  var autoDrive = false;
  var observer = null;
  var pollTimer = null;
  var debounceTimer = null;
  var lastSig = '';

  // 自动把「条/页」切到 200，减少翻页次数（最多尝试 3 次，成功后不再触发）
  var PAGE_SIZE = '200 条/页';
  var sizeDone = false;
  var sizeBusy = false;
  var sizeTried = 0;

  function pageSizeIsSet() {
    var sel = document.querySelectorAll('.ivu-select-item-selected');
    for (var i = 0; i < sel.length; i++) {
      if (cellText(sel[i]) === PAGE_SIZE) return true;
    }
    return false;
  }

  function ensurePageSize() {
    if (!autoDrive) return; // 未点「开始抓取」前不自动切换每页条数
    if (sizeDone || sizeBusy || sizeTried >= 3) return;
    if (pageSizeIsSet()) { sizeDone = true; return; }
    var items = document.querySelectorAll('.ivu-select-item');
    for (var i = 0; i < items.length; i++) {
      if (cellText(items[i]) !== PAGE_SIZE) continue;
      sizeTried++;
      sizeBusy = true;
      var before = tableKey();
      items[i].click();
      // 等表格按新条数重新渲染完再算切换成功，之后才允许翻页
      waitTableReady(before, '', function () {
        sizeBusy = false;
        if (pageSizeIsSet()) {
          sizeDone = true;
          console.log('[预约统计] 每页条数已切换为 ' + PAGE_SIZE);
        }
      });
      return;
    }
  }

  // 自动翻页：依次点击「下一页」，直到按钮禁用（每页 200 条时通常 2~3 次）
  var pagerBusy = false;
  var pagerDone = false;
  var sawData = false; // 是否已在本页采到记录，避免表格还没渲染就误判「只有一页」
  var turns = 0;
  var MAX_TURNS = 100;

  // 只取真正的数据行（含 <td> 的行，排除表头）
  function dataRows() {
    var out = [];
    var trs = document.querySelectorAll('tr');
    for (var i = 0; i < trs.length; i++) {
      var c = trs[i].children;
      if (!c) continue;
      for (var j = 0; j < c.length; j++) {
        if (c[j].tagName === 'TD') { out.push(trs[i]); break; }
      }
    }
    return out;
  }

  // 表格指纹：数据行数 + 首行文本 + 末行文本。
  // 首行文本可保证「每页条数相同」时仍能识别换页（末行可能是恒定的合计行）
  function tableKey() {
    var rows = dataRows();
    if (!rows.length) return '0||';
    return rows.length + '|' + cellText(rows[0]) + '|' + cellText(rows[rows.length - 1]);
  }

  // 当前激活的页码（iView 分页），读不到时返回空串
  function activePageNo() {
    var el = document.querySelector('.ivu-page-item-active');
    return el ? cellText(el) : '';
  }

  // 判定「渲染完成」所需的连续稳定次数：约 6 × 250ms ≈ 1.5s
  var SETTLE_POLLS = 6;
  var WAIT_TIMEOUT = 15000;

  // 等待表格真正渲染完成：指纹相对点击前已变化，且此后连续多次保持不变；
  // 同时把「激活页码已改变」作为辅助信号。超时兜底，避免死等。
  function waitTableReady(beforeKey, beforePage, cb) {
    var t0 = Date.now();
    var last = tableKey();
    var stable = 0;
    (function tick() {
      var s = tableKey();
      if (s === last) stable++; else { stable = 1; last = s; }
      var pageNow = activePageNo();
      var moved = s !== beforeKey || (!!beforePage && !!pageNow && pageNow !== beforePage);
      var t = Date.now() - t0;
      if ((moved && stable >= SETTLE_POLLS) || t > WAIT_TIMEOUT || !catching) {
        if (t > WAIT_TIMEOUT && !(moved && stable >= SETTLE_POLLS)) {
          console.log('[预约统计] 等待表格渲染超时，按当前内容继续');
        }
        cb();
        return;
      }
      setTimeout(tick, 250);
    })();
  }

  function turnPage() {
    if (!autoDrive) return; // 未点「开始抓取」前不自动翻页
    if (pagerBusy || pagerDone || !catching || !sizeDone || !sawData) return;
    var b = document.querySelector('li.ivu-page-next');
    if (!b) return;
    if (b.className.indexOf('ivu-page-disabled') >= 0) {
      pagerDone = true;
      console.log('[预约统计] 已翻到最后一页，翻页 ' + turns + ' 次，采集结束');
      return;
    }
    if (turns >= MAX_TURNS) { pagerDone = true; return; }
    turns++;
    pagerBusy = true;
    var before = tableKey();
    var beforePage = activePageNo();
    lastSig = ''; // 保证新页面的数据必定重新采集
    b.click();
    waitTableReady(before, beforePage, function () {
      scanAndMerge().then(function () {
        pagerBusy = false;
        turnPage();
      });
    });
  }

  function scanAndMerge() {
    ensurePageSize();
    turnPage();
    var found = scan();
    if (!found.length) return Promise.resolve(null);
    sawData = true;
    var sig = found.map(function (r) { return r.id; }).sort().join(';');
    if (sig === lastSig) return Promise.resolve(null);
    lastSig = sig;
    return merge(found).then(function (st) {
      if (st.added > 0) {
        console.log('[预约统计] 本页 ' + st.found + ' 条，新增 ' + st.added + ' 条，累计 ' + st.total + ' 条');
      }
      return st;
    });
  }

  function scheduleScan() {
    if (!catching) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scanAndMerge, 800);
  }

  function start() {
    if (observer) return;
    catching = true;
    scheduleScan();
    // 仅在新增节点里含 tr 时才触发，降低无关变化带来的开销
    observer = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType === 1 && (n.tagName === 'TR' || (n.querySelector && n.querySelector('tr')))) {
            scheduleScan();
            return;
          }
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    // 兜底轮询，防止表格未触发 DOM 变化却已更新（如局部渲染）
    pollTimer = setInterval(scanAndMerge, POLL_MS);
    console.log('[预约统计] 已开始自动抓取');
  }

  function stop() {
    catching = false;
    clearTimeout(debounceTimer);
    if (observer) { observer.disconnect(); observer = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    console.log('[预约统计] 已暂停自动抓取');
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    if (changes.records && (!changes.records.newValue || !changes.records.newValue.length)) {
      lastSig = ''; // 数据被清空后允许重新采集
    }
    // 用户在 popup 点「开始抓取」：写入新的 drive 时间戳，开启自动采集 + 自动切 200 条/页 + 自动翻页
    if (changes.drive) {
      autoDrive = true;
      sizeDone = false;
      sizeBusy = false;
      sizeTried = 0;
      pagerBusy = false;
      pagerDone = false;
      turns = 0;
      sawData = false;
      lastSig = '';
      start();
      scanAndMerge();
      return;
    }
    if (changes.catching && changes.catching.newValue === false) {
      autoDrive = false;
      stop();
    }
  });

  // 打开页面时不自动抓取，也不点击任何分页控件；等待用户点击扩展中的「开始抓取」
  chrome.storage.local.get(['catching'], function (o) {
    if (o.catching === true) chrome.storage.local.set({ catching: false });
    console.log('[预约统计] 已就绪：点扩展中的「开始抓取」后才会自动切 200 条/页并翻页');
  });
})();
