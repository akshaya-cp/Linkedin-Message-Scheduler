// background.js - MV3 service worker
// Two-phase injection:
//   Phase 1 (main frame only)  → click the "Message" button
//   Phase 2 (ALL frames/iframes) → find compose box, type, and send

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

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  const sessionKey = 'pending_tab_' + tabId;
  const session = await chrome.storage.session.get(sessionKey);
  const pending = session[sessionKey];
  if (!pending) return;
  if (!tab.url || !tab.url.includes('linkedin.com')) return;

  await chrome.storage.session.remove(sessionKey);

  // ── Phase 1 (after 6s): click Message button in main frame ─────────────────
  setTimeout(async () => {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        func: phase1ClickMessageButton
      });
      const clickResult = results && results[0] && results[0].result;

      // ── Phase 2 (after 7 more seconds): find compose box in ALL frames ────
      setTimeout(async () => {
        try {
          await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: phase2SendMessage,
            args: [pending.messageText, pending.msgId, pending.recipientName, clickResult || '']
          });
        } catch (err) {
          await updateStatus(pending.msgId, 'failed', {
            errorReason: '[Phase2 inject] ' + err.message
          });
          chrome.notifications.create('fail_p2_' + pending.msgId, {
            type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'),
            title: 'Auto-send Failed', message: err.message, priority: 2
          });
        }
      }, 5000);

    } catch (err) {
      await updateStatus(pending.msgId, 'failed', {
        errorReason: '[Phase1 inject] ' + err.message
      });
    }
  }, 6000);
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
      title: 'Auto-send Failed', message: error || 'Could not auto-send.', priority: 2
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
// PHASE 1 — runs in main frame only
// Finds and clicks the "Message" button on the profile page.
// Returns a string describing what happened (for debug).
// ─────────────────────────────────────────────────────────────────────────────
function phase1ClickMessageButton() {

  function hasMessageText(el) {
    if (el.textContent.trim() === 'Message') return true;
    return Array.from(el.querySelectorAll('span')).some(function(s) {
      return s.textContent.trim() === 'Message';
    });
  }

  // Priority 1: button (not anchor) inside the profile actions section
  var actionsSection = document.querySelector(
    '.pvs-profile-actions, .pv-top-card--actions, .pv-s-profile-actions, [data-section="topcard-actions"]'
  );
  if (actionsSection) {
    var sectionBtns = Array.from(actionsSection.querySelectorAll('button'));
    var found = sectionBtns.find(function(b) {
      var label = (b.getAttribute('aria-label') || '').toLowerCase();
      return label.includes('message') || hasMessageText(b);
    });
    if (found) { found.click(); return 'CLICKED(actions/button): ' + found.outerHTML.slice(0, 80); }
  }

  // Priority 2: any <button> on the page with "Message" text
  var allBtns = Array.from(document.querySelectorAll('button'));
  var found = allBtns.find(function(b) {
    var label = (b.getAttribute('aria-label') || '').toLowerCase();
    return label.includes('message') || hasMessageText(b);
  });
  if (found) { found.click(); return 'CLICKED(button): aria=' + (found.getAttribute('aria-label') || '') + ' text=' + found.textContent.trim().slice(0, 30); }

  // Priority 3: <a> inside profile actions (opens thread — still valid)
  if (actionsSection) {
    var sectionLinks = Array.from(actionsSection.querySelectorAll('a'));
    found = sectionLinks.find(function(a) {
      var label = (a.getAttribute('aria-label') || '').toLowerCase();
      return label.includes('message') || hasMessageText(a);
    });
    if (found) { found.click(); return 'CLICKED(actions/link): href=' + (found.getAttribute('href') || '') + ' text=' + found.textContent.trim().slice(0, 30); }
  }

  // Priority 4: any <a> with "Message" text (last resort)
  var allLinks = Array.from(document.querySelectorAll('a'));
  found = allLinks.find(function(a) { return hasMessageText(a); });
  if (found) { found.click(); return 'CLICKED(link/fallback): href=' + (found.getAttribute('href') || '') + ' text=' + found.textContent.trim().slice(0, 30); }

  var debug = Array.from(document.querySelectorAll('button')).slice(0, 6).map(function(b) {
    return (b.getAttribute('aria-label') || b.textContent.trim().slice(0, 15));
  }).join(' / ');
  return 'NOT_FOUND. Buttons: ' + debug;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 — injected into ALL frames (including iframes)
// Each frame checks for a compose box. Only the frame that has one proceeds.
// ─────────────────────────────────────────────────────────────────────────────
function phase2SendMessage(messageText, msgId, recipientName, phase1Result) {
  function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  function waitFor(fn, label, timeout) {
    timeout = timeout || 10000;
    return new Promise(function(resolve, reject) {
      var elapsed = 0;
      var iv = setInterval(function() {
        var el = fn();
        if (el) { clearInterval(iv); resolve(el); return; }
        elapsed += 400;
        if (elapsed >= timeout) { clearInterval(iv); reject(new Error('[' + label + '] timeout')); }
      }, 400);
    });
  }

  function findComposeBox() {
    var selectors = [
      '.msg-form__contenteditable[contenteditable="true"]',
      '.msg-overlay-conversation-bubble [contenteditable="true"]',
      'div[aria-label="Write a message…"][contenteditable="true"]',
      'div[aria-label="Write a message"][contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"]',
      '.msg-form [contenteditable="true"]',
      '[contenteditable="true"]',
      '.msg-form__textarea',
      'textarea[placeholder*="message" i]',
      'textarea[placeholder*="write" i]',
      'textarea'
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
      var label = (b.getAttribute('aria-label') || '').trim().toLowerCase();
      var text  = b.textContent.trim().toLowerCase();
      return (label === 'send' || text === 'send') && !b.disabled;
    });
    if (el) return el;
    el = document.querySelector('.msg-form button[type="submit"]:not(:disabled)') ||
         document.querySelector('.msg-overlay-conversation-bubble button[type="submit"]:not(:disabled)') ||
         document.querySelector('form button[type="submit"]:not(:disabled)');
    return el || null;
  }

  // ── Skip background/preload frames LinkedIn uses for prefetching ─────────
  var frameUrl = window.location.href;
  if (frameUrl.includes('/preload') || frameUrl.includes('_bprMode') || frameUrl.includes('bprMode') || frameUrl.includes('li-page-preload')) {
    return;
  }

  // ── Check if THIS frame has a compose box ───────────────────────────────
  var immediate = findComposeBox();
  if (!immediate) {
    // Nothing here — wrong frame, exit silently
    return;
  }

  // ── This frame has the compose box — proceed ───────────────────────────
  async function send() {
    try {
      // Wait for compose box to be fully ready (in case it's still animating)
      var composeBox = await waitFor(findComposeBox, 'ComposeBox', 8000);

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

      var enteredText = isTextarea ? composeBox.value : composeBox.textContent;
      if (!enteredText || enteredText.trim() === '') {
        throw new Error('[type] Text did not register (tag=' + composeBox.tagName + ')');
      }

      var sendBtn = await waitFor(findSendButton, 'SendButton', 8000);
      sendBtn.click();
      await sleep(2000);

      chrome.runtime.sendMessage({
        type: 'LINKEDIN_SEND_RESULT', msgId: msgId,
        recipientName: recipientName, success: true
      });

    } catch (err) {
      chrome.runtime.sendMessage({
        type: 'LINKEDIN_SEND_RESULT', msgId: msgId,
        recipientName: recipientName, success: false,
        error: err.message + ' | p1=' + phase1Result + ' | frame=' + window.location.href.slice(0, 60)
      });
    }
  }

  send();
}
