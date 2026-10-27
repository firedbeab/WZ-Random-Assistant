const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const { createDataScope, canUseTestData } = require('./dataScope');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGES = 10;
const SAFETY_CHUNK_LENGTH = 1500;
const IMAGE_URL_MAX_AGE = 600;
const recentErrors = new Map();

async function recordServerError(scope, action, err) {
  const allowed = ['listPublished', 'getImageAccess', 'listAll', 'getForAdmin', 'initializeDefaults', 'uploadImage',
    'verifyUploadedImage', 'deleteFiles', 'save', 'setPublished', 'reorder', 'delete'];
  const operation = allowed.includes(action) ? action : 'unknown';
  const error = Number.isInteger(err && err.errCode) ? `SDK_${err.errCode}` : 'BACKEND_UNAVAILABLE';
  const entry = { source: 'server', module: 'manageHelpContent', action: `help.${operation}`, error,
    data_scope: scope.testMode ? 'test' : 'production' };
  console.warn('[使用说明] 后端异常', entry);
  const key = `${scope.prefix}${operation}`;
  if (Date.now() - (recentErrors.get(key) || 0) < 60000) return;
  recentErrors.set(key, Date.now());
  try {
    await db.collection(scope.collection('system_events')).add({ data: {
      ...entry, category: 'system_error', severity: 'error', created_at: db.serverDate()
    } });
  } catch (_) { console.warn('[使用说明] 错误事件写入失败'); }
}

const DEFAULT_ARTICLES = [
  {
    title: '开放时间与验证码',
    summary: '什么时候可以提交，以及验证码无法使用时怎么办',
    content: '提交通道通常在每周日 8:00-20:00 开放，具体状态请以首页显示为准。\n\n提交时需要使用广播站当周提供的有效验证码。如果验证码无法通过，请检查是否输入完整、是否已经过期，或联系广播站管理员确认。'
  },
  {
    title: '如何提交',
    summary: '完成一次点歌提交的基本步骤',
    content: '1. 在首页确认通道处于开放状态。\n2. 输入本周验证码。\n3. 填写内容名称和补充说明。\n4. 如有版本、时间或其他要求，可填写特殊备注。\n5. 点击“提交”，看到成功提示即表示提交完成。\n\n同一微信用户每周只能完成一次有效提交，请在提交前认真检查内容。'
  },
  {
    title: '各项内容如何填写',
    summary: '内容名称、补充说明和特殊备注的填写建议',
    content: '内容名称：填写歌曲名称，尽量使用完整、准确的名称。\n\n补充说明：建议填写歌手、演唱者或便于管理员识别的信息。\n\n特殊备注：选填。可填写指定版本、希望使用的音源或其他必要说明；没有特殊要求时可以留空。'
  },
  {
    title: '提交后会发生什么',
    summary: '抽取、审核与发布并不是同时完成',
    content: '提交成功后，首页会显示“已提交，请等待抽取”。周日晚通道关闭后，系统会进行随机抽取并生成待审核列表。\n\n管理员完成审核后才会发布最终列表，因此提交成功不代表一定会被抽中，也不会立即出现在已发布列表中。'
  },
  {
    title: '查看已发布列表',
    summary: '查看本期及往期排期',
    content: '在首页点击“查看已发布列表”即可进入列表页面。最新列表发布后，首页会显示提示。\n\n列表页面支持切换查看近期已发布内容；长按单条内容可以复制。若本周尚未发布，请稍后再查看。'
  },
  {
    title: '开启发布通知',
    summary: '列表发布后接收微信订阅消息',
    content: '进入已发布列表页面后，可以点击通知卡片开启本周发布通知。微信弹出授权窗口时请选择允许。\n\n订阅通知按次授权，消息发送后会被消耗；如需下一期通知，请再次进入页面开启。未收到消息时，也可以直接打开小程序查看最新列表。'
  },
  {
    title: '常见问题',
    summary: '提交状态、换设备和通知相关问题',
    content: '换设备后看不到提交状态：请确认使用的是同一个微信账号，并重新进入首页等待数据加载。\n\n通道显示关闭：默认只在规定时间开放，首页状态为最终依据。\n\n提交后未出现在列表：提交内容需要经过随机抽取和管理员审核，未被抽中不会进入最终列表。\n\n没有收到发布通知：请确认本周已主动开启通知，并允许微信发送订阅消息。'
  }
];

function success(data, extra = {}) {
  return Object.assign({ success: true, data }, extra);
}

function failure(message) {
  return { success: false, message };
}

function normalizeText(value, maxLength, required = false) {
  if (typeof value !== 'string') return required ? null : '';
  const text = value.trim();
  if ((required && !text) || text.length > maxLength) return null;
  return text;
}

function isHelpFile(fileID, scope) {
  if (typeof fileID !== 'string' || fileID.length > 1024) return false;
  const match = /^cloud:\/\/([^/]+)\/(.+)$/.exec(fileID);
  const env = cloud.getWXContext().ENV;
  return Boolean(match && env && (match[1] === env || match[1].startsWith(`${env}.`)) &&
    new RegExp(`^${scope.testMode ? 'test/' : ''}help/[a-zA-Z0-9_-]+\\.(jpg|jpeg|png|webp)$`).test(match[2]));
}

function normalizeImages(images, scope) {
  if (!Array.isArray(images) || images.length > MAX_IMAGES) return null;
  if (!images.every(fileID => isHelpFile(fileID, scope))) return null;
  return Array.from(new Set(images));
}

function detectImageExtension(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpg';
  }
  if (buffer.length >= 8 && buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  if (buffer.length >= 12 && buffer.slice(0, 4).toString() === 'RIFF' && buffer.slice(8, 12).toString() === 'WEBP') {
    return 'webp';
  }
  return '';
}

async function getRole(openid, usersCollection) {
  if (!openid) return 'user';
  const res = await db.collection(usersCollection)
    .where({ openid })
    .limit(1)
    .get();
  return res.data.length > 0 ? res.data[0].role : 'user';
}

async function requireSuperAdmin(openid, usersCollection) {
  return (await getRole(openid, usersCollection)) === 'superadmin';
}

function publicArticle(article, scope) {
  return {
    _id: article._id,
    title: article.title || '',
    summary: article.summary || '',
    content: article.content || '',
    images: Array.isArray(article.images) ? article.images.filter(fileID => isHelpFile(fileID, scope)) : [],
    sort_order: Number(article.sort_order) || 0
  };
}

function sortArticles(articles) {
  return articles.slice().sort((a, b) => {
    const orderDiff = (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
    if (orderDiff !== 0) return orderDiff;
    return String(a._id || '').localeCompare(String(b._id || ''));
  });
}

async function deleteHelpFiles(fileIDs, scope) {
  const safeFiles = Array.from(new Set((fileIDs || []).filter(fileID => isHelpFile(fileID, scope))));
  if (safeFiles.length === 0) return;
  try {
    // 保护其他说明（含草稿）的共享引用；删除/保存后重新查询，不能仅依赖页面传来的清理列表。
    const res = await db.collection(scope.collection('help_articles')).limit(100).get();
    if (res.data.length === 100) {
      console.warn('[使用说明] 引用查询达到上限，跳过文件清理');
      return;
    }
    const used = new Set(res.data.flatMap(article => Array.isArray(article.images) ? article.images : []));
    const unused = safeFiles.filter(fileID => !used.has(fileID));
    if (unused.length) await cloud.deleteFile({ fileList: unused });
  } catch (err) {
    await recordServerError(scope, 'deleteFiles', err);
  }
}

async function validateUploadedImages(fileIDs, scope) {
  const results = await Promise.all(fileIDs.map(async fileID => {
    try {
      const download = await cloud.downloadFile({ fileID });
      const fileContent = download && download.fileContent;
      if (!Buffer.isBuffer(fileContent) || !fileContent.length || fileContent.length > MAX_IMAGE_BYTES) {
        return { passed: false, message: '图片大小不能超过2MB' };
      }
      if (!detectImageExtension(fileContent)) {
        return { passed: false, message: '仅支持 JPG、PNG 或 WebP 图片' };
      }
      return { passed: true };
    } catch (err) {
      await recordServerError(scope, 'verifyUploadedImage', err);
      return { passed: false, message: '图片校验失败，请重试' };
    }
  }));
  return results.find(result => !result.passed) || { passed: true };
}

async function checkPublishedText(openid, fields, scope) {
  const text = fields.filter(value => typeof value === 'string' && value.trim())
    .map(value => value.trim())
    .join('\n');
  const chunks = [];
  for (let start = 0; start < text.length; start += SAFETY_CHUNK_LENGTH) {
    chunks.push(text.slice(start, start + SAFETY_CHUNK_LENGTH));
  }

  try {
    for (const content of chunks) {
      const result = await cloud.openapi.security.msgSecCheck({
        openid,
        scene: 2,
        version: 2,
        content
      });
      const suggest = result && result.result && result.result.suggest;
      if (suggest && suggest !== 'pass') {
        return { passed: false, unavailable: false };
      }
    }
    return { passed: true, unavailable: false };
  } catch (err) {
    await recordServerError(scope, 'setPublished', err);
    return { passed: false, unavailable: true };
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const action = event && event.action;
  const scope = createDataScope(event);
  const collectionName = scope.collection('help_articles');
  const usersCollection = scope.collection('users');

  try {
    if (!(await canUseTestData(db, OPENID, scope))) {
      return { ...failure('仅超级管理员可使用测试环境'), code: 'TEST_ACCESS_DENIED' };
    }
    if (action === 'listPublished') {
      const res = await db.collection(collectionName)
        .limit(100)
        .get();
      const published = sortArticles(res.data.filter(article => article.is_published === true));
      return success(published.map(article => publicArticle(article, scope)));
    }
    if (action === 'getImageAccess') {
      if (!OPENID) return { success: false, code: 'UNAUTHENTICATED', message: '无法确认用户身份' };
      if (!Array.isArray(event.fileIDs) || !event.fileIDs.length || event.fileIDs.length > 10 ||
          !event.fileIDs.every(fileID => isHelpFile(fileID, scope))) {
        return { success: false, code: 'INVALID_IMAGE_REQUEST', message: '图片请求无效' };
      }
      const fileIDs = Array.from(new Set(event.fileIDs));
      const res = await db.collection(collectionName).limit(100).get();
      const published = new Set(res.data.filter(article => article.is_published === true)
        .flatMap(article => publicArticle(article, scope).images));
      if (!fileIDs.every(fileID => published.has(fileID))) {
        return { success: false, code: 'IMAGE_NOT_AVAILABLE', message: '图片已下架或不可访问' };
      }
      const issuedAt = Date.now();
      const signed = await cloud.getTempFileURL({ fileList: fileIDs.map(fileID => ({ fileID, maxAge: IMAGE_URL_MAX_AGE })) });
      const files = fileIDs.map(fileID => {
        const item = (signed.fileList || []).find(file => file.fileID === fileID);
        // 旧服务端SDK可能不回传maxAge，使用本次实际传给平台的固定有效期。
        const maxAge = item && item.maxAge === undefined ? IMAGE_URL_MAX_AGE : item && item.maxAge;
        if (!item || item.status !== 0 || typeof item.tempFileURL !== 'string' || !/^https:\/\/[^\s]+$/.test(item.tempFileURL) ||
            !Number.isInteger(maxAge) || maxAge <= 0 || maxAge > IMAGE_URL_MAX_AGE) {
          throw new Error('IMAGE_URL_UNAVAILABLE');
        }
        return { fileID, url: item.tempFileURL, maxAge, expiresAt: issuedAt + maxAge * 1000 };
      });
      return success({ files });
    }

    if (!await requireSuperAdmin(OPENID, usersCollection)) {
      return { ...failure('仅超级管理员可执行此操作'), code: 'FORBIDDEN' };
    }

    if (action === 'listAll') {
      const res = await db.collection(collectionName)
        .limit(100)
        .get();
      return success(sortArticles(res.data).map(article => ({
        _id: article._id,
        title: article.title || '',
        summary: article.summary || '',
        images: Array.isArray(article.images) ? article.images.filter(fileID => isHelpFile(fileID, scope)) : [],
        is_published: Boolean(article.is_published),
        sort_order: Number(article.sort_order) || 0
      })));
    }

    if (action === 'initializeDefaults') {
      const countRes = await db.collection(collectionName).count();
      if (countRes.total > 0) return failure('已有说明内容，无需初始化');
      await Promise.all(DEFAULT_ARTICLES.map((article, index) => db.collection(collectionName).add({
        data: Object.assign({}, article, {
          images: [],
          is_published: true,
          sort_order: index + 1,
          created_at: db.serverDate(),
          updated_at: db.serverDate(),
          created_by: OPENID,
          updated_by: OPENID
        })
      })));
      return success(null);
    }

    if (action === 'getForAdmin') {
      const articleId = normalizeText(event.articleId, 64, true);
      if (!articleId) return failure('说明条目标识无效');
      const res = await db.collection(collectionName).doc(articleId).get();
      return success({
        _id: res.data._id,
        title: res.data.title || '',
        summary: res.data.summary || '',
        content: res.data.content || '',
        images: Array.isArray(res.data.images) ? res.data.images.filter(fileID => isHelpFile(fileID, scope)) : [],
        is_published: Boolean(res.data.is_published),
        sort_order: Number(res.data.sort_order) || 0
      });
    }

    if (action === 'uploadImage') {
      const base64 = typeof event.base64 === 'string' ? event.base64 : '';
      if (!base64 || base64.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8) {
        return failure('图片大小不能超过2MB');
      }
      const fileContent = Buffer.from(base64, 'base64');
      if (!fileContent.length || fileContent.length > MAX_IMAGE_BYTES) {
        return failure('图片大小不能超过2MB');
      }
      const detectedExtension = detectImageExtension(fileContent);
      if (!detectedExtension) return failure('仅支持 JPG、PNG 或 WebP 图片');
      const fileName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${detectedExtension}`;
      const upload = await cloud.uploadFile({
        cloudPath: `${scope.testMode ? 'test/help' : 'help'}/${fileName}`,
        fileContent
      });
      return success(null, { fileID: upload.fileID });
    }

    if (action === 'verifyUploadedImage') {
      const fileID = normalizeText(event.fileID, 1024, true);
      if (!fileID || !isHelpFile(fileID, scope)) return failure('图片路径无效');
      const validation = await validateUploadedImages([fileID], scope);
      if (!validation.passed) {
        await deleteHelpFiles([fileID], scope);
        return failure(validation.message);
      }
      return success(null, { fileID });
    }

    if (action === 'deleteFiles') {
      const fileIDs = normalizeImages(event.fileIDs || [], scope);
      if (fileIDs === null) return failure('图片列表无效');
      await deleteHelpFiles(fileIDs, scope);
      return success(null);
    }

    if (action === 'save') {
      if (Array.isArray(event.images) && event.images.length > MAX_IMAGES) {
        return failure('每条说明最多添加10张图片');
      }
      const articleId = normalizeText(event.articleId || '', 64, false);
      const title = normalizeText(event.title, 40, true);
      const summary = normalizeText(event.summary || '', 80, false);
      const content = normalizeText(event.content, 5000, true);
      const images = normalizeImages(event.images || [], scope);
      const newImageIDs = normalizeImages(event.newImageIDs || [], scope);
      if (!title || summary === null || !content || images === null || newImageIDs === null ||
        !newImageIDs.every(fileID => images.includes(fileID))) {
        return failure('说明内容格式不正确');
      }
      const isPublished = Boolean(event.isPublished);
      // 新图片文件校验与文本内容安全检查相互独立，可以并行。
      const [imageValidation, safety] = await Promise.all([
        validateUploadedImages(newImageIDs, scope),
        isPublished
          ? (scope.testMode
            ? Promise.resolve({ passed: true, unavailable: false })
            : checkPublishedText(OPENID, [title, summary, content], scope))
          : Promise.resolve({ passed: true, unavailable: false })
      ]);
      if (!imageValidation.passed) {
        await deleteHelpFiles(newImageIDs, scope);
        return failure(imageValidation.message);
      }
      if (isPublished) {
        if (safety.unavailable) return failure('内容安全检查暂不可用，请稍后再试');
        if (!safety.passed) return failure('说明内容可能包含不适宜信息，请修改后重试');
      }
      const commonData = {
        title,
        summary,
        content,
        images,
        is_published: isPublished,
        updated_at: db.serverDate(),
        updated_by: OPENID
      };

      if (articleId) {
        const oldRes = await db.collection(collectionName).doc(articleId).get();
        const oldImages = Array.isArray(oldRes.data.images) ? oldRes.data.images : [];
        await db.collection(collectionName).doc(articleId).update({ data: commonData });
        await deleteHelpFiles(oldImages.filter(fileID => !images.includes(fileID)), scope);
        return success({ _id: articleId });
      }

      const existingRes = await db.collection(collectionName).limit(100).get();
      const sortOrder = existingRes.data.reduce(
        (maxOrder, article) => Math.max(maxOrder, Number(article.sort_order) || 0),
        0
      ) + 1;
      const addRes = await db.collection(collectionName).add({
        data: Object.assign({}, commonData, {
          sort_order: sortOrder,
          created_at: db.serverDate(),
          created_by: OPENID
        })
      });
      return success({ _id: addRes._id });
    }

    if (action === 'setPublished') {
      const articleId = normalizeText(event.articleId, 64, true);
      if (!articleId) return failure('说明条目标识无效');
      const isPublished = Boolean(event.isPublished);
      if (isPublished) {
        const articleRes = await db.collection(collectionName).doc(articleId).get();
        const article = articleRes.data;
        const safety = scope.testMode
          ? { passed: true, unavailable: false }
          : await checkPublishedText(OPENID, [article.title, article.summary, article.content], scope);
        if (safety.unavailable) return failure('内容安全检查暂不可用，请稍后再试');
        if (!safety.passed) return failure('说明内容可能包含不适宜信息，请修改后重试');
      }
      await db.collection(collectionName).doc(articleId).update({
        data: {
          is_published: isPublished,
          updated_at: db.serverDate(),
          updated_by: OPENID
        }
      });
      return success(null);
    }

    if (action === 'reorder') {
      const articleId = normalizeText(event.articleId, 64, true);
      const direction = event.direction;
      if (!articleId || !['up', 'down'].includes(direction)) {
        return failure('排序参数无效');
      }
      const res = await db.collection(collectionName)
        .limit(100)
        .get();
      const items = sortArticles(res.data);
      const index = items.findIndex(item => item._id === articleId);
      const target = direction === 'up' ? index - 1 : index + 1;
      if (index < 0 || target < 0 || target >= items.length) return success(null);
      [items[index], items[target]] = [items[target], items[index]];
      await Promise.all(items.map((item, order) => db.collection(collectionName).doc(item._id).update({
        data: { sort_order: order + 1 }
      })));
      return success(null);
    }

    if (action === 'delete') {
      const articleId = normalizeText(event.articleId, 64, true);
      if (!articleId) return failure('说明条目标识无效');
      const res = await db.collection(collectionName).doc(articleId).get();
      const images = Array.isArray(res.data.images) ? res.data.images : [];
      await db.collection(collectionName).doc(articleId).remove();
      await deleteHelpFiles(images, scope);
      return success(null);
    }

    return failure('不支持的操作');
  } catch (err) {
    await recordServerError(scope, action, err);
    return { ...failure('操作失败，请稍后重试'), code: 'BACKEND_UNAVAILABLE' };
  }
};
