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
  return `Sessions:\n${rows.join('\n')}\n\nTap a session below to select or view it.`;
}

class TelegramControl {
  constructor({ token, chatId, listSessions, getHistory, ensureSession, writeSession, executeTerminal, interruptTerminal, sendPrompt, submitDelayMs = 75, approvalRetryMs = 3000, fetchImpl = globalThis.fetch }) {
    this.token = token;
    this.chatId = String(chatId || '');
    this.listSessions = listSessions;
    this.getHistory = getHistory;
    this.ensureSession = ensureSession;
    this.writeSession = writeSession;
    this.executeTerminal = executeTerminal;
    this.interruptTerminal = interruptTerminal;
    this.sendPrompt = sendPrompt;
    this.submitDelayMs = submitDelayMs;
    this.approvalRetryMs = approvalRetryMs;
    this.fetch = fetchImpl;
    this.selectedTile = null;
    this.offset = 0;
    this.stopped = true;
    this.abortControllers = new Set();
    this.actions = new Map();
    this.approvalNotifications = new Map();
    this.approvalSending = new Map();
    this.approvalRetryTimers = new Map();
    this.answeredApprovals = new Map();
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
    for (const timer of this.approvalRetryTimers.values()) clearTimeout(timer);
    this.approvalRetryTimers.clear();
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

  async sendLong(text, extra = {}) {
    let remaining = String(text);
    while (remaining) {
      let cut = Math.min(3900, remaining.length);
      if (cut < remaining.length) {
        const paragraph = remaining.lastIndexOf('\n\n', cut);
        if (paragraph > 500) cut = paragraph;
      }
      const chunk = remaining.slice(0, cut);
      remaining = remaining.slice(cut).trimStart();
      await this.send(chunk, remaining ? {} : extra);
    }
  }

  addAction(action) {
    const token = `action:${crypto.randomBytes(8).toString("hex")}`;
    this.actions.set(token, action);
    while (this.actions.size > 200) this.actions.delete(this.actions.keys().next().value);
    return token;
  }

  sessionKeyboard(sessions = this.listSessions()) {
    return sessions.map((session) => {
      const tile = session.tile || session.key;
      const label = `${session.owned ? "Select" : "View"} ${session.project}`.slice(0, 64);
      return [{ text: label, callback_data: this.addAction({ type: "select", tile }) }];
    });
  }

  sessionButtonMarkup(session) {
    const tile = session.tile || session.key;
    return { reply_markup: { inline_keyboard: [[{
      text: `${session.owned ? 'Select' : 'View'} ${session.project}`.slice(0, 64),
      callback_data: this.addAction({ type: 'select', tile }),
    }]] } };
  }

  selectedKeyboard(session) {
    const keyboard = [
      [
        { text: 'Recent', callback_data: this.addAction({ type: 'command', name: 'tail', tile: session.tile || session.key }) },
        { text: 'History', callback_data: this.addAction({ type: 'command', name: 'history', tile: session.tile || session.key }) },
      ],
      [
        { text: 'Status', callback_data: this.addAction({ type: 'command', name: 'status', tile: session.tile || session.key }) },
        { text: "Sessions", callback_data: this.addAction({ type: "command", name: "sessions" }) },
      ],
    ];
    if (session.owned) keyboard[1].unshift({ text: 'Interrupt', callback_data: this.addAction({ type: 'command', name: 'interrupt', tile: session.tile || session.key }) });
    return keyboard;
  }

  async sendSessions() {
    const sessions = this.listSessions();
    await this.send(sessionListText(sessions, this.selectedTile), sessions.length
      ? { reply_markup: { inline_keyboard: this.sessionKeyboard(sessions) } }
      : {});
  }

  async sendSelectedMenu(session) {
    const ownership = session.owned ? "You can send prompts to this session." : "This session is view only.";
    await this.send(`Selected ${session.project}. ${ownership}\nUse the buttons below to inspect it.`, {
      reply_markup: { inline_keyboard: this.selectedKeyboard(session) },
    });
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

  async acknowledgeAnswer(query, label, questionSignature, answeredTokens = null) {
    await this.request('answerCallbackQuery', {
      callback_query_id: query.id,
      text: `Sent: ${label}`.slice(0, 200),
    });

    const messageId = query.message?.message_id;
    if (messageId === undefined) return;
    const confirmation = `Response sent: ${label}`;
    const original = String(query.message?.text || 'Approval request');
    const suffix = `\n\n✅ ${confirmation}`;
    const text = `${original.slice(0, Math.max(0, 4096 - suffix.length))}${suffix}`;
    answeredTokens ||= new Set([...this.actions]
      .filter(([, action]) => action.type === 'answer' && action.questionSignature === questionSignature)
      .map(([token]) => token));
    const inlineKeyboard = query.message?.reply_markup?.inline_keyboard
      ?.map((row) => row.filter((button) => !answeredTokens.has(button.callback_data)))
      .filter((row) => row.length);
    try {
      await this.request('editMessageText', {
        chat_id: String(query.message.chat.id),
        message_id: messageId,
        text,
        ...(inlineKeyboard ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {}),
      });
    } catch (error) {
      // Do not leave a button that has already submitted an answer active.
      // This separate request also covers an edit rejected for message length.
      try {
        await this.request('editMessageReplyMarkup', {
          chat_id: String(query.message.chat.id),
          message_id: messageId,
          reply_markup: { inline_keyboard: inlineKeyboard || [] },
        });
      } catch (_) {}
      try {
        await this.send(confirmation);
      } catch (sendError) {
        console.error(`[telegram] could not show approval confirmation: ${sendError.message}`);
      }
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
      if (action.type === 'answer') {
        const session = this.listSessions().find((item) => (item.tile || item.key) === action.tile);
        if (!session?.owned) throw new Error('That session is no longer available for remote control.');
        await this.ensureSession(action.tile);
        const current = this.listSessions().find((item) => (item.tile || item.key) === action.tile);
        const pending = this.getHistory?.(current)?.pendingQuestions || [];
        if (this.actions.get(query.data) !== action || !current?.owned
          || !pending.some((question) => JSON.stringify(question) === action.questionSignature)) {
          this.actions.delete(query.data);
          throw new Error('This approval has expired. Wait for the current question.');
        }
        if (action.questionSignature) {
          if (!this.answeredApprovals.has(action.tile)) this.answeredApprovals.set(action.tile, new Set());
          this.answeredApprovals.get(action.tile).add(action.questionSignature);
        }
        const answeredTokens = new Set();
        for (const [token, candidate] of this.actions) {
          if (candidate.type === 'answer' && candidate.tile === action.tile
            && candidate.questionSignature === action.questionSignature) {
            answeredTokens.add(token);
            this.actions.delete(token);
          }
        }
        try {
          this.writeSession(action.tile, action.keys, { approval: true });
        } catch (error) {
          this.answeredApprovals.get(action.tile)?.delete(action.questionSignature);
          this.approvalNotifications.delete(action.tile);
          this.notifyState(session, 'approval');
          throw error;
        }
        this.selectedTile = action.tile;
        await this.acknowledgeAnswer(query, action.label, action.questionSignature, answeredTokens);
        this.approvalNotifications.delete(action.tile);
        this.notifyState(session, 'approval');
      } else if (action.type === 'select') {
        const session = this.listSessions().find((item) => (item.tile || item.key) === action.tile);
        if (!session) throw new Error('That session is no longer available.');
        this.selectedTile = action.tile;
        await this.request('answerCallbackQuery', { callback_query_id: query.id, text: `Opened ${session.project}`.slice(0, 200) });
        await this.sendSelectedMenu(session);
      } else if (action.type === 'command') {
        if (action.tile) {
          const session = this.listSessions().find((item) => (item.tile || item.key) === action.tile);
          if (!session) throw new Error('That session is no longer available.');
          if (['interrupt', 'send'].includes(action.name) && !session.owned) {
            throw new Error('External sessions are view only.');
          }
          this.selectedTile = action.tile;
        }
        await this.request('answerCallbackQuery', { callback_query_id: query.id, text: 'Loading...' });
        await this.handleCommand({ name: action.name, argument: '' });
      } else {
        throw new Error('This option has expired.');
      }
      this.actions.delete(query.data);
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
      await this.sendSessions();
      return;
    }
    if (name === 'use') {
      const sessions = this.listSessions();
      const index = Number.parseInt(argument, 10) - 1;
      const session = Number.isInteger(index) && index >= 0 ? sessions[index] : null;
      if (!session) throw new Error('Choose a session number from /sessions.');
      if (!session.owned) throw new Error('External sessions cannot be controlled because Signal Box does not own their terminal.');
      this.selectedTile = session.tile || session.key;
      await this.sendSelectedMenu(session);
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
      const session = this.requireControllableSession();
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
      const session = this.requireControllableSession();
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
      if (session.agent === 'codex' && this.sendPrompt) {
        await this.sendPrompt(session, argument);
        await this.send(`Prompt sent to ${session.project}.`);
        return;
      }
      await this.ensureSession(this.selectedTile);
      // Codex's TUI can classify text and Enter delivered in one PTY write as
      // a paste, leaving the text in its composer. Match real keyboard input:
      // type first, then deliver Enter as a separate event.
      this.writeSession(this.selectedTile, argument);
      await delay(this.submitDelayMs);
      this.writeSession(this.selectedTile, '\r');
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

  requireControllableSession() {
    const session = this.requireSelected();
    if (!session.owned) throw new Error('External sessions are view only.');
    return session;
  }

  clearApproval(tile) {
    for (const [token, action] of this.actions) {
      if (action.tile === tile && action.type === 'answer') this.actions.delete(token);
    }
    this.approvalNotifications.delete(tile);
    this.approvalSending.delete(tile);
    this.answeredApprovals.delete(tile);
    const timer = this.approvalRetryTimers.get(tile);
    if (timer) clearTimeout(timer);
    this.approvalRetryTimers.delete(tile);
  }

  scheduleApprovalRetry(tile) {
    if (this.approvalRetryTimers.has(tile) || this.stopped) return;
    const timer = setTimeout(() => {
      this.approvalRetryTimers.delete(tile);
      const session = this.listSessions().find((item) => (item.tile || item.key) === tile);
      if (session?.state === 'approval') this.notifyState(session, 'approval');
    }, this.approvalRetryMs);
    timer.unref?.();
    this.approvalRetryTimers.set(tile, timer);
  }

  notifyState(session, state) {
    if (!this.enabled || !this.configured || this.stopped || !session) return;
    const tile = session.tile || session.key;
    const number = this.listSessions().findIndex((item) => (item.tile || item.key) === tile) + 1;
    const select = number > 0 ? `\nTap the session button below to open it.` : '';
    if (state !== 'approval') {
      this.clearApproval(tile);
      let latest = '';
      try {
        const history = this.getHistory?.(session);
        latest = history?.pairs?.length ? `\n\nLatest input/output:\n${formatHistoryPairs(history.pairs, 1)}` : '';
      } catch (error) {
        console.error(`[telegram] could not read completed session output: ${error.message}`);
      }
      this.sendLong(`✅ ${session.project} completed.${latest}${select}`,
        number > 0 ? this.sessionButtonMarkup(session) : {})
        .catch((error) => console.error(`[telegram] notification failed: ${error.message}`));
      return;
    }

    let questions = [];
    try {
      questions = this.getHistory?.(session)?.pendingQuestions || [];
    } catch (error) {
      console.error(`[telegram] could not read pending question: ${error.message}`);
    }

    const approvalSignature = JSON.stringify(questions);
    if (this.approvalNotifications.get(tile) === approvalSignature
      || this.approvalSending.get(tile) === approvalSignature) return;

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
      const questionIndex = questions.findIndex((question) => {
        const signature = JSON.stringify(question);
        return !this.answeredApprovals.get(tile)?.has(signature);
      });
      if (questionIndex >= 0) {
        const question = questions[questionIndex];
        const questionSignature = JSON.stringify(question);
        (question.options || []).forEach((option, optionIndex) => {
          const token = this.addAction({
            type: 'answer',
            tile,
            label: option.label,
            questionSignature,
            keys: option.keys || `${'\x1b[B'.repeat(optionIndex)}${question.multiSelect ? ' \r' : '\r'}`,
          });
          const prefix = questions.length > 1 ? `${questionIndex + 1}. ` : '';
          inlineKeyboard.push([{
            text: `${prefix}${option.label}`.slice(0, 64),
            callback_data: token,
          }]);
        });
      }
    }

    if (questions.length && session.owned && !inlineKeyboard.length
      && questions.every((question) => this.answeredApprovals.get(tile)?.has(JSON.stringify(question)))) return;

    const instruction = inlineKeyboard.length
      ? `\n\nTap an option below${questions.length > 1 ? ', answering the questions from top to bottom' : ''}.`
      : session.owned
        ? `${select}\nReply with /send <answer> after selecting the session.`
        : select;
    const message = `🟠 ${session.project} needs user input or permission.${details ? `\n\n${details}` : ''}${instruction}`;
    const extra = inlineKeyboard.length
      ? { reply_markup: { inline_keyboard: inlineKeyboard } }
      : number > 0 ? this.sessionButtonMarkup(session) : {};
    this.approvalSending.set(tile, approvalSignature);
    this.send(message, extra).then(() => {
      if (this.approvalSending.get(tile) !== approvalSignature) return;
      this.approvalSending.delete(tile);
      this.approvalNotifications.set(tile, approvalSignature);
    }).catch((error) => {
      if (this.approvalSending.get(tile) === approvalSignature) {
        this.approvalSending.delete(tile);
        this.scheduleApprovalRetry(tile);
      }
      console.error(`[telegram] notification failed: ${error.message}`);
    });
  }
}

module.exports = { TelegramControl, parseCommand, sessionListText };
