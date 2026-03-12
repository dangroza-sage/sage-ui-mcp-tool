/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Allows users to open the side panel by clicking the action icon.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Inject content script in all tabs first.
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({});
  tabs.forEach(({ id: tabId }) => {
    chrome.scripting
      .executeScript({
        target: { tabId },
        files: ['content.js'],
      })
      .catch(() => {});
  });
});

// Update badge text with the number of tools per tab.
chrome.tabs.onActivated.addListener(({ tabId }) => updateBadge(tabId));
chrome.tabs.onUpdated.addListener((tabId) => updateBadge(tabId));

async function updateBadge(tabId) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id !== tabId) return;
  chrome.action.setBadgeText({ text: '', tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });

  try {
    await chrome.tabs.sendMessage(tabId, { action: 'LIST_TOOLS' });
  } catch (error) {
    const message = error?.message || String(error);
    if (
      message.includes('Receiving end does not exist') ||
      message.includes('Could not establish connection')
    ) {
      return;
    }
    console.warn('[WebMCP] Failed to update badge for tab', tabId, message);
  }
}

chrome.runtime.onMessage.addListener(({ tools }, { tab }) => {
  if (!tab?.id) return;
  const text = tools?.length ? `${tools.length}` : '';
  chrome.action.setBadgeText({ text, tabId: tab.id });
});
