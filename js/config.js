/* ------------------------------------------------------------------
   BJS 配置
   ------------------------------------------------------------------
   apiBase    授时代理地址。留空表示同源（由 server.mjs 提供）。
              部署到纯静态托管时，可通过 ?api=https://proxy.example.com
              指向自建的 NTP 代理。
   apiPath    代理接口路径。
   autoSyncMs 自动重新校准间隔。
   retryMs    失败后的重试间隔。
   fallbackHttp 是否允许降级到 HTTP 时间接口。
------------------------------------------------------------------- */

(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var apiOverride = params.get('api');
  var isFile = window.location.protocol === 'file:';
  var defaultBase = isFile ? 'http://127.0.0.1:8787' : '';

  window.BJS_CONFIG = {
    apiBase: String(apiOverride || defaultBase).replace(/\/+$/, ''),
    apiPath: '/api/time',
    autoSyncMs: 5 * 60 * 1000,
    retryMs: 30 * 1000,
    requestTimeoutMs: 5000,
    fallbackHttp: true
  };
})();
