/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI } from './js-genai.js';

const statusDiv = document.getElementById('status');
const tbody = document.getElementById('tableBody');
const thead = document.getElementById('tableHeaderRow');
const autoRefreshToggleBtn = document.getElementById('autoRefreshToggleBtn');
const sourceTabSelect = document.getElementById('sourceTabSelect');
const toolFilterInput = document.getElementById('toolFilterInput');
const refreshToolsBtn = document.getElementById('refreshToolsBtn');
const importSourceTextBtn = document.getElementById('importSourceTextBtn');
const fillDataBtn = document.getElementById('fillDataBtn');
const copyToClipboard = document.getElementById('copyToClipboard');
const copyAsScriptToolConfig = document.getElementById('copyAsScriptToolConfig');
const copyAsJSON = document.getElementById('copyAsJSON');
const toolNames = document.getElementById('toolNames');
const selectedToolDetails = document.getElementById('selectedToolDetails');
const selectedToolDescription = document.getElementById('selectedToolDescription');
const selectedToolSchema = document.getElementById('selectedToolSchema');
const inputArgsText = document.getElementById('inputArgsText');
const formatArgsBtn = document.getElementById('formatArgsBtn');
const executeBtn = document.getElementById('executeBtn');
const toolResults = document.getElementById('toolResults');
const userPromptText = document.getElementById('userPromptText');
const fillDataPromptTemplate = document.getElementById('fillDataPromptTemplate');
const promptBtn = document.getElementById('promptBtn');
const traceBtn = document.getElementById('traceBtn');
const resetBtn = document.getElementById('resetBtn');
const apiKeyBtn = document.getElementById('apiKeyBtn');
const promptResults = document.getElementById('promptResults');

const AUTO_REFRESH_STORAGE_KEY = 'autoRefreshTabsEnabled';
const FILL_DATA_PROMPT_TEMPLATE_STORAGE_KEY = 'fillDataPromptTemplate';
const DEFAULT_FILL_DATA_PROMPT_TEMPLATE = 'Fill the form based on follwing information:';

let currentTools = [];
let filteredTools = [];
let currentPageUrl = '';
let selectedToolName = '';
let windowTabs = [];
let currentTargetTabId;
let selectedSourceTabId;
let tabSupportById = new Map();
let autoRefreshEnabled = localStorage.getItem(AUTO_REFRESH_STORAGE_KEY) === 'true';
let autoRefreshTimeoutId;

let userPromptPendingId = 0;
let lastSuggestedUserPrompt = '';

init().catch((error) => {
  setStatus(String(error), 'error');
  copyToClipboard.hidden = true;
});

// Listen for the results coming back from content.js
chrome.runtime.onMessage.addListener(({ message, tools, url }, sender) => {
  if (sender.tab && sender.tab.id !== currentTargetTabId) return;

  setStatus(message || '', message ? 'error' : '');

  if (!tools) return;

  const nextTools = tools || [];
  const haveNewTools = JSON.stringify(currentTools) !== JSON.stringify(nextTools);

  currentTools = nextTools;
  currentPageUrl = url || getTabById(currentTargetTabId)?.url || currentPageUrl;
  renderTools({ haveNewTools });

  if (haveNewTools) suggestUserPrompt();
});

tbody.ondblclick = () => {
  tbody.classList.toggle('prettify');
};

copyAsScriptToolConfig.onclick = async () => {
  const text = currentTools
    .map((tool) => {
      return `\
script_tools {
  name: "${tool.name}"
  description: "${tool.description}"
  input_schema: ${JSON.stringify(parseInputSchema(tool.inputSchema))}
}`;
    })
    .join('\r\n');
  await navigator.clipboard.writeText(text);
};

copyAsJSON.onclick = async () => {
  const tools = currentTools.map((tool) => {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: parseInputSchema(tool.inputSchema),
    };
  });
  await navigator.clipboard.writeText(JSON.stringify(tools, '', '  '));
};

// Interact with the page

let genAI, chat;

const envModulePromise = import('./.env.json', { with: { type: 'json' } });

async function initGenAI() {
  let env;
  try {
    // Try load .env.json if present.
    env = (await envModulePromise).default;
  } catch {}
  if (env?.apiKey) localStorage.apiKey ??= env.apiKey;
  localStorage.model ??= env?.model || 'gemini-2.5-flash';
  genAI = localStorage.apiKey ? new GoogleGenAI({ apiKey: localStorage.apiKey }) : undefined;
  promptBtn.disabled = !localStorage.apiKey;
  resetBtn.disabled = !localStorage.apiKey;
  updateFillDataButtonState();
}

async function suggestUserPrompt() {
  if (currentTools.length == 0 || !genAI || userPromptText.value !== lastSuggestedUserPrompt)
    return;
  const userPromptId = ++userPromptPendingId;
  const response = await genAI.models.generateContent({
    model: localStorage.model,
    contents: [
      '**Context:**',
      `Today's date is: ${getFormattedDate()}`,
      '**Tool Rules:**',
      '1. **Bank Transaction Filter:** Use **PAST** dates only (e.g., "last month," "December 15th," "yesterday").',
      '2. **Flight Search:** Use **FUTURE** dates only (e.g., "next week," "February 15th").',
      '3. **Accommodation Search:** Use **FUTURE** dates only (e.g., "next weekend," "March 15th").',
      '**Task:**',
      'Generate one natural user query for a range of tools below, ideally chaining them together.',
      'Ensure the date makes sense relative to today.',
      'Output the query text only.',
      '**Tools:**',
      JSON.stringify(currentTools),
    ],
  });
  if (userPromptId !== userPromptPendingId || userPromptText.value !== lastSuggestedUserPrompt)
    return;
  lastSuggestedUserPrompt = response.text;
  userPromptText.value = '';
  for (const chunk of response.text) {
    await new Promise((r) => requestAnimationFrame(r));
    userPromptText.value += chunk;
  }
}

userPromptText.onkeydown = (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    promptBtn.click();
  }
};

promptBtn.onclick = async () => {
  try {
    await promptAI();
  } catch (error) {
    trace.push({ error });
    logPrompt(`⚠️ Error: "${error}"`);
  }
};

let trace = [];

async function promptAI() {
  const targetTabId = await syncCurrentTargetTab();
  if (!targetTabId) {
    throw new Error('No active target tab found.');
  }

  chat ??= genAI.chats.create({ model: localStorage.model });

  const message = userPromptText.value;
  userPromptText.value = '';
  lastSuggestedUserPrompt = '';
  promptResults.textContent += `User prompt: "${message}"\n`;
  const sendMessageParams = { message, config: getConfig() };
  trace.push({ userPrompt: sendMessageParams });
  let currentResult = await chat.sendMessage(sendMessageParams);
  let finalResponseGiven = false;

  while (!finalResponseGiven) {
    const response = currentResult;
    trace.push({ response });
    const functionCalls = response.functionCalls || [];

    if (functionCalls.length === 0) {
      if (!response.text) {
        logPrompt(`⚠️ AI response has no text: ${JSON.stringify(response.candidates)}\n`);
      } else {
        logPrompt(`AI result: ${response.text?.trim()}\n`);
      }
      finalResponseGiven = true;
    } else {
      const toolResponses = [];
      for (const { name, args } of functionCalls) {
        const inputArgs = JSON.stringify(args);
        logPrompt(`AI calling tool "${name}" with ${inputArgs}`);
        try {
          const result = await executeTool(targetTabId, name, inputArgs);
          toolResponses.push({ functionResponse: { name, response: { result } } });
          logPrompt(`Tool "${name}" result: ${result}`);
        } catch (e) {
          logPrompt(`⚠️ Error executing tool "${name}": ${e.message}`);
          toolResponses.push({
            functionResponse: { name, response: { error: e.message } },
          });
        }
      }

      // FIXME: New WebMCP tools may not be discovered if there's a navigation.
      // An articial timeout is introduced for mitigation but it's not robust enough.
      await new Promise((r) => setTimeout(r, 500));

      const sendMessageParams = { message: toolResponses, config: getConfig() };
      trace.push({ userPrompt: sendMessageParams });
      currentResult = await chat.sendMessage(sendMessageParams);
    }
  }
}

resetBtn.onclick = () => {
  chat = undefined;
  trace = [];
  userPromptText.value = '';
  lastSuggestedUserPrompt = '';
  promptResults.textContent = '';
  suggestUserPrompt();
};

apiKeyBtn.onclick = async () => {
  const apiKey = prompt('Enter Gemini API key');
  if (apiKey == null) return;
  localStorage.apiKey = apiKey;
  await initGenAI();
  suggestUserPrompt();
};

traceBtn.onclick = async () => {
  const text = JSON.stringify(trace, '', ' ');
  await navigator.clipboard.writeText(text);
};

executeBtn.onclick = async () => {
  toolResults.textContent = '';
  const name = toolNames.selectedOptions[0]?.value;
  const targetTabId = await syncCurrentTargetTab();
  if (!name || !targetTabId) return;

  let parsedArgs;
  try {
    parsedArgs = parseInputArgs();
  } catch {
    return;
  }

  const inputArgs = JSON.stringify(parsedArgs);
  inputArgsText.value = JSON.stringify(parsedArgs, '', ' ');
  setStatus(`Executing "${name}"…`, 'info');

  const result = await executeTool(targetTabId, name, inputArgs).catch(
    (error) => `⚠️ Error: "${error}"`,
  );
  toolResults.textContent = result;
  setStatus(
    String(result).startsWith('⚠️ Error:') ? `Execution failed for "${name}".` : `Executed "${name}".`,
    String(result).startsWith('⚠️ Error:') ? 'error' : 'success',
  );
};

sourceTabSelect.onchange = () => {
  selectedSourceTabId = Number(sourceTabSelect.value);
};

autoRefreshToggleBtn.onclick = () => {
  setAutoRefreshEnabled(!autoRefreshEnabled);
};

fillDataPromptTemplate.oninput = () => {
  localStorage.setItem(FILL_DATA_PROMPT_TEMPLATE_STORAGE_KEY, fillDataPromptTemplate.value);
};

toolNames.onchange = updateDefaultValueForInputArgs;
toolFilterInput.oninput = () => renderTools();

refreshToolsBtn.onclick = async () => {
  setStatus('Refreshing tabs and tools…', 'info');
  await refreshTabs();
  await refreshTargetTools();
};

importSourceTextBtn.onclick = async () => {
  if (!selectedSourceTabId) return;

  setStatus('Importing text from source tab…', 'info');

  try {
    const { contextData, title } = await getContextDataFromSourceTab();
    userPromptText.value = [userPromptText.value.trim(), contextData].filter(Boolean).join('\n\n');
    setStatus(`Imported text from "${title}".`, 'success');
  } catch (error) {
    setStatus(`Could not read the selected source tab: ${error.message || error}`, 'error');
  }
};

fillDataBtn.onclick = async () => {
  if (!selectedSourceTabId) {
    setStatus('Select a source tab before using Fill data.', 'error');
    return;
  }

  try {
    const { contextData, title } = await getContextDataFromSourceTab();
    const promptPrefix = getFillDataPromptTemplate();
    userPromptText.value = `${promptPrefix}\n\n${contextData}`;
    setStatus(`Submitting Fill data prompt using "${title}".`, 'info');
    await promptAI();
  } catch (error) {
    trace.push({ error });
    setStatus(`Could not fill data from the selected source tab: ${error.message || error}`, 'error');
    logPrompt(`⚠️ Error: "${error}"`);
  }
};

formatArgsBtn.onclick = () => {
  try {
    const parsedArgs = parseInputArgs();
    inputArgsText.value = JSON.stringify(parsedArgs, '', ' ');
    setStatus('Input JSON formatted.', 'success');
  } catch {}
};

function updateDefaultValueForInputArgs() {
  selectedToolName = toolNames.value;
  const inputSchema = toolNames.selectedOptions[0]?.dataset.inputSchema || '{}';
  const template = generateTemplateFromSchema(parseInputSchema(inputSchema));
  inputArgsText.value = JSON.stringify(template, '', ' ');
  renderSelectedToolDetails();
}

async function executeTool(tabId, name, inputArgs) {
  try {
    const result = await sendMessageToTab(tabId, {
      action: 'EXECUTE_TOOL',
      name,
      inputArgs,
    });
    if (result !== null) return result;
  } catch (error) {
    if (!error.message.includes('message channel is closed')) throw error;
  }
  await waitForPageLoad(tabId);
  return await sendMessageToTab(tabId, {
    action: 'GET_CROSS_DOCUMENT_SCRIPT_TOOL_RESULT',
  });
}

async function init() {
  renderAutoRefreshToggle();
  initFillDataPromptTemplate();
  syncAutoRefreshListeners();
  await initGenAI();
  await refreshTabs();
  await refreshTargetTools();
}

async function refreshTabs() {
  currentTargetTabId = await syncCurrentTargetTab();
  const tabs = await chrome.tabs.query({ currentWindow: true });
  windowTabs = tabs
    .filter((tab) => typeof tab.id === 'number')
    .sort(
      (left, right) =>
        Number(Boolean(right.active)) - Number(Boolean(left.active)) || left.index - right.index,
    );

  if (windowTabs.length === 0) {
    currentTargetTabId = undefined;
    selectedSourceTabId = undefined;
    tabSupportById = new Map();
    currentTools = [];
    renderTabSelectors();
    renderTools();
    setStatus('No tabs available in the current window.', 'error');
    return;
  }

  if (!windowTabs.some((tab) => tab.id === selectedSourceTabId)) {
    selectedSourceTabId = getPreferredSourceTabId();
  }

  const supportEntries = await Promise.all(
    windowTabs.map(async (tab) => [tab.id, await getTabSupport(tab.id, { refresh: true })]),
  );
  tabSupportById = new Map(supportEntries);
  renderTabSelectors();
}

async function refreshTargetTools() {
  const targetTabId = await syncCurrentTargetTab();
  if (!targetTabId) {
    currentTools = [];
    renderTools();
    return;
  }

  const tab = getTabById(targetTabId);
  currentPageUrl = tab?.url || currentPageUrl;
  const support = await getTabSupport(targetTabId, { refresh: true });
  if (support.url) {
    currentPageUrl = support.url;
  }

  if (!support.reachable) {
    currentTools = [];
    renderTools();
    setStatus('Current active tab cannot be accessed by the extension.', 'error');
    return;
  }

  if (!support.hasMcp) {
    currentTools = [];
    renderTools();
    setStatus('Current active tab is reachable but does not expose WebMCP support.', 'info');
    return;
  }

  currentTools = [];
  renderTools();
  setStatus(`Loading tools from "${tab?.title || 'current tab'}"…`, 'info');
  await sendMessageToTab(targetTabId, { action: 'LIST_TOOLS' });
}

function setAutoRefreshEnabled(enabled) {
  autoRefreshEnabled = enabled;
  localStorage.setItem(AUTO_REFRESH_STORAGE_KEY, String(enabled));
  renderAutoRefreshToggle();
  syncAutoRefreshListeners();
}

function renderAutoRefreshToggle() {
  autoRefreshToggleBtn.setAttribute('aria-pressed', String(autoRefreshEnabled));
  const label = `Auto-refresh tabs: ${autoRefreshEnabled ? 'On' : 'Off'}`;
  autoRefreshToggleBtn.setAttribute('aria-label', label);
  autoRefreshToggleBtn.setAttribute('title', label);
}

function initFillDataPromptTemplate() {
  fillDataPromptTemplate.value =
    localStorage.getItem(FILL_DATA_PROMPT_TEMPLATE_STORAGE_KEY) || DEFAULT_FILL_DATA_PROMPT_TEMPLATE;
}

function getFillDataPromptTemplate() {
  const value = fillDataPromptTemplate.value.trim();
  return value || DEFAULT_FILL_DATA_PROMPT_TEMPLATE;
}

function syncAutoRefreshListeners() {
  chrome.tabs.onActivated.removeListener(handleAutoRefreshEvent);
  chrome.tabs.onUpdated.removeListener(handleAutoRefreshEvent);
  chrome.tabs.onCreated.removeListener(handleAutoRefreshEvent);
  chrome.tabs.onRemoved.removeListener(handleAutoRefreshEvent);

  if (!autoRefreshEnabled) {
    return;
  }

  chrome.tabs.onActivated.addListener(handleAutoRefreshEvent);
  chrome.tabs.onUpdated.addListener(handleAutoRefreshEvent);
  chrome.tabs.onCreated.addListener(handleAutoRefreshEvent);
  chrome.tabs.onRemoved.addListener(handleAutoRefreshEvent);
}

function handleAutoRefreshEvent() {
  scheduleAutoRefresh();
}

function scheduleAutoRefresh() {
  clearTimeout(autoRefreshTimeoutId);
  autoRefreshTimeoutId = setTimeout(async () => {
    try {
      await refreshTabs();
      await refreshTargetTools();
    } catch (error) {
      setStatus(String(error), 'error');
    }
  }, 250);
}

async function getTabSupport(tabId, { refresh = false } = {}) {
  if (!refresh && tabSupportById.has(tabId)) {
    return tabSupportById.get(tabId);
  }

  let support;
  try {
    const result = await sendMessageToTab(tabId, { action: 'GET_TAB_CAPABILITIES' });
    support = {
      reachable: true,
      hasMcp: Boolean(result?.hasMcp),
      toolsCount: result?.toolsCount || 0,
      title: result?.title,
      url: result?.url,
    };
  } catch (error) {
    support = {
      reachable: false,
      hasMcp: false,
      toolsCount: 0,
      error: error.message || String(error),
    };
  }

  tabSupportById.set(tabId, support);
  return support;
}

async function sendMessageToTab(tabId, payload, { allowInjection = true } = {}) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch (error) {
    if (!allowInjection || !shouldInjectContentScript(error)) {
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

function renderTabSelectors() {
  renderTabSelect(sourceTabSelect, selectedSourceTabId, 'No source tab available');
  importSourceTextBtn.disabled = !selectedSourceTabId;
  updateFillDataButtonState();
}

function updateFillDataButtonState() {
  fillDataBtn.disabled = !selectedSourceTabId || !localStorage.apiKey;
}

function renderTabSelect(select, selectedId, emptyLabel) {
  select.innerHTML = '';

  if (windowTabs.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = emptyLabel;
    select.appendChild(option);
    select.disabled = true;
    return;
  }

  select.disabled = false;
  windowTabs.forEach((tab) => {
    const option = document.createElement('option');
    option.value = String(tab.id);
    option.textContent = formatTabOptionLabel(tab);
    select.appendChild(option);
  });

  if (selectedId != null && windowTabs.some((tab) => tab.id === selectedId)) {
    select.value = String(selectedId);
  }
}

function formatTabOptionLabel(tab) {
  const support = tabSupportById.get(tab.id) || { reachable: false, hasMcp: false };
  const icon = support.reachable ? (support.hasMcp ? '🟢' : '⚪️') : '🔒';
  const title = truncateText(tab.title || 'Untitled tab', 42);
  const hostname = getHostname(tab.url);
  return hostname ? `${icon} ${title} — ${hostname}` : `${icon} ${title}`;
}

async function syncCurrentTargetTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTargetTabId = tab?.id;
  if (tab?.url) {
    currentPageUrl = tab.url;
  }
  return currentTargetTabId;
}

function parseInputSchema(inputSchema) {
  if (!inputSchema) {
    return { type: 'object', properties: {} };
  }

  if (typeof inputSchema === 'object') {
    return inputSchema;
  }

  try {
    return JSON.parse(inputSchema);
  } catch {
    return { type: 'object', properties: {} };
  }
}

function getPreferredSourceTabId() {
  return windowTabs.find((tab) => tab.id !== currentTargetTabId)?.id || windowTabs[0]?.id;
}

function getTabById(tabId) {
  return windowTabs.find((tab) => tab.id === tabId);
}

function truncateText(text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function getHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

async function getContextDataFromSourceTab() {
  if (!selectedSourceTabId) {
    throw new Error('No source tab selected.');
  }

  const result = await sendMessageToTab(selectedSourceTabId, { action: 'EXTRACT_PAGE_TEXT' });
  const title = result.title || getTabById(selectedSourceTabId)?.title || 'Source tab';
  const contextData = [
    `Source tab: ${title}`,
    result.url ? `URL: ${result.url}` : undefined,
    `Text source: ${result.source === 'selection' ? 'current selection' : 'page content'}`,
    '',
    result.text || '(No readable text found)',
    result.truncated ? '[Text truncated by extension]' : undefined,
  ]
    .filter(Boolean)
    .join('\n');

  return { contextData, title };
}

function renderTools({ haveNewTools = false } = {}) {
  tbody.innerHTML = '';
  thead.innerHTML = '';
  toolNames.innerHTML = '';

  const previousSelection = selectedToolName || toolNames.value;
  filteredTools = filterTools(currentTools, toolFilterInput.value);

  copyToClipboard.hidden = currentTools.length === 0;

  if (currentTools.length === 0) {
    renderEmptyState(`No tools registered yet in ${currentPageUrl || 'this tab'}`);
    inputArgsText.value = '';
    inputArgsText.disabled = true;
    toolNames.disabled = true;
    executeBtn.disabled = true;
    formatArgsBtn.disabled = true;
    renderSelectedToolDetails();
    return;
  }

  if (filteredTools.length === 0) {
    renderEmptyState('No tools match the current filter.');
    inputArgsText.disabled = true;
    toolNames.disabled = true;
    executeBtn.disabled = true;
    formatArgsBtn.disabled = true;
    renderSelectedToolDetails();
    return;
  }

  inputArgsText.disabled = false;
  toolNames.disabled = false;
  executeBtn.disabled = false;
  formatArgsBtn.disabled = false;

  const keys = Object.keys(filteredTools[0]);
  keys.forEach((key) => {
    const th = document.createElement('th');
    th.textContent = key;
    thead.appendChild(th);
  });

  filteredTools.forEach((item) => {
    const row = document.createElement('tr');
    keys.forEach((key) => {
      const td = document.createElement('td');
      try {
        td.innerHTML = `<pre>${JSON.stringify(JSON.parse(item[key]), '', '  ')}</pre>`;
      } catch (error) {
        td.textContent = item[key];
      }
      row.appendChild(td);
    });
    tbody.appendChild(row);

    const option = document.createElement('option');
    option.textContent = `"${item.name}"`;
    option.value = item.name;
    option.dataset.inputSchema = item.inputSchema;
    toolNames.appendChild(option);
  });

  selectedToolName = filteredTools.some((tool) => tool.name === previousSelection)
    ? previousSelection
    : filteredTools[0].name;
  toolNames.value = selectedToolName;
  renderSelectedToolDetails();

  if (haveNewTools || selectedToolName !== previousSelection || !inputArgsText.value.trim()) {
    updateDefaultValueForInputArgs();
  }
}

function filterTools(tools, query) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return tools;
  return tools.filter((tool) => {
    return [tool.name, tool.description, tool.inputSchema]
      .filter(Boolean)
      .some((value) => value.toLowerCase().includes(normalizedQuery));
  });
}

function renderEmptyState(text) {
  const row = document.createElement('tr');
  row.innerHTML = `<td colspan="100%"><i>${text}</i></td>`;
  tbody.appendChild(row);
}

function renderSelectedToolDetails() {
  const selectedTool = currentTools.find((tool) => tool.name === selectedToolName);
  if (!selectedTool) {
    selectedToolDetails.classList.add('is-hidden');
    selectedToolDescription.textContent = '';
    selectedToolSchema.textContent = '';
    return;
  }

  selectedToolDetails.classList.remove('is-hidden');
  selectedToolDescription.textContent = selectedTool.description || 'No description provided.';

  let parsedSchema;
  try {
    parsedSchema = selectedTool.inputSchema
      ? JSON.parse(selectedTool.inputSchema)
      : { type: 'object', properties: {} };
  } catch {
    parsedSchema = selectedTool.inputSchema;
  }

  selectedToolSchema.textContent = JSON.stringify(parsedSchema, '', '  ');
}

function parseInputArgs() {
  const rawInput = inputArgsText.value.trim();
  if (!rawInput) {
    const error = new Error('Input arguments are required and must be valid JSON.');
    setStatus(error.message, 'error');
    throw error;
  }

  try {
    return JSON.parse(rawInput);
  } catch (error) {
    setStatus(`Invalid JSON input: ${error.message}`, 'error');
    inputArgsText.focus();
    throw error;
  }
}

function setStatus(message = '', state = '') {
  statusDiv.textContent = message;
  statusDiv.hidden = !message;
  if (state) {
    statusDiv.dataset.state = state;
  } else {
    delete statusDiv.dataset.state;
  }
}

function logPrompt(text) {
  promptResults.textContent += `${text}\n`;
  promptResults.scrollTop = promptResults.scrollHeight;
}

function getFormattedDate() {
  const today = new Date();
  return today.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function getConfig() {
  const targetTab = getTabById(currentTargetTabId);
  const systemInstruction = [
    'You are an assistant embedded in a browser tab.',
    'User prompts typically refer to the current active tab unless stated otherwise.',
    'Use your tools to query page content when you need it.',
    `Today's date is: ${getFormattedDate()}`,
    `Target tab title: ${targetTab?.title || 'Unknown'}`,
    `Target tab URL: ${targetTab?.url || currentPageUrl || 'Unknown'}`,
    'CRITICAL RULE: Whenever the user provides a relative date (e.g., "next Monday", "tomorrow", "in 3 days"),  you must calculate the exact calendar date based on today\'s date.',
  ];

  const functionDeclarations = currentTools.map((tool) => {
    return {
      name: tool.name,
      description: tool.description,
      parametersJsonSchema: parseInputSchema(tool.inputSchema),
    };
  });
  return { systemInstruction, tools: [{ functionDeclarations }] };
}

function generateTemplateFromSchema(schema) {
  if (!schema || typeof schema !== 'object') {
    return null;
  }

  if (schema.hasOwnProperty('const')) {
    return schema.const;
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return generateTemplateFromSchema(schema.oneOf[0]);
  }

  if (schema.hasOwnProperty('default')) {
    return schema.default;
  }

  if (Array.isArray(schema.examples) && schema.examples.length > 0) {
    return schema.examples[0];
  }

  switch (schema.type) {
    case 'object':
      const obj = {};
      if (schema.properties) {
        Object.keys(schema.properties).forEach((key) => {
          obj[key] = generateTemplateFromSchema(schema.properties[key]);
        });
      }
      return obj;

    case 'array':
      if (schema.items) {
        return [generateTemplateFromSchema(schema.items)];
      }
      return [];

    case 'string':
      if (schema.enum && schema.enum.length > 0) {
        return schema.enum[0];
      }
      if (schema.format === 'date') {
        return new Date().toISOString().substring(0, 10);
      }
      // yyyy-MM-ddThh:mm:ss.SSS
      if (
        schema.format ===
        '^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\\.[0-9]{1,3})?)?$'
      ) {
        return new Date().toISOString().substring(0, 23);
      }
      // yyyy-MM-ddThh:mm:ss
      if (
        schema.format ===
        '^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$'
      ) {
        return new Date().toISOString().substring(0, 19);
      }
      // yyyy-MM-ddThh:mm
      if (schema.format === '^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]$') {
        return new Date().toISOString().substring(0, 16);
      }
      // yyyy-MM
      if (schema.format === '^[0-9]{4}-(0[1-9]|1[0-2])$') {
        return new Date().toISOString().substring(0, 7);
      }
      // yyyy-Www
      if (schema.format === '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$') {
        return `${new Date().toISOString().substring(0, 4)}-W01`;
      }
      // HH:mm:ss.SSS
      if (schema.format === '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\\.[0-9]{1,3})?)?$') {
        return new Date().toISOString().substring(11, 23);
      }
      // HH:mm:ss
      if (schema.format === '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$') {
        return new Date().toISOString().substring(11, 19);
      }
      // HH:mm
      if (schema.format === '^([01][0-9]|2[0-3]):[0-5][0-9]$') {
        return new Date().toISOString().substring(11, 16);
      }
      if (schema.format === '^#[0-9a-zA-Z]{6}$') {
        return '#ff00ff';
      }
      if (schema.format === 'tel') {
        return '123-456-7890';
      }
      if (schema.format === 'email') {
        return 'user@example.com';
      }
      return 'example_string';

    case 'number':
    case 'integer':
      if (schema.minimum !== undefined) return schema.minimum;
      return 0;

    case 'boolean':
      return false;

    case 'null':
      return null;

    default:
      return {};
  }
}

function waitForPageLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

document.querySelectorAll('.collapsible-header').forEach((header) => {
  header.addEventListener('click', () => {
    header.classList.toggle('collapsed');
    const content = header.nextElementSibling;
    if (content?.classList.contains('section-content')) {
      content.classList.toggle('is-hidden');
    }
  });
});
