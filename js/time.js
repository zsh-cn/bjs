/* ------------------------------------------------------------------
   BJS 授时客户端
   ------------------------------------------------------------------
   1. 首选同源 /api/time（server.mjs 通过 SNTP 访问公共 NTP 服务器）；
   2. 代理不可用时降级到支持 JSONP 的 HTTP 时间接口。
   浏览器无法直接发送 UDP 数据包，所以纯静态页面只能走第 2 条路径。
------------------------------------------------------------------- */

(function () {
  'use strict';

  var JSONP_TIMEOUT = 5000;
  var SAMPLE_COUNT = 3;
  var SOURCE_LABELS = {
    'ntp.cnnic.cn': 'CNNIC',
    'ntp.aliyun.com': '阿里云',
    'ntp.tencent.com': '腾讯云',
    'ntp.ntsc.ac.cn': '国家授时中心',
    'ntp1.nim.ac.cn': '中国计量科学研究院'
  };

  function jsonp(makeUrl, timeout) {
    return new Promise(function (resolve, reject) {
      var name = '__bjs_cb_' + Math.random().toString(36).slice(2);
      var script = document.createElement('script');
      var settled = false;
      var timer;

      function cleanup() {
        clearTimeout(timer);
        try { delete window[name]; } catch (e) { window[name] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
      }

      window[name] = function (data) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(data);
      };

      script.onerror = function () {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('时间接口加载失败'));
      };

      timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('时间接口请求超时'));
      }, timeout || JSONP_TIMEOUT);

      script.async = true;
      script.src = makeUrl(name);
      document.head.appendChild(script);
    });
  }

  function fetchProxy(config) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, config.requestTimeoutMs || 5000);
    var t0 = Date.now();
    var url = (config.apiBase || '') + (config.apiPath || '/api/time') +
      ((config.apiPath || '/api/time').indexOf('?') === -1 ? '?' : '&') + '_=' + t0;

    return fetch(url, {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    }).then(function (response) {
      var t4 = Date.now();
      if (!response.ok) throw new Error('授时接口返回 HTTP ' + response.status);
      return response.json().then(function (data) {
        if (!data || data.ok !== true || !Number.isFinite(data.time)) {
          throw new Error('授时接口响应格式无效');
        }
        var processing = Number.isFinite(data.processingMs) ? data.processingMs : 0;
        var host = data.server || 'ntp.cnnic.cn';
        var label = SOURCE_LABELS[String(host).toLowerCase()] || host;
        return {
          offset: data.time - processing / 2 - (t0 + t4) / 2,
          rtt: t4 - t0,
          ntpRtt: Number.isFinite(data.rttMs) ? data.rttMs : null,
          source: host,
          sourceLabel: label,
          method: 'ntp',
          at: t4,
          atPerf: performance.now(),
          detail: [
            host,
            data.ip,
            data.stratum != null ? 'stratum ' + data.stratum : null,
            Number.isFinite(data.rttMs) ? 'NTP RTT ' + Math.round(data.rttMs) + ' ms' : null
          ].filter(Boolean).join(' · ')
        };
      });
    }).finally(function () {
      clearTimeout(timer);
    });
  }

  function fetchSuning() {
    var t0 = Date.now();
    return jsonp(function (cb) {
      return 'https://f.m.suning.com/api/ct.do?callback=' + encodeURIComponent(cb) +
        '&_=' + t0;
    }).then(function (data) {
      var t4 = Date.now();
      var time = Number(data && data.currentTime);
      if (!Number.isFinite(time)) throw new Error('苏宁时间接口响应格式无效');
      return {
        offset: time - (t0 + t4) / 2,
        rtt: t4 - t0,
        ntpRtt: null,
        source: 'f.m.suning.com',
        sourceLabel: '苏宁授时',
        method: 'http',
        at: t4,
        atPerf: performance.now(),
        detail: 'HTTP 时间接口 · 精度低于 NTP'
      };
    });
  }

  function fetchTaobao() {
    var t0 = Date.now();
    return jsonp(function (cb) {
      return 'https://api.m.taobao.com/rest/api3.do?api=mtop.common.getTimestamp' +
        '&v=1.0&type=originaljson&dataType=jsonp&callback=' + encodeURIComponent(cb) +
        '&_=' + t0;
    }).then(function (data) {
      var t4 = Date.now();
      var time = Number(data && data.data && data.data.t);
      if (!Number.isFinite(time)) throw new Error('淘宝时间接口响应格式无效');
      return {
        offset: time - (t0 + t4) / 2,
        rtt: t4 - t0,
        ntpRtt: null,
        source: 'api.m.taobao.com',
        sourceLabel: '淘宝授时',
        method: 'http',
        at: t4,
        atPerf: performance.now(),
        detail: 'HTTP 时间接口 · 精度低于 NTP'
      };
    });
  }

  function sample(source, count) {
    var tasks = [];
    for (var i = 0; i < count; i++) tasks.push(source());

    return Promise.allSettled(tasks).then(function (results) {
      var list = results
        .filter(function (result) { return result.status === 'fulfilled'; })
        .map(function (result) { return result.value; })
        .sort(function (a, b) { return a.rtt - b.rtt; });

      if (!list.length) {
        var failure = results.find(function (result) { return result.status === 'rejected'; });
        throw failure ? failure.reason : new Error('时间接口请求失败');
      }

      var best = list[0];
      best.samples = list.length;
      return best;
    });
  }

  function getTime(config) {
    var errors = [];

    var attemptProxy = config.apiBase === null ? Promise.reject(new Error('未配置代理')) :
      fetchProxy(config).catch(function (error) {
        errors.push('NTP 代理：' + error.message);
        throw error;
      });

    return attemptProxy.catch(function () {
      if (config.fallbackHttp === false) throw new Error(errors.join('；'));
      var sources = [fetchSuning, fetchTaobao];

      function trySource(index) {
        if (index >= sources.length) {
          var error = new Error('无法连接任何授时服务');
          error.causes = errors;
          throw error;
        }
        return sample(sources[index], SAMPLE_COUNT).catch(function (error) {
          errors.push((index === 0 ? '苏宁' : '淘宝') + '：' + error.message);
          return trySource(index + 1);
        });
      }

      return trySource(0);
    }).catch(function (error) {
      if (!error.causes) error.causes = errors;
      throw error;
    });
  }

  window.BJS = window.BJS || {};
  window.BJS.getTime = getTime;
})();
