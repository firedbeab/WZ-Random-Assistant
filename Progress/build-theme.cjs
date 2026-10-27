// 修改 utils/theme.js 后运行：node Progress/build-theme.cjs
const fs = require('node:fs');
const path = require('node:path');
const theme = require('../utils/theme');
const root = path.resolve(__dirname, '..');
function outputs() {
  const block = mode => Object.entries(theme.getTokens(mode)).map(([key, value]) => `  --${key}: ${value};`).join('\n');
  const css = `/* 由 utils/theme.js 生成；运行 node Progress/build-theme.cjs，勿单独改色值。 */\npage {\n${block('light')}\n}\n@media (prefers-color-scheme: dark) {\n  page {\n${block('dark').split('\n').map(line => '  ' + line).join('\n')}\n  }\n}\n`;
  const native = {};
  for (const mode of ['light', 'dark']) {
    const colors = theme.getTokens(mode);
    native[mode] = {
      navigationBarTextStyle: mode === 'dark' ? 'white' : 'black', navigationBarBackgroundColor: colors.surface,
      backgroundColor: colors.bg, backgroundColorTop: colors.bg, backgroundColorBottom: colors.bg,
      backgroundTextStyle: mode === 'dark' ? 'light' : 'dark'
    };
  }
  return { 'styles/themes.wxss': css, 'theme.json': JSON.stringify(native, null, 2) + '\n' };
}
if (require.main === module) for (const [file, content] of Object.entries(outputs())) fs.writeFileSync(path.join(root, file), content);
module.exports = { outputs };
