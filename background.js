// background.js - MV3 service worker
// Opens LinkedIn tab at scheduled time, injects script to click Message,
// type the draft, and click Send automatically.

const ALARM_PREFIX = 'msg_';

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;

  const msgId = alarm.name.slice(ALARM_PREFIX.length);
  const { scheduledMessages = [] } = await chrome.storage.local.get('scheduledMessages');
  const msg = scheduledMessages.find(m => m.id === msgId);

  if (!msg || msg.status !== 'pending') return;

  if (!msg.profileUrl || !msg.profileUrl.includes('linkedin.com')) {
    await updateStatus(msgId, 'notified');
    chrome.notifications.create('notif_' + msgId, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Time to message ' + msg.recipientName,
      message: msg.messageText.length > 100 ? msg.messageText.slice(0, 97) + '...' : msg.messageText,
      priority: 2
    });
    return;
  }

  await updateStatus(msgId, 'sending');

  try {
    const tab = await chrome.tabs.create({ url: msg.profileUrl, active: true });
    await chrome.storage.session.set({
      ['pending_tab_' + tab.id]: {
        msgId: msg.id,
        messageText: msg.messageText,
        recipientName: msg.recipientName
      }
    });
  } catch (err) {
    await updateStatus(msgId, 'failed');
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;

  const sessionKey = 'pending_tab_' + tabId;
  const session = await chrome.storage.session.get(sessionKey);
  const pending = session[sessionKey];

  if (!pending) return;
  if (!tab.url || !tab.url.includes('linkedin.com')) return;

  await chrome.storage.session.remove(sessionKey);

  setTimeout(async () => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: autoSendLinkedInMessage,
        args: [pending.messageText, pending.msgId, pending.recipientName]
      });
    } catch (err) {
      await updateStatus(pending.msgId, 'failed');
      chrome.notifications.create('fail_' + pending.msgId, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'Could Not Inject Script',
        message: 'Make sure you are logged into LinkedIn. Error: ' + err.message,
        priority: 2
      });
    }
  }, 3000);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'LINKEDIN_SEND_RESULT') return;
  const { msgId, recipientName, success, error } = msg;

  if (success) {
    updateStatus(msgId, 'sent');
    chrome.notifications.create('success_' + msgId, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Message Sent!',
      message: 'Your message to ' + recipientName + ' was sent on LinkedIn.',
      priority: 2
    });
  } else {
    updateStatus(msgId, 'failed');
    chrome.notifications.create('fail_' + msgId, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Auto-send Failed',
      message: error || ('Could not auto-send to ' + recipientName + '. Please send manually.'),
      priority: 2
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

async function updateStatus(msgId, status) {
  const { scheduledMessages = [] } = await chrome.storage.local.get('scheduledMessages');
  const updated = scheduledMessages.map(m =>
    m.id === msgId ? { ...m, status, updatedAt: new Date().toISOString() } : m
  );
  await chrome.storage.local.set({ scheduledMessages: updated });
}

// Injected into the LinkedIn tab - runs in PAGE context, not service worker
function autoSendLinkedInMessage(messageText, msgId, recipientName) {
  function waitFor(selectorOrFn, timeout) {
    timeout = timeout || 15000;
    return new Promise(function(resolve, reject) {
      function check() {
        var el = typeof selectorOrFn === 'function'
          ? selectorOrFn()
          : document.querySelector(selectorOrFn);
        return el && el.offsetParent !== null ? el : null;
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
        reject(new Error(typeof selectorOrFn === 'string' ? 'Not found: ' + selectorOrFn : 'Element not found'));
      }, timeout);
    });
  }

  function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  async function run() {
    try {
      var url = window.location.href;

      if (!url.includes('/messaging/')) {
        // Profile page: find and click the Message button
        var messageBtn = await waitFor(function() {
          var allEls = Array.from(document.querySelectorAll('button, a[role="button"], a'));
          return allEls.find(function(el) {
            var label = (el.getAttribute('aria-label') || '').toLowerCase();
            var text  = el.textContent.trim();
            return label.startsWith('message') || text === 'Message' || text === 'Send message';
          }) || null;
        }, 10000);

        messageBtn.click();
        await sleep(2000);
      }

      // Find compose box
      var composeBox = await waitFor(function() {
        return document.querySelector('div.msg-form__contenteditable[contenteditable="true"]') ||
               document.querySelector('div[role="textbox"][contenteditable="true"]');
      }, 10000);

      // Focus, clear, type
      composeBox.focus();
      await sleep(400);
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      await sleep(200);

      var inserted = document.execCommand('insertText', false, messageText);
      if (!inserted || composeBox.textContent.trim() === '') {
        composeBox.textContent = messageText;
        composeBox.dispatchEvent(new InputEvent('input', { bubbles: true, data: messageText }));
      }

      await sleep(800);

      // Find and click Send
      var sendBtn = await waitFor(function() {
        var candidates = Array.from(document.querySelectorAll(
          'button.msg-form__send-button, .msg-form__footer button[type="submit"], button[type="submit"]'
        ));
        return candidates.find(function(b) { return !b.disabled; }) || null;
      }, 8000);

      sendBtn.click();
      await sleep(1500);

      chrome.runtime.sendMessage({ type: 'LINKEDIN_SEND_RESULT', msgId: msgId, recipientName: recipientName, success: true });

    } catch (err) {
      chrome.runtime.sendMessage({ type: 'LINKEDIN_SEND_RESULT', msgId: msgId, recipientName: recipientName, success: false, error: err.message });
    }
  }

  run();
}
