var KEY = 'records';
var SITE = 'https://cgyy.buaa.edu.cn/venue/orders'; // 预约记录页
var $ = function (id) { return document.getElementById(id); };

function h2(m) { return Math.round(m / 60 * 100) / 100; }

// 场馆配色：按场馆排列顺序依次取色，与场馆名称内容无关
var VENUE_COLORS = ['#2d6cdf', '#ff9933', '#2ecc71', '#9b59b6', '#e74c3c', '#17a2b8',
  '#f1c40f', '#e67e22', '#1abc9c', '#8e44ad', '#3498db', '#95a5a6'];

// 从 a 到 b 补齐所有月份（含无记录月份）
function monthRange(a, b) {
  var out = [], p = a.split('-'), y = +p[0], m = +p[1];
  var q = b.split('-'), ey = +q[0], em = +q[1];
  while (y < ey || (y === ey && m <= em)) {
    out.push(y + '-' + (m < 10 ? '0' + m : m));
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

function getStore() {
  return new Promise(function (res) {
    chrome.storage.local.get([KEY, 'updatedAt', 'catching'], function (o) { res(o); });
  });
}

// 同步抓取开关的界面状态：默认未开始，点「开始抓取」后才自动切换每页条数并翻页
function setCatchingUI(on) {
  $('start').disabled = on;
  $('pause').disabled = !on;
  $('state').textContent = on ? '正在抓取' : '未开始';
  $('state').className = 'state' + (on ? '' : ' off');
}

function tip(msg, isErr) {
  var el = $('tip');
  el.textContent = msg;
  el.className = 'tip' + (isErr ? ' err' : '');
  el.style.display = 'block';
  clearTimeout(tip._t);
  tip._t = setTimeout(function () { el.style.display = 'none'; }, 4000);
}

// 已打开该站点则切过去，否则新开一个标签页
function openSite() {
  chrome.tabs.query({ url: SITE + '*' }, function (tabs) {
    if (tabs && tabs.length) {
      chrome.tabs.update(tabs[0].id, { active: true });
      chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      chrome.tabs.create({ url: SITE });
    }
  });
}

var S = { months: [], venues: [], on: new Set() };

function buildModel(all) {
  var recs = all.filter(function (r) {
    return (r.pay || '').indexOf('已支付') >= 0 && (r.status || '').indexOf('正常') >= 0;
  });

  var byVenue = {};
  var ms = {};
  recs.forEach(function (r) {
    var v = r.venue || '(未知场馆)';
    if (!byVenue[v]) byVenue[v] = { name: v, count: 0, mins: {} };
    byVenue[v].count++;
    byVenue[v].mins[r.month] = (byVenue[v].mins[r.month] || 0) + r.minutes;
    ms[r.month] = 1;
  });

  var keys = Object.keys(ms).sort();
  var months = keys.length ? monthRange(keys[0], keys[keys.length - 1]) : [];

  var venues = Object.keys(byVenue).map(function (k) { return byVenue[k]; });
  venues.forEach(function (v) {
    v.arr = months.map(function (m) { return v.mins[m] || 0; });
    v.total = v.arr.reduce(function (a, b) { return a + b; }, 0);
  });
  venues.sort(function (a, b) { return b.total - a.total; });
  venues.forEach(function (v, i) { v.color = VENUE_COLORS[i % VENUE_COLORS.length]; });

  return { all: all, recs: recs, months: months, venues: venues };
}

function buildButtons() {
  $('picker').innerHTML = S.venues.map(function (v, i) {
    var on = S.on.has(i);
    return '<button class="pick' + (on ? ' on' : '') + '" data-i="' + i + '"' +
      (on ? ' style="background:' + v.color + '"' : '') + '>' +
      '<i style="background:' + v.color + '"></i>' + v.name +
      '<span class="ct">' + v.count + ' 条</span></button>';
  }).join('');
}

function card(k, v) {
  return '<div class="card"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>';
}

function render() {
  buildButtons();

  var idx = Array.from(S.on).sort(function (a, b) { return a - b; });
  if (!idx.length) {
    $('empty').style.display = 'block';
    $('result').style.display = 'none';
    return;
  }
  $('empty').style.display = 'none';
  $('result').style.display = 'block';

  var months = S.months;
  var monthly = months.map(function () { return 0; });
  var totals = {}, cnt = 0, tot = 0;
  idx.forEach(function (i) {
    var v = S.venues[i], s = 0;
    for (var j = 0; j < months.length; j++) { monthly[j] += v.arr[j]; s += v.arr[j]; }
    totals[i] = s; cnt += v.count; tot += s;
  });

  var maxV = Math.max.apply(null, monthly);
  var peakJ = monthly.indexOf(maxV);

  $('cards').innerHTML =
    card('选中场馆', idx.length + ' 个') +
    card('记录数', cnt + ' 条') +
    card('总时长', h2(tot) + ' 小时') +
    card('月均时长', h2(tot / months.length) + ' 小时') +
    card('峰值月份', months[peakJ] + ' · ' + h2(maxV) + ' 小时');

  var h = '<div class="scroll"><div class="chart">';
  months.forEach(function (mo, j) {
    var tipTx = mo + ' 合计 ' + h2(monthly[j]) + ' 小时', segs = '';
    idx.forEach(function (i) {
      var v = S.venues[i].arr[j];
      if (v <= 0) return;
      tipTx += '\n' + S.venues[i].name + ' ' + h2(v) + ' 小时';
      segs += '<div class="seg" style="height:' + (maxV > 0 ? v * 100 / maxV : 0) + '%;background:' + S.venues[i].color + '"></div>';
    });
    h += '<div class="col" title="' + tipTx + '"><div class="stack">' + segs + '</div></div>';
  });
  h += '</div><div class="axis">';
  months.forEach(function (mo) { h += '<div class="lbl">' + mo + '</div>'; });
  h += '</div></div>';
  $('chart').innerHTML = h;

  var t = '<table><thead><tr><th>月份</th>';
  idx.forEach(function (i) { t += '<th style="text-align:right">' + S.venues[i].name + '</th>'; });
  t += '<th style="text-align:right">合计</th></tr></thead><tbody>';
  months.forEach(function (mo, j) {
    var sum = 0, row = '<tr><td>' + mo + '</td>';
    idx.forEach(function (i) {
      var v = S.venues[i].arr[j]; sum += v;
      row += '<td class="num' + (v === 0 ? ' zero' : '') + '">' + h2(v) + '</td>';
    });
    row += '<td class="num' + (sum === 0 ? ' zero' : '') + '"><b>' + h2(sum) + '</b></td></tr>';
    t += row;
  });
  t += '<tr><td><b>合计</b></td>';
  idx.forEach(function (i) { t += '<td class="num"><b>' + h2(totals[i]) + '</b></td>'; });
  t += '<td class="num"><b>' + h2(tot) + '</b></td></tr></tbody></table>';
  $('table').innerHTML = t;
}

// ---------- 导出为独立静态 HTML ----------
function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function buildExportHTML(m, all, updatedAt) {
  var data = {
    months: m.months,
    venues: m.venues.map(function (v) {
      return { name: v.name, color: v.color, count: v.count, arr: v.arr };
    })
  };
  // 转义 <，避免数据中的 "</script>" 提前闭合脚本标签
  var json = JSON.stringify(data).replace(/</g, '\\u003c');
  var last = m.months[m.months.length - 1];
  var sub = '筛选条件：状态含「已支付」且含「正常」<br>' +
    '共收录 ' + all.length + ' 条记录，命中 ' + m.recs.length + ' 条<br>' +
    '时间区间：' + m.months[0] + ' ~ ' + last + '，共 ' + m.months.length + ' 个月<br>' +
    '导出时间：' + new Date().toLocaleString() +
    (updatedAt ? '（最近采集 ' + new Date(updatedAt).toLocaleString() + '）' : '');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>场地预约时长统计</title>
<style>
*{box-sizing:border-box}
body{margin:0;padding:32px;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#f5f7fa;color:#1f2d3d}
h1{font-size:20px;margin:0 0 6px}
h2{font-size:15px;margin:0 0 14px;color:#2c3e50}
.sub{color:#8492a6;font-size:13px;margin-bottom:22px;line-height:1.7}
.cards{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:24px}
.card{background:#fff;border-radius:8px;padding:14px 20px;box-shadow:0 1px 4px rgba(0,0,0,.06);min-width:132px}
.card .k{font-size:12px;color:#8492a6}
.card .v{font-size:22px;font-weight:600;margin-top:4px}
.panel{background:#fff;border-radius:8px;padding:22px 24px 18px;box-shadow:0 1px 4px rgba(0,0,0,.06);margin-bottom:20px}
.scroll{overflow-x:auto}
.chart{display:flex;align-items:flex-end;gap:10px;height:300px;border-bottom:1px solid #dfe4ea;padding:0 4px;width:max-content;min-width:100%}
.col{flex:1 0 52px;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%}
.stack{display:flex;flex-direction:column-reverse;justify-content:flex-start;width:100%;max-width:56px;height:100%}
.seg{width:100%;box-shadow:inset 0 -1px 0 rgba(255,255,255,.45)}
.axis{display:flex;gap:10px;padding:8px 4px 0;width:max-content;min-width:100%}
.axis .lbl{flex:1 0 52px;text-align:center;font-size:11px;color:#8492a6;white-space:nowrap}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border-bottom:1px solid #eef1f5;padding:7px 10px;text-align:left}
th{background:#fafbfc;color:#5a6b7f;font-weight:600;white-space:nowrap}
td.num{text-align:right;font-variant-numeric:tabular-nums}
td.zero{color:#c8ccd4}
.tblwrap{overflow-x:auto;margin-top:22px}
.note{font-size:12px;color:#8492a6;margin-top:14px;line-height:1.7}
.picker{display:flex;gap:10px;flex-wrap:wrap}
.pick{display:inline-flex;align-items:center;gap:8px;padding:7px 14px;border:1px solid #d6dce5;background:#fff;border-radius:20px;cursor:pointer;font-size:13px;color:#5a6b7f;font-family:inherit;transition:all .15s}
.pick:hover{border-color:#a9b6c7}
.pick.on{color:#fff;border-color:transparent;box-shadow:0 1px 3px rgba(0,0,0,.12)}
.pick i{width:10px;height:10px;border-radius:50%;display:inline-block}
.pick.on i{background:#fff !important}
.pick .ct{font-size:11px;opacity:.7}
.acts{display:flex;gap:10px;margin:14px 0 20px}
.acts button{padding:6px 14px;border:1px solid #d6dce5;background:#fff;border-radius:6px;cursor:pointer;font-size:12px;color:#5a6b7f;font-family:inherit}
.acts button:hover{border-color:#a9b6c7;color:#2c3e50}
.empty{padding:48px 0;text-align:center;color:#a9b6c7;font-size:13px}
</style>
</head>
<body>
<h1>场地预约时长统计</h1>
<div class="sub">${sub}</div>
<div class="panel">
<h2>自选场馆合并统计</h2>
<div class="picker" id="picker"></div>
<div class="acts"><button id="all">全选</button><button id="none">清空</button></div>
<div class="empty" id="empty">请在上方选择至少一个场馆</div>
<div id="result">
<div class="cards" id="cards"></div>
<div id="chart"></div>
<div id="table" class="tblwrap"></div>
</div>
<div class="note">点击场馆按钮可多选/取消，选中后即时合并统计并显示直方图与明细表；鼠标悬停柱条可查看各场馆拆分。</div>
</div>
<script>
var DATA = ${json};
(function () {
  var MONTHS = DATA.months, VENUES = DATA.venues;
  var ON = VENUES.map(function () { return true; });

  function h2(mins) { return Math.round(mins / 60 * 100) / 100; }
  function card(k, v) { return '<div class="card"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>'; }

  function render() {
    document.getElementById('picker').innerHTML = VENUES.map(function (v, i) {
      var on = ON[i];
      return '<button class="pick' + (on ? ' on' : '') + '" data-i="' + i + '"' +
        (on ? ' style="background:' + v.color + '"' : '') + '>' +
        '<i style="background:' + v.color + '"></i>' + v.name +
        '<span class="ct">' + v.count + ' 条</span></button>';
    }).join('');

    var idx = [];
    ON.forEach(function (b, i) { if (b) idx.push(i); });
    var empty = document.getElementById('empty'), result = document.getElementById('result');
    if (!idx.length) { empty.style.display = 'block'; result.style.display = 'none'; return; }
    empty.style.display = 'none'; result.style.display = 'block';

    var monthly = MONTHS.map(function () { return 0; });
    var totals = {}, cnt = 0, tot = 0;
    idx.forEach(function (i) {
      var v = VENUES[i], s = 0;
      for (var j = 0; j < MONTHS.length; j++) { monthly[j] += v.arr[j]; s += v.arr[j]; }
      totals[i] = s; cnt += v.count; tot += s;
    });
    var maxV = Math.max.apply(null, monthly);
    var peakJ = monthly.indexOf(maxV);

    document.getElementById('cards').innerHTML =
      card('选中场馆', idx.length + ' 个') +
      card('记录数', cnt + ' 条') +
      card('总时长', h2(tot) + ' 小时') +
      card('月均时长', h2(tot / MONTHS.length) + ' 小时') +
      card('峰值月份', MONTHS[peakJ] + ' · ' + h2(maxV) + ' 小时');

    var h = '<div class="scroll"><div class="chart">';
    MONTHS.forEach(function (mo, j) {
      var tx = mo + ' 合计 ' + h2(monthly[j]) + ' 小时', segs = '';
      idx.forEach(function (i) {
        var v = VENUES[i].arr[j];
        if (v <= 0) return;
        tx += '\\n' + VENUES[i].name + ' ' + h2(v) + ' 小时';
        segs += '<div class="seg" style="height:' + (maxV > 0 ? v * 100 / maxV : 0) + '%;background:' + VENUES[i].color + '"></div>';
      });
      h += '<div class="col" title="' + tx.replace(/"/g, '&quot;') + '"><div class="stack">' + segs + '</div></div>';
    });
    h += '</div><div class="axis">';
    MONTHS.forEach(function (mo) { h += '<div class="lbl">' + mo + '</div>'; });
    h += '</div></div>';
    document.getElementById('chart').innerHTML = h;

    var t = '<table><thead><tr><th>月份</th>';
    idx.forEach(function (i) { t += '<th style="text-align:right">' + VENUES[i].name + '</th>'; });
    t += '<th style="text-align:right">合计</th></tr></thead><tbody>';
    MONTHS.forEach(function (mo, j) {
      var sum = 0, row = '<tr><td>' + mo + '</td>';
      idx.forEach(function (i) {
        var v = VENUES[i].arr[j]; sum += v;
        row += '<td class="num' + (v === 0 ? ' zero' : '') + '">' + h2(v) + '</td>';
      });
      row += '<td class="num' + (sum === 0 ? ' zero' : '') + '"><b>' + h2(sum) + '</b></td></tr>';
      t += row;
    });
    t += '<tr><td><b>合计</b></td>';
    idx.forEach(function (i) { t += '<td class="num"><b>' + h2(totals[i]) + '</b></td>'; });
    t += '<td class="num"><b>' + h2(tot) + '</b></td></tr></tbody></table>';
    document.getElementById('table').innerHTML = t;
  }

  document.getElementById('picker').addEventListener('click', function (e) {
    var b = e.target.closest('.pick');
    if (!b) return;
    ON[+b.getAttribute('data-i')] = !ON[+b.getAttribute('data-i')];
    render();
  });
  document.getElementById('all').addEventListener('click', function () {
    ON = VENUES.map(function () { return true; }); render();
  });
  document.getElementById('none').addEventListener('click', function () {
    ON = VENUES.map(function () { return false; }); render();
  });

  render();
})();
</script>
</body>
</html>`;
}

function exportHtml() {
  return getStore().then(function (o) {
    var all = o.records || [];
    var m = buildModel(all);
    if (!m.venues.length) { tip('暂无数据可导出，请先在预约记录页采集', true); return; }

    var html = buildExportHTML(m, all, o.updatedAt);
    var url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    var d = new Date();
    var name = '预约时长统计-' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '.html';

    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    tip('已导出 ' + name + '（' + m.recs.length + ' 条记录 / ' + m.venues.length + ' 个场馆）');
  });
}

function refresh() {
  return getStore().then(function (o) {
    setCatchingUI(o.catching === true);
    var all = o.records || [];
    var m = buildModel(all);

    // 已有界面时按场馆名保留用户的选择，避免实时刷新把勾选状态清空
    var prev = null;
    if (S.venues.length) {
      prev = {};
      S.on.forEach(function (i) { if (S.venues[i]) prev[S.venues[i].name] = true; });
    }

    S.months = m.months;
    S.venues = m.venues;
    S.on = new Set();
    m.venues.forEach(function (v, i) { if (!prev || prev[v.name]) S.on.add(i); });

    if (!m.venues.length) {
      $('hint').style.display = 'flex';
      $('src').textContent = '尚未采集到数据。请先打开并登录预约记录页（cgyy.buaa.edu.cn）。';
      $('picker').innerHTML = '';
      $('empty').style.display = 'block';
      $('empty').textContent = '还没有采集到数据，请点上方「打开预约记录页」，登录后点「开始抓取」';
      $('result').style.display = 'none';
      return;
    }

    $('hint').style.display = 'none';
    $('src').innerHTML = '已收录 ' + all.length + ' 条记录，其中「已支付 + 正常」' + m.recs.length +
      ' 条 · 时间区间 ' + m.months[0] + ' ~ ' + m.months[m.months.length - 1] +
      '（共 ' + m.months.length + ' 个月）' +
      (o.updatedAt ? '<br>最近更新：' + new Date(o.updatedAt).toLocaleString() : '');
    render();
  });
}

// ---------- 事件 ----------
$('picker').addEventListener('click', function (e) {
  var b = e.target.closest('.pick');
  if (!b) return;
  var i = +b.getAttribute('data-i');
  if (S.on.has(i)) S.on.delete(i); else S.on.add(i);
  render();
});

$('all').addEventListener('click', function () {
  S.on = new Set(S.venues.map(function (_, i) { return i; }));
  render();
});

$('none').addEventListener('click', function () {
  S.on = new Set();
  render();
});

$('start').addEventListener('click', function () {
  // drive 时间戳每次都不同，确保内容脚本一定收到「开始抓取」这一显式动作
  chrome.storage.local.set({ catching: true, drive: Date.now() }, function () {
    setCatchingUI(true);
    tip('已开始抓取：将自动切到 200 条/页并逐页采集');
  });
});

$('pause').addEventListener('click', function () {
  chrome.storage.local.set({ catching: false }, function () {
    setCatchingUI(false);
    tip('已暂停自动抓取');
  });
});

$('export').addEventListener('click', function () {
  exportHtml();
});

$('open').addEventListener('click', openSite);

// 二次点击确认，避免弹窗环境下 confirm 不可用
var clearArmed = false;
$('clear').addEventListener('click', function () {
  var btn = $('clear');
  if (!clearArmed) {
    clearArmed = true;
    btn.textContent = '再点一次确认清空';
    setTimeout(function () {
      clearArmed = false;
      btn.textContent = '清空数据';
    }, 3000);
    return;
  }
  clearArmed = false;
  chrome.storage.local.set({ records: [], updatedAt: Date.now() }, function () {
    tip('已清空');
    refresh();
  });
});

$('full').addEventListener('click', function () {
  chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') + '#tab' });
});

// 以 #tab 打开时铺满窗口（popup 弹窗尺寸由浏览器固定，无法缩放）
if (location.hash === '#tab') document.body.classList.add('wide');

// 内容脚本在页面加载/暂停时会同步 catching，这里保持按钮状态一致
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === 'local' && changes.catching) setCatchingUI(changes.catching.newValue === true);
});

// 采集过程中实时刷新界面：内容脚本每合并一次数据都会写 records / updatedAt
var refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 400);
}

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local') return;
  if (changes.records || changes.updatedAt) scheduleRefresh();
});

refresh();
