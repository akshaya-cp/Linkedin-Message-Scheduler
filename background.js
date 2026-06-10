// ── background.js ─────────────────────────────────────────────────────────────
// Runs as a Manifest V3 service worker.
// Uses chrome.alarms (more reliable than setInterval in MV3) to fire
// notifications exactly when a scheduled message is due.

const ALARM_PREFIX = 'msg_';

// ── Alarm listener ─────────────────────────────────────────────────────────────
// Fires when any alarm created by popup.js (named "msg_<id>") triggers.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;

  const msgId = alarm.name.slice(ALARM_PREFIX.length);

  chrome.storage.local.get(['scheduledMessages'], (result) => {
    const messages = result.scheduledMessages || [];
    const msg = messages.find(m => m.id === msgId);

    if (!msg || msg.status !== 'pending') return;

    // Fire the OS notification — use full extension URL for icon (required in service worker)
    chrome.notifications.create(`notif_${msgId}`, {
      type:     'basic',
      iconUrl:  chrome.runtime.getURL('icons/icon128.png'),
      title:    `⏰ Time to message ${msg.recipientName}`,
      message:  msg.messageText.length > 100
                  ? msg.messageText.slice(0, 97) + '…'
                  : msg.messageText,
      priority: 2,
      buttons:  msg.profileUrl
                  ? [{ title: 'Open LinkedIn Profile' }]
                  : []
    }, (notifId) => {
      if (chrome.runtime.lastError) {
        console.error('Notification failed:', chrome.runtime.lastError.message);
        return;
      }
      // Mark as notified only after notification successfully created
      const updated = messages.map(m =>
        m.id === msgId ? { ...m, status: 'notified', notifiedAt: new Date().toISOString() } : m
      );
      chrome.storage.local.set({ scheduledMessages: updated });
    });
  });
});

// ── Notification click: open LinkedIn profile ──────────────────────────────────
chrome.notifications.onClicked.addListener((notifId) => {
  if (!notifId.startsWith('notif_')) return;

  const msgId = notifId.slice('notif_'.length);

  chrome.storage.local.get(['scheduledMessages'], (result) => {
    const messages = result.scheduledMessages || [];
    const msg = messages.find(m => m.id === msgId);

    if (msg && msg.profileUrl) {
      chrome.tabs.create({ url: msg.profileUrl });
    }
    chrome.notifications.clear(notifId);
  });
});

// ── Notification button click: "Open LinkedIn Profile" button ─────────────────
chrome.notifications.onButtonClicked.addListener((notifId, btnIdx) => {
  if (!notifId.startsWith('notif_')) return;

  const msgId = notifId.slice('notif_'.length);

  if (btnIdx === 0) {
    chrome.storage.local.get(['scheduledMessages'], (result) => {
      const messages = result.scheduledMessages || [];
      const msg = messages.find(m => m.id === msgId);
      if (msg && msg.profileUrl) {
        chrome.tabs.create({ url: msg.profileUrl });
      }
      chrome.notifications.clear(notifId);
    });
  }
});

// ── On install: re-register alarms for any pending messages ───────────────────
// This covers the case where Chrome was restarted and alarms were cleared.
chrome.runtime.onInstalled.addListener(rescheduleAllAlarms);
chrome.runtime.onStartup.addListener(rescheduleAllAlarms);

function rescheduleAllAlarms() {
  chrome.storage.local.get(['scheduledMessages'], (result) => {
    const messages = result.scheduledMessages || [];
    const now = Date.now();

    messages.forEach(msg => {
      if (msg.status !== 'pending') return;

      const when = new Date(msg.scheduledTime).getTime();

      if (when > now) {
        // Future — set a precise alarm
        chrome.alarms.create(`${ALARM_PREFIX}${msg.id}`, { when });
      } else {
        // Overdue while Chrome was closed — fire notification immediately
        chrome.alarms.create(`${ALARM_PREFIX}${msg.id}`, {
          when: now + 3000   // 3-second delay so the service worker is ready
        });
      }
    });
  });
}
