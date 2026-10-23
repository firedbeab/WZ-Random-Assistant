const cats = [
  { name: '探头猫', motion: 'peek', art: '/\\_/\\\n( ·ω· )\nฅ     ฅ' },
  { name: '开心猫', motion: 'bounce', art: ' /\\_/\\\n( ^ω^ )\n /   \\' },
  { name: '瞌睡猫', motion: 'sleep', art: '/\\_/\\\n( -ω- )' },
  { name: '惊讶猫', motion: 'surprise', art: ' /\\_/\\\n( OωO )\n /   \\' },
  { name: '伸爪猫', motion: 'paws', art: ' /\\_/\\\n( =ω= )\n(") (")' },
  { name: '招手猫', motion: 'wave', art: 'ฅ(=･ω･=)ฅ' },
  { name: '眨眼猫', motion: 'wink', art: '/\\_/\\\n( ·ω· )\n/   \\', winkFace: '( >ω· )' },
  { name: '爱心猫', motion: 'heart', art: ' /\\_/\\\n( ♡ω♡ )\n /   \\' },
  { name: '馋嘴猫', motion: 'snack', art: '/\\_/\\\n( =ω= )\nฅ ><> ฅ' },
  { name: '害羞猫', motion: 'shy', art: '/\\_/\\\n(〃ω〃)\n/   \\' },
  { name: '抱鱼猫', motion: 'fish', art: ' /\\_/\\\n( =ω= )\n / ><> \\' },
  { name: '纸箱猫', motion: 'box', art: ' /\\_/\\\n( •ω• )\n┌───────┐\n│  喵!  │\n└───────┘' }
];
const invitations = ['喵 :3', '喵。', '喵～', '喵 >ω<'];
// 只影响二连/三连累计奖励；四连继续优先展示云端照片。
const ASCII_REWARD_CHANCE = .2;
const displayCats = cats.map(cat => ({ ...cat, id: cat.motion, lines: cat.art.split('\n').map(line => line.trim()) }));
module.exports = { cats: displayCats, invitations, ASCII_REWARD_CHANCE };
