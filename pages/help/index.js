const { cloudCall, isTestMode, storageKey } = require('../../utils/runtime');
const imageAccess = require('../../utils/image-access');
const diagnostics = require('../../utils/image-diagnostics');

const CACHE_KEY = storageKey('help_articles_cache_v1');
const IMAGE_CACHE_KEY = storageKey('help_image_file_cache_v1');
const IMAGE_CACHE_DIR = `${wx.env.USER_DATA_PATH}/help-image-cache`;
const MAX_IMAGE_CACHE_BYTES = 12 * 1024 * 1024;

function getImageExtension(fileID) {
  const match = String(fileID).match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
  const extension = match ? match[1].toLowerCase() : 'jpg';
  return ['jpg', 'jpeg', 'png', 'webp'].includes(extension) ? extension : 'jpg';
}

function hashText(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

Page({
  data: {
    isTestMode: isTestMode(),
    articles: [],
    expandedId: '',
    loading: true,
    loadFailed: false,
    loadErrorTitle: '暂时无法加载使用说明',
    loadErrorText: '请检查网络后重试',
    imageSrcs: {},
    imageErrors: {}
  },

  onLoad() {
    this.imageCacheTasks = Object.create(null);
    const cached = wx.getStorageSync(CACHE_KEY);
    if (Array.isArray(cached) && cached.length > 0) {
      this.setData({ articles: cached, loading: false });
    }
    this.loadArticles();
  },

  async onPullDownRefresh() {
    await this.loadArticles(false);
    wx.stopPullDownRefresh();
  },

  async loadArticles(showLoading = true) {
    if (showLoading && this.data.articles.length === 0) {
      this.setData({ loading: true });
    }
    try {
      const res = await cloudCall({
        name: 'manageHelpContent',
        data: { action: 'listPublished' }
      });
      if (!res.result || !res.result.success) {
        // 区分“没有权限”和“网络/其它失败”，避免把权限拒绝说成网络问题误导排查。
        const error = new Error((res.result && res.result.message) || 'load failed');
        error.code = (res.result && res.result.code) || '';
        throw error;
      }
      const articles = Array.isArray(res.result.data) ? res.result.data : [];
      const openedIds = new Set(
        this.data.articles.filter(article => article._opened).map(article => article._id)
      );
      const displayArticles = articles.map(article => (
        openedIds.has(article._id)
          ? Object.assign({}, article, { _opened: true })
          : article
      ));
      wx.setStorageSync(CACHE_KEY, articles);
      this.setData({ articles: displayArticles, loading: false, loadFailed: false });
      // 已展开的条目重新进入时补齐图片地址；未展开的等展开时再取。
      const opened = displayArticles.filter(article => article._opened && Array.isArray(article.images) && article.images.length > 0);
      opened.forEach(article => this.prepareImages(article.images));
    } catch (err) {
      const code = (err && err.code) || '';
      const denied = code === 'TEST_ACCESS_DENIED' || code === 'FORBIDDEN' || /权限/.test((err && err.message) || '');
      this.setData({
        loading: false,
        loadFailed: this.data.articles.length === 0,
        loadErrorTitle: denied ? '暂时无法查看说明' : '加载失败',
        loadErrorText: denied ? '当前账号没有查看该内容的权限' : '请检查网络后重试'
      });
    }
  },

  toggleArticle(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data.expandedId === id) {
      this.setData({ expandedId: '' });
      return;
    }
    // 条目内容第一次展开后保留节点，后续折叠只隐藏，
    // 避免缩略图因 wx:if 反复销毁、重建而重新加载。
    const articles = this.data.articles.map(article => {
      if (article._id !== id || article._opened) return article;
      return Object.assign({}, article, { _opened: true });
    });
    this.setData({ articles, expandedId: id });
    const target = articles.find(article => article._id === id);
    if (target && Array.isArray(target.images) && target.images.length > 0) this.prepareImages(target.images);
  },

  getImageCacheIndex() {
    const cache = wx.getStorageSync(IMAGE_CACHE_KEY);
    return cache && typeof cache === 'object' && !Array.isArray(cache) ? cache : {};
  },

  saveImageCacheIndex(cache) {
    try {
      wx.setStorageSync(IMAGE_CACHE_KEY, cache);
    } catch (err) {
      // 索引写入失败不影响查看云端图片。
    }
  },

  accessLocalFile(filePath) {
    const fs = wx.getFileSystemManager();
    return new Promise(resolve => {
      fs.access({
        path: filePath,
        success: () => resolve(true),
        fail: () => resolve(false)
      });
    });
  },

  async getCachedImagePath(fileID, touch = true) {
    const cache = this.getImageCacheIndex();
    const entry = cache[fileID];
    if (!entry || !entry.path || !await this.accessLocalFile(entry.path)) {
      if (entry) {
        delete cache[fileID];
        this.saveImageCacheIndex(cache);
      }
      return '';
    }
    if (touch) {
      entry.lastUsed = Date.now();
      this.saveImageCacheIndex(cache);
    }
    return entry.path;
  },

  ensureImageCacheDirectory() {
    const fs = wx.getFileSystemManager();
    return new Promise((resolve, reject) => {
      fs.mkdir({
        dirPath: IMAGE_CACHE_DIR,
        recursive: true,
        success: resolve,
        fail: err => {
          const message = String(err && err.errMsg || '').toLowerCase();
          if (message.includes('exist')) resolve();
          else reject(err);
        }
      });
    });
  },

  removeLocalFile(filePath) {
    const fs = wx.getFileSystemManager();
    return new Promise(resolve => {
      fs.unlink({ filePath, success: resolve, fail: resolve });
    });
  },

  async makeImageCacheRoom(incomingBytes, protectedFileID) {
    const cache = this.getImageCacheIndex();
    const entries = Object.keys(cache).map(fileID => ({
      fileID,
      path: cache[fileID].path,
      size: Number(cache[fileID].size) || 0,
      lastUsed: Number(cache[fileID].lastUsed) || 0
    }));
    let totalBytes = entries.reduce((total, entry) => total + entry.size, 0);
    entries.sort((left, right) => left.lastUsed - right.lastUsed);
    for (const entry of entries) {
      if (totalBytes + incomingBytes <= MAX_IMAGE_CACHE_BYTES) break;
      if (entry.fileID === protectedFileID) continue;
      await this.removeLocalFile(entry.path);
      totalBytes -= entry.size;
      delete cache[entry.fileID];
    }
    this.saveImageCacheIndex(cache);
  },

  copyToImageCache(tempFilePath, targetPath) {
    const fs = wx.getFileSystemManager();
    return new Promise((resolve, reject) => {
      fs.copyFile({
        srcPath: tempFilePath,
        destPath: targetPath,
        success: resolve,
        fail: reject
      });
    });
  },

  getLocalFileSize(filePath) {
    const fs = wx.getFileSystemManager();
    return new Promise((resolve, reject) => {
      fs.getFileInfo({
        filePath,
        success: result => resolve(Number(result.size) || 0),
        fail: reject
      });
    });
  },

  cacheImage(fileID) {
    if (this.imageCacheTasks[fileID]) return this.imageCacheTasks[fileID];
    const task = (async () => {
      const existingPath = await this.getCachedImagePath(fileID);
      if (existingPath) return existingPath;

      // 私有桶下普通用户不能用 fileID 直接下载，先换服务端签发的短时地址；
      // 换不到时回退直连，兼容上传者本人与旧环境。
      let download;
      try {
        const url = await imageAccess.resolve('manageHelpContent', fileID);
        download = await new Promise((resolve, reject) => {
          wx.downloadFile({
            url,
            success: res => (res.statusCode === 200 && res.tempFilePath
              ? resolve(res)
              : reject(Object.assign(new Error(`HTTP_${res.statusCode || 0}`), { code: `HTTP_${res.statusCode || 0}` }))),
            fail: reject
          });
        });
      } catch (err) {
        diagnostics.record('help_image', 'signed_download', err);
        download = await wx.cloud.downloadFile({ fileID });
      }
      if (!download || !download.tempFilePath) throw new Error('图片下载失败');
      const fileSize = await this.getLocalFileSize(download.tempFilePath);
      await this.ensureImageCacheDirectory();
      await this.makeImageCacheRoom(fileSize, fileID);
      const extension = getImageExtension(fileID);
      const targetPath = `${IMAGE_CACHE_DIR}/${hashText(fileID)}.${extension}`;
      await this.copyToImageCache(download.tempFilePath, targetPath);
      const cache = this.getImageCacheIndex();
      cache[fileID] = { path: targetPath, size: fileSize, lastUsed: Date.now() };
      this.saveImageCacheIndex(cache);
      return targetPath;
    })();
    this.imageCacheTasks[fileID] = task;
    task.then(
      () => { delete this.imageCacheTasks[fileID]; },
      () => { delete this.imageCacheTasks[fileID]; }
    );
    return task;
  },

  async previewImage(e) {
    const { current, images } = e.currentTarget.dataset;
    if (!current || !Array.isArray(images) || images.length === 0) return;
    let currentPath = await this.getCachedImagePath(current);
    if (!currentPath) {
      wx.showLoading({ title: '加载大图...', mask: true });
      try {
        currentPath = await this.cacheImage(current);
      } catch (err) {
        // 缓存不可用时退回短时签名地址；绝不再把裸 fileID 交给预览，那对普通用户必然失败。
        diagnostics.record('help_image', 'preview', err);
        currentPath = await imageAccess.resolve('manageHelpContent', current).catch(() => '');
      } finally {
        wx.hideLoading();
      }
    }
    if (!currentPath) {
      wx.showToast({ title: '图片暂时无法打开', icon: 'none' });
      return;
    }
    const urls = await Promise.all(images.map(async fileID => {
      if (fileID === current) return currentPath;
      const cached = await this.getCachedImagePath(fileID, false);
      if (cached) return cached;
      return (await imageAccess.resolve('manageHelpContent', fileID).catch(() => '')) || currentPath;
    }));
    wx.previewImage({ current: currentPath, urls });
  },

  retryLoad() {
    this.loadArticles();
  },

  // 缩略图优先用本地缓存，其次用短时签名地址；都拿不到就记录一次失败，等用户手动重试。
  async prepareImages(fileIDs) {
    const list = (Array.isArray(fileIDs) ? fileIDs : []).filter(id => typeof id === 'string' && id);
    if (!list.length) return;
    const srcs = Object.assign({}, this.data.imageSrcs);
    const errors = Object.assign({}, this.data.imageErrors);
    let changed = false;
    for (const fileID of list) {
      if (srcs[fileID]) continue;
      try {
        const cachedPath = await this.getCachedImagePath(fileID, false);
        const display = cachedPath || await imageAccess.resolve('manageHelpContent', fileID);
        if (display) { srcs[fileID] = display; delete errors[fileID]; changed = true; }
      } catch (err) {
        diagnostics.record('help_image', 'resolve', err);
        if (!errors[fileID]) { errors[fileID] = true; changed = true; }
      }
    }
    if (changed) this.setData({ imageSrcs: srcs, imageErrors: errors });
  },

  onImageError(e) {
    const fileID = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.fileId;
    if (!fileID) return;
    diagnostics.record('help_image', 'render', (e.detail && e.detail.errMsg) || 'render_failed');
    imageAccess.forget(fileID);
    const srcs = Object.assign({}, this.data.imageSrcs);
    delete srcs[fileID];
    const errors = Object.assign({}, this.data.imageErrors);
    errors[fileID] = true;
    this.setData({ imageSrcs: srcs, imageErrors: errors });
  },

  // 重试只清掉失败项并重新申请地址，不清空其它已成功显示的图片。
  retryImages(e) {
    const ids = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.images;
    const list = Array.isArray(ids) ? ids : [];
    const srcs = Object.assign({}, this.data.imageSrcs);
    const errors = Object.assign({}, this.data.imageErrors);
    list.forEach(fileID => { delete srcs[fileID]; delete errors[fileID]; imageAccess.forget(fileID); });
    this.setData({ imageSrcs: srcs, imageErrors: errors }, () => this.prepareImages(list));
  }
});
