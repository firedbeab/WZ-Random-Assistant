// 只计算布局，不改变窗口或系统状态栏。所有数值均为逻辑像素。
function navigationLayout(info = {}, capsule = {}) {
  info = info && typeof info === 'object' ? info : {};
  capsule = capsule && typeof capsule === 'object' ? capsule : {};
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const width = finite(info.windowWidth) && info.windowWidth >= 240 ? info.windowWidth : 375;
  const safeTop = info.safeArea && info.safeArea.top;
  const top = finite(info.statusBarHeight) ? info.statusBarHeight : (finite(safeTop) ? safeTop : 20);
  const statusHeight = Math.min(100, Math.max(0, top));
  const capsuleValid = finite(capsule.top) && finite(capsule.height) && finite(capsule.left)
    && capsule.top >= statusHeight && capsule.top - statusHeight <= 24
    && capsule.height >= 20 && capsule.height <= 64
    && capsule.left >= width / 2 && capsule.left < width;
  const barHeight = capsuleValid
    ? Math.max(40, Math.min(72, (capsule.top - statusHeight) * 2 + capsule.height))
    : 44;
  const sideWidth = capsuleValid
    ? Math.min(width * .42, Math.max(76, width - capsule.left + 8))
    : Math.min(96, width * .32);
  return { statusHeight, barHeight, sideWidth, totalHeight: statusHeight + barHeight };
}

module.exports = { navigationLayout };
