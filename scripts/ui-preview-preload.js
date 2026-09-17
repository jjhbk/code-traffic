// Synthetic data for the isolated UI smoke check. Never loads real account data.
const { contextBridge } = require('electron');
const messages = [];
let paused = false;
const tasks = [{ taskId: 'demo-task', summary: 'Review the launch brief', status: 'active', confidence: 'medium', dueDate: 'today', evidence: { text: 'Please review the brief before our Thursday meeting.' } }];
const api = {
  listSessions: async () => [], listArchivedSessions: async () => [], listTasks: async () => tasks,
  getSettings: async () => ({ enabled: false, configured: true }), getMailStatus: async () => ({ paired: true }),
  getDigestSettings: async () => ({ quietHoursStart: '22:00', quietHoursEnd: '08:00', timeZone: 'America/New_York' }), checkModel: async () => ({ mode: 'off' }), getCalendarStatus: async () => ({}), getDriveStatus: async () => ({}),
  getIntegrationStatus: async () => ({ claude: { configured: true }, codex: { configured: true } }),
  getAssistantStatus: async () => ({ running: true, paused }), setAssistantPaused: async (value) => { paused = value.paused; return { running: true, paused }; },
  getAssistantConversation: async () => messages,
  getAssistantDecisions: async () => [{ taskId: 'demo-task', type: 'digest', reason: 'due-today', evidence: [tasks[0].evidence.text] }],
  getAssistantWorkflows: async () => [],
  sendAssistantMessage: async ({ text }) => { messages.push({ direction: 'inbound', content: text, createdAt: Date.now() }, { direction: 'outbound', content: 'The launch brief is ready for your review.', createdAt: Date.now() }); },
  onSessionsChanged: () => {}, onPtyData: () => {}, onMailPairProgress: () => {}, onMailStatusChanged: () => {},
  listCalendarEvents: async () => [], listDriveFiles: async () => [], listMailMessages: async () => [],
  getModelSettings: async () => ({ mode: 'off', localModel: 'qwen3:4b-instruct', frontierModel: 'configured-model', frontierBaseUrl: 'https://example.com/v1' }), getModelDiagnostics: async () => ({}),
  getTaskGraph: async () => ({ nodes: [], edges: [] }), getActivity: async () => [],
};
contextBridge.exposeInMainWorld('signalBox', api);
