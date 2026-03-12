# WebMCP - Model Context Tool Inspector

A Chrome Extension that allows developers to inspect, monitor, and execute tools exposed via the experimental `navigator.modelContextTesting` Web API.

## Prerequisites

**Important:** This extension relies on the experimental `navigator.modelContextTesting` Web API. You must enable the "WebMCP for testing" flag in `chrome://flags` to turn it on in Chrome 146.0.7672.0 or higher.

## Installation

You can install this extension either directly from the Chrome Web Store or manually from the source code.

For a dedicated local setup guide, see [HOW_TO_INSTALL_EXTENSION.md](HOW_TO_INSTALL_EXTENSION.md).

### Option 1: Chrome Web Store (recommended)

Install the extension directly via the [Chrome Web Store](https://chromewebstore.google.com/detail/model-context-tool-inspec/gbpdfapgefenggkahomfgkhfehlcenpd).

### Option 2: Install from source

See [HOW_TO_INSTALL_EXTENSION.md](HOW_TO_INSTALL_EXTENSION.md) for the full step-by-step version.

1.  **Download the Source:**
    Clone this repository or download the source files into a directory.

2.  **Install dependencies:**
    In the directory, run `npm install`.

3.  **Open Chrome Extensions:**
    Navigate to `chrome://extensions/` in your browser address bar.

4.  **Enable Developer Mode:**
    Toggle the **Developer mode** switch in the top right corner of the Extensions page.

5.  **Load Unpacked:**
    Click the **Load unpacked** button that appears in the top left. Select the directory containing `manifest.json` (the folder where you saved the files).

## Usage

1.  **Navigate to a Page:**
    Open a web page that exposes Model Context tools.

2.  **Open the Inspector:**
    Click the extension's action icon (the puzzle piece or pinned icon) in the Chrome toolbar. This will open the **Side Panel**.

3.  **Inspect Tools:**
    * The current active tab is always the tool-execution target.
    * Choose a **Source Tab** if you want to pull text from another open page into the prompt box.
    * The extension will inject a content script to query the page.
    * A table will appear listing all available tools found on the page.
    * The source tab dropdown uses status icons: `🟢` WebMCP available, `⚪️` readable tab without WebMCP, `🔒` restricted or unreachable.
    * Use the filter box to narrow the list by tool name, description, or schema.
    * Use **Refresh** to re-query tab status and reload tools for the current active tab.

4.  **Execute a Tool:**
    * **Tool:** Select the desired tool from the dropdown menu for the current active tab.
    * **Selected Tool Details:** Review the tool description and JSON schema before running it.
    * **Input Arguments:** Enter the arguments for the tool in the text area.
        * *Note:* The input must be valid JSON (e.g., `{"text": "hello world"}`).
        * Use **Format JSON** to normalize the payload before sending it.
    * Click **Execute Tool**.

5.  **Use Text From Another Tab:**
    * Pick a **Source Tab** from the current window.
    * Click **Insert Source Tab Text into Prompt**.
    * The extension will import the current selection from that tab when available, otherwise it falls back to the page text.

## Disclaimer

This is not an officially supported Google product. This project is not
eligible for the [Google Open Source Software Vulnerability Rewards
Program](https://bughunters.google.com/open-source-security).
