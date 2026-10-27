const theme = require('../../utils/theme');
const { newRound, nextRoll } = require('../../utils/dice-easter-egg');
const photos = require('../../utils/easter-egg-photos');
const diagnostics = require('../../utils/image-diagnostics');
const encounters = require('../../utils/easter-encounters');
const replies = require('../../utils/easter-replies');
const { cats, invitations, ASCII_REWARD_CHANCE } = require('../../utils/easter-cats');
const FACE_PIPS = [[4], [0, 8], [0, 4, 8], [0, 2, 6, 8], [0, 2, 4, 6, 8], [0, 2, 3, 5, 6, 8]];
const FACE_ROTATIONS = [[0, 0], [0, -90], [-90, 0], [90, 0], [0, 90], [0, 180]];
// 原生预览标记的兜底存活时间：超过该时长仍未收到页面 show，就当作标记泄漏并清除。
const PREVIEW_FLAG_TTL = 5 * 60 * 1000;
// 领奖时等待照片的总预算。首次冷路径实测约 4.5 秒（两次云调用 + 下载 90KB），
// 原先 2.5 秒会在网络稍慢时必然回退文字猫。
const PHOTO_WAIT_MS = 5000;
const SCENARIOS = [
  { value: 'quick', label: '快速四连（10次内）' }, { value: 'pairs', label: '8次二连累计（16次投掷）' },
  { value: 'triples', label: '2次三连累计（6次投掷）' }, { value: 'mixed', label: '混合计数（验证小点不相加）' },
  { value: 'pity', label: '保底边界（从保底前2次开始）' }, { value: 'normal', label: '正式随机规则' }
];
function confetti() {
  const colors = ['#ffbc42', '#ff6b8a', '#67d5b5', '#8f9bff', '#b88bdf', '#fff2cd'];
  return Array.from({ length: 56 }, (_, id) => ({ id, round: id % 4 === 0,
    style: `left:${id % 2 ? 95 : 5}%;--travel:${(id % 2 ? -1 : 1) * (50 + Math.random() * 260)}px;--rise:${-130 - Math.random() * 250}px;--spin:${Math.floor(Math.random() * 1000 + 360)}deg;background:${colors[id % colors.length]};animation-delay:${Math.random() * 180}ms;animation-duration:${1700 + Math.random() * 500}ms;`
  }));
}
// 照片展示框的高度：按图片真实比例算，夹在 320–620rpx 之间。
// 比例与框一致时 aspectFill 等于不裁剪，因此不会再出现左右白边；
// 特别竖长的图会被夹到上限并轻微裁掉上下边缘。
const PHOTO_BOX_MIN = 320;
const PHOTO_BOX_MAX = 620;
const PHOTO_BOX_DEFAULT = 500;
// 与 .photo-card .egg-content 的左右 padding（24rpx × 2）保持一致。
const PHOTO_BOX_WIDTH = 750 - 48;

function photoBoxHeightFor(detail) {
  const width = detail && Number(detail.width) > 0 ? Number(detail.width) : 0;
  const height = detail && Number(detail.height) > 0 ? Number(detail.height) : 0;
  if (!width || !height) return PHOTO_BOX_DEFAULT;
  const scaled = Math.round(PHOTO_BOX_WIDTH * (height / width));
  if (!Number.isFinite(scaled) || scaled <= 0) return PHOTO_BOX_DEFAULT;
  return Math.max(PHOTO_BOX_MIN, Math.min(PHOTO_BOX_MAX, scaled));
}

Component(theme.component({
  properties: { testMode: { type: Boolean, value: false }, superadmin: { type: Boolean, value: false } },
  data: {
    visible: false, stage: 'dice', rolling: false, face: 0, streak: 0, streakNumbers: [], dots: [], dotPulse: false,
    faces: FACE_PIPS.map((pips, i) => ({ value: i + 1, dots: Array.from({ length: 9 }, (_, slot) => ({ slot, visible: pips.includes(slot) })) })),
    coreFacets: Array.from({ length: 114 }, (_, i) => i), // 与构建时圆角内芯面片数一致。
    cubeStyle: 'transform:rotateX(-18deg) rotateY(-26deg);', celebrating: false, confetti: [], meows: [],
    invitation: '', photoSrc: '', photoReady: false, photoBoxHeight: PHOTO_BOX_DEFAULT, _photoId: '', topText: '', bottomText: '', asciiCat: cats[0],
    encounterSeen: 0, encounterTotal: 0, scrollHeight: 400, panelScrollTop: 0,
    testExpanded: false, scenarios: SCENARIOS, scenarioIndex: 0,
    rewards: ['正常概率', '指定云端照片', '指定颜文字猫'], rewardIndex: 0,
    networks: ['正常预加载', '缓存命中演示', '慢加载演示', '图片失败演示', '无启用条目演示'], networkIndex: 0,
    pities: ['随机50–96', '50次边界', '96次边界'], pityIndex: 0,
    cats, catIndex: 0, invitations, invitationIndex: 0, diagnostics: '',
    replyModes: ['正常30%（最近投稿）', '普通文案', '指定歌手文案（示例）', '指定歌名文案（示例）', '最近投稿必触发'], replyModeIndex: 0,
    replyTemplates: replies.singerTemplates, replyTemplateIndex: 0
  },
  observers: {
    'visible, stage, testExpanded, topText, bottomText, photoReady'() { this.refreshLayout(); }
  },
  lifetimes: {
    attached() { this._timers = []; this._token = 0; this._rotation = [-18, -26]; this.resetRound(); },
    detached() { this._detached = true; this.clearTimers(); this._token++; this._previewing = false; this._previewSuspended = false; this._previewStartedAt = 0; }
  },
  pageLifetimes: {
    // 打开原生大图时页面也会触发 hide，此时只能挂起，不能结束奖励或重置轮次。
    hide() {
      if (this._previewing) { this._previewSuspended = true; return; }
      this.close();
    },
    // 从大图返回只恢复布局；照片、上下文案、遇见计数和菜单展开状态保持原样。
    show() {
      if (this._previewSuspended) {
        this._previewSuspended = false;
        this._previewing = false;
        this._previewStartedAt = 0;
        this.later(() => this.refreshLayout(), 0);
        return;
      }
      // 标记长时间未释放说明回调丢失，清掉它，避免以后真正离开页面时不再清理。
      if (this._previewing && Date.now() - (this._previewStartedAt || 0) > PREVIEW_FLAG_TTL) {
        this._previewing = false;
        this._previewStartedAt = 0;
      }
    }
  },
  methods: {
    refreshLayout() {
      if (!this.data.visible) return;
      const token = this._token;
      wx.nextTick(() => {
        if (this._detached || !this.data.visible || token !== this._token) return;
        const info = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync();
        this.createSelectorQuery().select('.egg-content').boundingClientRect(rect => {
          if (!rect || this._detached || !this.data.visible || token !== this._token) return;
          const height = Math.min(Math.ceil(rect.height), Math.floor(info.windowHeight * .86));
          if (height !== this.data.scrollHeight) this.setData({ scrollHeight: height });
          if (this._layoutStage !== this.data.stage) {
            this._layoutStage = this.data.stage;
            this.setData({ panelScrollTop: this._scrollTop || 0 }, () => this.setData({ panelScrollTop: 0 }));
          }
        }).exec();
      });
    },
    onPanelScroll(e) { this._scrollTop = e.detail.scrollTop; },
    testAllowed() { return this.properties.testMode && this.properties.superadmin; },
    later(fn, ms) {
      const timer = setTimeout(() => { this._timers = this._timers.filter(item => item !== timer); if (!this._detached) fn(); }, ms);
      this._timers.push(timer); return timer;
    },
    clearTimers() {
      (this._timers || []).forEach(clearTimeout); this._timers = [];
      if (this._pendingDelay) { this._pendingDelay(); this._pendingDelay = null; }
    },
    preloadPhoto() {
      // 预加载失败必须清掉任务，否则领奖时会一直复用一个已经失败的任务。
      // 首次冷路径要等两次云调用和一次下载，任何一步抖动都可能在开窗阶段失败，因此在后台自动重试一次。
      const token = this._token;
      const attempt = () => photos.manifest(true).then(() => photos.prepare(this._lastPhotoId));
      this._photoTask = attempt()
        .catch(err => {
          diagnostics.record('easter_photo', 'preload', err);
          return new Promise(resolve => setTimeout(resolve, 800)).then(() => {
            if (this._detached || token !== this._token) return null;
            return attempt();
          });
        })
        .catch(err => {
          diagnostics.record('easter_photo', 'preload_retry', err);
          this._photoTask = null;
          return null;
        });
    },
    preloadReply() {
      const request = this._replyRequest = (this._replyRequest || 0) + 1;
      this._replySubmission = null;
      replies.load().then(submission => {
        if (!this._detached && request === this._replyRequest && this.data.visible) this._replySubmission = submission;
      });
    },
    rewardCaption(fallback, custom = false, preview = false) {
      if (custom) return fallback;
      const test = this.testAllowed(), index = test ? this.data.replyModeIndex : 0;
      if (preview && index === 0) return fallback;
      const options = { mode: ['normal', 'off', 'singer', 'song', 'force'][index] || 'normal', index: test ? this.data.replyTemplateIndex : 0 };
      // 同一奖励只抽一次；照片失败回退文字猫时不重新掷30%的概率。
      const choice = preview ? replies.choose(this._replySubmission, options)
        : (this._personalReply === undefined ? (this._personalReply = replies.choose(this._replySubmission, options)) : this._personalReply);
      return choice ? choice.text : fallback;
    },
    open() {
      if (this.data.visible) return;
      // 组件 attached 可能早于 test-mode 属性同步，开窗时才确定首次规则。
      if (!this._round.rolls) this.resetRound();
      this._token++;
      this._personalReply = undefined;
      this.setData({ visible: true, stage: 'dice', photoSrc: '', photoReady: false });
      this.preloadPhoto();
      this.preloadReply();
      // 首次测量可能处于入场缩放中，动画结束后再校准，避免短弹窗末尾被裁掉。
      this.later(() => this.refreshLayout(), 400);
    },
    close() {
      this.clearTimers(); this._token++;
      if (this._beforeRollRotation) this._rotation = this._beforeRollRotation;
      this._beforeRollRotation = null; this._touchStart = null;
      this._currentPhoto = null; this._layoutStage = null;
      this._previewing = false; this._previewSuspended = false; this._previewStartedAt = 0;
      this._replyRequest = (this._replyRequest || 0) + 1; this._replySubmission = null;
      if (this._round && this._round.won) this.resetRound();
      this.setData({ visible: false, rolling: false, celebrating: false, meows: [], confetti: [], dotPulse: false,
        cubeStyle: `transform:rotateX(${this._rotation[0]}deg) rotateY(${this._rotation[1]}deg);` });
    },
    resetRound() {
      this.clearTimers(); this._token++;
      const scenario = this.testAllowed() ? SCENARIOS[this.data.scenarioIndex].value : (this.properties.testMode ? 'quick' : 'normal');
      const pityAfter = this.testAllowed() && this.data.pityIndex ? (this.data.pityIndex === 1 ? 50 : 96) : 0;
      this._round = newRound({ scenario, pityAfter }); this._rotation = [-18, -26]; this._beforeRollRotation = null;
      this._currentPhoto = null;
      this._personalReply = undefined;
      this.setData({ stage: 'dice', rolling: false, face: 0, streak: 0, streakNumbers: [], dots: [], meows: [], confetti: [], celebrating: false, dotPulse: false,
        photoBoxHeight: PHOTO_BOX_DEFAULT,
        cubeStyle: 'transform:rotateX(-18deg) rotateY(-26deg);', diagnostics: this.diagnostics() });
    },
    diagnostics() {
      const r = this._round;
      return `已完成 ${r.rolls} 次 · 二连 ${r.pairCount}/8 · 三连 ${r.tripleCount}/2 · 保底 ${r.pityAfter}${r.winReason ? ' · 通关：' + r.winReason : ''}`;
    },
    noop() {},
    onDiceTap() { if (Date.now() >= (this._suppressTapUntil || 0)) this.roll(); },
    onTouchStart(e) { const t = e.touches && e.touches[0]; this._touchStart = t ? { x: t.clientX, y: t.clientY } : null; },
    onTouchEnd(e) {
      const t = e.changedTouches && e.changedTouches[0], start = this._touchStart; this._touchStart = null;
      if (this.data.testExpanded) return;
      if (start && t && start.y - t.clientY > 35 && Math.abs(start.x - t.clientX) < 100) { this._suppressTapUntil = Date.now() + 450; this.roll(); }
    },
    roll() {
      if (!this.data.visible || this.data.rolling || this.data.stage !== 'dice' || this._round.won) return;
      const result = nextRoll(this._round, this.properties.testMode);
      const target = FACE_ROTATIONS[result.lastFace - 1];
      this._beforeRollRotation = this._rotation.slice();
      this._rotation = [(Math.floor(this._rotation[0] / 360) + 3) * 360 + target[0], (Math.floor(this._rotation[1] / 360) + 4) * 360 + target[1]];
      this.setData({ rolling: true, cubeStyle: `transform:rotateX(${this._rotation[0]}deg) rotateY(${this._rotation[1]}deg);` });
      this.later(() => {
        this._beforeRollRotation = null; this._round = result;
        this.setData({ rolling: false, face: result.lastFace, streak: result.streak,
          streakNumbers: Array.from({ length: result.streak }, (_, id) => ({ id: `${result.rolls}-${id}`, face: result.lastFace })),
          dots: Array.from({ length: result.dots }, (_, id) => id), dotPulse: result.streak === 2 || result.streak === 3,
          diagnostics: this.diagnostics() });
        if (result.streak === 2) this.meow(1);
        if (result.streak === 3) this.meow(3);
        this.later(() => this.setData({ dotPulse: false }), 650);
        if (result.won) this.celebrate();
      }, 920);
    },
    meow(count) {
      const usedCorners = [];
      for (let i = 0; i < count; i++) this.later(() => {
        const id = ++this._meowId || (this._meowId = 1);
        // 以骰子区域为坐标系，在四角轮流出现；三声喵避免挤在同一处。
        const corners = [0, 1, 2, 3].filter(corner => corner !== this._meowCorner && !usedCorners.includes(corner));
        const corner = corners[Math.floor(Math.random() * corners.length)];
        usedCorners.push(corner);
        this._meowCorner = corner;
        const right = corner % 2 === 1, bottom = corner >= 2;
        const left = (right ? 71 : 5) + Math.random() * 3;
        const top = (bottom ? 72 : 16) + Math.random() * 5;
        const entryX = right ? 24 : -24;
        const entryY = bottom ? 18 : -18;
        const item = { id, style: `left:${left}%;top:${top}%;--entry-x:${entryX}rpx;--entry-y:${entryY}rpx;--drift:${Math.random() * 16 - 8}rpx;`, text: ['喵～', '喵~', '喵 :3'][Math.floor(Math.random() * 3)] };
        this.setData({ meows: this.data.meows.concat(item) });
        this.later(() => this.setData({ meows: this.data.meows.filter(m => m.id !== id) }), 1700);
      }, i * 260);
    },
    celebrate() {
      this.setData({ stage: 'celebrate', celebrating: true, confetti: confetti(), invitation: invitations[Math.floor(Math.random() * invitations.length)] });
      this.later(() => this.setData({ stage: 'ask' }), 1400);
      this.later(() => this.setData({ celebrating: false, confetti: [] }), 2400);
    },
    showAscii(index, preview = false) {
      const cat = Number.isInteger(index) && cats[index] ? cats[index] : encounters.pick('cat', cats);
      const selected = cats.indexOf(cat);
      this._currentPhoto = null;
      const catalog = cats.map(item => item.id);
      const progress = encounters.summary('cat', catalog), token = this._token;
      this.setData({ stage: 'ascii', asciiCat: cat, catIndex: selected, encounterSeen: progress.seen, encounterTotal: progress.total,
        topText: '喵，原来是你呀。', bottomText: this.rewardCaption('小猫用文字和你打了个招呼。', false, preview) }, () => {
        if (preview || !this.data.visible || this.data.stage !== 'ascii' || this.data.asciiCat.id !== cat.id || token !== this._token) return;
        const shown = encounters.record('cat', cat.id, catalog);
        this.setData({ encounterSeen: shown.seen, encounterTotal: shown.total });
      });
    },
    async showCat() {
      if (this.data.stage !== 'ask') return;
      const reward = this.testAllowed() ? this.data.rewardIndex : 0;
      if (reward === 2 || (!reward && this._round.winReason !== 'four' && Math.random() < ASCII_REWARD_CHANCE)) { this.showAscii(); return; }
      const token = ++this._token;
      const network = this.testAllowed() ? this.data.networkIndex : 0;
      this._currentPhoto = null;
      this.setData({ stage: 'loading', photoReady: false, photoSrc: '', encounterSeen: 0, encounterTotal: 0, topText: photos.DEFAULT_TOP, bottomText: photos.DEFAULT_BOTTOM });
      try {
        if (network === 4) { this.showAscii(); return; }
        if (network === 2) await new Promise(resolve => {
          this._pendingDelay = resolve;
          this.later(() => { this._pendingDelay = null; resolve(); }, 1600);
        });
        if (token !== this._token || !this.data.visible) return;
        let photo = network === 1
          ? await photos.withTimeout(photos.prepareCached(this._lastPhotoId), PHOTO_WAIT_MS).catch(() => null)
          : await photos.withTimeout(this._photoTask || photos.prepare(this._lastPhotoId), PHOTO_WAIT_MS).catch(() => null);
        if (token !== this._token || !this.data.visible) return;
        // 预加载失败时允许在领奖时有限重试一次；不重抽20%文字概率、不改通关规则。
        if (!photo && network !== 1) {
          photo = await photos.withTimeout(photos.prepare(this._lastPhotoId), PHOTO_WAIT_MS).catch(err => {
            diagnostics.record('easter_photo', 'reward_retry', err);
            return null;
          });
          if (token !== this._token || !this.data.visible) return;
        }
        if (!photo) { this.showAscii(); return; }
        if (network === 3) { this.later(() => { if (token === this._token) this.showAscii(); }, 400); return; }
        this._currentPhoto = photo;
        this.setData({ stage: 'photo', _photoId: photo.id, photoSrc: photo.path, topText: photo.topText,
          bottomText: this.rewardCaption(photo.bottomText, photo.hasCustomBottom !== false), photoReady: false,
          photoBoxHeight: PHOTO_BOX_DEFAULT });
        // 文件存在但解码/渲染迟迟不成功时也及时给出文字猫。
        this.later(() => { if (token === this._token && this.data.stage === 'photo' && !this.data.photoReady) this.showAscii(); }, 2500);
      } catch (_) { if (token === this._token && this.data.visible) this.showAscii(); }
    },
    onPhotoLoad(e) {
      if (!this.data.visible || this.data.stage !== 'photo' || this.data.photoReady || !this._currentPhoto) return;
      if (e && e.currentTarget && e.currentTarget.dataset.photoId !== this._currentPhoto.id) return;
      const photo = this._currentPhoto;
      this._lastPhotoId = photo.id;
      const progress = encounters.record('photo', photo.id, photo.catalogIds || [photo.id]);
      // 按图片真实宽高比决定展示框高度，避免比例不符时露底色；测量异常时退回默认值。
      const boxHeight = photoBoxHeightFor(e && e.detail);
      this.setData({
        photoReady: true,
        photoBoxHeight: boxHeight,
        encounterSeen: progress.seen,
        encounterTotal: progress.total
      });
      // 图片真正完成布局后再校准一次弹窗高度，避免"刚出现时还能滚动、点过大图才适配"。
      this.scheduleRelayout();
    },
    // 单独抽出来，方便测试替换为惰性实现（真实测量依赖 wx）。
    scheduleRelayout() { this.later(() => this.refreshLayout(), 50); },
    onPhotoError(e) {
      if (!this.data.visible || this.data.stage !== 'photo') return;
      if (e && e.currentTarget && this._currentPhoto && e.currentTarget.dataset.photoId !== this._currentPhoto.id) return;
      diagnostics.record('easter_photo', 'render', (e && e.detail && e.detail.errMsg) || 'render_failed');
      this.showAscii();
    },
    // 原生预览期间只挂起奖励：进入/返回都不结束本轮，照片、文案与遇见数保持原样。
    // 预览启动失败要立刻释放标记，否则之后真正离开页面时不再清理。
    async previewCat() {
      if (!this.data.visible || this.data.stage !== 'photo' || !this.data.photoReady || !this.data.photoSrc) return;
      if (this._previewing) return;
      this._previewing = true;
      this._previewStartedAt = Date.now();
      let src = this.data.photoSrc;
      // 展示用的可能是短期签名地址；预览前先换成本地文件，否则每次点开大图都要重新下载整张图（表现为一直转圈）。
      if (/^https?:/i.test(src) && this._currentPhoto && this._currentPhoto.fileID) {
        wx.showLoading({ title: '正在打开大图', mask: true });
        const fileID = this._currentPhoto.fileID;
        src = await photos.ensureLocal(fileID).catch(() => '');
        if (!src) src = await photos.refreshSignedUrl(fileID).catch(() => '');
        wx.hideLoading();
        if (!src) {
          this._previewing = false;
          this._previewStartedAt = 0;
          diagnostics.record('easter_photo', 'preview', 'local_unavailable');
          wx.showToast({ title: '图片暂时无法打开', icon: 'none' });
          return;
        }
        if (src !== this.data.photoSrc) this.setData({ photoSrc: src });
      }
      wx.previewImage({
        current: src,
        urls: [src],
        fail: () => { if (!this._previewSuspended) { this._previewing = false; this._previewStartedAt = 0; } }
      });
    },
    toggleTest() { if (this.testAllowed()) this.setData({ testExpanded: !this.data.testExpanded }); },
    onTestOption(e) {
      if (!this.testAllowed() || this.data.rolling) return;
      const field = e.currentTarget.dataset.field;
      if (!['scenarioIndex', 'pityIndex', 'rewardIndex', 'networkIndex', 'catIndex', 'invitationIndex', 'replyModeIndex', 'replyTemplateIndex'].includes(field)) return;
      this.setData({ [field]: Number(e.detail.value) });
      if (field === 'replyModeIndex') this.setData({ replyTemplates: this.data.replyModeIndex === 3 ? replies.songTemplates : replies.singerTemplates, replyTemplateIndex: 0 });
      if (field === 'replyModeIndex' || field === 'replyTemplateIndex') {
        this._personalReply = undefined;
        if (this.data.stage === 'ascii') this.showAscii(this.data.catIndex, true);
        if (this.data.stage === 'photo' && this._currentPhoto) {
          const photo = this._currentPhoto;
          this.setData({ bottomText: this.rewardCaption(photo.bottomText, photo.hasCustomBottom !== false, true) });
        }
      }
      if (field === 'scenarioIndex' || field === 'pityIndex') { this.resetRound(); this.later(() => this.refreshLayout(), 400); }
      if (field === 'catIndex' && this.data.stage === 'ascii') this.showAscii(this.data.catIndex, true);
      if (field === 'invitationIndex' && this.data.stage === 'ask') this.setData({ invitation: invitations[this.data.invitationIndex] });
    },
    testReset() { if (this.testAllowed()) { this.resetRound(); this.preloadPhoto(); this.later(() => this.refreshLayout(), 400); } },
    // 测试切换会清除开窗计时器，补一次入场后的校准，避免快速预览被缩放测量裁边。
    testAscii() { if (this.testAllowed()) { this.clearTimers(); this._token++; this.setData({ rolling: false, celebrating: false, meows: [] }); this.showAscii(this.data.catIndex, true); this.later(() => this.refreshLayout(), 400); } },
    testInvitation() { if (this.testAllowed()) { this.clearTimers(); this._token++; this.setData({ stage: 'ask', rolling: false, celebrating: false, meows: [], invitation: invitations[this.data.invitationIndex] }); this.later(() => this.refreshLayout(), 400); } },
    testGate(e) {
      if (!this.testAllowed()) return;
      this.close(); this.triggerEvent('resetgate', { normal: e.currentTarget.dataset.normal === true });
    }
  }
}));
