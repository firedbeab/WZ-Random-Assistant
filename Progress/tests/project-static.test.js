const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const totals = { js: 0, json: 0, wxml: 0 };
function scan(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.isSymbolicLink() || ['node_modules', '.git', '.codex', '.agents', '.cloudbase'].includes(item.name)) continue;
    const file = path.join(dir, item.name);
    if (item.isDirectory()) { scan(file); continue; }
    const ext = path.extname(file).slice(1);
    if (!(ext in totals)) continue;
    const source = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    if (ext === 'js') new vm.Script(source, { filename: file });
    if (ext === 'json') JSON.parse(source);
    if (ext === 'wxml') {
      const stack = [];
      for (const match of source.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<\/?([a-z][\w-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/g)) {
        if (match[0].startsWith('</')) assert.equal(stack.pop(), match[1], `${file}: unbalanced ${match[0]}`);
        else if (!match[0].endsWith('/>')) stack.push(match[1]);
      }
      assert.equal(stack.length, 0, `${file}: unclosed WXML elements`);
    }
    totals[ext]++;
  }
}
scan(root);
console.log('PASS: project-owned JavaScript syntax, JSON parsing and WXML tag balance', totals);
