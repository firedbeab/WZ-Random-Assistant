// Only a display conversion: persisted week_key and query/navigation values stay Sunday.
function mondayDateText(weekKey) {
  if (typeof weekKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(weekKey)) return '';
  const date = new Date(weekKey + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== weekKey || date.getUTCDay() !== 0) return '';
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10).replace(/-/g, '.');
}
module.exports = { mondayDateText };
