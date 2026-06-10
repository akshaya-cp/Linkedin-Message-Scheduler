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

  // Poll every 500ms until element found or timeout
  function waitFor(fn, label, timeout) {
    timeout = timeout || 15000;
    return new Promise(function(resolve, reject) {
      var elapsed = 0;
      var interval = setInterval(function() {
        var el = fn();
        if (el) { clearInterval(interval); resolve(el); return; }
        elapsed += 500;
        if (elapsed >= timeout) {
          clearInterval(interval);
          reject(new Error('[' + label + '] Not found after ' + (timeout/1000) + 's'));
        }
      }, 500);
    });
  }

  function findComposeBox() {
    // All known LinkedIn compose box selectors
    var selectors = [
      '.msg-form__contenteditable[contenteditable="true"]',
      '.msg-overlay-conversation-bubble [contenteditable="true"]',
      'div[aria-label="Write a message…"][contenteditable="true"]',
      'div[aria-label="Write a message"][contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"]',
      '.msg-form [contenteditable="true"]'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el) return el;
    }
    // Last resort: any visible contenteditable with area > threshold
    var all = Array.from(document.querySelectorAll('[contenteditable="true"]'));
    return all.find(function(e) {
      var r = e.getBoundingClientRect();
      return r.width > 100 && r.height > 20;
    }) || null;
  }

  function findMessageButton() {
    // Method 1: button with a SPAN child whose text is exactly "Message"
    var btns = Array.from(document.querySelectorAll('button'));
    var found = btns.find(function(b) {
      var spans = Array.from(b.querySelectorAll('span'));
      return spans.some(function(s) { return s.textContent.trim() === 'Message'; });
    });
    if (found) return found;

    // Method 2: aria-label contains "message" (case insensitive)
    found = document.querySelector('button[aria-label*="essage"]');
    if (found) return found;

    // Method 3: button textContent is exactly "Message"
    found = btns.find(function(b) { return b.textContent.trim() === 'Message'; });
    if (found) return found;

    return null;
  }

  function findSendButton() {
    // Method 1: known class
    var el = document.querySelector('button.msg-form__send-button');
    if (el && !el.disabled) return el;

    // Method 2: button with aria-label "Send" or text "Send"
    var btns = Array.from(document.querySelectorAll('button'));
    el = btns.find(function(b) {
      var label = (b.getAttribute('aria-label') || '').trim().toLowerCase();
      var text  = b.textContent.trim().toLowerCase();
      return (label === 'send' || text === 'send') && !b.disabled;
    });
    if (el) return el;

    // Method 3: submit button inside msg form
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
        var messageBtn = await waitFor(findMessageButton, 'Message Button', 12000);

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
