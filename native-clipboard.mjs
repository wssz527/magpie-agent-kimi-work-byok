// The core owns this file; the plugin only re-exports it so the clipboard
// helper has one implementation, including the Windows `clip.exe` branch.
export { copySetupToken, defaultClipboardCopy } from './vendor/kimi-work-gateway/native-clipboard.mjs';
