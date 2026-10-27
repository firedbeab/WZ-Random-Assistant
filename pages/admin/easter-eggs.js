const feedback = require('../../utils/admin-feedback');
const theme = require('../../utils/theme');
const { cloudCall, isTestMode } = require('../../utils/runtime');
const { DEFAULT_TOP, DEFAULT_BOTTOM } = require('../../utils/easter-egg-photos');
const MAX_BYTES = 2 * 1024 * 1024;
Page(theme.page(feedback.page({
  data: {
    isTestMode: isTestMode(), allowed: false, loading: true, entries: [], revision: 0, busy: false,
    editing: false, id: '', fileID: '', imagePath: '', localPath: '', topText: '', bottomText: '', enabled: true,
    previewTop: DEFAULT_TOP, previewBottom: DEFAULT_BOTTOM, dirty: false, editorClosing: false
  },
  async onLoad() {
    this.setData({ loading: true });
    try {
      // 两个接口各自校验权限；并行读取，避免身份确认后再串行等配置。
      const [res, result] = await Promise.all([
        cloudCall({ name: 'getUserInfo' }), this.api({ action: 'listAll' })
      ]);
      if (!res.result || !res.result.success || res.result.data.role !== 'superadmin') throw new Error('仅超级管理员可维护彩蛋');
      this.setData({ allowed: true }); this.applyEntries(result);
    } catch (err) {
      feedback.showToast(this, { title: err.message || '无法验证身份', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1200);
    } finally { this.setData({ loading: false }); }
  },
  async api(data) {
    const res = await cloudCall({ name: 'manageEasterEggs', data });
    if (!res.result || !res.result.success) throw new Error(res.result && res.result.message || '操作失败');
    return res.result.data;
  },
  async loadEntries() {
    if (!this.data.allowed) return;
    this.setData({ loading: true });
    try {
      const result = await this.api({ action: 'listAll' });
      this.applyEntries(result);
    } catch (err) { feedback.showToast(this, { title: err.message, icon: 'none' }); }
    finally { this.setData({ loading: false }); }
  },
  applyEntries(result) {
    this.setData({ entries: result.entries.map(item => ({ ...item, displayTop: item.topText || DEFAULT_TOP, displayBottom: item.bottomText || DEFAULT_BOTTOM })), revision: result.revision });
  },
  backFromEditor() { wx.navigateBack(); },
  async onPullDownRefresh() { await this.loadEntries(); wx.stopPullDownRefresh(); },
  onUnload() { feedback.clear(this); clearTimeout(this._editorCloseTimer); },
  edit(e) {
    if (this.data.busy || !this.data.allowed) return;
    const item = this.data.entries.find(entry => entry.id === e.currentTarget.dataset.id) || {};
    this.setData({ editing: true, id: item.id || '', fileID: item.fileID || '', imagePath: item.fileID || '', localPath: '',
      topText: item.topText || '', bottomText: item.bottomText || '', enabled: item.enabled !== false,
      previewTop: item.topText || DEFAULT_TOP, previewBottom: item.bottomText || DEFAULT_BOTTOM, dirty: false });
  },
  markDirty(patch) {
    this.setData({ ...patch, dirty: true });
    if (wx.enableAlertBeforeUnload) wx.enableAlertBeforeUnload({ message: '彩蛋修改尚未保存，确定离开吗？' });
  },
  input(e) {
    const field = e.currentTarget.dataset.field;
    if (!['topText', 'bottomText'].includes(field)) return;
    const value = e.detail.value;
    this.markDirty({ [field]: value, [field === 'topText' ? 'previewTop' : 'previewBottom']: value.trim() || (field === 'topText' ? DEFAULT_TOP : DEFAULT_BOTTOM) });
    return value;
  },
  toggleEditor(e) { this.markDirty({ enabled: e.detail.value }); },
  closeEditor() {
    if (this.data.busy || this.data.editorClosing) return;
    const close = () => this.animateEditorClose();
    if (!this.data.dirty) { close(); return; }
    feedback.showModal(this, { title: '放弃本次修改？', content: '未保存的图片和文字不会上传。', success: res => { if (res.confirm) close(); } });
  },
  animateEditorClose() {
    if (this.data.editorClosing) return;
    this.setData({ editorClosing: true });
    this._editorCloseTimer = setTimeout(() => {
      this.setData({ editing: false, dirty: false, editorClosing: false });
      if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
    }, 200);
  },
  async chooseImage() {
    if (this.data.busy) return;
    try {
      if (wx.requirePrivacyAuthorize) await new Promise((resolve, reject) => wx.requirePrivacyAuthorize({ success: resolve, fail: reject }));
      const res = await wx.chooseMedia({ count: 1, mediaType: ['image'], sizeType: ['compressed'], sourceType: ['album', 'camera'] });
      const file = res.tempFiles[0];
      let path = file.tempFilePath;
      const fs = wx.getFileSystemManager();
      const sizeOf = value => new Promise((resolve, reject) => fs.getFileInfo({ filePath: value, success: info => resolve(info.size), fail: reject }));
      let size = file.size || await sizeOf(path);
      if (size > MAX_BYTES) {
        feedback.showLoading(this, { title: '压缩图片中', mask: true });
        const info = await new Promise((resolve, reject) => wx.getImageInfo({ src: path, success: resolve, fail: reject }));
        for (const step of [{ quality: 80, side: 2048 }, { quality: 65, side: 1600 }, { quality: 45, side: 1280 }]) {
          const scale = Math.min(1, step.side / Math.max(info.width, info.height));
          const compressed = await wx.compressImage({ src: file.tempFilePath, quality: step.quality, compressedWidth: Math.max(1, Math.round(info.width * scale)), compressedHeight: Math.max(1, Math.round(info.height * scale)) });
          path = compressed.tempFilePath; size = await sizeOf(path); if (size <= MAX_BYTES) break;
        }
      }
      if (!size || size > MAX_BYTES) throw new Error('图片仍超过2MB，请换一张');
      this.markDirty({ imagePath: path, localPath: path });
    } catch (err) {
      if (!/cancel/i.test(err.errMsg || '')) feedback.showToast(this, { title: err.message || '未选到图片，请检查隐私授权', icon: 'none' });
    } finally { feedback.hideLoading(this); }
  },
  preview(e) {
    const src = e.currentTarget.dataset.src || this.data.imagePath;
    if (src) wx.previewImage({ current: src, urls: [src] });
  },
  async save() {
    if (!this.data.allowed || this.data.busy) return;
    if (!this.data.imagePath) { feedback.showToast(this, { title: '请先选择一张图片', icon: 'none' }); return; }
    this.setData({ busy: true }); feedback.showLoading(this, { title: '保存中', mask: true });
    let uploaded = '';
    try {
      let fileID = this.data.fileID;
      if (this.data.localPath) {
        const match = /\.(jpg|jpeg|png|webp)$/i.exec(this.data.localPath);
        const upload = await wx.cloud.uploadFile({ cloudPath: `${isTestMode() ? 'test/' : ''}easter-eggs/${Date.now()}-${Math.random().toString(36).slice(2, 14)}.${match ? match[1].toLowerCase() : 'jpg'}`, filePath: this.data.localPath });
        fileID = upload.fileID; uploaded = fileID;
      }
      await this.api({ action: 'save', revision: this.data.revision, id: this.data.id, fileID,
        topText: this.data.topText.trim(), bottomText: this.data.bottomText.trim(), enabled: this.data.enabled });
      this.setData({ dirty: false }); this.animateEditorClose(); if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
      feedback.showToast(this, { title: '彩蛋已保存', icon: 'success' }); await this.loadEntries();
    } catch (err) {
      if (uploaded) { try { await this.api({ action: 'deleteFiles', fileIDs: [uploaded] }); } catch (_) { /* 保存错误优先。 */ } }
      if (/内容已更新/.test(err.message)) await this.loadEntries();
      feedback.showToast(this, { title: err.message, icon: 'none', duration: 2500 });
    } finally { feedback.hideLoading(this); this.setData({ busy: false }); }
  },
  async changeEnabled(e) {
    if (this.data.busy || !this.data.allowed) return;
    const item = this.data.entries.find(entry => entry.id === e.currentTarget.dataset.id);
    if (!item) return;
    this.setData({ busy: true });
    try { await this.api({ action: 'setEnabled', id: item.id, revision: this.data.revision, enabled: !item.enabled }); await this.loadEntries(); }
    catch (err) { feedback.showToast(this, { title: err.message, icon: 'none' }); if (/内容已更新/.test(err.message)) await this.loadEntries(); }
    finally { this.setData({ busy: false }); }
  },
  remove(e) {
    if (this.data.busy || !this.data.allowed) return;
    const id = e.currentTarget.dataset.id;
    feedback.showModal(this, { title: '删除这个彩蛋？', content: '条目会移除，未被其他条目使用的云端图片也会清理，此操作不可撤销。', confirmColor: theme.getNativeColors().danger, success: async res => {
      if (!res.confirm || this.data.busy) return;
      this.setData({ busy: true });
      try { await this.api({ action: 'delete', id, revision: this.data.revision }); await this.loadEntries(); feedback.showToast(this, { title: '已删除', icon: 'success' }); }
      catch (err) { feedback.showToast(this, { title: err.message, icon: 'none' }); if (/内容已更新/.test(err.message)) await this.loadEntries(); }
      finally { this.setData({ busy: false }); }
    } });
  },
  noop() {}
})));
