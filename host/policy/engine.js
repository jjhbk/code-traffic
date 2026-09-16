const CAPABILITIES = new Map([
  ['agent.input', { effects: 'reversible', surfaces: ['desktop', 'telegram'] }],
  ['desk.prompt', { effects: 'reversible', surfaces: ['desktop', 'telegram'] }],
  ['gmail.send', { effects: 'commit', surfaces: ['desktop', 'telegram'] }],
  ['gmail.read', { effects: 'read', surfaces: ['desktop', 'telegram'] }],
  ['calendar.read', { effects: 'read', surfaces: ['desktop', 'telegram'] }],
  ['calendar.update', { effects: 'commit', surfaces: ['desktop', 'telegram'] }],
  ['drive.read', { effects: 'read', surfaces: ['desktop', 'telegram'] }],
  ['files.read', { effects: 'read', surfaces: ['desktop', 'telegram'] }],
  ['browser.read', { effects: 'read', surfaces: ['desktop', 'telegram'] }],
  ['browser.reversible', { effects: 'reversible', surfaces: ['desktop', 'telegram'] }],
  ['browser.commit', { effects: 'commit', surfaces: ['desktop', 'telegram'] }],
  ['terminal.exec', { effects: 'commit', surfaces: ['desktop'] }],
]);

class PolicyEngine {
  constructor({ version = 'single-user-1' } = {}) { this.version = version; }

  evaluate(action = {}, { surfaces = ['desktop'] } = {}) {
    const capability = String(action.capability || '');
    const definition = CAPABILITIES.get(capability);
    if (!definition) throw new Error('Unknown capabilities cannot be approved.');
    if (action.autonomous === true) throw new Error('Autonomous write grants are disabled.');
    const allowedSurfaces = surfaces.filter((surface) => definition.surfaces.includes(surface));
    if (!allowedSurfaces.length) throw new Error(`This action cannot be approved on the requested surface.`);
    return {
      capability,
      effects: definition.effects,
      surfaces: allowedSurfaces,
      requiresApproval: definition.effects !== 'read',
      policyVersion: this.version,
    };
  }
}

module.exports = { CAPABILITIES, PolicyEngine };
