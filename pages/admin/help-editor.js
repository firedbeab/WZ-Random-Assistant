const MAX_IMAGES = 5;
const MAX_IMAGE_SIZE = 2 * 1024 * 1024;
const TARGET_IMAGE_SIZE = Math.floor(1.8 * 1024 * 1024);
const IMAGE_COMPRESSION_STEPS = [
  { quality: 80, maxSide: 2560 },
  { quality: 68, maxSide: 2048 },
  { quality: 55, maxSide: 1600 },
  { quality: 42, maxSide: 1280 }
];

Page({
  data: {
    articleId: '',
    title: '',
    summary: '',
    content: '',
    images: [],
    isPublished: false,
    loading: true,
    saving: false,
    showPreview: false,
    dirty: false
  },

  async onLoad(options) {
    const articleId = options.id ? decodeURIComponent(options.id) : '';
    this.setData({ articleId });
    const allowed = await this.checkPermission();
    if (!allowed) return;
    if (articleId) {
      await this.loadArticle(articleId);
    } else {
      this.setData({ loading: false });
    }
  },

  async checkPermission() {
    try {
      const res = await wx.cloud.callFunction({ name: 'getUserInfo' });
      if (res.result && res.result.success && res.result.data.role === 'superadmin') {
        return true;
      }
    } catch (err) {
      // 统一按无权限处理，避免暴露内部错误。
    }
    wx.showToast({ title: '仅超级管理员可编辑', icon: 'none' });
    setTimeout(() => wx.navigateBack(), 1200);
    return false;
  },

  async loadArticle(articleId) {
    wx.showLoading({ title: '加载中...' });
    try {
      const res = await wx.cloud.callFunction({
        name: 'manageHelpContent',
        data: { action: 'getForAdmin', articleId }
      });
      if (!res.result || !res.result.success) {
        throw new Error('load failed');
      }
      const article = res.result.data;
      const images = (article.images || []).map(fileID => ({
        url: fileID,
        fileID,
        local: false
      }));
      this.setData({
        title: article.title || '',
        summary: article.summary || '',
        content: article.content || '',
        images,
        isPublished: Boolean(article.is_published),
        loading: false,
        dirty: false
      });
    } catch (err) {
      wx.showToast({ title: '说明加载失败', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1200);
    } finally {
      wx.hideLoading();
    }
  },

  markDirty(patch = {}) {
    const wasDirty = this.data.dirty;
    this.setData(Object.assign({}, patch, { dirty: true }));
    if (!wasDirty && wx.enableAlertBeforeUnload) {
      wx.enableAlertBeforeUnload({ message: '修改尚未保存，确定离开吗？' });
    }
  },

  onTitleInput(e) {
    const value = e.detail.value;
    this.markDirty({ title: value });
    return value;
  },

  onSummaryInput(e) {
    const value = e.detail.value;
    this.markDirty({ summary: value });
    return value;
  },

  onContentInput(e) {
    const value = e.detail.value;
    this.markDirty({ content: value });
    return value;
  },

  requestPrivacyAuthorization() {
    if (typeof wx.requirePrivacyAuthorize !== 'function') {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      wx.requirePrivacyAuthorize({
        success: resolve,
        fail: reject
      });
    });
  },

  getLocalFileSize(filePath, knownSize) {
    const parsedSize = Number(knownSize);
    if (Number.isFinite(parsedSize) && parsedSize > 0) {
      return Promise.resolve(parsedSize);
    }
    const fs = wx.getFileSystemManager();
    return new Promise((resolve, reject) => {
      fs.getFileInfo({
        filePath,
        success: result => resolve(Number(result.size) || 0),
        fail: reject
      });
    });
  },

  getLocalImageInfo(src) {
    return new Promise((resolve, reject) => {
      wx.getImageInfo({ src, success: resolve, fail: reject });
    });
  },

  compressLocalImage(src, imageInfo, step) {
    const width = Number(imageInfo.width) || 0;
    const height = Number(imageInfo.height) || 0;
    const longestSide = Math.max(width, height);
    const scale = longestSide > step.maxSide ? step.maxSide / longestSide : 1;
    const options = {
      src,
      quality: step.quality,
      success: null,
      fail: null
    };
    if (width > 0 && height > 0) {
      options.compressedWidth = Math.max(1, Math.round(width * scale));
      options.compressedHeight = Math.max(1, Math.round(height * scale));
    }
    return new Promise((resolve, reject) => {
      options.success = result => resolve(result.tempFilePath);
      options.fail = reject;
      wx.compressImage(options);
    });
  },

  async prepareSelectedImage(file) {
    const originalPath = file.tempFilePath || file.path;
    if (!originalPath) return null;
    const originalSize = await this.getLocalFileSize(originalPath, file.size);
    if (originalSize > 0 && originalSize <= MAX_IMAGE_SIZE) {
      return { url: originalPath, tempPath: originalPath, local: true, compressed: false };
    }

    const imageInfo = await this.getLocalImageInfo(originalPath);
    let smallest = null;
    for (const step of IMAGE_COMPRESSION_STEPS) {
      const compressedPath = await this.compressLocalImage(originalPath, imageInfo, step);
      const compressedSize = await this.getLocalFileSize(compressedPath);
      if (!smallest || compressedSize < smallest.size) {
        smallest = { path: compressedPath, size: compressedSize };
      }
      if (compressedSize > 0 && compressedSize <= TARGET_IMAGE_SIZE) {
        return {
          url: compressedPath,
          tempPath: compressedPath,
          local: true,
          compressed: true
        };
      }
    }

    if (smallest && smallest.size > 0 && smallest.size <= MAX_IMAGE_SIZE) {
      return {
        url: smallest.path,
        tempPath: smallest.path,
        local: true,
        compressed: true
      };
    }
    return null;
  },

  async chooseImages() {
    const remaining = MAX_IMAGES - this.data.images.length;
    if (remaining <= 0) {
      wx.showToast({ title: '最多上传5张图片', icon: 'none' });
      return;
    }
    try {
      // 主动触发微信隐私授权流程，避免直接调用图片接口时只得到模糊失败信息。
      await this.requestPrivacyAuthorization();

      let res;
      if (typeof wx.chooseMedia === 'function') {
        res = await wx.chooseMedia({
          count: remaining,
          mediaType: ['image'],
          sizeType: ['compressed'],
          sourceType: ['album', 'camera']
        });
      } else {
        res = await wx.chooseImage({
          count: remaining,
          sizeType: ['compressed'],
          sourceType: ['album', 'camera']
        });
      }
      const selectedFiles = Array.isArray(res.tempFiles) && res.tempFiles.length > 0
        ? res.tempFiles
        : (res.tempFilePaths || []).map(tempFilePath => ({ tempFilePath }));
      const accepted = [];
      let rejected = false;
      let compressed = false;
      if (selectedFiles.some(file => Number(file.size) > MAX_IMAGE_SIZE)) {
        wx.showLoading({ title: '正在压缩图片...', mask: true });
      }
      try {
        for (const file of selectedFiles) {
          try {
            const prepared = await this.prepareSelectedImage(file);
            if (!prepared) {
              rejected = true;
              continue;
            }
            accepted.push(prepared);
            if (prepared.compressed) compressed = true;
          } catch (compressErr) {
            console.warn('[使用说明] 图片压缩失败:', compressErr.errMsg || compressErr.message || '未知错误');
            rejected = true;
          }
        }
      } finally {
        wx.hideLoading();
      }
      if (accepted.length > 0) {
        this.markDirty({ images: this.data.images.concat(accepted) });
      }
      if (rejected) {
        wx.showToast({ title: '部分图片压缩后仍超过2MB', icon: 'none', duration: 2500 });
      } else if (compressed) {
        wx.showToast({ title: '图片已自动压缩', icon: 'success' });
      }
    } catch (err) {
      const errMsg = err && err.errMsg ? err.errMsg : '';
      const normalizedMsg = errMsg.toLowerCase();
      if (normalizedMsg.includes('cancel')) return;
      console.warn('[使用说明] 选择图片失败:', errMsg || '未知错误');
      if (
        normalizedMsg.includes('not declared') ||
        normalizedMsg.includes('undeclared') ||
        (normalizedMsg.includes('scope') && normalizedMsg.includes('privacy'))
      ) {
        wx.showModal({
          title: '需更新隐私声明',
          content: '这不是手机相册权限。请先在微信公众平台的用户隐私保护指引中声明“选中的照片或视频信息”，更新生效后再试。',
          showCancel: false
        });
      } else if (
        normalizedMsg.includes('not authorized') ||
        normalizedMsg.includes('disagree') ||
        normalizedMsg.includes('auth deny')
      ) {
        wx.showToast({ title: '未同意隐私保护指引', icon: 'none' });
      } else if (normalizedMsg.includes('privacy') || errMsg.includes('隐私')) {
        wx.showModal({
          title: '隐私授权未完成',
          content: '请在弹出的隐私保护指引中点击“同意”后再选择图片。',
          showCancel: false
        });
      } else {
        wx.showToast({ title: '无法打开图片选择器', icon: 'none' });
      }
    }
  },

  removeImage(e) {
    const index = Number(e.currentTarget.dataset.index);
    const images = this.data.images.slice();
    images.splice(index, 1);
    this.markDirty({ images });
  },

  moveImage(e) {
    const index = Number(e.currentTarget.dataset.index);
    const direction = e.currentTarget.dataset.direction;
    const target = direction === 'left' ? index - 1 : index + 1;
    if (target < 0 || target >= this.data.images.length) return;
    const images = this.data.images.slice();
    [images[index], images[target]] = [images[target], images[index]];
    this.markDirty({ images });
  },

  previewImage(e) {
    const current = e.currentTarget.dataset.url;
    const urls = this.data.images.map(item => item.url);
    if (current && urls.length > 0) wx.previewImage({ current, urls });
  },

  togglePreview() {
    this.setData({ showPreview: !this.data.showPreview });
  },

  async uploadLocalImage(image) {
    const extensionMatch = image.tempPath.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
    const extension = extensionMatch ? extensionMatch[1].toLowerCase() : 'jpg';
    const safeExtension = ['jpg', 'jpeg', 'png', 'webp'].includes(extension) ? extension : 'jpg';
    const randomPart = Math.random().toString(36).slice(2, 12);
    const upload = await wx.cloud.uploadFile({
      cloudPath: `help/${Date.now()}-${randomPart}.${safeExtension}`,
      filePath: image.tempPath
    });
    if (!upload || !upload.fileID) {
      throw new Error('图片上传失败');
    }
    return upload.fileID;
  },

  async cleanupUploadedFiles(fileIDs) {
    if (!fileIDs.length) return;
    try {
      await wx.cloud.callFunction({
        name: 'manageHelpContent',
        data: { action: 'deleteFiles', fileIDs }
      });
    } catch (err) {
      // 清理失败不覆盖原始保存错误。
    }
  },

  validateForm() {
    if (!this.data.title.trim()) {
      wx.showToast({ title: '请输入标题', icon: 'none' });
      return false;
    }
    if (!this.data.content.trim()) {
      wx.showToast({ title: '请输入详细说明', icon: 'none' });
      return false;
    }
    return true;
  },

  onSaveDraft() {
    this.saveArticle(false);
  },

  onPublish() {
    if (!this.validateForm()) return;
    wx.showModal({
      title: '发布使用说明',
      content: '发布后用户将立即看到这条说明，是否继续？',
      confirmText: '发布',
      success: res => {
        if (res.confirm) this.saveArticle(true);
      }
    });
  },

  async saveArticle(isPublished) {
    if (this.data.saving || !this.validateForm()) return;
    this.setData({ saving: true });
    wx.showLoading({ title: '保存中...' });
    const uploadedFileIDs = [];
    try {
      // 图片之间没有依赖关系，并行上传与校验可显著缩短多图保存时间。
      // 等待所有任务结束后再统一判错，避免部分请求仍在运行时提前清理。
      const uploadResults = await Promise.all(this.data.images.map(async image => {
        if (!image.local) {
          return { success: true, fileID: image.fileID };
        }
        try {
          const fileID = await this.uploadLocalImage(image);
          uploadedFileIDs.push(fileID);
          return { success: true, fileID };
        } catch (error) {
          return { success: false, error };
        }
      }));
      const failedUpload = uploadResults.find(result => !result.success);
      if (failedUpload) {
        throw failedUpload.error || new Error('图片上传失败');
      }
      const finalImages = uploadResults.map(result => result.fileID);

      const res = await wx.cloud.callFunction({
        name: 'manageHelpContent',
        data: {
          action: 'save',
          articleId: this.data.articleId,
          title: this.data.title.trim(),
          summary: this.data.summary.trim(),
          content: this.data.content.trim(),
          images: finalImages,
          newImageIDs: uploadedFileIDs,
          isPublished
        }
      });
      if (!res.result || !res.result.success) {
        throw new Error((res.result && res.result.message) || 'save failed');
      }

      if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
      this.setData({ dirty: false, isPublished });
      wx.showToast({ title: isPublished ? '已发布' : '草稿已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 800);
    } catch (err) {
      await this.cleanupUploadedFiles(uploadedFileIDs);
      const message = err && err.message && err.message !== 'save failed'
        ? err.message
        : '保存失败，请重试';
      wx.showToast({ title: message, icon: 'none', duration: 2500 });
    } finally {
      wx.hideLoading();
      this.setData({ saving: false });
    }
  }
});
