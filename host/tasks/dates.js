const WEEKDAYS = new Map([['sunday', 0], ['monday', 1], ['tuesday', 2], ['wednesday', 3], ['thursday', 4], ['friday', 5], ['saturday', 6]]);

function timestampOf(value, fallback = Date.now()) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function localParts(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'long' }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), weekday: values.weekday.toLowerCase() };
}

function offsetAt(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  const hour = Number(values.hour) === 24 ? 0 : Number(values.hour);
  return Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), hour, Number(values.minute), Number(values.second)) - Math.floor(timestamp / 1000) * 1000;
}

function localDateTimeToUtc(parts, timeZone) {
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const first = localAsUtc - offsetAt(localAsUtc, timeZone);
  const second = localAsUtc - offsetAt(first, timeZone);
  return second;
}

function resolveDueAt(dueDate, sourceTimestamp, timeZone = 'UTC', fallbackNow = Date.now()) {
  const normalized = String(dueDate || '').trim().toLowerCase();
  if (!normalized) return null;
  const source = timestampOf(sourceTimestamp, fallbackNow);
  let date = localParts(source, timeZone);
  if (normalized === 'tomorrow') {
    const next = new Date(Date.UTC(date.year, date.month - 1, date.day) + 86400000);
    date = { ...date, year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
  } else if (WEEKDAYS.has(normalized)) {
    const delta = (WEEKDAYS.get(normalized) - WEEKDAYS.get(date.weekday) + 7) % 7;
    const next = new Date(Date.UTC(date.year, date.month - 1, date.day) + delta * 86400000);
    date = { ...date, year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
  } else if (normalized !== 'today') {
    return null;
  }
  return localDateTimeToUtc({ ...date, hour: 23, minute: 59, second: 59 }, timeZone) + 999;
}

module.exports = { resolveDueAt };
