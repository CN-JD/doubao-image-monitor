(() => {
  if (window.__DOUBAO_IMAGE_MONITOR_LOADED__) {
    return;
  }
  window.__DOUBAO_IMAGE_MONITOR_LOADED__ = true;

  const CONFIG = {
    inputSelector: '[autocomplete="off"]',
    inputFallbackSelectors: [
      'textarea',
      '[contenteditable="true"]',
      '[role="textbox"]'
    ],
    sendButtonSelectors: [
      '#flow-end-msg-send'
    ],
    runningTaskSelector: 'div[data-state="closed"]',
    loginModalSelector: '.login_modal',
    generatingKeywords: [
      '生成中',
      '正在生成',
      '创作中',
      '绘制中',
      '处理中',
      '请稍候',
      '排队中'
    ],
    failedKeywords: [
      '我暂时无法生成你要求的内容'
    ],
    doneKeywords: [
      '重新生成',
      '继续生成',
      '下载',
      '保存图片'
    ]
  };

  let lastStatus = 'unknown';
  let lastReportAt = 0;
  let lastImageCount = 0;
  let extensionAlive = true;
  let intervalId = null;
  let observer = null;
  let lockedByLoginModal = false;
  let pageTextCache = '';
  let pageTextCacheAt = 0;
  let imageCountCache = 0;
  let imageCountCacheAt = 0;
  let domDirty = true;
  let mutationReportTimer = null;

  const PAGE_TEXT_TTL_MS = 1500;
  const IMAGE_COUNT_TTL_MS = 1200;
  const REPORT_MIN_INTERVAL_MS = 2500;
  const MUTATION_REPORT_DEBOUNCE_MS = 300;

  function isContextInvalidatedError(error) {
    const message = String(error?.message || error || '');
    return message.includes('Extension context invalidated') ||
      message.includes('context invalidated') ||
      message.includes('Extension context was invalidated');
  }

  function cleanupAfterInvalidated() {
    extensionAlive = false;

    try {
      if (observer) observer.disconnect();
    } catch { }

    try {
      if (intervalId) window.clearInterval(intervalId);
    } catch { }

    try {
      if (mutationReportTimer) window.clearTimeout(mutationReportTimer);
    } catch { }

    try {
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('visibilitychange', handleVisibilityChange);
    } catch { }
  }

  async function safeRuntimeSendMessage(message) {
    if (!extensionAlive) return null;

    try {
      if (!globalThis.chrome?.runtime?.id) {
        cleanupAfterInvalidated();
        return null;
      }

      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      if (isContextInvalidatedError(error)) {
        cleanupAfterInvalidated();
        return null;
      }

      return null;
    }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function markDomDirty() {
    domDirty = true;
  }

  function scheduleMutationReport() {
    if (!extensionAlive) return;
    if (mutationReportTimer) {
      window.clearTimeout(mutationReportTimer);
    }

    mutationReportTimer = window.setTimeout(() => {
      mutationReportTimer = null;
      reportStatus(false);
    }, MUTATION_REPORT_DEBOUNCE_MS);
  }

  function nextFrame() {
    return new Promise(resolve => {
      if (document.hidden || document.visibilityState === 'hidden') {
        window.setTimeout(resolve, 0);
        return;
      }

      requestAnimationFrame(() => resolve());
    });
  }

  function textIncludesAny(text, keywords) {
    return keywords.some(keyword => text.includes(keyword));
  }

  function hasRunningTaskMarker() {
    return Boolean(document.querySelector(CONFIG.runningTaskSelector));
  }

  function hasLoginModal() {
    return Boolean(document.querySelector(CONFIG.loginModalSelector));
  }

  function isConversationLimited() {

    if (hasLoginModal()) {
      lockedByLoginModal = true;
    }

    return lockedByLoginModal;
  }

  async function waitForPostSendState(timeout = 2000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeout) {
      if (isConversationLimited()) {
        return { state: 'limited' };
      }

      if (hasRunningTaskMarker()) {
        return { state: 'generating' };
      }

      await sleep(100);
    }

    return { state: getStatus() };
  }

  function getPageText() {
    const now = Date.now();
    if (!domDirty && now - pageTextCacheAt < PAGE_TEXT_TTL_MS) {
      return pageTextCache;
    }

    pageTextCache = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    pageTextCacheAt = now;
    return pageTextCache;
  }

  function getLikelyImageCount() {
    const now = Date.now();
    if (!domDirty && now - imageCountCacheAt < IMAGE_COUNT_TTL_MS) {
      return imageCountCache;
    }

    const images = Array.from(document.images || []);

    imageCountCache = images.filter(img => {
      const src = img.currentSrc || img.src || '';
      const width = img.naturalWidth || img.width || 0;
      const height = img.naturalHeight || img.height || 0;

      if (!src) return false;
      if (src.startsWith('data:')) return false;
      if (width < 120 || height < 120) return false;

      return true;
    }).length;

    imageCountCacheAt = now;
    return imageCountCache;
  }

  function isEditableElement(element) {
    if (!element) return false;

    const tag = element.tagName?.toLowerCase();
    const type = String(element.getAttribute('type') || '').toLowerCase();

    if (tag === 'textarea') return true;
    if (tag === 'input' && !['hidden', 'button', 'submit', 'checkbox', 'radio', 'file'].includes(type)) return true;
    if (element.isContentEditable) return true;
    if (element.getAttribute('contenteditable') === 'true') return true;
    if (element.getAttribute('contenteditable') === 'plaintext-only') return true;
    if (element.getAttribute('role') === 'textbox') return true;
    if (element.matches?.('[data-slate-editor="true"], .ProseMirror')) return true;

    return false;
  }

  function findEditableDescendant(element) {
    if (!element) return null;

    const selectors = [
      'textarea',
      'input:not([type="hidden"]):not([type="button"]):not([type="submit"])',
      '[contenteditable="true"]',
      '[contenteditable="plaintext-only"]',
      '[role="textbox"]',
      '[data-slate-editor="true"]',
      '.ProseMirror'
    ];

    for (const selector of selectors) {
      const found = element.querySelector?.(selector);
      if (found && isElementVisible(found) && isEditableElement(found)) {
        return found;
      }
    }

    return null;
  }

  function getInputElement() {
    const selectors = [CONFIG.inputSelector, ...CONFIG.inputFallbackSelectors];
    const candidates = [];

    for (const selector of selectors) {
      try {
        const matched = Array.from(document.querySelectorAll(selector));
        for (const element of matched) {
          if (!element) continue;

          if (isElementVisible(element) && isEditableElement(element)) {
            candidates.push(element);
            continue;
          }

          const child = findEditableDescendant(element);
          if (child) candidates.push(child);
        }
      } catch { }
    }

    if (document.activeElement && isElementVisible(document.activeElement) && isEditableElement(document.activeElement)) {
      candidates.unshift(document.activeElement);
    }

    const unique = Array.from(new Set(candidates));

    // 优先选屏幕下方、尺寸较大的可编辑区域。聊天输入框通常在页面底部。
    unique.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const aScore = ar.bottom + Math.min(ar.width * ar.height, 50000) / 1000;
      const bScore = br.bottom + Math.min(br.width * br.height, 50000) / 1000;
      return bScore - aScore;
    });

    return unique[0] || null;
  }

  function isElementVisible(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function isClickable(element) {
    if (!element) return false;

    const ariaDisabled = element.getAttribute('aria-disabled');
    const disabled = Boolean(element.disabled) || ariaDisabled === 'true';

    return !disabled && isElementVisible(element);
  }

  function findSendButton() {
    for (const selector of CONFIG.sendButtonSelectors) {
      const button = document.querySelector(selector);
      if (isClickable(button)) {
        return button;
      }
    }

    return null;
  }

  async function waitForSendButton(timeout = 2500) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeout) {
      const button = findSendButton();
      if (button) return button;

      await nextFrame();
      await sleep(50);
    }

    return null;
  }

  function getElementDebugInfo(element) {
    if (!element) return { exists: false };

    const rect = element.getBoundingClientRect?.() || {};

    return {
      exists: true,
      tagName: element.tagName,
      id: element.id || '',
      className: String(element.className || ''),
      role: element.getAttribute?.('role') || '',
      autocomplete: element.getAttribute?.('autocomplete') || '',
      contenteditable: element.getAttribute?.('contenteditable') || '',
      isContentEditable: Boolean(element.isContentEditable),
      visible: isElementVisible(element),
      rect: {
        x: Math.round(rect.x || 0),
        y: Math.round(rect.y || 0),
        width: Math.round(rect.width || 0),
        height: Math.round(rect.height || 0)
      }
    };
  }

  function readInputValue(element) {
    if (!element) return '';

    const tag = element.tagName?.toLowerCase();
    if (tag === 'textarea' || tag === 'input') {
      return String(element.value || '');
    }

    return String(element.innerText || element.textContent || element.value || '');
  }

  function dispatchEditableEvents(element, value) {
    try {
      element.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: value
      }));
    } catch { }

    try {
      element.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: value
      }));
    } catch {
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }

    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Process' }));
  }

  // 用户验证可用的填充代码：固定使用 document.querySelector('[autocomplete="off"]') 命中的输入框。
  function setInputValue(element, value) {
    // 注意：很多 input / textarea 的 value setter 不在元素自身上，
    // 而是在 HTMLInputElement.prototype / HTMLTextAreaElement.prototype 上。
    // 所以 Object.getOwnPropertyDescriptor(element, 'value') 可能是 undefined。
    if (!element) {
      throw new Error('setInputValue: element 为空');
    }

    element.focus();

    const ownDescriptor = Object.getOwnPropertyDescriptor(element, 'value');
    const prototype = Object.getPrototypeOf(element);
    const prototypeDescriptor = prototype
      ? Object.getOwnPropertyDescriptor(prototype, 'value')
      : undefined;

    const inputDescriptor = window.HTMLInputElement
      ? Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
      : undefined;

    const textareaDescriptor = window.HTMLTextAreaElement
      ? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
      : undefined;

    const valueSetter = ownDescriptor?.set;
    const prototypeValueSetter = prototypeDescriptor?.set;

    let nativeValueSetter = prototypeValueSetter;

    if (element instanceof HTMLTextAreaElement && textareaDescriptor?.set) {
      nativeValueSetter = textareaDescriptor.set;
    } else if (element instanceof HTMLInputElement && inputDescriptor?.set) {
      nativeValueSetter = inputDescriptor.set;
    }

    if (valueSetter && nativeValueSetter && valueSetter !== nativeValueSetter) {
      nativeValueSetter.call(element, value);
    } else if (nativeValueSetter) {
      nativeValueSetter.call(element, value);
    } else if (valueSetter) {
      valueSetter.call(element, value);
    } else {
      // 极端情况兜底：例如非标准输入元素。
      element.value = value;
    }

    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function setContentEditableValue(element, value) {
    try {
      element.focus();
      element.click();
      await nextFrame();
    } catch { }

    let insertedByCommand = false;

    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
      insertedByCommand = document.execCommand('insertText', false, value);
    } catch { }

    await nextFrame();

    if (!readInputValue(element).includes(value)) {
      try {
        element.textContent = value;
      } catch { }
    }

    dispatchEditableEvents(element, value);

    return insertedByCommand;
  }

  async function fillPromptIntoInput(element, value) {
    const tag = element.tagName?.toLowerCase();

    try {
      element.scrollIntoView({ block: 'center', behavior: 'instant' });
    } catch {
      try { element.scrollIntoView({ block: 'center' }); } catch { }
    }

    try {
      element.focus();
      element.click();
    } catch { }

    await nextFrame();
    await sleep(60);

    if (tag === 'textarea' || tag === 'input') {
      setInputValue(element, value);
    } else {
      await setContentEditableValue(element, value);
    }

    await nextFrame();
    await sleep(160);

    let actualValue = readInputValue(element).trim();

    // 有些富文本编辑器焦点后会把真正的编辑节点切到 activeElement。
    if (!actualValue.includes(value) && document.activeElement && document.activeElement !== element && isEditableElement(document.activeElement)) {
      const active = document.activeElement;
      const activeTag = active.tagName?.toLowerCase();
      if (activeTag === 'textarea' || activeTag === 'input') {
        setInputValue(active, value);
      } else {
        await setContentEditableValue(active, value);
      }
      await sleep(160);
      actualValue = readInputValue(active).trim();
      if (actualValue.includes(value)) {
        return { ok: true, element: active, actualValue, usedActiveElement: true };
      }
    }

    actualValue = readInputValue(element).trim();

    return {
      ok: actualValue.includes(value),
      element,
      actualValue,
      debug: getElementDebugInfo(element)
    };
  }

  async function sendPrompt(prompt) {
    if (isConversationLimited()) {
      reportStatus(true);
      return {
        ok: false,
        status: 'limited',
        isLimited: true,
        error: '当前标签页已出现“登录以解锁更多功能”弹窗，说明对话已达上限，后续将自动跳过该标签页。'
      };
    }

    if (hasRunningTaskMarker()) {
      reportStatus(true);
      return {
        ok: false,
        status: 'generating',
        error: '当前标签页仍在生成中，检测到 div[data-state="closed"]，本次跳过。'
      };
    }

    const textarea = document.querySelector('[autocomplete="off"]') || getInputElement();

    if (!textarea) {
      return {
        ok: false,
        error: '没有找到输入框：[autocomplete="off"] / textarea / contenteditable'
      };
    }

    setInputValue(textarea, prompt);

    // 豆包的 #flow-end-msg-send 只有输入框有内容后才会出现，
    // 所以这里必须先填内容、触发 input/change，再等待按钮渲染出来。
    await nextFrame();
    await sleep(80);

    const sendButton = await waitForSendButton(3000);
    if (!sendButton) {
      return {
        ok: false,
        status: getStatus(),
        error: '已填入输入框，但 3 秒内没有出现提交按钮：#flow-end-msg-send。请确认输入框是否真的触发了 input/change。'
      };
    }

    sendButton.click();

    const postState = await waitForPostSendState(2200);

    if (postState.state === 'limited') {
      reportStatus(true);
      return {
        ok: false,
        status: 'limited',
        isLimited: true,
        error: '发送后弹出“登录以解锁更多功能”，该标签页已达对话上限，后续将自动跳过。'
      };
    }

    await sleep(200);
    reportStatus(true);

    return {
      ok: true,
      status: getStatus(),
      imageCount: getLikelyImageCount(),
      hasRunningTaskMarker: hasRunningTaskMarker()
    };
  }

  function getStatus() {
    const text = getPageText();
    const imageCount = getLikelyImageCount();
    const input = getInputElement();

    if (isConversationLimited()) {
      return 'limited';
    }

    if (textIncludesAny(text, CONFIG.failedKeywords)) {
      return 'failed';
    }

    // 按你的规则：存在 div[data-state="closed"] 表示生图任务未结束；不存在表示已结束。
    if (hasRunningTaskMarker()) {
      return 'generating';
    }

    if (imageCount > lastImageCount) {
      lastImageCount = imageCount;
      return 'done';
    }

    if (imageCount > 0 && textIncludesAny(text, CONFIG.doneKeywords)) {
      return 'done';
    }

    // 没有 div[data-state="closed"] 且能找到输入框，就认为当前任务已结束，可以继续发下一轮。
    if (input) {
      return 'done';
    }

    return 'unknown';
  }

  function getStatusPayload() {
    const status = getStatus();
    const imageCount = getLikelyImageCount();
    const input = getInputElement();
    const runningTask = hasRunningTaskMarker();
    const limited = isConversationLimited();

    return {
      status,
      title: document.title,
      url: location.href,
      imageCount,
      hasInput: Boolean(input),
      hasRunningTaskMarker: runningTask,
      isLimited: limited,
      inputDebug: getElementDebugInfo(input)
    };
  }

  function reportStatus(force = false) {
    if (!extensionAlive) return;

    const now = Date.now();

    if (!force && !domDirty && now - lastReportAt < REPORT_MIN_INTERVAL_MS) {
      return;
    }

    const payload = getStatusPayload();

    if (!force && payload.status === lastStatus && now - lastReportAt < REPORT_MIN_INTERVAL_MS) {
      domDirty = false;
      return;
    }

    lastStatus = payload.status;
    lastReportAt = now;
    domDirty = false;

    safeRuntimeSendMessage({
      type: 'DOUBAO_STATUS_UPDATE',
      payload
    });
  }

  try {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || typeof message !== 'object') return false;

      if (message.type === 'DOUBAO_GET_STATUS') {
        sendResponse({ ok: true, payload: getStatusPayload() });
        return true;
      }

      if (message.type === 'DOUBAO_SEND_PROMPT') {
        sendPrompt(message.prompt || '继续生成图片')
          .then(result => sendResponse(result))
          .catch(error => sendResponse({ ok: false, error: error.message || String(error) }));
        return true;
      }

      return false;
    });
  } catch (error) {
    if (isContextInvalidatedError(error)) {
      cleanupAfterInvalidated();
    }
  }

  function handleFocus() {
    markDomDirty();
    reportStatus(true);
  }

  function handleVisibilityChange() {
    markDomDirty();
    reportStatus(true);
  }

  observer = new MutationObserver(() => {
    markDomDirty();
    scheduleMutationReport();
  });

  if (document.body && extensionAlive) {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['disabled', 'aria-disabled', 'class', 'data-state']
    });
  }

  if (extensionAlive) {
    window.addEventListener('focus', handleFocus);
    window.addEventListener('visibilitychange', handleVisibilityChange);

    intervalId = window.setInterval(() => reportStatus(false), 5000);
    reportStatus(true);
  }
})();
