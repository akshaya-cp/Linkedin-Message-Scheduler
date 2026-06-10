// background.js - MV3 service worker

const ALARM_PREFIX = 'msg_';

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  const msgId = alarm.name.slice(ALARM_PREFIX.length);
  const { scheduledMessages = [] } = await chrome.storage.local.get('scheduledMessages');
  const msg = scheduledMessages.find(m => m.id === msgId);
  if (!msg || msg.status !== 'pending') return;

  if (!msg.profileUrl || !msg.profileUrl.includes('linkedin.com')) {
    await updateStatus(msgId, 'notified', {});
    chrome.notifications.create('notif_' + msgId, {
      type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Time to message ' + msg.recipientName,
      message: msg.messageText.slice(0, 100), priority: 2
    });
    return;
  }

  await updateStatus(msgId, 'sending', {});
  try {
    const tab = await chrome.tabs.create({ url: msg.profileUrl, active: true });
    await chrome.storage.session.set({
      ['pending_tab_' + tab.id]: { msgId: msg.id, messageText: msg.messageText, recipientName: msg.recipientName }
    });
  } catch (err) {
    await updateStatus(msgId, 'failed', { errorReason: 'Could not open tab: ' + err.message });
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  const sessionKey = 'pending_tab_' + tabId;
  const session = await chrome.storage.session.get(sessionKey);
  const pending = session[sessionKey];
  if (!pending) return;

  // Must be on a LinkedIn profile page (not login/feed/etc)
  if (!tab.url || !tab.url.match(/linkedin\.com\/in\//)) return;

  await chrome.storage.session.remove(sessionKey);

  // Give LinkedIn's SPA 8 seconds to finish rendering
  setTimeout(async () => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: autoSendLinkedInMessage,
        args: [pending.messageText, pending.msgId, pending.recipientName]
      });
    } catch (err) {
      await updateStatus(pending.msgId, 'failed', {
        errorReason: '[Script injection] ' + err.message
      });
    }
  }, 8000);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'LINKEDIN_SEND_RESULT') return;
  const { msgId, recipientName, success, error } = msg;
  if (success) {
    updateStatus(msgId, 'sent', { errorReason: null });
    chrome.notifications.create('success_' + msgId, {
      type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Message Sent!',
      message: 'Your message to ' + recipientName + ' was sent on LinkedIn.', priority: 2
    });
  } else {
    updateStatus(msgId, 'failed', { errorReason: error || 'Unknown error' });
    chrome.notifications.create('fail_' + msgId, {
      type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Auto-send Failed',
      message: error || 'Could not auto-send. Please send manually.', priority: 2
    });
  }
});

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

async function updateStatus(msgId, status, extra) {
  const { scheduledMessages = [] } = await chrome.storage.local.get('scheduledMessages');
  const updated = scheduledMessages.map(m =>
    m.id === msgId ? Object.assign({}, m, { status, updatedAt: new Date().toISOString() }, extra) : m
  );
  await chrome.storage.local.set({ scheduledMessages: updated });
}

// ─────────────────────────────────────────────────────────────────────────────
// Runs inside the LinkedIn tab (PAGE context — no background.js scope access)
// ─────────────────────────────────────────────────────────────────────────────
function autoSendLinkedInMessage(messageText, msgId, recipientName) {

  function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  // Poll every 500ms until element found or timeout.
  // debugFn() is called on timeout to add extra info to the error.
  function waitFor(fn, label, timeout, debugFn) {
    timeout = timeout || 15000;
    return new Promise(function(resolve, reject) {
      var elapsed = 0;
      var interval = setInterval(function() {
        var el = fn();
        if (el) { clearInterval(interval); resolve(el); return; }
        elapsed += 500;
        if (elapsed >= timeout) {
          clearInterval(interval);
          var extra = debugFn ? (' | ' + debugFn()) : '';
          reject(new Error('[' + label + '] Not found after ' + (timeout/1000) + 's' + extra));
        }
      }, 500);
    });
  }

  // Snapshot of first N clickable elements for debug output
  function debugClickable(n) {
    var els = Array.from(document.querySelectorAll('button, a[href], [role="button"]')).slice(0, n || 6);
    return els.map(function(e) {
      var label = e.getAttribute('aria-label') || '';
      var text  = e.textContent.trim().replace(/\s+/g, ' ').slice(0, 25);
      return e.tagName + (label ? '[aria=' + label.slice(0,20) + ']' : '[' + text + ']');
    }).join(' / ');
  }

  function findComposeBox() {
    var selectors = [
      '.msg-form__contenteditable[contenteditable="true"]',
      '.msg-overlay-conversation-bubble [contenteditable="true"]',
      'div[aria-label="Write a message…"][contenteditable="true"]',
      'div[aria-label="Write a message"][contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"]',
      '.msg-form [contenteditable="true"]',
      'div[contenteditable="true"]'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el) return el;
    }
    // Last resort: any visible contenteditable
    var all = Array.from(document.querySelectorAll('[contenteditable="true"]'));
    return all.find(function(e) {
      var r = e.getBoundingClientRect();
      return r.width > 80 && r.height > 15;
    }) || null;
  }

  function findMessageButton() {
    var allClickable = Array.from(document.querySelectorAll('button, a, [role="button"]'));

    // 1. aria-label is "Message" or starts with "Message "
    var found = allClickable.find(function(el) {
      var label = (el.getAttribute('aria-label') || '').trim();
      return label === 'Message' || label.toLowerCase().startsWith('message ');
    });
    if (found) return found;

    // 2. has a span[aria-hidden] child with text "Message" (LinkedIn icon+text pattern)
    found = allClickable.find(function(el) {
      return Array.from(el.querySelectorAll('span')).some(function(s) {
        return s.textContent.trim() === 'Message';
      });
    });
    if (found) return found;

    // 3. LinkedIn-specific action button classes
    var actionBtn = document.querySelector('.pvs-profile-actions__action, .pv-s-profile-actions__action');
    if (actionBtn && actionBtn.textContent.includes('Message')) return actionBtn;

    // 4. href containing messaging/compose or messaging-overlay
    found = document.querySelector('a[href*="messaging/compose"], a[href*="messaging-overlay"]');
    if (found) return found;

    // 5. any clickable whose short text is exactly "Message"
    found = allClickable.find(function(el) {
      return el.textContent.trim() === 'Message';
    });
    if (found) return found;

    return null;
  }

  function findSendButton() {
    var el = document.querySelector('button.msg-form__send-button:not(:disabled)');
    if (el) return el;

    var btns = Array.from(document.querySelectorAll('button'));
    el = btns.find(function(b) {
      var label = (b.getAttribute('aria-label') || '').trim().toLowerCase();
      var text  = b.textContent.trim().toLowerCase();
      return (label === 'send' || text === 'send') && !b.disabled;
    });
    if (el) return el;

    el = document.querySelector('.msg-form button[type="submit"]:not(:disabled)') ||
         document.querySelector('.msg-overlay-conversation-bubble button[type="submit"]:not(:disabled)');
    return el || null;
  }

  async function run() {
    try {
      var step = 'init';

      // ── Step 1: click Message button (unless compose is already open) ────
      step = 'find-compose-box-initial';
      var composeAlreadyOpen = findComposeBox();

      if (!composeAlreadyOpen) {
        step = 'find-message-button';
          var messageBtn = await waitFor(findMessageButton, 'Message Button', 12000, function() {
            return 'PAGE ELEMENTS: ' + debugClickable(8);
          });

        step = 'click-message-button';
        messageBtn.click();
        await sleep(3000); // wait for overlay to animate open
      }

      // ── Step 2: locate compose box ───────────────────────────────────────
      step = 'find-compose-box';
      var composeBox = await waitFor(findComposeBox, 'Compose Box', 12000);

      // ── Step 3: type the message ─────────────────────────────────────────
      step = 'type-message';
      composeBox.click();
      composeBox.focus();
      await sleep(500);

      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      await sleep(300);

      var typed = document.execCommand('insertText', false, messageText);
      if (!typed || composeBox.textContent.trim() === '') {
        composeBox.innerHTML = messageText;
        composeBox.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: messageText }));
      }
      await sleep(1000);

      // Verify text was actually entered
      if (composeBox.textContent.trim() === '') {
        throw new Error('[type-message] Text did not register in compose box');
      }

      // ── Step 4: click Send ───────────────────────────────────────────────
      step = 'find-send-button';
      var sendBtn = await waitFor(findSendButton, 'Send Button', 10000);

      step = 'click-send';
      sendBtn.click();
      await sleep(2000);

      chrome.runtime.sendMessage({ type: 'LINKEDIN_SEND_RESULT', msgId: msgId, recipientName: recipientName, success: true });

    } catch (err) {
      chrome.runtime.sendMessage({ type: 'LINKEDIN_SEND_RESULT', msgId: msgId, recipientName: recipientName, success: false, error: err.message });
    }
  }

  run();
}
