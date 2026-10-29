// Page scrolling only: fixed dialogs and sheets use the separate keyboard inset.
// Geometry is expressed in logical pixels, as returned by WeChat selector query.
function scrollDelta(rect, viewportHeight, overlap, navHeight) {
  if (!rect || !Number.isFinite(rect.top) || !Number.isFinite(rect.bottom)) return 0;
  const top = Math.max(0, navHeight || 0) + 12;
  const bottom = Math.max(top, viewportHeight - Math.max(0, overlap || 0) - 24);
  const height = Math.max(0, rect.bottom - rect.top);
  if (bottom <= top) return 0;
  if (rect.top < top) return Math.floor(rect.top - top);
  // Place the focused input around the upper half of the visible area. This
  // also leaves room to see what is being typed before it reaches the keyboard.
  const ideal = Math.max(top, Math.min(bottom - height, top + (bottom - top) * .42 - height / 2));
  return Math.max(0, Math.ceil(rect.top - ideal));
}
function clear(page) {
  for (const timer of page._keyboardScrollTimers || []) clearTimeout(timer);
  page._keyboardScrollTimers = [];
  page._keyboardScrollGeneration = (page._keyboardScrollGeneration || 0) + 1;
}
function current(page) {
  if (typeof getCurrentPages !== 'function') return true;
  const pages = getCurrentPages();
  return pages.length > 0 && pages[pages.length - 1] === page;
}
function schedule(page, platform, overlap, metrics) {
  clear(page);
  if (!page._keyboardTarget || page._keyboardTarget.layer !== 'page' || !page._appearanceVisible || !page._keyboardHeight || !platform || !platform.createSelectorQuery || !platform.pageScrollTo) return;
  const target = page._keyboardTarget;
  const generation = page._keyboardScrollGeneration;
  const measure = () => {
    if (page._keyboardTarget !== target || !page._appearanceVisible || !page._keyboardHeight || !current(page)) return;
    try {
      // .in() is for custom-component scopes; some page renderers never invoke
      // the callback when a Page instance is passed to it.
      const query = platform.createSelectorQuery();
      query.select(target.selector).boundingClientRect();
      query.selectViewport().scrollOffset();
      query.exec(result => {
        if (page._keyboardScrollGeneration !== generation || page._keyboardTarget !== target || !page._appearanceVisible || !page._keyboardHeight || !current(page) || !result || !result[0] || !result[1]) return;
        const delta = scrollDelta(result[0], metrics.height, overlap, metrics.nav);
        if (Math.abs(delta) > 1) platform.pageScrollTo({ scrollTop: Math.max(0, (result[1].scrollTop || 0) + delta), duration: 180, fail() {} });
      });
    } catch (_) { /* Old clients retain native keyboard positioning. */ }
  };
  page._keyboardScrollTimers = [setTimeout(measure, 100), setTimeout(measure, 380)];
}
module.exports = { scrollDelta, clear, schedule };
