// 在扩展图标上显示已采集记录数
function refreshBadge() {
  chrome.storage.local.get(['records'], function (o) {
    var n = (o.records || []).length;
    chrome.action.setBadgeText({ text: n > 0 ? String(n) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#2d6cdf' });
  });
}

chrome.runtime.onInstalled.addListener(refreshBadge);
chrome.runtime.onStartup.addListener(refreshBadge);
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === 'local' && changes.records) refreshBadge();
});
