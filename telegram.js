const crypto = require('crypto');
const { setTimeout: delay } = require('timers/promises');
const { formatHistoryPairs } = require('./history');

function parseCommand(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  if (!text.startsWith('/')) return { name: 'send', argument: text };
  const match = text.match(/^\/([a-z]+)(?:@\S+)?(?:\s+([\s\S]*))?$/i);
  return match ? { name: match[1].toLowerCase(), argument: (match[2] || '').trim() } : null;
}

function sessionListText(sessions, selectedTile) {
  if (!sessions.length) return 'No sessions are available.';
  const symbols = { working: '🟢', approval: '🟠', done: '🔴' };
  const rows = sessions.map((session, index) => {
    const tile = session.tile || session.key;
    const symbol = symbols[session.state] || '⚪';
    const ownership = session.owned ? '' : ' (external, view only)';
    const selected = tile === selectedTile ? ' ← selected' : '';
    const type = { claude: 'Claude Code', codex: 'Codex', terminal: 'Terminal' }[session.agent] || 'Session';
    return `${index + 1}. ${symbol} ${session.project} · ${type} — ${session.state || 'idle'}${ownership}${selected}`;
  });
  return `Sessions:\n${rows.join('\n')}\n\nUse /use <number> to select one.`;
}

class TelegramControl {
  constructor({ token, chatId, listSessions, getHistory, ensureSession, writeSession, executeTerminal, interruptTerminal, fetchImpl = globalThis.fetch }) {
    this.token = token;
    this.chatId = String(chatId || '');
    this.listSessions = listSessions;
    this.getHistory = getHistory;
    this.ensureSession = ensureSession;
    this.writeSession = writeSession;
    this.executeTerminal = executeTerminal;
    this.interruptTerminal = interruptTerminal;
    this.fetch = fetchImpl;
    this.selectedTile = null;
    this.offset = 0;
    this.stopped = true;
    this.abortControllers = new Set();
    this.actions = new Map();
  }

  get enabled() { return Boolean(this.token && this.fetch); }
  get configured() { return Boolean(this.chatId); }

  start() {
    if (!this.enabled || !this.stopped) return;
    this.stopped = false;
    this.poll().catch((error) => {
      if (!this.stopped) console.error(`[telegram] polling stopped: ${error.message}`);
    });
  }

  stop() {
    this.stopped = true;
    for (const controller of this.abortControllers) controller.abort();
    this.abortControllers.clear();
  }

  async request(method, payload) {
    const controller = new AbortController();
    this.abortControllers.add(controller);
    try {
      const response = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.description || `Telegram returned HTTP ${response.status}`);
      return result.result;
    } finally {
      this.abortControllers.delete(controller);
    }
  }

  async sendTo(chatId, text, extra = {}) {
    if (!this.enabled || this.stopped) return;
    await this.request('sendMessage', {
      chat_id: String(chatId),
      text: String(text).slice(0, 4096),
      ...extra,
    });
  }

  async send(text, extra = {}) {
    if (!this.configured) return;
    await this.sendTo(this.chatId, text, extra);
  }

  async sendLong(text) {
    let remaining = String(text);
    while (remaining) {
      let cut = Math.min(3900, remaining.length);
      if (cut < remaining.length) {
        const paragraph = remaining.lastIndexOf('\n\n', cut);
        if (paragraph > 500) cut = paragraph;
      }
      await this.send(remaining.slice(0, cut));
      remaining = remaining.slice(cut).trimStart();
    }
  }

  async poll() {
    try {
      if (this.configured) {
        const queued = await this.request('getUpdates', { offset: -1, timeout: 0, allowed_updates: ['message', 'callback_query'] });
        if (queued.length) {
          const latest = queued[queued.length - 1];
          this.offset = latest.update_id + 1;
          if (parseCommand(latest.message?.text)?.name === 'start') await this.handleUpdate(latest);
        }
      }
    } catch (error) {
      if (this.stopped || error.name === 'AbortError') return;
      console.error(`[telegram] could not initialize: ${error.message}`);
    }

    while (!this.stopped) {
      try {
        const updates = await this.request('getUpdates', {
          offset: this.offset,
          timeout: 25,
          allowed_updates: ['message', 'callback_query'],
        });
        for (const update of updates) {
          this.offset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch (error) {
        if (this.stopped || error.name === 'AbortError') return;
        console.error(`[telegram] ${error.message}`);
        await delay(3000);
      }
    }
  }

  async handleUpdate(update) {
    if (update?.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }
    const message = update && update.message;
    if (!message || message.chat?.id === undefined || typeof message.text !== 'string') return;
    const command = parseCommand(message.text);
    if (!command) return;
    const incomingChatId = String(message.chat.id);
    if (command.name === 'start' && incomingChatId !== this.chatId) {
      await this.sendTo(incomingChatId, `Your Signal Box chat ID is ${incomingChatId}.\n\nSet TELEGRAM_CHAT_ID=${incomingChatId} in .env, then restart Signal Box.`);
      return;
    }
    if (!this.configured) return;
    if (incomingChatId !== this.chatId) return;
    try {
      await this.handleCommand(command);
    } catch (error) {
      await this.send(`Could not complete that command: ${error.message}`);
    }
  }

  async handleCallback(query) {
    const incomingChatId = query.message?.chat?.id;
    if (!query.id || incomingChatId === undefined) return;
    if (!this.configured || String(incomingChatId) !== this.chatId) {
      await this.request('answerCallbackQuery', {
        callback_query_id: query.id,
        text: 'This chat is not authorized for Signal Box.',
        show_alert: true,
      });
      return;
    }

    const action = this.actions.get(query.data);
    if (!action) {
      await this.request('answerCallbackQuery', {
        callback_query_id: query.id,
        text: 'This option has expired. Wait for a new prompt or open the app.',
        show_alert: true,
      });
      return;
    }

    try {
      const session = this.listSessions().find((item) => (item.tile || item.key) === action.tile);
      if (!session?.owned) throw new Error('That session is no longer available for remote control.');
      await this.ensureSession(action.tile);
      this.writeSession(action.tile, action.keys);
      this.selectedTile = action.tile;
      this.actions.delete(query.data);
      await this.request('answerCallbackQuery', {
        callback_query_id: query.id,
        text: `Sent: ${action.label}`.slice(0, 200),
      });
    } catch (error) {
      await this.request('answerCallbackQuery', {
        callback_query_id: query.id,
        text: error.message.slice(0, 200),
        show_alert: true,
      });
    }
  }

  selectedSession() {
    return this.listSessions().find((session) => (session.tile || session.key) === this.selectedTile) || null;
  }

  async handleCommand({ name, argument }) {
    if (name === 'start' || name === 'help') {
      await this.send('Signal Box remote control\n\n/sessions — list sessions\n/use <number> — select a session\n/status — show the selected session\n/send <text> — send a prompt\n/tail — show the last 3 input/output pairs\n/history — show the full conversation\n/interrupt — send Ctrl+C\n\nAfter selecting a session, plain text is also sent as a prompt.');
      return;
    }
    if (name === 'sessions') {
      await this.send(sessionListText(this.listSessions(), this.selectedTile));
      return;
    }
    if (name === 'use') {
      const sessions = this.listSessions();
      const index = Number.parseInt(argument, 10) - 1;
      const session = Number.isInteger(index) && index >= 0 ? sessions[index] : null;
      if (!session) throw new Error('Choose a session number from /sessions.');
      if (!session.owned) throw new Error('External sessions cannot be controlled because Signal Box does not own their terminal.');
      this.selectedTile = session.tile || session.key;
      await this.send(`Selected ${session.project}. Send plain text or use /send <text>.`);
      return;
    }
    if (name === 'status') {
      const session = this.selectedSession();
      await this.send(session
        ? `${session.project}\nType: ${{ claude: 'Claude Code', codex: 'Codex', terminal: 'Terminal' }[session.agent] || 'Session'}\nState: ${session.state || 'idle'}\nPath: ${session.path || session.cwd}`
        : 'No session selected. Use /sessions, then /use <number>.');
      return;
    }
    if (name === 'tail') {
      const session = this.requireSelected();
      const history = this.getHistory(session);
      await this.sendLong(`${session.project} — recent conversation\n\n${formatHistoryPairs(history.pairs, 3)}`);
      return;
    }
    if (name === 'history') {
      const session = this.requireSelected();
      const history = this.getHistory(session);
      await this.sendLong(`${session.project} — full conversation (${history.count} pairs)\n\n${formatHistoryPairs(history.pairs, history.pairs.length || 1)}`);
      return;
    }
    if (name === 'interrupt') {
      const session = this.requireSelected();
      if (session.agent === 'terminal') {
        if (!this.interruptTerminal?.(session)) throw new Error('No Telegram command is currently running in this terminal.');
        await this.send(`Interrupted: ${session.project}`);
        return;
      }
      await this.ensureSession(this.selectedTile);
      this.writeSession(this.selectedTile, '\x03');
      await this.send(`Interrupt sent to ${session.project}.`);
      return;
    }
    if (name === 'send') {
      if (!argument) throw new Error('Add text after /send.');
      const session = this.requireSelected();
      if (session.agent === 'terminal') {
        if (!this.executeTerminal) throw new Error('Remote terminal execution is unavailable.');
        this.executeTerminal(session, argument).then((result) => {
          const suffix = result.code && result.code !== 0
            ? `\n\n(exit code ${result.code})`
            : result.signal ? `\n\n(stopped by ${result.signal})` : '';
          const truncation = result.truncated ? '\n\n(output truncated)' : '';
          const output = result.output || '(no output)';
          return this.sendLong(`$ ${argument}\n\n${output}${suffix}${truncation}`);
        }).catch((error) => this.send(`$ ${argument}\n\nError: ${error.message}`))
          .catch((error) => console.error(`[telegram] terminal response failed: ${error.message}`));
        return;
      }
      await this.ensureSession(this.selectedTile);
      this.writeSession(this.selectedTile, `${argument}\r`);
      await this.send(`Prompt sent to ${session.project}.`);
      return;
    }
    throw new Error('Unknown command. Use /help to see available commands.');
  }

  requireSelected() {
    const session = this.selectedSession();
    if (!session) throw new Error('No session selected. Use /sessions, then /use <number>.');
    return session;
  }

  notifyState(session, state) {
    if (!this.enabled || !this.configured || this.stopped || !session) return;
    const tile = session.tile || session.key;
    const number = this.listSessions().findIndex((item) => (item.tile || item.key) === tile) + 1;
    const select = number > 0 ? `\nUse /use ${number} to select it.` : '';
    if (state !== 'approval') {
      this.send(`✅ ${session.project} completed.${select}\nUse /tail to review the latest input/output pairs.`)
        .catch((error) => console.error(`[telegram] notification failed: ${error.message}`));
      return;
    }

    let questions = [];
    try {
      questions = this.getHistory?.(session)?.pendingQuestions || [];
    } catch (error) {
      console.error(`[telegram] could not read pending question: ${error.message}`);
    }

    for (const [token, action] of this.actions) {
      if (action.tile === tile) this.actions.delete(token);
    }

    const details = questions.map((question, questionIndex) => {
      const heading = question.header ? `${question.header}: ` : '';
      const options = question.options?.map((option, optionIndex) =>
        `${optionIndex + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`
      ) || [];
      return `${questionIndex + 1}. ${heading}${question.question}${options.length ? `\n${options.join('\n')}` : ''}`;
    }).join('\n\n');

    const inlineKeyboard = [];
    if (session.owned) {
      questions.forEach((question, questionIndex) => {
        (question.options || []).forEach((option, optionIndex) => {
          const token = `answer:${crypto.randomBytes(8).toString('hex')}`;
          this.actions.set(token, {
            tile,
            label: option.label,
            keys: `${'\x1b[B'.repeat(optionIndex)}\r`,
          });
          const prefix = questions.length > 1 ? `${questionIndex + 1}. ` : '';
          inlineKeyboard.push([{
            text: `${prefix}${option.label}`.slice(0, 64),
            callback_data: token,
          }]);
        });
      });
    }
    while (this.actions.size > 200) this.actions.delete(this.actions.keys().next().value);

    const instruction = inlineKeyboard.length
      ? `\n\nTap an option below${questions.length > 1 ? ', answering the questions from top to bottom' : ''}.`
      : `${select}\nReply with /send <answer> after selecting the session.`;
    const message = `🟠 ${session.project} needs user input or permission.${details ? `\n\n${details}` : ''}${instruction}`;
    const extra = inlineKeyboard.length ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {};
    this.send(message, extra).catch((error) => console.error(`[telegram] notification failed: ${error.message}`));
  }
}

module.exports = { TelegramControl, parseCommand, sessionListText };
