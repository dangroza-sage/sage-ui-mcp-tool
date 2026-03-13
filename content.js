/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

console.debug('[WebMCP] Content script injected');

chrome.runtime.onMessage.addListener(({ action, name, inputArgs }, _, reply) => {
  try {
    if (action == 'GET_TAB_CAPABILITIES') {
      const hasMcp = Boolean(navigator.modelContextTesting);
      const tools = hasMcp ? navigator.modelContextTesting.listTools() : [];
      reply({
        title: document.title,
        url: location.href,
        hasMcp,
        toolsCount: tools.length,
      });
      return;
    }

    if (action == 'EXTRACT_PAGE_TEXT') {
      reply({
        title: document.title,
        url: location.href,
        ...extractPageText(),
      });
      return;
    }

    if (action == 'EXTRACT_MENU_ITEMS') {
      reply({
        title: document.title,
        url: location.href,
        items: extractMenuItems(),
      });
      return;
    }

    if (action == 'ACTIVATE_MENU_ITEM') {
      try {
        const result = activateMenuItem(inputArgs);
        reply({ ok: true, ...result });
      } catch (error) {
        reply({ ok: false, error: error.message || String(error) });
      }
      return;
    }

    if (!navigator.modelContextTesting) {
      throw new Error('Error: You must run Chrome with the "WebMCP for testing" flag enabled.');
    }
    if (action == 'LIST_TOOLS') {
      listTools();
      if ('ontoolchange' in navigator.modelContextTesting.__proto__) {
        navigator.modelContextTesting.addEventListener('toolchange', listTools);
        return;
      }
      navigator.modelContextTesting.registerToolsChangedCallback(listTools);
    }
    if (action == 'EXECUTE_TOOL') {
      console.debug(`[WebMCP] Execute tool "${name}" with`, inputArgs);
      let targetFrame, loadPromise;
      // Check if this tool is associated with a form target
      const formTarget = document.querySelector(`form[toolname="${name}"]`)?.target;
      if (formTarget) {
        targetFrame = document.querySelector(`[name=${formTarget}]`);
        loadPromise = new Promise((resolve) => {
          targetFrame.addEventListener('load', resolve, { once: true });
        });
      }
      // Execute the experimental tool
      const promise = navigator.modelContextTesting.executeTool(name, inputArgs);
      promise
        .then(async (result) => {
          // If result is null and we have a target frame, wait for the frame to reload.
          if (result === null && targetFrame) {
            console.debug(`[WebMCP] Waiting for form target ${targetFrame} to load`);
            await loadPromise;
            console.debug('[WebMCP] Get cross document script tool result');
            result =
              await targetFrame.contentWindow.navigator.modelContextTesting.getCrossDocumentScriptToolResult();
          }
          reply(result);
        })
        .catch(({ message }) => reply(JSON.stringify(message)));
      return true;
    }
    if (action == 'GET_CROSS_DOCUMENT_SCRIPT_TOOL_RESULT') {
      console.debug('[WebMCP] Get cross document script tool result');
      const promise = navigator.modelContextTesting.getCrossDocumentScriptToolResult();
      promise.then(reply).catch(({ message }) => reply(JSON.stringify(message)));
      return true;
    }
  } catch ({ message }) {
    chrome.runtime.sendMessage({ message });
  }
});

function listTools() {
  const tools = navigator.modelContextTesting.listTools();
  console.debug(`[WebMCP] Got ${tools.length} tools`, tools);
  chrome.runtime.sendMessage({ tools, url: location.href });
}

window.addEventListener('toolactivated', ({ toolName }) => {
  console.debug(`[WebMCP] Tool "${toolName}" started execution.`);
});

window.addEventListener('toolcancel', ({ toolName }) => {
  console.debug(`[WebMCP] Tool "${toolName}" execution is cancelled.`);
});

function extractPageText() {
  const selectedText = window.getSelection()?.toString().trim() || '';
  const bodyText = document.body?.innerText?.trim() || '';
  const text = (selectedText || bodyText).replace(/\s+\n/g, '\n').trim();
  const limit = 12000;
  return {
    text: text.slice(0, limit),
    source: selectedText ? 'selection' : 'page',
    truncated: text.length > limit,
  };
}

function extractMenuItems() {
  const selectors = [
    '.qx-siamenu-main .qx-menu-item a',
    '.qx-siamenu-main .qx-menu-item',
    '[role="menuitem"]',
    'nav a',
    '.menu a',
    '.nav a',
    'header a',
  ];

  const candidates = selectors.flatMap((selector) => {
    return Array.from(document.querySelectorAll(selector)).map((element) => ({
      element,
      selector,
    }));
  });

  const seen = new Set();
  const items = [];

  for (const { element, selector } of candidates) {
    const text = normalizeMenuText(element.innerText || element.textContent || '');
    if (!text) continue;

    const href = element.getAttribute('href') || element.closest('a')?.getAttribute('href') || '';
    const key = `${text}::${href}`;
    if (seen.has(key)) continue;
    seen.add(key);

    items.push({
      text,
      href,
      selector: buildElementSelector(element),
      sourceSelector: selector,
    });
  }

  return items.slice(0, 500);
}

function activateMenuItem(inputArgs) {
  const payload =
    typeof inputArgs === 'string' ? JSON.parse(inputArgs || '{}') : inputArgs || {};
  const { selector, href, text } = payload;
  const currentSessionToken = extractSessionToken(location.href);

  let target = selector ? document.querySelector(selector) : null;
  if (!target && text) {
    target = findMenuElementByText(text, href);
  }

  if (target) {
    const actionTarget = resolveMenuActionTarget(target, href);
    actionTarget.scrollIntoView({ block: 'center', inline: 'nearest' });

    if (href?.startsWith('javascript:')) {
      if (clickElement(actionTarget)) {
        return { ok: true, method: 'legacy-click' };
      }

      const extractedUrl = applySessionToken(extractUrlFromJavascriptHref(href), currentSessionToken);
      if (extractedUrl) {
        location.href = new URL(extractedUrl, location.href).href;
        return { ok: true, method: 'legacy-location' };
      }

      throw new Error('Legacy menu action could not be resolved safely.');
    }

    if (clickElement(actionTarget)) {
      return { ok: true, method: 'click' };
    }
  }

  if (href && !href.startsWith('javascript:')) {
    location.href = new URL(applySessionToken(href, currentSessionToken), location.href).href;
    return { ok: true, method: 'location' };
  }

  throw new Error('Could not locate the selected menu item on the page.');
}

function normalizeMenuText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function extractSessionToken(value) {
  const match = String(value || '').match(/(?:\?|&|%3[fF]|%26)\.?sess(?:=|%3[dD])([^&#%]+)/i);
  return match?.[1] || '';
}

function applySessionToken(value, sessionToken) {
  if (!sessionToken) return value;

  const source = String(value || '');
  const encodedUpdated = source.replace(/(\.?sess%3[dD])([^&#%]*)/i, `$1${sessionToken}`);
  if (encodedUpdated !== source) {
    return encodedUpdated;
  }

  const plainUpdated = source.replace(/(\.?sess=)([^&#]*)/i, `$1${sessionToken}`);
  if (plainUpdated !== source) {
    return plainUpdated;
  }

  return source;
}

function buildElementSelector(element) {
  if (!element) return '';
  if (element.id) return `#${CSS.escape(element.id)}`;

  const segments = [];
  let current = element;
  while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
    let segment = current.tagName.toLowerCase();
    if (current.classList.length > 0) {
      segment += `.${Array.from(current.classList).slice(0, 2).map((name) => CSS.escape(name)).join('.')}`;
    }

    const siblings = Array.from(current.parentElement?.children || []).filter(
      (child) => child.tagName === current.tagName,
    );
    if (siblings.length > 1) {
      segment += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    }

    segments.unshift(segment);

    const selector = segments.join(' > ');
    if (document.querySelectorAll(selector).length === 1) {
      return selector;
    }

    current = current.parentElement;
  }

  return segments.join(' > ');
}

function findMenuElementByText(text, href) {
  const normalizedTargetText = normalizeMenuText(text || '');
  const candidates = Array.from(
    document.querySelectorAll('.qx-siamenu-main .qx-menu-item, [role="menuitem"], nav a, .menu a, .nav a, header a'),
  );

  return candidates.find((element) => {
    const elementText = normalizeMenuText(element.innerText || element.textContent || '');
    const elementHref = element.getAttribute('href') || '';
    return elementText === normalizedTargetText && (!href || href === elementHref);
  });
}

function resolveMenuActionTarget(target, href) {
  const anchor = target.matches?.('a') ? target : target.closest?.('a');
  if (href?.startsWith('javascript:') && anchor) {
    return (
      anchor.closest('.qx-menu-item, [role="menuitem"], li, button') ||
      anchor.parentElement ||
      target
    );
  }

  return anchor || target;
}

function clickElement(element) {
  if (!element) return false;

  element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
  const notCancelled = element.dispatchEvent(clickEvent);

  if (notCancelled && typeof element.click === 'function' && !element.matches('a[href^="javascript:"]')) {
    element.click();
  }

  return true;
}

function extractUrlFromJavascriptHref(href) {
  const source = String(href || '').replace(/^javascript:/i, '').trim();
  const openInIFrameMatch = source.match(/^openInIFrame\((['"])(.*?)\1\s*,\s*(['"])(.*?)\3\)$/i);
  if (openInIFrameMatch) {
    return openInIFrameMatch[4] || '';
  }
  const quotedMatch = source.match(/["']([^"']+(?:\.aspx|\.html|\/[^"']*))?["']/i);
  return quotedMatch?.[1] || '';
}
