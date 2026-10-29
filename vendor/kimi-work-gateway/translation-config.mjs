const FIELDS = new Set(['enabled', 'provider', 'targetLanguage', 'view', 'customEndpoint', 'customModel', 'apiKeyEnv']);

// Names the renderer/host process and the Kimi child rely on structurally. A
// translation key must never be configured under one of them: the host deletes
// its configured key name from the Kimi environment before spawn, and deleting
// PATH, HOME or the subagent bundle override would break Kimi itself.
const RESERVED_ENV_EXACT = new Set(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'APPDATA',
  'LOCALAPPDATA', 'PROGRAMFILES', 'USERPROFILE', 'SHELL', 'PWD', 'OLDPWD', 'LANG', 'LC_ALL', 'TERM',
  'KIMI_API_KEY', 'KIMI_SHARE_DIR']);
const RESERVED_ENV_PREFIX = ['DAIMON_', 'ELECTRON_', 'NODE_', 'DYLD_', 'LD_', 'KIMI_DAIMON_', 'KIMI_CODE_'];

export function reservedEnvName(name) {
  if (RESERVED_ENV_EXACT.has(name) || RESERVED_ENV_PREFIX.some(prefix => name.startsWith(prefix))) return true;
  return false;
}

export const TRANSLATION_LANGUAGES = Object.freeze(['zh', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'ru']);
export const TRANSLATION_DEFAULTS = Object.freeze({ enabled: false, provider: 'bing', targetLanguage: 'zh',
  view: 'translated', customEndpoint: '', customModel: '', apiKeyEnv: 'KIMI_WORK_TRANSLATION_API_KEY' });

export function normalizeTranslationConfig(value) {
  if (value === undefined) return { ...TRANSLATION_DEFAULTS };
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !FIELDS.has(key))) {
    throw Error('invalid_translation_config');
  }
  const settings = { ...TRANSLATION_DEFAULTS, ...value };
  if (typeof settings.enabled !== 'boolean' || !['bing', 'google', 'custom'].includes(settings.provider)
    || !TRANSLATION_LANGUAGES.includes(settings.targetLanguage) || !['translated', 'original'].includes(settings.view)
    || typeof settings.customEndpoint !== 'string' || settings.customEndpoint.length > 2048
    || typeof settings.customModel !== 'string' || settings.customModel.length > 2048 || /[\x00-\x1f\x7f]/.test(settings.customModel)
    || typeof settings.apiKeyEnv !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(settings.apiKeyEnv)
    || reservedEnvName(settings.apiKeyEnv)) {
    throw Error('invalid_translation_config');
  }
  settings.customEndpoint = settings.customEndpoint.trim();
  settings.customModel = settings.customModel.trim();
  if (settings.customEndpoint) {
    let url;
    try { url = new URL(settings.customEndpoint); } catch { throw Error('invalid_translation_endpoint'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      throw Error('invalid_translation_endpoint');
    }
    settings.customEndpoint = url.href;
  }
  if (settings.provider === 'custom' && !settings.customEndpoint) throw Error('translation_endpoint_required');
  return settings;
}
