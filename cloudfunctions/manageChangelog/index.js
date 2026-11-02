// BEGIN shared text safety: only an explicit pass may be published.
async function checkTextSafety(cloud, openid, content, testMode = false) {
  if (testMode || !content.trim()) return { passed: true, unavailable: false };
  const unavailable = { passed: false, unavailable: true, code: 'SAFETY_UNAVAILABLE', message: '内容检查暂时不可用，请稍后重试；填写内容已保留' };
  try {
    const result = await cloud.openapi.security.msgSecCheck({ openid, scene: 2, version: 2, content });
    if (!result || (result.errCode !== undefined && result.errCode !== 0)) return unavailable;
    const suggest = result.result && result.result.suggest;
    if (suggest === 'pass') return { passed: true, unavailable: false };
    if (suggest === 'risky' || suggest === 'review') return { passed: false, unavailable: false, code: 'CONTENT_REJECTED', message: '内容未通过安全检查，请修改后重试' };
    return unavailable;
  } catch (error) {
    const sdkCode = error && Number.isInteger(error.errCode) ? error.errCode : 'UNKNOWN';
    console.warn('[内容安全] 检查未完成', { code: sdkCode });
    return { ...unavailable, sdkCode };
  }
}
// END shared text safety.

// Read-only health check: production superadmin only, never bypasses safety in test mode.
async function probeTextSafety(event, openid) {
  if (!event || event.action !== 'checkTextSafety') return null;
  if (!await isProductionSuperadmin(db, openid)) return { success: false, code: 'FORBIDDEN', message: '无权限访问' };
  if (typeof event.content !== 'string' || !event.content.trim() || event.content.length > 300) return { success: false, message: '请输入1至300字的检查内容' };
  return { success: true, data: await checkTextSafety(cloud, openid, event.content.trim(), false) };
}

const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const { createDataScope, canUseTestData, isProductionSuperadmin } = require('./dataScope');

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
  const entry = { source: 'server', module: 'manageChangelog', action: `changelog.${operation}`, error,
    data_scope: scope.testMode ? 'test' : 'production' };
  console.warn('[更新日志] 后端异常', entry);
  const key = `${scope.prefix}${operation}`;
  if (Date.now() - (recentErrors.get(key) || 0) < 60000) return;
  recentErrors.set(key, Date.now());
  try {
    await db.collection(scope.collection('system_events')).add({ data: {
      ...entry, category: 'system_error', severity: 'error', created_at: db.serverDate()
    } });
  } catch (_) { console.warn('[更新日志] 错误事件写入失败'); }
}

const DEFAULT_ARTICLES = [];

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
    new RegExp(`^${scope.testMode ? 'test/' : ''}changelog/[a-zA-Z0-9_-]+\\.(jpg|jpeg|png|webp)$`).test(match[2]));
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
  return isProductionSuperadmin(db, openid);
}

function publicArticle(article, scope) {
  return {
    _id: article._id,
    title: article.title || '',
    summary: article.summary || '',
    content: article.content || '',
    images: Array.isArray(article.images) ? article.images.filter(fileID => isHelpFile(fileID, scope)) : [],
    sort_order: Number(article.sort_order) || 0, version: article.version || '', release_date: article.release_date || '', revision: article.revision || 1
  };
}

function sortArticles(articles) {
  return articles.slice().sort((a, b) => {
    const dateDiff=String(b.release_date||'').localeCompare(String(a.release_date||''));if(dateDiff)return dateDiff;
    const orderDiff = (Number(b.sort_order) || 0) - (Number(a.sort_order) || 0);
    if (orderDiff !== 0) return orderDiff;
    return String(a._id || '').localeCompare(String(b._id || ''));
  });
}

async function deleteHelpFiles(fileIDs, scope) {
  const safeFiles = Array.from(new Set((fileIDs || []).filter(fileID => isHelpFile(fileID, scope))));
  if (safeFiles.length === 0) return;
  try {
    // 保护其他说明（含草稿）的共享引用；删除/保存后重新查询，不能仅依赖页面传来的清理列表。
    const res = await db.collection(scope.collection('changelog_articles')).limit(100).get();
    if (res.data.length === 100) {
      console.warn('[更新日志] 引用查询达到上限，跳过文件清理');
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
      const safety = await checkTextSafety(cloud, openid, content, false);
      if (!safety.passed) return safety;
    }
    return { passed: true, unavailable: false };
  } catch (err) {
    await recordServerError(scope, 'setPublished', err);
    return { passed: false, unavailable: true };
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const probe = await probeTextSafety(event, OPENID); if (probe) return probe;
  const action = event && event.action;
  const scope = createDataScope(event);
  const collectionName = scope.collection('changelog_articles');
  const usersCollection = scope.collection('users');

  try {
    if (!(await canUseTestData(db, OPENID, scope))) {
      return { ...failure('仅超级管理员可使用测试环境'), code: 'TEST_ACCESS_DENIED' };
    }
    if(action==='getCapabilities')return success({canEdit:await requireSuperAdmin(OPENID,usersCollection)});
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
        sort_order: Number(article.sort_order) || 0, version:article.version || '', release_date:article.release_date || '', revision:article.revision || 1
      })));
    }

    if (action === 'initializeDefaults') return failure('请手动新建真实版本日志，不自动生成示例');
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
        sort_order: Number(res.data.sort_order) || 0, version:res.data.version || '', release_date:res.data.release_date || '', revision:res.data.revision || 1
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
        cloudPath: `${scope.testMode ? 'test/changelog' : 'changelog'}/${fileName}`,
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
      const version=normalizeText(event.version,24,true),releaseDate=normalizeText(event.releaseDate,10,true);
      if(!version||!/^v?\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?$/.test(version)||!releaseDate||!/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)||!Number.isFinite(Date.parse(releaseDate+'T00:00:00Z'))||new Date(releaseDate+'T00:00:00Z').toISOString().slice(0,10)!==releaseDate)return failure('请填写有效版本号和发布日期');
      if (Array.isArray(event.images) && event.images.length > MAX_IMAGES) {
        return failure('每条日志最多添加10张图片');
      }
      const articleId = normalizeText(event.articleId || '', 64, false);
      const title = normalizeText(event.title, 40, true);
      const summary = normalizeText(event.summary || '', 80, false);
      const content = normalizeText(event.content, 5000, true);
      const images = normalizeImages(event.images || [], scope);
      const newImageIDs = normalizeImages(event.newImageIDs || [], scope);
      if (!title || summary === null || !content || images === null || newImageIDs === null ||
        !newImageIDs.every(fileID => images.includes(fileID))) {
        return failure('日志内容格式不正确');
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
        if (!safety.passed) return failure('日志内容可能包含不适宜信息，请修改后重试');
      }
      const commonData = {
        version,release_date:releaseDate,revision:1,
        title,
        summary,
        content,
        images,
        is_published: isPublished,
        updated_at: db.serverDate(),
        updated_by: OPENID
      };

      if (articleId) {
        const tx=await db.startTransaction();let oldImages=[];
        try{const oldRes=await tx.collection(collectionName).doc(articleId).get();if(!oldRes.data||event.revision!==(oldRes.data.revision||1)){await tx.rollback();return {...failure('日志已被其他管理员修改，请返回刷新后再编辑'),code:'CONFLICT'};}oldImages=Array.isArray(oldRes.data.images)?oldRes.data.images:[];await tx.collection(collectionName).doc(articleId).update({data:{...commonData,revision:(oldRes.data.revision||1)+1}});await tx.commit();}catch(err){try{await tx.rollback();}catch(_){}throw err;}
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

    return failure('不支持的操作');
  } catch (err) {
    await recordServerError(scope, action, err);
    return { ...failure('操作失败，请稍后重试'), code: 'BACKEND_UNAVAILABLE' };
  }
};
