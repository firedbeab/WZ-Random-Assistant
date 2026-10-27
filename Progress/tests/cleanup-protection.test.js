// 测试域全量清理的保护契约：白名单、通道开关、彩蛋配置与审计不能被清掉。
// 这几份文档属于「环境配置」而不是「业务数据」，清掉会让测试域进不去、通道状态错乱、
// 彩蛋无内容。2026-10-27 实际发生过的故障就是清理把白名单删了。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let checks = 0;
function check(actual, expected, label) { assert.equal(actual, expected, label); checks++; }

const src = fs.readFileSync(path.join(__dirname, '../../cloudfunctions/testTool/index.js'), 'utf8');

// 1) 保留清单存在且包含四份关键配置
check(/const PRESERVED_CONFIG_DOCS = \[/.test(src), true, '存在保留清单常量');
['test_accounts_v1', 'channel_override', 'easter_eggs_v1', 'test_tool_cleanup_audit'].forEach(name => {
  check(src.includes(`'${name}'`), true, `保留清单包含 ${name}`);
});

// 2) 清理与预览都走同一个排除条件（避免"预览说清 N 条、实际清 N-4 条"的不一致）
const guardUses = (src.match(/configCleanupWhere\(\)/g) || []).length;
check(guardUses >= 2, true, '预览与清理共用同一个排除条件');
check(/_id: _\.nin\(PRESERVED_CONFIG_DOCS\)/.test(src), true, '排除条件按 _id 做 nin 过滤');

// 3) configs 不再是"无条件全清"的分支
const loopBlock = src.slice(src.indexOf('for (const baseName of ALL_CLEANUP_BASE_COLLECTIONS)'));
const loopEnd = loopBlock.indexOf('await db.collection(usersCollection)');
const loop = loopBlock.slice(0, loopEnd > 0 ? loopEnd : 1200);
check(loop.includes("if (baseName === 'configs')"), true, '清理循环里 configs 有独立分支');
check(/removeAll\(dataScope\.collection\(baseName\), configCleanupWhere\(\)\)/.test(loop), true, 'configs 分支使用排除条件');

// 4) 保留数量写进审计详情，便于事后核对
check(src.includes('details.configs_preserved'), true, '审计详情记录保留数量');

console.log(`PASS: ${checks} cleanup-protection assertions; 白名单/通道开关/彩蛋配置/审计在测试域全量清理时被保留`);
