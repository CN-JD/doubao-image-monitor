const DEFAULT_PROMPT = '继续生成10张图片';
const DEFAULT_PROMPTS = [
  '继续生成10张图片',
];

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(['promptText', 'promptPresets', 'autoRefreshSeconds', 'autoSendEnabled']);
  const defaults = {};

  if (!existing.promptText) defaults.promptText = DEFAULT_PROMPT;
  if (!Array.isArray(existing.promptPresets) || !existing.promptPresets.length) {
    defaults.promptPresets = DEFAULT_PROMPTS;
  }
  if (!existing.autoRefreshSeconds) defaults.autoRefreshSeconds = 3;
  if (typeof existing.autoSendEnabled !== 'boolean') defaults.autoSendEnabled = false;

  if (Object.keys(defaults).length) {
    await chrome.storage.local.set(defaults);
  }

  if (chrome.sidePanel?.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (chrome.sidePanel?.open) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch (error) {
    console.warn('打开侧边栏失败：', error);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.type === 'DOUBAO_STATUS_UPDATE') {
    const tabId = sender.tab?.id;
    if (!tabId) return false;

    const payload = message.payload || {};
    const fingerprint = JSON.stringify({
      status: payload.status || '获取中',
      imageCount: Number(payload.imageCount || 0),
      hasRunningTaskMarker: Boolean(payload.hasRunningTaskMarker),
      isLimited: Boolean(payload.isLimited)
    });

    const now = Date.now();
    const cache = globalThis.__doubaoStatusForwardCache || (globalThis.__doubaoStatusForwardCache = new Map());
    const previous = cache.get(tabId);

    if (previous && previous.fingerprint === fingerprint && now - previous.at < 800) {
      sendResponse({ ok: true, deduped: true });
      return true;
    }

    cache.set(tabId, {
      fingerprint,
      at: now
    });

    chrome.runtime.sendMessage({
      type: 'PANEL_STATUS_UPDATE',
      tabId,
      payload
    }).catch(() => {
    });

    sendResponse({ ok: true });
    return true;
  }

  return false;
});
