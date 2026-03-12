# How to Install the Extension

This guide walks through loading the extension locally in Chrome.

## Prerequisites

- Chrome 146.0.7672.0 or higher
- The `WebMCP for testing` flag enabled in `chrome://flags`
- This repository available on your machine

## Clone the Repository

1. Choose a parent directory for local development.
2. Clone the repository:
   - `git clone <repository-url> sage-ui-mcp-tool`
3. Move into the project folder:
   - `cd sage-ui-mcp-tool`

If you already have the source on disk, you can skip this section.

## Install From Source

1. Open a terminal in the project folder.
2. Install dependencies:
   - `npm install`
3. Confirm the folder contains `manifest.json`.
4. Open Chrome and navigate to `chrome://extensions/`.
5. Turn on **Developer mode**.
6. Click **Load unpacked**.
7. Select this project folder, the one containing `manifest.json`.

## Development Workflow

Use this flow when you are actively changing the extension locally:

1. Make your code or styling changes in the cloned folder.
2. If dependencies changed, run:
   - `npm install`
3. Return to `chrome://extensions/`.
4. Click **Reload** on the unpacked extension.
5. Refresh the target webpage if needed.
6. Re-open the side panel to verify the latest behavior.

## Reload After Changes

When you change extension files:

1. Return to `chrome://extensions/`.
2. Find this extension.
3. Click **Reload**.
4. Re-open the side panel if needed.

## Troubleshooting

- If no tools appear, confirm the WebMCP flag is enabled and the current page actually exposes `navigator.modelContextTesting`.
- If messaging errors appear, refresh the page and reload the extension.
- Restricted pages such as `chrome://` URLs cannot be inspected by the extension.
