const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');

function fixture(file, options = {}) {
  let page;
  const resolved = [], previews = [], toasts = [], picks = [];
  const wx = {
    env: { USER_DATA_PATH: '/fixture' },
    showToast: value => toasts.push(value.title), showLoading() {}, hideLoading() {},
    previewImage: value => previews.push(value),
    async chooseMedia(value) { picks.push(value.count); return options.pick ? options.pick(value) : { tempFiles: Array.from({ length: value.count }, (_, i) => ({ tempFilePath: `/chosen-${picks.length}-${i}.jpg` })) }; }
  };
  if (options.legacy) { wx.chooseImage = wx.chooseMedia; delete wx.chooseMedia; }
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), {
    wx, Page: value => { page = value; }, console, setTimeout, clearTimeout,
    require(name) {
      if (name.includes('admin-feedback')) return require('../../utils/admin-feedback');
      if (name.endsWith('/theme')) return require('../../utils/theme');
      if (name.endsWith('/runtime')) return { isTestMode: () => false, storageKey: key => key, cloudCall: options.call || (async () => ({ result: { success: true } })) };
      if (name.endsWith('/image-access')) return { async resolve(fn, id) { resolved.push(id); return `https://images.invalid/${encodeURIComponent(id)}`; }, forget() {} };
      if (name.endsWith('/image-diagnostics')) return { record() {} };
      throw new Error(name);
    }
  });
  page.data = structuredClone(page.data);
  page.setData = (patch, callback) => { Object.assign(page.data, patch); if (callback) callback(); };
  page.getCachedImagePath = async () => '';
  page.prepareSelectedImage = async file => ({ url: file.tempFilePath || file.path, local: true });
  return { page, resolved, previews, toasts, picks };
}
const files = Array.from({ length: 10 }, (_, i) => `cloud://fixture/help/image-${i}.jpg`);

test('展开说明仅准备四张缩略图，完整图片列表及折叠节点不被裁剪', async () => {
  const f = fixture('pages/help/index.js');
  f.page.data.articles = [{ _id: 'guide', images: files }];
  f.page.toggleArticle({ currentTarget: { dataset: { id: 'guide' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.resolved, files.slice(0, 4));
  assert.equal(f.page.data.articles[0].images.length, 10);
  assert.equal(Object.keys(f.page.data.imageSrcs).length, 4);
  f.page.toggleArticle({ currentTarget: { dataset: { id: 'guide' } } });
  assert.equal(f.page.data.articles[0]._opened, true);
  assert.equal(f.page.data.expandedId, '');
});

test('第四张更多提示仍从第四张打开，并向原生预览传入十张图片的原始顺序', async () => {
  const f = fixture('pages/help/index.js');
  f.page.getCachedImagePath = async id => id === files[3] ? '/cached-fourth.jpg' : '';
  await f.page.previewImage({ currentTarget: { dataset: { current: files[3], images: files } } });
  const preview = f.previews[0];
  assert.equal(preview.current, '/cached-fourth.jpg');
  assert.equal(preview.urls.length, 10);
  assert.equal(preview.urls[3], preview.current);
  assert.equal(preview.urls[9], `https://images.invalid/${encodeURIComponent(files[9])}`);
});

test('缩略图重试仅请求可见四张，大图列表仍完整', async () => {
  const f = fixture('pages/help/index.js');
  f.page.data.imageErrors = Object.fromEntries(files.map(id => [id, true]));
  f.page.retryImages({ currentTarget: { dataset: { images: files } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.resolved, files.slice(0, 4));
  assert.equal(Object.keys(f.page.data.imageSrcs).length, 4);
});

test('管理端现代和旧选择器都可分批添加至十张，第十一张和保存超限均被阻止', async () => {
  for (const legacy of [false, true]) {
    const f = fixture('pages/admin/help-editor.js', { legacy });
    f.page.data.title = '标题'; f.page.data.content = '正文';
    await f.page.chooseImages(); await f.page.chooseImages();
    assert.deepEqual(f.picks, [9, 1]);
    assert.equal(f.page.data.images.length, 10);
    assert.equal(f.page.validateForm(), true);
    await f.page.chooseImages();
    assert.deepEqual(f.picks, [9, 1]);
    f.page.data.images.push({ url: '/extra.jpg' });
    assert.equal(f.page.validateForm(), false);
    assert.match(f.page.data._adminFeedbackMessage, /最多添加10张/);
  }
});

test('选择进行中不能重复打开或保存，取消后解除状态', async () => {
  let rejectPick;
  const f = fixture('pages/admin/help-editor.js', { pick: () => new Promise((resolve, reject) => { rejectPick = reject; }) });
  const picking = f.page.chooseImages();
  await new Promise(resolve => setImmediate(resolve));
  await f.page.chooseImages(); await f.page.saveArticle(false);
  assert.deepEqual(f.picks, [9]);
  assert.equal(f.page.data.saving, false);
  rejectPick({ errMsg: 'chooseMedia:fail cancel' }); await picking;
  assert.equal(f.page.data.choosingImages, false);
  assert.equal(f.page.data.images.length, 0);
});
