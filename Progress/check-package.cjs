// 本地源文件预算与运行时依赖检查；编译后的实际体积仍以开发者工具代码分析为准。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const LIMIT_BYTES = 1500000; // 使用十进制1.5MB，比1.5MiB更严格。
const normalize = value => value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '').toLowerCase();

function matches(file, rule) {
  const name = normalize(file), value = normalize(rule.value);
  switch (rule.type) {
    case 'folder': return name === value || name.startsWith(value + '/');
    case 'file': return name === value;
    case 'suffix': return name.endsWith(value);
    case 'prefix': return name.startsWith(value);
    case 'regexp': return new RegExp(rule.value, 'i').test(file.replace(/\\/g, '/'));
    default: throw new Error(`未支持的打包规则 ${rule.type}，请先更新检查器，不能静默低估包体。`);
  }
}
function audit(root, config) {
  const ignore = config.packOptions && config.packOptions.ignore || [], include = config.packOptions && config.packOptions.include || [];
  const kept = file => include.some(rule => matches(file, rule)) || !ignore.some(rule => matches(file, rule));
  const files = [];
  function walk(relative = '') {
    for (const item of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const file = path.posix.join(relative, item.name);
      if (item.isSymbolicLink()) throw new Error('请人工核验符号链接：' + file);
      if (item.isDirectory()) {
        if (!include.length && ignore.some(rule => rule.type === 'folder' && matches(file, rule))) continue;
        walk(file);
      } else if (kept(file)) files.push({ path: file, bytes: fs.statSync(path.join(root, file)).size });
    }
  }
  walk();
  const names = new Set(files.map(file => file.path));
  const requireFile = file => assert(names.has(file), `运行时依赖被排除或丢失：${file}`);
  const resolve = (from, request, suffix) => {
    const location = request.startsWith('/') ? path.resolve(root, '.' + request) : path.resolve(root, path.dirname(from), request);
    let relative = path.relative(root, location).replace(/\\/g, '/');
    assert(!relative.startsWith('../'), '依赖不能越出项目：' + from);
    if (suffix) relative += suffix;
    else if (!path.extname(relative)) relative += '.js';
    requireFile(relative); return relative;
  };
  for (const essential of ['app.js', 'app.json', 'app.wxss', 'sitemap.json']) requireFile(essential);
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  if (app.themeLocation) requireFile(app.themeLocation);
  for (const page of app.pages || []) for (const extension of ['.js', '.json', '.wxml', '.wxss']) requireFile(page + extension);
  for (const file of files) {
    const extension = path.extname(file.path);
    if (!['.js', '.json', '.wxss', '.wxml'].includes(extension)) continue;
    const source = fs.readFileSync(path.join(root, file.path), 'utf8');
    if (extension === '.js') for (const match of source.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) resolve(file.path, match[1]);
    if (extension === '.wxss') for (const match of source.matchAll(/@import\s+['"]([^'"]+)['"]/g)) resolve(file.path, match[1]);
    if (extension === '.json') {
      const json = JSON.parse(source);
      for (const component of Object.values(json.usingComponents || {})) {
        if (/^(?:plugin|dynamicLib):\/\//.test(component)) continue;
        for (const suffix of ['.js', '.json', '.wxml', '.wxss']) resolve(file.path, component, suffix);
      }
    }
    if (extension === '.wxml') for (const match of source.matchAll(/\b(?:src|import)="([^"{}]+)"/g)) {
      if (/^(?:https?:|cloud:|data:|wxfile:)/.test(match[1])) continue;
      resolve(file.path, match[1]);
    }
  }
  for (const file of files) assert(!/^(?:Progress|cloudfunctions|node_modules|\.[^/]+)\//i.test(file.path), `开发资料进入前端包：${file.path}`);
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  assert(bytes < LIMIT_BYTES, `源文件预算超限：${bytes} >= ${LIMIT_BYTES}`);
  return { sourceBytes: bytes, fileCount: files.length, limitBytes: LIMIT_BYTES, files };
}
if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const template = JSON.parse(fs.readFileSync(path.join(root, 'project.config.example.json'), 'utf8'));
  const localFile = path.join(root, 'project.config.json');
  const local = fs.existsSync(localFile) ? JSON.parse(fs.readFileSync(localFile, 'utf8')) : template;
  assert.deepEqual(local.packOptions, template.packOptions, '本地packOptions与模板不一致；仅同步该字段，保留自己的AppID和其它配置。');
  const report = audit(root, local);
  console.log(`PASS: ${report.fileCount} source files, ${report.sourceBytes} bytes (${(report.sourceBytes / 1024).toFixed(1)} KiB); runtime references complete; source budget <1,500,000 bytes.`);
}
module.exports = { audit, matches, LIMIT_BYTES };
