// The toolbar button opens the side panel; everything else lives in the panel itself, which simply frames
// the local server the bot already runs. The extension never talks to Showdown and never reads the page.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
