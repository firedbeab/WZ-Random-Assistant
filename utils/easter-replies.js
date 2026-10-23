const { cloudCall } = require('./runtime');
const REPLY_CHANCE = .3;
const singerTemplates = [
  '我也很喜欢听{歌手}的歌呀',
  '今天想听{歌手}，也想晒晒太阳喵。',
  '听{歌手}的时候，给小猫留一只耳机嘛。',
  '{歌手}的歌，适合和小猫一起听喵～',
  '原来你也喜欢{歌手}呀，喵 :3',
  '{歌手}和小鱼干，今天先选哪个呢喵？',
  '下次听{歌手}，记得叫上小猫呀。',
  '{歌手}的歌？小猫的耳朵已经竖起来啦。'
];
const songTemplates = [
  '《{歌名}》呀，小猫陪你一起听喵～',
  '《{歌名}》这个名字，小猫记住啦。',
  '今天有《{歌名}》，也有一只小猫。',
  '听《{歌名}》的时候，可以顺手摸摸小猫。',
  '《{歌名}》已经准备好，小猫也坐好啦。',
  '《{歌名}》？先让我找个舒服的姿势喵。'
];
function chineseName(value, title = false) {
  if (typeof value !== 'string') return '';
  let name = value.trim();
  // 只识别一层完整书名号，展示时保留一对；歌手不拆分或删符号。
  if (title && name.startsWith('《') && name.endsWith('》')) name = name.slice(1, -1);
  return /^[\u3400-\u4DBF\u4E00-\u9FFF〇]{1,5}$/.test(name) ? name : '';
}
function candidates(submission) {
  if (!submission || submission.status === 'removed') return [];
  const singer = chineseName(submission.singer), song = chineseName(submission.song_name, true);
  return [
    ...singerTemplates.map((template, index) => ({ id: `singer-${index}`, kind: 'singer', text: template.replace('{歌手}', singer) })).filter(() => singer),
    ...songTemplates.map((template, index) => ({ id: `song-${index}`, kind: 'song', text: template.replace('{歌名}', song) })).filter(() => song)
  ];
}
function choose(submission, options = {}, random = Math.random) {
  if (options.mode === 'off') return null;
  if (options.mode === 'singer' || options.mode === 'song') {
    // 示例只由组件的测试模式+超管双重校验入口使用，不写入真实投稿。
    return candidates({ singer: '周杰伦', song_name: '晴天' }).filter(item => item.kind === options.mode)[options.index || 0] || null;
  }
  const pool = candidates(submission);
  if (!pool.length || (options.mode !== 'force' && random() >= REPLY_CHANCE)) return null;
  return pool[Math.floor(random() * pool.length)];
}
async function load(ms = 1500) {
  let timer;
  try {
    const response = await Promise.race([
      Promise.resolve().then(() => cloudCall({ name: 'getUserInfo', data: { action: 'getLatestSubmission' } })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })
    ]);
    return response && response.result && response.result.success ? response.result.data || null : null;
  } catch (_) { return null; }
  finally { clearTimeout(timer); }
}
module.exports = { REPLY_CHANCE, singerTemplates, songTemplates, chineseName, candidates, choose, load };
