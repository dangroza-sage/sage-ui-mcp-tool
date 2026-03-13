const statusEl = document.getElementById('status');
const menuSearchInput = document.getElementById('menuSearchInput');
const refreshMenuBtn = document.getElementById('refreshMenuBtn');
const pageMeta = document.getElementById('pageMeta');
const menuCount = document.getElementById('menuCount');
const menuEmptyState = document.getElementById('menuEmptyState');
const menuList = document.getElementById('menuList');
const linkPreviewDialog = document.getElementById('linkPreviewDialog');
const closeLinkPreviewBtn = document.getElementById('closeLinkPreviewBtn');
const linkPreviewTitle = document.getElementById('linkPreviewTitle');
const linkPreviewText = document.getElementById('linkPreviewText');

let allItems = [];
let filteredItems = [];
let activeTabId;
let currentPageUrl = '';

init().catch((error) => {
  setStatus(String(error), 'error');
});

async function init() {
  menuSearchInput.addEventListener('input', renderItems);
  refreshMenuBtn.addEventListener('click', loadMenuItems);
  closeLinkPreviewBtn.addEventListener('click', () => linkPreviewDialog.close());
  await loadMenuItems();
}

async function loadMenuItems() {
  setStatus('Loading menu items…', 'info');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id;

  if (!activeTabId) {
    allItems = [];
    renderItems();
    setStatus('No active tab found.', 'error');
    return;
  }

  const response = await sendMessageToTab(activeTabId, { action: 'EXTRACT_MENU_ITEMS' });
  currentPageUrl = response?.url || tab?.url || '';
  allItems = (response?.items || []).map((item) => buildResolvedItem(item, currentPageUrl));
  pageMeta.textContent = [response?.title, currentPageUrl].filter(Boolean).join(' — ');
  renderItems();
  setStatus(
    allItems.length ? `Loaded ${allItems.length} menu item${allItems.length === 1 ? '' : 's'}.` : 'No menu items found on this tab.',
    allItems.length ? 'success' : 'info',
  );
}

function renderItems() {
  const query = menuSearchInput.value.trim().toLowerCase();
  filteredItems = !query
    ? allItems
    : allItems.filter((item) => {
        return [item.text, item.href, item.resolvedHref, item.sourceSelector]
          .filter(Boolean)
          .some((value) => value.toLowerCase().includes(query));
      });

  menuCount.textContent = `${filteredItems.length} item${filteredItems.length === 1 ? '' : 's'}`;
  menuEmptyState.classList.toggle('is-hidden', filteredItems.length > 0);
  menuList.innerHTML = '';

  for (const item of filteredItems) {
    const card = document.createElement('div');
    card.className = 'menu-result-item';

    const title = document.createElement('div');
    title.className = 'menu-result-title';
    title.textContent = item.text;
    card.appendChild(title);

    if (item.sourceSelector || item.resolvedHref || item.href) {
      const meta = document.createElement('div');
      meta.className = 'menu-result-meta';
      meta.textContent = item.sourceSelector || (item.displayHref ? 'Updated link available' : item.href);
      card.appendChild(meta);
    }

    const actions = document.createElement('div');
    actions.className = 'menu-result-actions';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.textContent = 'Open';
    openBtn.addEventListener('click', () => activateItem(item));
    actions.appendChild(openBtn);

    if (item.displayHref || item.resolvedHref || item.href) {
      const showLinkBtn = document.createElement('button');
      showLinkBtn.type = 'button';
      showLinkBtn.className = 'secondary';
      showLinkBtn.textContent = 'Show link';
      showLinkBtn.addEventListener('click', () => showLinkPreview(item));
      actions.appendChild(showLinkBtn);
    }

    card.appendChild(actions);
    menuList.appendChild(card);
  }
}

async function activateItem(item) {
  if (!activeTabId) {
    setStatus('No active tab found.', 'error');
    return;
  }

  setStatus(`Opening “${item.text}”…`, 'info');

  try {
    const actionItem = buildResolvedItem(item, currentPageUrl);

    if (String(actionItem.href || '').startsWith('javascript:')) {
      await activateLegacyItemInMainWorld(actionItem);
      setStatus(`Opened “${item.text}”.`, 'success');
      return;
    }

    const result = await sendMessageToTab(activeTabId, {
      action: 'ACTIVATE_MENU_ITEM',
      inputArgs: JSON.stringify(actionItem),
    });

    if (!result?.ok) {
      if (String(actionItem.href || '').startsWith('javascript:') || /openInIFrame|Legacy menu/i.test(result?.error || '')) {
        await activateLegacyItemInMainWorld(actionItem);
        setStatus(`Opened “${item.text}”.`, 'success');
        return;
      }
      throw new Error(result?.error || 'Unknown menu activation error');
    }

    setStatus(`Opened “${item.text}”.`, 'success');
  } catch (error) {
    setStatus(`Could not open “${item.text}”: ${error.message || error}`, 'error');
  }
}

function showLinkPreview(item) {
  const resolvedItem = buildResolvedItem(item, currentPageUrl);
  linkPreviewTitle.textContent = resolvedItem.text;
  linkPreviewText.textContent = resolvedItem.displayHref || resolvedItem.resolvedHref || resolvedItem.href || '(No link available)';
  linkPreviewDialog.showModal();
}

function buildResolvedItem(item, pageUrl) {
  const rawHref = item.rawHref || item.href || '';
  const sessionToken = extractSessionToken(pageUrl);
  const resolvedHref = resolveHrefWithSession(rawHref, sessionToken);
  return {
    ...item,
    rawHref,
    href: resolvedHref,
    resolvedHref,
    displayHref: toDisplayHref(resolvedHref, pageUrl),
  };
}

function extractSessionToken(value) {
  const match = String(value || '').match(/(?:\?|&|%3[fF]|%26)\.?sess(?:=|%3[dD])([^&#%]+)/i);
  return match?.[1] || '';
}

function resolveHrefWithSession(href, sessionToken) {
  const source = String(href || '');
  if (!source) return '';

  if (source.startsWith('javascript:openInIFrame(')) {
    const match = source.match(/^javascript:openInIFrame\((['"])(.*?)\1\s*,\s*(['"])(.*?)\3\)$/i);
    if (!match) return source;
    const updatedTarget = applySessionToken(match[4], sessionToken);
    return `javascript:openInIFrame('${match[2]}', '${updatedTarget}')`;
  }

  return applySessionToken(source, sessionToken);
}

function toDisplayHref(href, pageUrl) {
  const source = String(href || '');
  if (!source) return '';

  const legacyMatch = source.match(/^javascript:openInIFrame\((['"])(.*?)\1\s*,\s*(['"])(.*?)\3\)$/i);
  if (legacyMatch) {
    const targetUrl = decodeValueSafely(legacyMatch[4]);
    try {
      return new URL(targetUrl, pageUrl || window.location.href).href;
    } catch {
      return targetUrl;
    }
  }

  try {
    return new URL(decodeValueSafely(source), pageUrl || window.location.href).href;
  } catch {
    return decodeValueSafely(source);
  }
}

function decodeValueSafely(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    return String(value || '');
  }
}

function applySessionToken(value, sessionToken) {
  if (!sessionToken) return value;

  const source = String(value || '');
  const decoded = (() => {
    try {
      return decodeURIComponent(source);
    } catch {
      return source;
    }
  })();

  const updatedDecoded = decoded.replace(/([?&])\.?sess=([^&#]*)/i, `$1.sess=${sessionToken}`);
  if (updatedDecoded !== decoded) {
    return source.includes('%3') ? encodeURIComponent(updatedDecoded) : updatedDecoded;
  }

  return source;
}

async function sendMessageToTab(tabId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch (error) {
    if (!shouldInjectContentScript(error)) {
      throw error;
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });

    return await chrome.tabs.sendMessage(tabId, payload);
  }
}

function shouldInjectContentScript(error) {
  const message = error?.message || String(error);
  return (
    message.includes('Receiving end does not exist') ||
    message.includes('Could not establish connection')
  );
}

async function activateLegacyItemInMainWorld(item) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: activeTabId },
    world: 'MAIN',
    args: [item],
    func: (menuItem) => {
      const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const href = String(menuItem?.href || '');
      const extractSessionToken = (value) => {
        const match = String(value || '').match(/(?:\?|&|%3[fF]|%26)\.?sess(?:=|%3[dD])([^&#%]+)/i);
        return match?.[1] || '';
      };
      const applySessionToken = (value, sessionToken) => {
        if (!sessionToken) return value;

        const source = String(value || '');
        const encodedUpdated = source.replace(
          /(\.?sess%3[dD])([^&#%]*)/i,
          `$1${sessionToken}`,
        );
        if (encodedUpdated !== source) {
          return encodedUpdated;
        }

        const plainUpdated = source.replace(/(\.?sess=)([^&#]*)/i, `$1${sessionToken}`);
        if (plainUpdated !== source) {
          return plainUpdated;
        }

        return source;
      };
      const parseLegacyOpenInIFrame = (value) => {
        const match = value.match(/^javascript:openInIFrame\((['"])(.*?)\1\s*,\s*(['"])(.*?)\3\)$/i);
        if (!match) return null;
        return {
          frameName: match[2],
          targetUrl: match[4],
        };
      };

      const navigateLegacyTarget = (frameName, targetUrl) => {
        const currentSessionToken = extractSessionToken(window.location.href);
        const sessionAwareTargetUrl = applySessionToken(targetUrl, currentSessionToken);
        const decodedTargetUrl = (() => {
          try {
            return decodeURIComponent(sessionAwareTargetUrl);
          } catch {
            return sessionAwareTargetUrl;
          }
        })();

        if (typeof window.openInIFrame === 'function') {
          window.openInIFrame(frameName, decodedTargetUrl);
          return { ok: true, method: 'openInIFrame' };
        }

        const frame = document.querySelector(`iframe[name="${frameName}"], frame[name="${frameName}"], #${frameName}`);
        if (frame && 'src' in frame) {
          frame.src = decodedTargetUrl;
          return { ok: true, method: 'iframe-src' };
        }

        window.location.href = decodedTargetUrl;
        return { ok: true, method: 'location' };
      };

      const legacyAction = parseLegacyOpenInIFrame(href);
      if (legacyAction) {
        return navigateLegacyTarget(legacyAction.frameName, legacyAction.targetUrl);
      }

      const candidates = [];
      if (menuItem?.selector) {
        const direct = document.querySelector(menuItem.selector);
        if (direct) candidates.push(direct);
      }

      const byText = Array.from(
        document.querySelectorAll('.qx-siamenu-main .qx-menu-item, [role="menuitem"], nav a, .menu a, .nav a, header a'),
      ).find((element) => {
        const elementText = normalizeText(element.innerText || element.textContent || '');
        const elementHref = element.getAttribute('href') || element.closest('a')?.getAttribute('href') || '';
        return elementText === normalizeText(menuItem?.text) && (!href || href === elementHref);
      });
      if (byText) candidates.push(byText);

      const target = candidates.find(Boolean);
      if (!target) {
        throw new Error('Could not locate the selected legacy menu item on the page.');
      }

      const anchor = target.matches?.('a') ? target : target.closest?.('a');
      const clickTarget = anchor || target;
      clickTarget.scrollIntoView({ block: 'center', inline: 'nearest' });

      clickTarget.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      clickTarget.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      if (typeof clickTarget.click === 'function') {
        clickTarget.click();
      } else {
        clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }

      return { ok: true, method: 'click' };
    },
  });

  if (!result?.ok) {
    throw new Error(result?.error || 'Legacy menu activation failed');
  }
}

function setStatus(message, state = '') {
  statusEl.textContent = message;
  if (state) {
    statusEl.dataset.state = state;
  } else {
    delete statusEl.dataset.state;
  }
}
