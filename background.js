// background.js - MV3 service worker
//
// Flow:
//  1. Alarm fires → open LinkedIn profile tab
//  2. Profile loads → Phase 1: extract recipient ID from the Message link href
//  3. Navigate tab to linkedin.com/messaging/compose/?recipient=<ID>  (full page, no iframe)
//  4. Compose page loads → Phase 2: find compose box, type, send

const ALARM_PREFIX = 'msg_';

// ── Alarm fires ───────────────────────────────────────────────────────────────
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

  // Safety net: auto-fail after 40 seconds if nothing responds
  setTimeout(async () => {
    const { scheduledMessages: msgs = [] } = await chrome.storage.local.get('scheduledMessages');
    const current = msgs.find(m => m.id === msgId);
    if (current && current.status === 'sending') {
      await updateStatus(msgId, 'failed', {
        errorReason: 'Timed out — no response from LinkedIn page. Make sure you are logged in.'
      });
    }
  }, 40000);

  try {
    const tab = await chrome.tabs.create({ url: msg.profileUrl, active: true });
    await chrome.storage.session.set({
      ['pending_tab_' + tab.id]: {
        msgId: msg.id, messageText: msg.messageText, recipientName: msg.recipientName
      }
    });
  } catch (err) {
    await updateStatus(msgId, 'failed', { errorReason: 'Could not open tab: ' + err.message });
  }
});

// ── Tab navigation events ─────────────────────────────────────────────────────
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || !tab.url.includes('linkedin.com')) return;

  // ── Case A: Messaging compose/thread page loaded → run Phase 2 ─────────────
  const navKey = 'phase2_nav_' + tabId;
  const navSession = await chrome.storage.session.get(navKey);
  const navPending = navSession[navKey];
  if (navPending && tab.url.match(/linkedin\.com\/messaging\//)) {
    await chrome.storage.session.remove(navKey);
    setTimeout(async () => {
      try {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: false }, // main frame only — full page compose
          func: phase2SendMessage,
          args: [navPending.messageText, navPending.msgId, navPending.recipientName, tab.url]
        });
      } catch (err) {
        await updateStatus(navPending.msgId, 'failed', { errorReason: '[Phase2] ' + err.message });
      }
    }, 3000); // 3s for React to render the compose form
    return;
  }

  // ── Case B: Profile page loaded → run Phase 1 to extract recipient ID ───────
  const sessionKey = 'pending_tab_' + tabId;
  const session = await chrome.storage.session.get(sessionKey);
  const pending = session[sessionKey];
  if (!pending) return;

  await chrome.storage.session.remove(sessionKey);
  await chrome.storage.session.set({ [navKey]: pending }); // store for Case A

  // Wait 6 seconds for LinkedIn SPA to fully render the profile actions
  setTimeout(async () => {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        func: phase1ExtractMessagingUrl
      });
      const extracted = results && results[0] && results[0].result;

      if (!extracted) {
        await chrome.storage.session.remove(navKey);
        await updateStatus(pending.msgId, 'failed', {
          errorReason: 'Could not find Message link on profile. Make sure you are logged in and connected.'
        });
        return;
      }

      // Navigate tab to the full messaging compose page
      await chrome.tabs.update(tabId, { url: extracted });
      // tabs.onUpdated Case A will fire when this page loads

    } catch (err) {
      await chrome.storage.session.remove(navKey);
      await updateStatus(pending.msgId, 'failed', { errorReason: '[Phase1] ' + err.message });
    }
  }, 6000);
});

// ── Result from Phase 2 ───────────────────────────────────────────────────────
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
      title: 'Auto-send Failed', message: error || 'Could not auto-send.', priority: 2
    });
  }
});

// ── Reschedule on restart ─────────────────────────────────────────────────────
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
// PHASE 1 — runs in profile page (main frame)
// Finds the Message link and extracts a clean messaging compose URL.
// Does NOT click the link (avoids overlay iframe).
// Returns full URL to navigate to, or null if not found.
// ─────────────────────────────────────────────────────────────────────────────
function phase1ExtractMessagingUrl() {
  var allLinks = Array.from(document.querySelectorAll('a'));

  function hasMessageLabel(el) {
    var label = (el.getAttribute('aria-label') || '').toLowerCase();
    if (label.includes('message')) return true;
    if (el.textContent.trim() === 'Message') return true;
    return Array.from(el.querySelectorAll('span')).some(function(s) {
      return s.textContent.trim() === 'Message';
    });
  }

  // Find an anchor with a /messaging/ href that is the Message button
  var msgLink = allLinks.find(function(a) {
    var href = a.getAttribute('href') || '';
    return href.includes('/messaging/') && hasMessageLabel(a);
  });

  if (msgLink) {
    var href = msgLink.getAttribute('href');
    // Parse out recipient / profileUrn params and build a clean full-page URL
    try {
      var u = new URL(href, 'https://www.linkedin.com');
      var recipient  = u.searchParams.get('recipient');
      var profileUrn = u.searchParams.get('profileUrn');

      if (recipient) {
        var clean = 'https://www.linkedin.com/messaging/compose/?recipient=' + encodeURIComponent(recipient);
        if (profileUrn) clean += '&profileUrn=' + encodeURIComponent(profileUrn);
        return clean;
      }
      // If no recipient param, use the href as-is (drop interop=msgOverlay)
      u.searchParams.delete('interop');
      u.searchParams.delete('screenContext');
      return u.toString();
    } catch(e) {
      return 'https://www.linkedin.com' + href;
    }
  }

  // Fallback: look for button (click it) — overlay will open in main page
  var btns = Array.from(document.querySelectorAll('button'));
  var btn = btns.find(function(b) {
    var label = (b.getAttribute('aria-label') || '').toLowerCase();
    return label.includes('message') || b.textContent.trim() === 'Message' ||
           Array.from(b.querySelectorAll('span')).some(function(s) { return s.textContent.trim() === 'Message'; });
  });
  if (btn) {
    btn.click();
    return 'BUTTON_CLICKED_overlay';
  }

  // Debug: list what's on the page
  var debug = allLinks.slice(0, 5).map(function(a) {
    return (a.getAttribute('href') || '').slice(0, 40) + '[' + a.textContent.trim().slice(0, 15) + ']';
  }).join(' / ');
  return 'NOT_FOUND: ' + debug;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 — runs in the LinkedIn messaging compose page (main frame, full page)
// Finds compose box, types message, clicks Send.
// ─────────────────────────────────────────────────────────────────────────────
function phase2SendMessage(messageText, msgId, recipientName, pageUrl) {
  function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  function waitFor(fn, label, timeout) {
    timeout = timeout || 12000;
    return new Promise(function(resolve, reject) {
      var elapsed = 0;
      var iv = setInterval(function() {
        var el = fn();
        if (el) { clearInterval(iv); resolve(el); return; }
        elapsed += 400;
        if (elapsed >= timeout) {
          clearInterval(iv);
          var all = Array.from(document.querySelectorAll('[contenteditable], textarea, input')).slice(0, 4);
          var info = all.map(function(e) {
            return e.tagName + '[ce=' + e.getAttribute('contenteditable') + '][ph=' + (e.getAttribute('placeholder') || e.getAttribute('aria-label') || '') + ']';
          }).join(' | ') || 'none';
          reject(new Error('[' + label + '] timeout. Editables: ' + info + ' | url=' + pageUrl.slice(0,60)));
        }
      }, 400);
    });
  }

  function findComposeBox() {
    var selectors = [
      'div.msg-form__contenteditable[contenteditable="true"]',
      'div[aria-label="Write a message…"][contenteditable="true"]',
      'div[aria-label="Write a message"][contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"]',
      '.msg-form [contenteditable="true"]',
      '[contenteditable="true"]',
      'textarea.msg-form__textarea',
      'textarea[placeholder*="message" i]',
      'textarea[placeholder*="write" i]'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el) return el;
    }
    return null;
  }

  function findSendButton() {
    var el = document.querySelector('button.msg-form__send-button:not(:disabled)');
    if (el) return el;
    var btns = Array.from(document.querySelectorAll('button'));
    el = btns.find(function(b) {
      var label = (b.getAttribute('aria-label') || '').toLowerCase();
      var text  = b.textContent.trim().toLowerCase();
      return (label === 'send' || text === 'send') && !b.disabled;
    });
    if (el) return el;
    return document.querySelector('.msg-form button[type="submit"]:not(:disabled)') || null;
  }

  async function send() {
    try {
      var composeBox = await waitFor(findComposeBox, 'ComposeBox', 12000);

      composeBox.click();
      composeBox.focus();
      await sleep(600);

      var isTextarea = composeBox.tagName === 'TEXTAREA' || composeBox.tagName === 'INPUT';
      if (isTextarea) {
        var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(composeBox, messageText);
        composeBox.dispatchEvent(new Event('input', { bubbles: true }));
        composeBox.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        await sleep(200);
        var ok = document.execCommand('insertText', false, messageText);
        if (!ok || composeBox.textContent.trim() === '') {
          composeBox.textContent = messageText;
          composeBox.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: messageText }));
        }
      }

      await sleep(1000);
      var entered = isTextarea ? composeBox.value : composeBox.textContent;
      if (!entered || entered.trim() === '') {
        throw new Error('[type] Text did not register (tag=' + composeBox.tagName + ')');
      }

      var sendBtn = await waitFor(findSendButton, 'SendButton', 8000);
      sendBtn.click();
      await sleep(2000);

      chrome.runtime.sendMessage({ type: 'LINKEDIN_SEND_RESULT', msgId: msgId, recipientName: recipientName, success: true });

    } catch (err) {
      chrome.runtime.sendMessage({ type: 'LINKEDIN_SEND_RESULT', msgId: msgId, recipientName: recipientName, success: false, error: err.message });
    }
  }

  send();
}
