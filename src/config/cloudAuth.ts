export const CLOUD_AUTH_CONFIG = {
  // Локальные порты для OAuth loopback redirect (http://localhost:<port>/callback).
  // Все три URI нужно добавить в «Доверенные redirect URI» в настройках OAuth-приложений:
  //   - Google: console.cloud.google.com → Credentials → OAuth 2.0 Client IDs → тип "Web application"
  //   - Yandex: oauth.yandex.ru → ваше приложение → Callback URI
  redirectPorts: [53785, 53786, 53787] as number[],

  yandex: {
    clientId: '',      // ← вставь ClientID из oauth.yandex.ru
    clientSecret: '',  // ← вставь Client secret
    folder: '/WPDock',
  },

  google: {
    clientId: '',      // ← вставь Client ID (тип "Web application") из console.cloud.google.com
    clientSecret: '',  // ← вставь Client secret
    folderId: '/WPDock',      // ← опционально: ID папки Google Drive (пусто = корень "Мой диск")
  },
} as const;
