// cloudfunctions/manageAdmins/index.js
const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

function isValidDocId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

exports.main = async (event, context) => {
  const { action } = event;
  const { OPENID } = cloud.getWXContext();

  // ===== 权限校验：仅超级管理员可操作 =====
  if (!OPENID) {
    return { success: false, message: '需要用户身份验证' };
  }
  const userRes = await db.collection('users')
    .where({ openid: OPENID }).limit(1).get();
  if (userRes.data.length === 0 || userRes.data[0].role !== 'superadmin') {
    return { success: false, message: '无权限访问' };
  }

  // ========== 通行码管理 ==========

  // 1. 列出所有通行码
  if (action === 'listPasscodes') {
    try {
      const res = await db.collection('admin_passcodes')
        .orderBy('created_at', 'desc')
        .get();
      const list = res.data.map(pc => ({
        _id: pc._id,
        label: pc.label,
        code_preview: pc.code_preview,
        created_at: pc.created_at
      }));
      return { success: true, data: list };
    } catch (err) {
      console.warn('[管理员] 查询通行码失败:', err.message || '未知错误');
      return { success: false, message: '查询失败，请稍后重试' };
    }
  }

  // 2. 生成新通行码
  if (action === 'addPasscode') {
    const { label } = event;
    if (typeof label !== 'string' || !label.trim()) {
      return { success: false, message: '请输入描述标签' };
    }
    if (label.trim().length > 40) {
      return { success: false, message: '描述标签不能超过40个字符' };
    }

    try {
      // 生成 6 位大写字母+数字
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let code = '';
      for (let i = 0; i < 6; i++) {
        code += chars[crypto.randomInt(chars.length)];
      }

      // 脱敏预览
      const preview = code.substring(0, 2) + '***' + code.substring(5);

      // bcrypt 哈希
      const hash = bcrypt.hashSync(code, 10);

      // 存储
      await db.collection('admin_passcodes').add({
        data: {
          code_hash: hash,
          code_preview: preview,
          label: label.trim(),
          created_at: db.serverDate(),
          created_by: OPENID
        }
      });

      // 返回明文（仅此一次）
      return { success: true, message: '通行码已创建', code: code, preview: preview };
    } catch (err) {
      console.warn('[管理员] 创建通行码失败:', err.message || '未知错误');
      return { success: false, message: '创建失败，请稍后重试' };
    }
  }

  // 3. 删除通行码
  if (action === 'deletePasscode') {
    const { passcodeId } = event;
    if (!isValidDocId(passcodeId)) {
      return { success: false, message: '参数缺失' };
    }

    try {
      await db.collection('admin_passcodes').doc(passcodeId).remove();
      return { success: true, message: '通行码已删除' };
    } catch (err) {
      console.warn('[管理员] 删除通行码失败:', err.message || '未知错误');
      return { success: false, message: '删除失败，请稍后重试' };
    }
  }

  // ========== 管理员管理 ==========

  // 4. 列出管理员
  if (action === 'listAdmins') {
    try {
      const res = await db.collection('users')
        .where({ role: _.in(['admin', 'superadmin']) })
        .orderBy('last_admin_verify', 'desc')
        .get();

      const list = res.data.map(u => ({
        openid: u.openid,
        role: u.role,
        admin_label: u.admin_label || '',
        last_admin_verify: u.last_admin_verify,
        created_at: u.created_at
      }));

      return { success: true, data: list };
    } catch (err) {
      console.warn('[管理员] 查询管理员失败:', err.message || '未知错误');
      return { success: false, message: '查询失败，请稍后重试' };
    }
  }

  // 5. 撤销管理员身份
  if (action === 'revokeAdmin') {
    const { targetOpenid } = event;
    if (typeof targetOpenid !== 'string' || !targetOpenid || targetOpenid.length > 128) {
      return { success: false, message: '参数缺失' };
    }

    // 不允许撤销自己
    if (targetOpenid === OPENID) {
      return { success: false, message: '不能撤销自己的超管身份' };
    }

    try {
      await db.collection('users')
        .where({ openid: targetOpenid })
        .update({
          data: {
            role: 'user',
            revoked_at: db.serverDate()
          }
        });

      return { success: true, message: '管理员身份已撤销' };
    } catch (err) {
      console.warn('[管理员] 撤销身份失败:', err.message || '未知错误');
      return { success: false, message: '撤销失败，请稍后重试' };
    }
  }

  return { success: false, message: '未知操作' };
};
