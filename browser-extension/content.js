const ALLOWED_ORIGIN = 'https://m.uber.com';

function target(name) {
  const explicit = document.querySelector(`[data-signal-box-target="${CSS.escape(name)}"]`);
  if (explicit) return explicit;
  const fallbacks = {
    pickup: ['input[aria-label*="pickup" i]', 'input[placeholder*="pickup" i]'],
    destination: ['input[aria-label*="destination" i]', 'input[placeholder*="destination" i]'],
    rideType: ['select[aria-label*="ride" i]', '[role="combobox"][aria-label*="ride" i]'],
    fare: ['[aria-label*="price" i]', '[aria-label*="fare" i]'],
    requestRide: ['button[aria-label*="request" i]', 'button[aria-label*="confirm" i]', 'button[type="submit"]'],
    bookingConfirmation: ['[aria-label*="trip" i]', '[aria-label*="confirmed" i]', '[data-testid*="trip" i]', '[data-testid*="confirmation" i]'],
  };
  return (fallbacks[name] || []).map((selector) => document.querySelector(selector)).find(Boolean) || null;
}

function perform(step) {
  if (location.origin !== ALLOWED_ORIGIN) throw new Error('This page origin is not allowlisted.');
  if (step.kind === 'fill') {
    const element = target(step.target);
    if (!element) throw new Error(`Recipe target not found: ${step.target}`);
    const value = String(step.value ?? '');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    return { target: step.target };
  }
  if (step.kind === 'select') {
    const element = target(step.target);
    if (!element) throw new Error(`Recipe target not found: ${step.target}`);
    element.value = String(step.value ?? '');
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { target: step.target };
  }
  if (step.kind === 'read') {
    const element = target(step.target);
    const value = element?.value || element?.textContent?.trim() || '';
    if (!value) throw new Error(`Recipe response drift: ${step.target}`);
    return value;
  }
  if (step.kind === 'click') {
    const element = target(step.target);
    if (!element) throw new Error(`Recipe target not found: ${step.target}`);
    element.click();
    return { target: step.target };
  }
  throw new Error(`Unsupported extension step: ${step.kind}`);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.channel !== 'signal-box') return false;
  try { sendResponse({ ok: true, result: perform(message.step) }); } catch (error) { sendResponse({ ok: false, error: error.message }); }
  return true;
});

let sessionId = document.documentElement.dataset.signalBoxSession || '';
chrome.storage.local.get(['signalBoxSession']).then((value) => {
  sessionId = sessionId || value.signalBoxSession || '';
  setInterval(() => chrome.runtime.sendMessage({ channel: 'signal-box-poll', sessionId }).catch(() => {}), 750);
});
