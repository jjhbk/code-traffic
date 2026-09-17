function dateKey(now, timeZone = 'UTC') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}

function rankTask(task) {
  let score = 0;
  const reasons = [];
  if (task.dueDate === 'today') { score += 100; reasons.push('due today'); }
  else if (task.dueDate === 'tomorrow') { score += 80; reasons.push('due tomorrow'); }
  else if (task.dueDate) { score += 40; reasons.push(`due ${task.dueDate}`); }
  if (task.owner === 'self') { score += 20; reasons.push('you owe this'); }
  if (task.blocker === 'self') { score += 10; reasons.push('blocking progress'); }
  return { task, score, reasons };
}

class DigestScheduler {
  constructor({ store, timeZone = 'UTC', dailyCap = 5, digestAt = '08:30', cadenceMinutes = 60, quietStart = null, quietEnd = null, clock = () => Date.now() } = {}) {
    if (!store) throw new Error('Digest scheduler requires a store.');
    this.store = store;
    this.timeZone = timeZone;
    this.dailyCap = dailyCap;
    this.digestAt = digestAt || '08:30';
    this.cadenceMinutes = [15, 30, 60].includes(Number(cadenceMinutes)) ? Number(cadenceMinutes) : 0;
    this.quietStart = quietStart;
    this.quietEnd = quietEnd;
    this.clock = clock;
  }

  isDue(now = this.clock()) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(this.digestAt)) return false;
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: this.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
    const current = Number(parts.find((part) => part.type === 'hour').value) * 60 + Number(parts.find((part) => part.type === 'minute').value);
    const [hour, minute] = this.digestAt.split(':').map(Number);
    return current >= hour * 60 + minute;
  }

  isQuiet(now = this.clock()) {
    if (!this.quietStart || !this.quietEnd) return false;
    const [startHour, startMinute] = this.quietStart.split(':').map(Number);
    const [endHour, endMinute] = this.quietEnd.split(':').map(Number);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: this.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
    const current = Number(parts.find((part) => part.type === 'hour').value) * 60 + Number(parts.find((part) => part.type === 'minute').value);
    const start = startHour * 60 + startMinute;
    const end = endHour * 60 + endMinute;
    return start <= end ? current >= start && current < end : current >= start || current < end;
  }

  prepare(tasks = [], modelRanking = null, { deliveryKey = null, budgetKey = null } = {}) {
    if (this.isQuiet()) return null;
    this.store.wakeSnoozedTasks(this.clock());
    const modelById = new Map((modelRanking?.items || []).map((item) => [String(item.taskId), item]));
    const ranked = tasks.filter((task) => task.status === 'active' && !(task.counterparty && this.store.isSuppressed('counterparty', task.counterparty))).map((task) => {
      const deterministic = rankTask(task);
      const model = modelById.get(String(task.taskId));
      return model ? { task, score: model.score, reasons: [model.reason] } : deterministic;
    }).sort((a, b) => b.score - a.score || String(a.task.taskId).localeCompare(String(b.task.taskId)));
    if (!ranked.length) return null;
    const key = deliveryKey || dateKey(this.clock(), this.timeZone);
    const items = ranked.slice(0, this.dailyCap).map(({ task, reasons }) => ({ taskId: task.taskId, summary: task.summary, reasons }));
    return this.store.reserveDigest({ dateKey: key, budgetDateKey: budgetKey || key, items, cap: this.dailyCap });
  }

  prepareScheduled(tasks = [], modelRanking = null) {
    const now = this.clock();
    if (!this.isScheduledDue(now)) return null;
    const day = dateKey(now, this.timeZone);
    if (this.cadenceMinutes > 0) {
      const slot = Math.floor(now / (this.cadenceMinutes * 60 * 1000));
      return this.prepare(tasks, modelRanking, { deliveryKey: `${day}:${slot}`, budgetKey: day });
    }
    return this.prepare(tasks, modelRanking, { deliveryKey: day, budgetKey: day });
  }

  isScheduledDue(now = this.clock()) {
    const day = dateKey(now, this.timeZone);
    if (this.isQuiet(now)) return false;
    if (this.cadenceMinutes > 0) {
      const slot = Math.floor(now / (this.cadenceMinutes * 60 * 1000));
      const deliveryKey = `${day}:${slot}`;
      return !this.store.hasNotificationForDate(deliveryKey, 'digest');
    }
    return this.isDue(now) && !this.store.hasNotificationForDate(day, 'digest');
  }
}

module.exports = { DigestScheduler, dateKey, rankTask };
