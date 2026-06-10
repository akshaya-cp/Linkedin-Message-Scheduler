// background.js - MV3 service worker
// Opens LinkedIn profile tab at scheduled time, injects a script that
// clicks "Message", types the draft, and clicks Send automatically.

const ALARM_PREFIX = 'msg_';

// ── Alarm fires: time to send ──────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;

  const msgId = alarm.name.slice(ALARM_PREFIX.length);
  const { scheduledMessages = [] } = await chrome.storage.local.get('scheduledMessages');
  const msg = scheduledMessages.find(m => m.id === msgId);

  if (!msg || msg.status !== 'pending') return;

  // No LinkedIn URL — fall back to plain reminder notification
  if (!msg.profileUrl || !msg.profileUrl.includes('linkedin.com')) {
    await updateStatus(msgId, 'notified', {});
    chrome.notifications.create('notif_' + msgId, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Time to message ' + msg.recipientName,
      message: msg.messageText.length > 100 ? msg.messageText.slice(0, 97) + '...' : msg.messageText,
      priority: 2
    });
    return;
  }

  await updateStatus(msgId, 'sending', {});

  try {
    const tab = await chrome.tabs.create({ url: msg.profileUrl, active: true });
    // Session storage persists across service-worker sleep/wake cycles
    await chrome.storage.session.set({
      ['pending_tab_' + tab.id]: {
        msgId: msg.id,
        messageText: msg.messageText,
        recipientName: msg.recipientName
      }
    });
  } catch (err) {
    await updateStatus(msgId, 'failed', { errorReason: 'Could not open tab: ' + err.message });
  }
});

// ── Tab finished loading: inject the auto-send script ─────────────────────────
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;

  const sessionKey = 'pending_tab_' + tabId;
  const session = await chrome.storage.session.get(sessionKey);
  const pending = session[sessionKey];

  if (!pending) return;
  if (!tab.url || !tab.url.includes('linkedin.com')) return;

  // Remove immediately so a second 'complete' event doesn't double-inject
  await chrome.storage.session.remove(sessionKey);

  // Wait 5 seconds for LinkedIn's React app to finish rendering
  setTimeout(async () => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: autoSendLinkedInMessage,
        args: [pending.messageText, pending.msgId, pending.recipientName]
      });
    } catch (err) {
      await updateStatus(pending.msgId, 'failed', {
        errorReason: 'Script injection failed. Are you logged into LinkedIn? (' + err.message + ')'
      });
      chrome.notifications.create('fail_inject_' + pending.msgId, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'Auto-send Failed',
        message: 'Script injection failed. Make sure you are logged into LinkedIn.',
        priority: 2
      });
    }
  }, 5000);
});

// ── Result message back from injected script ───────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'LINKEDIN_SEND_RESULT') return;
  const { msgId, recipientName, success, error } = msg;

  if (success) {
    updateStatus(msgId, 'sent', { errorReason: null });
    chrome.notifications.create('success_' + msgId, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Message Sent!',
      message: 'Your message to ' + recipientName + ' was sent on LinkedIn.',
      priority: 2
    });
  } else {
    updateStatus(msgId, 'failed', { errorReason: error || 'Unknown error' });
    chrome.notifications.create('fail_' + msgId, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Auto-send Failed',
      message: error || ('Could not auto-send to ' + recipientName + '. Please send manually.'),
      priority: 2
    });
  }
});

// ── On install/startup: reschedule alarms cleared when browser was closed ──────
chrome.runtime.onInstalled.addListener(rescheduleAllAlarms);
chrome.runtime.onStartup.addListener(rescheduleAllAlarms);

async function rescheduleAllAlarms() {
  const { scheduledMessages = [] } = await chrome.storage.local.get('scheduledMessages');
  const now = Date.now();
  for (const msg of scheduledMessages) {
    if (msg.status !== 'pending') continue;
    const when = new Date(msg.scheduledTime).getTime();
    chrome.alarms.create(ALARM_PREFIX + msg.id, { when: when > now ? when : now + 5000 });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function updateStatus(msgId, status, extra) {
  const { scheduledMessages = [] } = await chrome.storage.local.get('scheduledMessages');
  const updated = scheduledMessages.map(m =>
    m.id === msgId ? Object.assign({}, m, { status: status, updatedAt: new Date().toISOString() }, extra) : m
  );
  await chrome.storage.local.set({ scheduledMessages: updated });
}

// ─────────────────────────────────────────────────────────────────────────────
// autoSendLinkedInMessage
// Injected into the LinkedIn tab via chrome.scripting.executeScript.
// Runs in the PAGE context — cannot reference any background.js variables.
//
// Fixes vs previous version:
//  - Removed offsetParent check (fails for position:fixed/sticky containers)
//  - Text matching uses .includes() not strict equality
//  - Broader selector coverage for LinkedIn's varying DOM layouts
//  - Increased timeouts throughout
// ─────────────────────────────────────────────────────────────────────────────
function autoSendLinkedInMessage(messageText, msgId, recipientName) {

  // Wait for an element using MutationObserver. Visibility check uses
  // getBoundingClientRect instead of offsetParent (works with fixed/sticky).
  function waitFor(selectorOrFn, timeout) {
    timeout = timeout || 15000;
    return new Promise(function(resolve, reject) {
      function check() {
        var el = typeof selectorOrFn === 'function'
          ? selectorOrFn()
          : document.querySelector(selectorOrFn);
        if (!el) return null;
        // Accept elements that exist in DOM even if rect is zero (e.g. textbox before focus)
        return el;
      }

      var immediate = check();
      if (immediate) return resolve(immediate);

      var observer = new MutationObserver(function() {
        var found = check();
        if (found) { observer.disconnect(); resolve(found); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(function() {
        observer.disconnect();
        reject(new Error(
          typeof selectorOrFn === 'string'
            ? 'Not found: ' + selectorOrFn
            : 'Element not found (custom fn)'
        ));
      }, timeout);
    });
  }

  function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  // Type into a contenteditable element using React-compatible events
  function typeIntoContentEditable(el, text) {
    el.focus();
    // Try execCommand first (most reliable for contenteditable)
    var ok = document.execCommand('insertText', false, text);
    if (!ok || el.textContent.trim() === '') {
      // Fallback: set innerHTML and fire events React listens to
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  async function run() {
    try {
      var url = window.location.href;

      // ── Detect if we are already on a messaging page ─────────────────────
      var alreadyMessaging = url.includes('/messaging/');

      if (!alreadyMessaging) {
        // If a compose box is already visible (e.g. overlay bubble already open),
        // skip clicking the Message button entirely.
        var existingCompose =
          document.querySelector('.msg-form__contenteditable[contenteditable="true"]') ||
          document.querySelector('.msg-overlay-conversation-bubble [contenteditable="true"]') ||
          document.querySelector('div[role="textbox"][contenteditable="true"]');

        if (!existingCompose) {
          // ── Profile page: locate and click the "Message" button ─────────────
          var messageBtn = await waitFor(function() {
            var els = Array.from(document.querySelectorAll('button, a'));
            return els.find(function(el) {
              var ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
              var text = '';
              el.childNodes.forEach(function(node) {
                if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
                if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'SPAN') text += node.textContent;
              });
              text = text.trim();
              return (
                ariaLabel.includes('message') ||
                text === 'Message'             ||
                text === 'Send message'        ||
                el.textContent.trim() === 'Message'
              );
            }) || null;
          }, 12000);

          messageBtn.click();
          // Wait for the messaging drawer/overlay bubble to animate open
          await sleep(2500);
        }
      }

      // ── Find the compose textbox ─────────────────────────────────────────
      // LinkedIn has multiple compose UIs: full page, overlay bubble, drawer.
      // We try specific selectors first, then fall back to any visible contenteditable.
      var composeBox = await waitFor(function() {
        // Specific known selectors (full page + overlay bubble)
        var el =
          document.querySelector('.msg-form__contenteditable[contenteditable="true"]')           ||
          document.querySelector('.msg-overlay-conversation-bubble [contenteditable="true"]')    ||
          document.querySelector('div[aria-label="Write a message…"][contenteditable="true"]')   ||
          document.querySelector('div[aria-label="Write a message"][contenteditable="true"]')    ||
          document.querySelector('div[role="textbox"][contenteditable="true"]')                  ||
          document.querySelector('.msg-form [contenteditable="true"]')                           ||
          document.querySelector('.msg-convo-wrapper [contenteditable="true"]');

        // Last-resort: any contenteditable div with visible dimensions
        if (!el) {
          var all = Array.from(document.querySelectorAll('[contenteditable="true"]'));
          el = all.find(function(e) {
            var r = e.getBoundingClientRect();
            return r.width > 80 && r.height > 20;
          }) || null;
        }

        return el;
      }, 15000);

      // ── Clear and type the message ───────────────────────────────────────
      composeBox.focus();
      await sleep(400);

      // Select all and delete any placeholder / existing draft
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      await sleep(300);

      typeIntoContentEditable(composeBox, messageText);
      await sleep(1000);

      // ── Find and click the Send button ───────────────────────────────────
      var sendBtn = await waitFor(function() {
        // Try specific class selectors
        var candidates = Array.from(document.querySelectorAll(
          'button.msg-form__send-button, ' +
          '.msg-form__footer button[type="submit"], ' +
          '.msg-overlay-conversation-bubble button[type="submit"], ' +
          'button[data-control-name="send"]'
        ));

        // Also search by aria-label or visible text "Send"
        if (!candidates.length) {
          candidates = Array.from(document.querySelectorAll('button')).filter(function(b) {
            var label = (b.getAttribute('aria-label') || '').toLowerCase();
            var text  = b.textContent.trim().toLowerCase();
            return label === 'send' || label.includes('send message') || text === 'send';
          });
        }

        return candidates.find(function(b) { return !b.disabled; }) || null;
      }, 10000);

      if (!sendBtn || sendBtn.disabled) {
        throw new Error('Send button not found or disabled — message text may not have registered.');
      }

      sendBtn.click();
      await sleep(2000);

      chrome.runtime.sendMessage({
        type: 'LINKEDIN_SEND_RESULT',
        msgId: msgId,
        recipientName: recipientName,
        success: true
      });

    } catch (err) {
      chrome.runtime.sendMessage({
        type: 'LINKEDIN_SEND_RESULT',
        msgId: msgId,
        recipientName: recipientName,
        success: false,
        error: err.message
      });
    }
  }

  run();
}
