const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { audit, LIMIT_BYTES } = require('../check-package.cjs');
const root = path.resolve(__dirname, '../..');

test('发布包排除文档/截图/测试/备份/云函数，所有运行时依赖仍完整且小于1.5MB预算', () => {
  const template = JSON.parse(fs.readFileSync(path.join(root, 'project.config.example.json'), 'utf8'));
  const report = audit(root, template);
  assert.equal(LIMIT_BYTES, 1500000);
  assert(report.sourceBytes < LIMIT_BYTES);
  assert(report.files.some(file => file.path === 'utils/theme.js'));
  assert(report.files.some(file => file.path === 'theme.json'));
  const localFile = path.join(root, 'project.config.json');
  if (fs.existsSync(localFile)) assert.deepEqual(JSON.parse(fs.readFileSync(localFile, 'utf8')).packOptions, template.packOptions);
});
