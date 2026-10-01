const CACHE_KEY = 'help_articles_cache_v1';
const IMAGE_CACHE_KEY = 'help_image_file_cache_v1';
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
    articles: [],
    expandedId: '',
    loading: true,
    loadFailed: false
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
      const res = await wx.cloud.callFunction({
        name: 'manageHelpContent',
        data: { action: 'listPublished' }
      });
      if (!res.result || !res.result.success) {
        throw new Error('load failed');
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
    } catch (err) {
      this.setData({ loading: false, loadFailed: this.data.articles.length === 0 });
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

      const download = await wx.cloud.downloadFile({ fileID });
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
        // 本地缓存不可用时退回云端地址，不阻断用户查看。
        currentPath = current;
      } finally {
        wx.hideLoading();
      }
    }
    const urls = await Promise.all(images.map(async fileID => {
      if (fileID === current) return currentPath;
      return (await this.getCachedImagePath(fileID, false)) || fileID;
    }));
    wx.previewImage({ current: currentPath, urls });
  },

  retryLoad() {
    this.loadArticles();
  }
});
