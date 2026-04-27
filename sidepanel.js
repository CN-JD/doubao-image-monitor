const DOUBAO_URL_PATTERNS = [
  'https://doubao.com/*',
  'https://*.doubao.com/*'
];

const DEFAULT_PROMPTS = [
  '继续生成10张图片',
];

const DEFAULT_PROMPT = DEFAULT_PROMPTS[0];
const CUSTOM_PRESET_VALUE = '__CUSTOM_PROMPT__';

const statusMeta = {
  done: { text: '已完成', icon: '✅', progress: 100 },
  generating: { text: '生成中', icon: '⏳', progress: 65 },
  waiting: { text: '等待中', icon: '🕒', progress: 15 },
  failed: { text: '失败', icon: '⚠️', progress: 0 },
  limited: { text: '已达上限', icon: '🔒', progress: 0 },
  offline: { text: '未连接', icon: '—', progress: 0 },
  unknown: { text: '未知', icon: '？', progress: 0 }
};

let activeFilter = 'all';
let tasks = [];
let isSending = false;
let promptPresets = [...DEFAULT_PROMPTS];
let isProgrammaticPromptChange = false;
let activeTabId = null;
let activeWindowId = null;
let promptSaveTimer = null;
let autoSendEnabled = false;
const autoSentTaskTokens = new Set();

const PROMPT_SAVE_DEBOUNCE_MS = 500;
const PERIODIC_REFRESH_MS = 10000;

const taskList = document.getElementById('taskList');
const emptyTip = document.getElementById('emptyTip');
const toast = document.getElementById('toast');
const promptInput = document.getElementById('promptInput');
const charCount = document.getElementById('charCount');
const healthBadge = document.getElementById('healthBadge');
const healthText = document.getElementById('healthText');
const subtitle = document.getElementById('subtitle');
const promptPresetSelect = document.getElementById('promptPresetSelect');
const presetManager = document.getElementById('presetManager');
const presetEditor = document.getElementById('presetEditor');
const togglePresetManager = document.getElementById('togglePresetManager');
const autoSendToggle = document.getElementById('autoSendToggle');

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    toast.classList.remove('show');
  }, 2200);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function normalizePresets(value) {
  const source = Array.isArray(value) ? value : DEFAULT_PROMPTS;
  const seen = new Set();
  const result = [];

  for (const item of source) {
    const text = String(item || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }

  return result.length ? result : [...DEFAULT_PROMPTS];
}

function parsePresetEditorValue(value) {
  return normalizePresets(
    String(value || '')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
  );
}

function updateCharCount() {
  charCount.textContent = `${promptInput.value.length} 字`;
}

function renderPresetSelect() {
  const currentPrompt = promptInput.value || DEFAULT_PROMPT;
  promptPresetSelect.innerHTML = '';

  promptPresets.forEach((preset, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = preset.length > 38 ? `${preset.slice(0, 38)}…` : preset;
    option.title = preset;
    promptPresetSelect.appendChild(option);
  });

  const matchedIndex = promptPresets.findIndex(item => item === currentPrompt);
  if (matchedIndex >= 0) {
    promptPresetSelect.value = String(matchedIndex);
    return;
  }

  const customOption = document.createElement('option');
  customOption.value = CUSTOM_PRESET_VALUE;
  customOption.textContent = '自定义当前内容';
  promptPresetSelect.appendChild(customOption);
  promptPresetSelect.value = CUSTOM_PRESET_VALUE;
}

function renderPresetEditor() {
  presetEditor.value = promptPresets.join('\n');
}

function renderAutoSendToggle() {
  autoSendToggle.checked = autoSendEnabled;
}

function getTaskAutoSendToken(task) {
  if (!task) return '';
  return `${task.tabId}:${task.imageCount || 0}:${task.title || ''}`;
}

function syncAutoSentTokens() {
  const validTokens = new Set(
    tasks
      .filter(task => task.status === 'done')
      .map(task => getTaskAutoSendToken(task))
      .filter(Boolean)
  );

  for (const token of Array.from(autoSentTaskTokens)) {
    if (!validTokens.has(token)) {
      autoSentTaskTokens.delete(token);
    }
  }
}

function markTaskAutoSent(task) {
  const token = getTaskAutoSendToken(task);
  if (token) autoSentTaskTokens.add(token);
}

function clearTaskAutoSent(task) {
  const prefix = `${task?.tabId}:`;
  if (!task?.tabId) return;

  for (const token of Array.from(autoSentTaskTokens)) {
    if (token.startsWith(prefix)) {
      autoSentTaskTokens.delete(token);
    }
  }
}

async function loadSettings() {
  const settings = await chrome.storage.local.get(['promptText', 'promptPresets', 'autoSendEnabled']);
  promptPresets = normalizePresets(settings.promptPresets);
  promptInput.value = settings.promptText || promptPresets[0] || DEFAULT_PROMPT;
  autoSendEnabled = Boolean(settings.autoSendEnabled);
  renderPresetSelect();
  renderPresetEditor();
  renderAutoSendToggle();
  updateCharCount();
}

async function savePrompt() {
  await chrome.storage.local.set({ promptText: promptInput.value || DEFAULT_PROMPT });
}

function schedulePromptSave() {
  if (promptSaveTimer) {
    window.clearTimeout(promptSaveTimer);
  }

  promptSaveTimer = window.setTimeout(() => {
    promptSaveTimer = null;
    savePrompt().catch(() => {});
  }, PROMPT_SAVE_DEBOUNCE_MS);
}

async function savePromptPresets(nextPresets) {
  promptPresets = normalizePresets(nextPresets);
  await chrome.storage.local.set({ promptPresets });
  renderPresetSelect();
  renderPresetEditor();
}

async function saveAutoSendEnabled(nextValue) {
  autoSendEnabled = Boolean(nextValue);
  renderAutoSendToggle();
  await chrome.storage.local.set({ autoSendEnabled });
}

function isCreateImagePage(task) {
  return String(task?.url || '').startsWith('https://www.doubao.com/chat/create-image');
}

function isSendableTask(task) {
  if (!task) return false;
  if (task.isLimited || task.status === 'limited') return false;
  if (task.status === 'offline' || task.status === 'generating') return false;

  return ['done', 'waiting', 'failed'].includes(task.status) && task.hasInput !== false;
}

function getSendableTasks() {
  return tasks.filter(isSendableTask);
}

function getFilteredTasks() {
  if (activeFilter === 'all') return tasks;
  return tasks.filter(task => task.status === activeFilter);
}

async function updateActiveTabMarker(options = {}) {
  const { shouldRender = true } = options;

  let nextActiveTabId = null;
  let nextActiveWindowId = null;

  try {
    const focusedWindow = await chrome.windows.getLastFocused();
    if (focusedWindow?.id) {
      const [activeTab] = await chrome.tabs.query({
        active: true,
        windowId: focusedWindow.id
      });

      if (activeTab?.id) {
        nextActiveTabId = activeTab.id;
        nextActiveWindowId = activeTab.windowId;
      }
    }
  } catch {
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab?.id) {
        nextActiveTabId = activeTab.id;
        nextActiveWindowId = activeTab.windowId;
      }
    } catch {}
  }

  const changed = nextActiveTabId !== activeTabId || nextActiveWindowId !== activeWindowId;
  activeTabId = nextActiveTabId;
  activeWindowId = nextActiveWindowId;

  if (changed && shouldRender) {
    renderTasks();
  }
}

function setBusy(busy) {
  isSending = busy;
  document.querySelectorAll('button, select, textarea, input[type="checkbox"]').forEach(element => {
    if (element.id !== 'refresh') {
      element.disabled = busy;
    }
  });
}

function buildOfflineTask(tab, index, error) {
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    index,
    name: `任务 ${index + 1}`,
    title: tab.title || '豆包标签页',
    url: tab.url || '',
    status: 'offline',
    progress: 0,
    imageCount: 0,
    error: error || '无法连接 content script，请刷新该豆包标签页或重新加载插件。'
  };
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
  } catch {
  }
}

async function getTabStatus(tab, index) {
  try {
    let response;

    try {
      response = await chrome.tabs.sendMessage(tab.id, { type: 'DOUBAO_GET_STATUS' });
    } catch {
      await ensureContentScript(tab.id);
      response = await chrome.tabs.sendMessage(tab.id, { type: 'DOUBAO_GET_STATUS' });
    }

    const payload = response?.payload || {};
    const meta = statusMeta[payload.status] || statusMeta.unknown;

    return {
      tabId: tab.id,
      windowId: tab.windowId,
      index,
      name: `任务 ${index + 1}`,
      title: payload.title || tab.title || '豆包标签页',
      url: payload.url || tab.url || '',
      status: payload.status || 'unknown',
      progress: meta.progress,
      imageCount: payload.imageCount || 0,
      hasInput: Boolean(payload.hasInput),
      hasRunningTaskMarker: Boolean(payload.hasRunningTaskMarker),
      isLimited: Boolean(payload.isLimited || payload.status === 'limited')
    };
  } catch (error) {
    return buildOfflineTask(tab, index, error.message || String(error));
  }
}

async function loadTabs() {
  const tabs = await chrome.tabs.query({ url: DOUBAO_URL_PATTERNS });
  const selectedTabs = tabs.sort((a, b) => b.id - a.id);

  tasks = await Promise.all(selectedTabs.map((tab, index) => getTabStatus(tab, index)));
  syncAutoSentTokens();
  await updateActiveTabMarker({ shouldRender: false });
  render();
}

function renderStats() {
  const total = tasks.length;
  const connected = tasks.filter(task => task.status !== 'offline').length;

  document.getElementById('statTotal').textContent = total;
  document.getElementById('statGenerating').textContent = tasks.filter(t => t.status === 'generating').length;
  document.getElementById('statDone').textContent = tasks.filter(t => t.status === 'done').length;
  document.getElementById('statNeedAction').textContent = getSendableTasks().length;

  healthText.textContent = `已连接 ${connected}/${total}`;
  subtitle.textContent = total ? `正在监控 ${total} 个豆包标签页` : '请先打开豆包生图标签页';
  healthBadge.classList.toggle('offline', connected === 0);
}

function renderTasks() {
  const rows = getFilteredTasks();
  taskList.innerHTML = '';
  emptyTip.style.display = rows.length ? 'none' : 'block';

  rows.forEach(task => {
    const meta = statusMeta[task.status] || statusMeta.unknown;
    const isActiveTab = task.tabId === activeTabId;
    const card = document.createElement('article');
    card.className = `task-card ${escapeHtml(task.status)}${isActiveTab ? ' active-tab' : ''}`;

    const detail = task.error
      ? escapeHtml(task.error)
      : task.status === 'limited' || task.isLimited
        ? '已弹出登录解锁弹窗，后续批量发送会自动跳过该标签页'
        : `图片数：${task.imageCount || 0} · 生图中标记：${task.hasRunningTaskMarker ? '存在' : '不存在'} · 输入框：${task.hasInput ? '已找到' : '未找到'}`;

    const sendDisabled = !isSendableTask(task);
    const sendTitle = sendDisabled
      ? '仅在任务已结束、未达上限且输入框可用时发送'
      : '发送当前提示词';

    card.innerHTML = `
      <div class="task-top">
        <div class="task-name">
          <div class="task-heading">
            <strong>${escapeHtml(task.name)}</strong>
            ${isActiveTab ? '<span class="current-tab-pill" title="当前激活标签页">当前</span>' : ''}
          </div>
          <span title="${escapeHtml(task.title)}">${escapeHtml(task.title)}</span>
        </div>
        <div class="badge ${escapeHtml(task.status)}">${meta.icon} ${meta.text}</div>
      </div>
      <div class="progress-wrap">
        <div class="progress" style="width: ${Number(task.progress || 0)}%"></div>
      </div>
      <div class="meta">
        <span title="${detail}">${detail}</span>
      </div>
      <div class="card-actions">
        <button class="ghost" data-action="focus" data-tab-id="${task.tabId}">打开标签页</button>
        <button class="secondary" data-action="send" data-tab-id="${task.tabId}" ${sendDisabled ? 'disabled' : ''} title="${sendTitle}">发送当前</button>
      </div>
    `;

    taskList.appendChild(card);
  });
}

function render() {
  renderStats();
  renderTasks();
  renderAutoSendToggle();
  updateCharCount();
  renderPresetSelect();
}

async function focusTab(tabId) {
  const task = tasks.find(item => item.tabId === tabId);
  if (!task) return;

  await chrome.tabs.update(tabId, { active: true });
  if (task.windowId) {
    await chrome.windows.update(task.windowId, { focused: true });
  }

  activeTabId = tabId;
  activeWindowId = task.windowId || activeWindowId;
  renderTasks();
}

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise(resolve => {
      window.setTimeout(() => {
        resolve({
          ok: false,
          error: message || `等待超过 ${timeoutMs}ms`
        });
      }, timeoutMs);
    })
  ]);
}

async function sendPromptMessageToTask(task) {
  try {
    const response = await withTimeout(
      chrome.tabs.sendMessage(task.tabId, {
        type: 'DOUBAO_SEND_PROMPT',
        prompt: promptInput.value || DEFAULT_PROMPT
      }),
      6000,
      '发送等待超时。后台标签页可能暂停了页面渲染，准备激活标签页后重试。'
    );

    if (response?.isLimited || response?.status === 'limited') {
      return {
        ok: false,
        skipped: true,
        limited: true,
        status: 'limited',
        error: response?.error || '该标签页已达对话上限，后续将自动跳过'
      };
    }

    if (!response?.ok) {
      return { ok: false, status: response?.status, error: response?.error || '发送失败' };
    }

    return { ok: true, status: response?.status || 'generating' };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

async function sendPromptToTask(task, options = {}) {
  if (!task) {
    return { ok: false, error: '任务不存在' };
  }

  if (!isSendableTask(task)) {
    return {
      ok: false,
      skipped: true,
      limited: task.status === 'limited' || task.isLimited,
      error: task.status === 'generating'
        ? '任务仍在生成中，已跳过'
        : task.status === 'limited' || task.isLimited
          ? '标签页已达对话上限，已跳过'
          : '当前状态不可发送，已跳过'
    };
  }

  clearTaskAutoSent(task);

  const firstResult = await sendPromptMessageToTask(task);
  if (firstResult.ok) return firstResult;
  if (firstResult.skipped || firstResult.limited || firstResult.status === 'limited') return firstResult;
  if (options.disableActivationRetry) return firstResult;

  try {
    await focusTab(task.tabId);
    await new Promise(resolve => window.setTimeout(resolve, 350));
  } catch (error) {
    return {
      ok: false,
      error: `${firstResult.error}；自动激活标签页失败：${error.message || String(error)}`
    };
  }

  const secondResult = await sendPromptMessageToTask(task);
  if (secondResult.ok) return { ok: true, activatedRetry: true, status: secondResult.status };
  if (secondResult.skipped || secondResult.limited || secondResult.status === 'limited') return secondResult;

  return {
    ok: false,
    error: `${secondResult.error || '激活标签页后重试仍失败'}；首次错误：${firstResult.error || '未知'}`
  };
}

async function rememberActiveTabsByWindow(targetTasks) {
  const snapshots = new Map();
  const windowIds = Array.from(new Set(targetTasks.map(task => task.windowId).filter(Boolean)));

  for (const windowId of windowIds) {
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, windowId });
      if (activeTab?.id) snapshots.set(windowId, activeTab.id);
    } catch {}
  }

  return snapshots;
}

async function restoreActiveTabs(snapshots) {
  for (const [windowId, tabId] of snapshots.entries()) {
    try {
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(windowId, { focused: true });
    } catch {}
  }
}

async function sendPromptToTasks(targetTasks, label) {
  const skippedBeforeSend = targetTasks.filter(task => !isSendableTask(task));
  const eligibleTasks = targetTasks.filter(isSendableTask);

  if (!eligibleTasks.length) {
    if (skippedBeforeSend.length) {
      showToast(`没有可发送任务；已跳过 ${skippedBeforeSend.length} 个生成中/已达上限/不可发送标签页`);
    } else {
      showToast(`没有可发送的${label}任务`);
    }
    return;
  }

  setBusy(true);

  const originalActiveTabs = await rememberActiveTabsByWindow(eligibleTasks);
  let success = 0;
  let activatedRetryCount = 0;
  let skippedDuringSend = skippedBeforeSend.length;
  const failed = [];

  for (const task of eligibleTasks) {
    const result = await sendPromptToTask(task);

    if (result.status === 'limited' || result.limited) {
      task.status = 'limited';
      task.isLimited = true;
      skippedDuringSend += 1;
      continue;
    }

    if (result.skipped) {
      skippedDuringSend += 1;
      continue;
    }

    if (result.ok) {
      success += 1;
      if (result.activatedRetry) activatedRetryCount += 1;
    } else {
      failed.push(`${task.name}: ${result.error}`);
    }
  }

  await restoreActiveTabs(originalActiveTabs);

  setBusy(false);
  await loadTabs();

  const skippedText = skippedDuringSend ? `，跳过 ${skippedDuringSend} 个` : '';

  if (failed.length) {
    console.warn('发送失败详情：', failed);
    const firstError = failed[0] || '';
    showToast(`成功 ${success} 个${skippedText}，失败 ${failed.length} 个：${firstError.slice(0, 80)}`);
  } else if (activatedRetryCount) {
    showToast(`已发送 ${success} 个${label}任务${skippedText}；其中 ${activatedRetryCount} 个后台页已自动激活重试`);
  } else {
    showToast(`已向 ${success} 个${label}任务发送${skippedText}：${promptInput.value}`);
  }
}

async function tryAutoSendForTask(task) {
  if (!autoSendEnabled || isSending || !isSendableTask(task) || task.status !== 'done') {
    return;
  }

  if (isCreateImagePage(task)) {
    return;
  }

  const token = getTaskAutoSendToken(task);
  if (!token || autoSentTaskTokens.has(token)) {
    return;
  }

  markTaskAutoSent(task);
  const result = await sendPromptToTask(task, { disableActivationRetry: true });

  if (result.ok) {
    task.status = result.status || 'generating';
    task.progress = (statusMeta[task.status] || statusMeta.unknown).progress;
    task.hasRunningTaskMarker = task.status === 'generating';
    render();
    showToast(`已自动向 ${task.name} 发送提示词`);
    return;
  }

  if (result.status === 'limited' || result.limited) {
    task.status = 'limited';
    task.isLimited = true;
    task.progress = statusMeta.limited.progress;
    render();
    showToast(`${task.name} 已达上限，自动发送已跳过`);
    return;
  }

  autoSentTaskTokens.delete(token);

  if (!result.skipped) {
    showToast(`${task.name} 自动发送失败：${result.error || '未知错误'}`);
  }
}

function bindEvents() {
  document.getElementById('filters').addEventListener('click', event => {
    const button = event.target.closest('button[data-filter]');
    if (!button) return;

    activeFilter = button.dataset.filter;
    document.querySelectorAll('.chip').forEach(chip => chip.classList.remove('active'));
    button.classList.add('active');
    renderTasks();
  });

  taskList.addEventListener('click', async event => {
    const button = event.target.closest('button[data-action]');
    if (!button || isSending) return;

    const tabId = Number(button.dataset.tabId);
    const task = tasks.find(item => item.tabId === tabId);
    if (!task) return;

    if (button.dataset.action === 'focus') {
      await focusTab(tabId);
      return;
    }

    if (button.dataset.action === 'send') {
      await sendPromptToTasks([task], task.name);
    }
  });

  document.getElementById('sendAll').addEventListener('click', async () => {
    await sendPromptToTasks(tasks, '可发送');
  });

  document.getElementById('refresh').addEventListener('click', async () => {
    await loadTabs();
    showToast('状态已刷新');
  });

  autoSendToggle.addEventListener('change', async () => {
    await saveAutoSendEnabled(autoSendToggle.checked);
    showToast(autoSendEnabled ? '已开启自动发送' : '已关闭自动发送');
  });

  promptPresetSelect.addEventListener('change', async () => {
    const value = promptPresetSelect.value;
    if (value === CUSTOM_PRESET_VALUE) return;

    const preset = promptPresets[Number(value)];
    if (!preset) return;

    isProgrammaticPromptChange = true;
    promptInput.value = preset;
    isProgrammaticPromptChange = false;

    updateCharCount();
    await savePrompt();
    renderPresetSelect();
  });

  promptInput.addEventListener('input', async () => {
    updateCharCount();
    schedulePromptSave();

    if (!isProgrammaticPromptChange) {
      renderPresetSelect();
    }
  });

  promptInput.addEventListener('blur', async () => {
    if (promptSaveTimer) {
      window.clearTimeout(promptSaveTimer);
      promptSaveTimer = null;
    }
    await savePrompt();
  });

  togglePresetManager.addEventListener('click', () => {
    const willOpen = presetManager.hidden;
    presetManager.hidden = !willOpen;
    togglePresetManager.textContent = willOpen ? '收起配置' : '配置列表';
    if (willOpen) renderPresetEditor();
  });

  document.getElementById('savePresets').addEventListener('click', async () => {
    const nextPresets = parsePresetEditorValue(presetEditor.value);
    await savePromptPresets(nextPresets);
    showToast(`已保存 ${promptPresets.length} 条预设`);
  });

  document.getElementById('addCurrentPreset').addEventListener('click', async () => {
    const text = promptInput.value.trim();
    if (!text) {
      showToast('当前输入内容为空，不能加入预设');
      return;
    }

    if (promptPresets.includes(text)) {
      showToast('当前内容已经在预设列表中');
      return;
    }

    await savePromptPresets([...promptPresets, text]);
    showToast('已加入当前内容到预设列表');
  });

  document.getElementById('resetPresets').addEventListener('click', async () => {
    await savePromptPresets(DEFAULT_PROMPTS);
    showToast('已恢复默认预设');
  });

  chrome.tabs.onActivated.addListener(() => {
    updateActiveTabMarker({ shouldRender: true });
  });

  chrome.windows.onFocusChanged.addListener(() => {
    updateActiveTabMarker({ shouldRender: true });
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId === activeTabId && changeInfo.status === 'complete') {
      updateActiveTabMarker({ shouldRender: true });
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== 'PANEL_STATUS_UPDATE') return;

    const task = tasks.find(item => item.tabId === message.tabId);
    if (!task) {
      loadTabs();
      return;
    }

    const previousStatus = task.status;
    const previousImageCount = task.imageCount || 0;
    const payload = message.payload || {};
    const meta = statusMeta[payload.status] || statusMeta.unknown;

    Object.assign(task, {
      status: payload.status || task.status,
      title: payload.title || task.title,
      url: payload.url || task.url,
      progress: meta.progress,
      imageCount: payload.imageCount || 0,
      hasInput: Boolean(payload.hasInput),
      hasRunningTaskMarker: Boolean(payload.hasRunningTaskMarker),
      isLimited: Boolean(payload.isLimited || payload.status === 'limited')
    });

    if (task.status !== 'done') {
      clearTaskAutoSent(task);
    }

    render();

    const becameDone = task.status === 'done' && (
      previousStatus !== 'done' ||
      task.imageCount > previousImageCount
    );

    if (becameDone) {
      tryAutoSendForTask(task);
    }
  });
}

async function init() {
  bindEvents();
  await loadSettings();
  await loadTabs();

  window.setInterval(async () => {
    if (!document.hidden && !isSending) {
      await loadTabs();
    }
  }, PERIODIC_REFRESH_MS);
}

init().catch(error => {
  console.error(error);
  showToast(`初始化失败：${error.message || error}`);
});
