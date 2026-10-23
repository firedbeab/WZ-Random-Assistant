const { storageKey } = require('./runtime');
const KEY = storageKey('easter_encounters_v1');
function ids(values) { return Array.from(new Set((Array.isArray(values) ? values : []).filter(id => typeof id === 'string' && id.length > 0 && id.length <= 160))).slice(-500); }
let state;
function read() {
  if (state) return state;
  let saved;
  try { saved = wx.getStorageSync(KEY); } catch (_) { /* 磁盘不可用仍允许本次会话收集。 */ }
  saved = saved && typeof saved === 'object' ? saved : {};
  state = { photo: ids(saved.photo), cat: ids(saved.cat), lastPhoto: typeof saved.lastPhoto === 'string' ? saved.lastPhoto : '', lastCat: typeof saved.lastCat === 'string' ? saved.lastCat : '' };
  return state;
}
function summary(kind, catalog) {
  const available = ids(catalog), seen = new Set(read()[kind] || []);
  return { seen: available.filter(id => seen.has(id)).length, total: available.length };
}
function record(kind, id, catalog) {
  if (!['photo', 'cat'].includes(kind) || !ids(catalog).includes(id)) return summary(kind, catalog);
  const progress = read();
  progress[kind] = ids(progress[kind].concat(id));
  progress[kind === 'photo' ? 'lastPhoto' : 'lastCat'] = id;
  try { wx.setStorageSync(KEY, progress); } catch (_) { /* 不让本地缓存故障阻断奖励。 */ }
  return summary(kind, catalog);
}
function pick(kind, items, lastId = '', random = Math.random) {
  if (!items.length) return null;
  const progress = read(), seen = new Set(progress[kind] || []);
  const previous = lastId || progress[kind === 'photo' ? 'lastPhoto' : 'lastCat'];
  // 不排除任何条目：未遇见3、遇见1、上一次0.5，允许偶尔连续重复。
  const weights = items.map(item => item.id === previous ? .5 : seen.has(item.id) ? 1 : 3);
  let cursor = random() * weights.reduce((sum, weight) => sum + weight, 0);
  for (let i = 0; i < items.length; i++) { cursor -= weights[i]; if (cursor < 0) return items[i]; }
  return items[items.length - 1];
}
module.exports = { summary, record, pick };
