// ── DOM refs ──────────────────────────────────────────────────────────────────
const recipientName = document.getElementById('recipientName');
const profileUrl    = document.getElementById('profileUrl');
const messageText   = document.getElementById('messageText');
const scheduledTime = document.getElementById('scheduledTime');
const saveBtn       = document.getElementById('saveBtn');
const messageList   = document.getElementById('messageList');
const charCount     = document.getElementById('charCount');
const toast         = document.getElementById('toast');
const messageBadge  = document.getElementById('messageBadge');
const clearAllBtn   = document.getElementById('clearAllBtn');

// ── Init: set min datetime to now ─────────────────────────────────────────────
function setMinDateTime() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  scheduledTime.min = now.toISOString().slice(0, 16);
}
setMinDateTime();

// ── Character counter ─────────────────────────────────────────────────────────
messageText.addEventListener('input', () => {
  const len = messageText.value.length;
  charCount.textContent = `${len} / 300`;
  charCount.classList.toggle('warning', len > 270);
});

// ── Show toast notification ───────────────────────────────────────────────────
function showToast(message, type = 'success') {
  toast.textContent = message;
  toast.className = `toast ${type} show`;
  setTimeout(() => { toast.className = 'toast'; }, 3000);
}

// ── Load all messages from storage and render ─────────────────────────────────
function loadMessages() {
  chrome.storage.local.get(['scheduledMessages'], (result) => {
    const messages = result.scheduledMessages || [];
    renderMessages(messages);
    updateBadge(messages);
  });
}

// ── Update header badge count ─────────────────────────────────────────────────
function updateBadge(messages) {
  const pending  = messages.filter(m => m.status === 'pending').length;
  const sending  = messages.filter(m => m.status === 'sending').length;
  const failed   = messages.filter(m => m.status === 'failed').length;
  let label = `${pending} scheduled`;
  if (sending) label += ` · ${sending} sending`;
  if (failed)  label += ` · ${failed} failed`;
  messageBadge.textContent = label;
  clearAllBtn.style.display = messages.length > 0 ? 'block' : 'none';
}

// ── Render message cards ───────────────────────────────────────────────────────
function renderMessages(messages) {
  if (messages.length === 0) {
    messageList.innerHTML = `
      <div class="empty-state">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#c8d6e0" stroke-width="1.5">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <p>No messages scheduled yet.<br/>Add one above to get started.</p>
      </div>`;
    return;
  }

  // Sort: pending first, then overdue, then by time
  const sorted = [...messages].sort((a, b) => {
    if (a.status === 'pending' && b.status !== 'pending') return -1;
    if (a.status !== 'pending' && b.status === 'pending') return 1;
    return new Date(a.scheduledTime) - new Date(b.scheduledTime);
  });

  messageList.innerHTML = sorted.map(msg => {
    const dt       = new Date(msg.scheduledTime);
    const isOverdue = msg.status === 'pending' && dt < new Date();
    const status   = isOverdue ? 'overdue' : msg.status;
    const timeStr  = dt.toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    const shortUrl = msg.profileUrl
      ? msg.profileUrl.replace('https://www.', '').replace('https://', '')
      : '';

    return `
      <div class="message-card ${isOverdue ? 'overdue' : ''}" data-id="${msg.id}">
        <div class="card-header">
          <div>
            <div class="card-name">${escapeHtml(msg.recipientName)}</div>
            ${msg.profileUrl
              ? `<a class="card-url" href="${escapeHtml(msg.profileUrl)}" target="_blank" title="${escapeHtml(msg.profileUrl)}">${escapeHtml(shortUrl)}</a>`
              : ''}
          </div>
          <div class="card-actions">
            <button class="btn-icon copy" title="Copy message" data-id="${msg.id}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
            </button>
            <button class="btn-icon delete" title="Delete" data-id="${msg.id}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="card-message">${escapeHtml(msg.messageText)}</div>
        <div class="card-footer">
          <div class="card-time">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke-width="2">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            ${timeStr}
          </div>
          <span class="status-pill ${status}">${statusLabel(msg.status, isOverdue)}</span>
        </div>
      </div>`;
  }).join('');

  // Attach event listeners to buttons
  messageList.querySelectorAll('.btn-icon.delete').forEach(btn => {
    btn.addEventListener('click', () => deleteMessage(btn.dataset.id));
  });
  messageList.querySelectorAll('.btn-icon.copy').forEach(btn => {
    btn.addEventListener('click', () => copyMessage(btn.dataset.id));
  });
}

// ── Save a new message ────────────────────────────────────────────────────────
saveBtn.addEventListener('click', () => {
  const name    = recipientName.value.trim();
  const url     = profileUrl.value.trim();
  const message = messageText.value.trim();
  const time    = scheduledTime.value;

  if (!name)    { showToast('Please enter a recipient name.', 'error'); return; }
  if (!message) { showToast('Please write a message.', 'error'); return; }
  if (!time)    { showToast('Please select a scheduled time.', 'error'); return; }
  if (message.length > 300) { showToast('Message exceeds 300 characters.', 'error'); return; }

  const scheduledDate = new Date(time);
  if (scheduledDate <= new Date()) {
    showToast('Please pick a future date and time.', 'error');
    return;
  }

  const newMsg = {
    id:            Date.now().toString(),
    recipientName: name,
    profileUrl:    url,
    messageText:   message,
    scheduledTime: scheduledDate.toISOString(),
    status:        'pending',
    createdAt:     new Date().toISOString()
  };

  chrome.storage.local.get(['scheduledMessages'], (result) => {
    const messages = result.scheduledMessages || [];
    messages.push(newMsg);

    chrome.storage.local.set({ scheduledMessages: messages }, () => {
      // Register an alarm so the background worker wakes exactly on time
      chrome.alarms.create(`msg_${newMsg.id}`, {
        when: scheduledDate.getTime()
      });

      showToast(`Scheduled for ${scheduledDate.toLocaleString()}!`);
      clearForm();
      loadMessages();
    });
  });
});

// ── Delete a single message ───────────────────────────────────────────────────
function deleteMessage(id) {
  chrome.storage.local.get(['scheduledMessages'], (result) => {
    const messages = (result.scheduledMessages || []).filter(m => m.id !== id);
    chrome.storage.local.set({ scheduledMessages: messages }, () => {
      chrome.alarms.clear(`msg_${id}`);
      showToast('Message deleted.');
      loadMessages();
    });
  });
}

// ── Copy message text to clipboard ───────────────────────────────────────────
function copyMessage(id) {
  chrome.storage.local.get(['scheduledMessages'], (result) => {
    const msg = (result.scheduledMessages || []).find(m => m.id === id);
    if (msg) {
      navigator.clipboard.writeText(msg.messageText).then(() => {
        showToast('Message copied to clipboard!');
      });
    }
  });
}

// ── Clear all messages ────────────────────────────────────────────────────────
clearAllBtn.addEventListener('click', () => {
  if (!confirm('Delete all scheduled messages?')) return;
  chrome.alarms.clearAll();
  chrome.storage.local.set({ scheduledMessages: [] }, () => {
    showToast('All messages cleared.');
    loadMessages();
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function clearForm() {
  recipientName.value = '';
  profileUrl.value    = '';
  messageText.value   = '';
  scheduledTime.value = '';
  charCount.textContent = '0 / 300';
  charCount.classList.remove('warning');
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
            .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

function capitalise(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}

function statusLabel(status, isOverdue) {
  if (isOverdue)          return 'Overdue';
  if (status === 'sending') return '⏳ Sending…';
  if (status === 'sent')    return '✅ Sent';
  if (status === 'failed')  return '❌ Failed';
  if (status === 'notified') return 'Notified ✓';
  return capitalise(status);
}

// ── Auto-refresh when background changes storage ──────────────────────────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.scheduledMessages) {
    renderMessages(changes.scheduledMessages.newValue || []);
    updateBadge(changes.scheduledMessages.newValue || []);
  }
});

// ── On load ───────────────────────────────────────────────────────────────────
loadMessages();
