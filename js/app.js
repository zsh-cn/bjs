/* ------------------------------------------------------------------
   BJS · 北京时间
   显示、校准与界面状态
------------------------------------------------------------------- */

(function () {
  'use strict';

  var config = Object.assign({
    apiBase: '',
    apiPath: '/api/time',
    autoSyncMs: 5 * 60 * 1000,
    retryMs: 30 * 1000,
    requestTimeoutMs: 5000,
    fallbackHttp: true
  }, window.BJS_CONFIG || {});

  var $ = function (id) { return document.getElementById(id); };

  var clockMain = $('clock-main');
  var clockMs = $('clock-ms');
  var secondsFill = $('seconds-fill');
  var dateText = $('date-text');
  var weekdayText = $('weekday-text');
  var statusEl = $('status');
  var statusText = $('status-text');
  var syncBtn = $('sync-btn');
  var themeBtn = $('theme-toggle');
  var themeMeta = $('theme-color');
  var hourBtn = $('hour-toggle');
  var hourLabel = $('hour-toggle-label');
  var clockMeridiem = $('clock-meridiem');
  var hint = $('hint');
  var factSource = $('fact-source');
  var factOffset = $('fact-offset');
  var factRtt = $('fact-rtt');
  var factLast = $('fact-last');
  var deviceClock = $('device-clock');
  var utcTime = $('utc-time');
  var creditName = $('credit-name');
  var creditTail = $('credit-tail');

  var pad = function (n) { return n < 10 ? '0' + n : String(n); };
  var WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  var BEIJING_OFFSET = 8 * 60 * 60 * 1000;
  var DEFAULT_TITLE = 'BJS · 北京时间';
  var HOUR_CYCLE_KEY = 'bjs-hour-cycle';
  var hourCycle = '24';   // '12' | '24'
  var SOURCE_CREDITS = {
    'ntp.cnnic.cn': ['CNNIC', '· 中国互联网络信息中心'],
    'ntp.aliyun.com': ['阿里云', '· 阿里云公共 NTP'],
    'ntp.tencent.com': ['腾讯云', '· 腾讯云公共 NTP'],
    'ntp.ntsc.ac.cn': ['NTSC', '· 中国科学院国家授时中心'],
    'ntp1.nim.ac.cn': ['NIM', '· 中国计量科学研究院']
  };

  /* ---------------- 主题 ---------------- */

  var root = document.documentElement;
  var darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  function readTheme() {
    try { return localStorage.getItem('bjs-theme'); } catch (e) { return null; }
  }

  function applyTheme(theme) {
    root.dataset.theme = theme;
    if (themeMeta) themeMeta.setAttribute('content', theme === 'dark' ? '#0b0b0e' : '#f5f4f0');
    if (themeBtn) {
      themeBtn.setAttribute('aria-label', theme === 'dark' ? '切换到浅色主题' : '切换到深色主题');
      themeBtn.title = theme === 'dark' ? '切换到浅色主题' : '切换到深色主题';
    }
  }

  applyTheme(readTheme() || root.dataset.theme || (darkQuery.matches ? 'dark' : 'light'));

  themeBtn.addEventListener('click', function () {
    var next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('bjs-theme', next); } catch (e) {}
    applyTheme(next);
  });

  var onSchemeChange = function (event) {
    if (!readTheme()) applyTheme(event.matches ? 'dark' : 'light');
  };
  if (darkQuery.addEventListener) darkQuery.addEventListener('change', onSchemeChange);
  else if (darkQuery.addListener) darkQuery.addListener(onSchemeChange);

  /* ---------------- 时钟模型 ---------------- */

  var anchorWall = Date.now();
  var anchorPerf = performance.now();
  var delta = 0;          // 服务端时间 − 本机时间
  var slew = null;

  function localNow() {
    return anchorWall + (performance.now() - anchorPerf);
  }

  function trueNow() {
    return localNow() + delta;
  }

  function applyOffset(offset) {
    if (!Number.isFinite(offset)) return;
    var diff = offset - delta;
    if (Math.abs(diff) > 200 || Math.abs(diff) < 0.5) {
      delta = offset;
      slew = null;
      return;
    }
    slew = {
      from: delta,
      to: offset,
      start: performance.now(),
      duration: 600
    };
  }

  function applySample(result) {
    if (!Number.isFinite(result.offset)) return;
    if (!Number.isFinite(result.atPerf)) {
      applyOffset(result.offset);
      return;
    }
    var localAtSample = anchorWall + (result.atPerf - anchorPerf);
    applyOffset(result.at + result.offset - localAtSample);
  }

  /* ---------------- 渲染 ---------------- */

  var lastMain = '';
  var lastMs = '';
  var lastDate = '';
  var lastWeekday = '';
  var lastMeridiem = '';
  var lastTitleText = '';
  var lastUtcText = '';

  /* ---------------- 12/24 小时制 ---------------- */

  function readHourCycle() {
    try {
      return localStorage.getItem(HOUR_CYCLE_KEY) === '12' ? '12' : '24';
    } catch (e) {
      return '24';
    }
  }

  function isHour12() {
    return hourCycle === '12';
  }

  function hourInCycle(hours) {
    return isHour12() ? (hours % 12 || 12) : hours;
  }

  function meridiemOf(hours) {
    return hours < 12 ? 'AM' : 'PM';
  }

  function applyHourCycle(cycle) {
    hourCycle = cycle === '12' ? '12' : '24';
    var is12 = isHour12();

    if (clockMeridiem) clockMeridiem.hidden = !is12;
    if (hourLabel) hourLabel.textContent = hourCycle + 'H';
    if (hourBtn) {
      var label = is12 ? '切换为 24 小时制' : '切换为 12 小时制';
      hourBtn.setAttribute('aria-label', label);
      hourBtn.title = label;
      hourBtn.setAttribute('aria-pressed', is12 ? 'true' : 'false');
    }
  }

  function renderUtc(ms) {
    var d = new Date(ms);
    var hours = d.getUTCHours();
    var text = pad(hourInCycle(hours)) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) +
      (isHour12() ? ' ' + meridiemOf(hours) : '');
    if (text !== lastUtcText) {
      utcTime.textContent = text;
      lastUtcText = text;
    }
  }

  function render(t) {
    var ms = Math.floor(t);
    var bj = new Date(ms + BEIJING_OFFSET);
    var hours = bj.getUTCHours();
    var meridiem = isHour12() ? meridiemOf(hours) : '';

    var main = pad(hourInCycle(hours)) + ':' + pad(bj.getUTCMinutes()) + ':' + pad(bj.getUTCSeconds());
    if (main !== lastMain) {
      clockMain.textContent = main;
      lastMain = main;

      var titleText = main + (meridiem ? ' ' + meridiem : '');
      if (titleText !== lastTitleText) {
        document.title = titleText + ' · ' + DEFAULT_TITLE;
        lastTitleText = titleText;
      }

      renderUtc(ms);
    }

    if (meridiem !== lastMeridiem) {
      clockMeridiem.textContent = meridiem;
      lastMeridiem = meridiem;
    }

    var msText = '.' + String(bj.getUTCMilliseconds()).padStart(3, '0');
    if (msText !== lastMs) {
      clockMs.textContent = msText;
      lastMs = msText;
    }

    var date = bj.getUTCFullYear() + '年' + (bj.getUTCMonth() + 1) + '月' + bj.getUTCDate() + '日';
    if (date !== lastDate) {
      dateText.textContent = date;
      lastDate = date;
    }

    var weekday = WEEKDAYS[bj.getUTCDay()];
    if (weekday !== lastWeekday) {
      weekdayText.textContent = weekday;
      lastWeekday = weekday;
    }

    var progress = (t % 1000) / 1000;
    if (progress < 0) progress = 0;
    secondsFill.style.transform = 'scaleX(' + progress.toFixed(4) + ')';
  }

  function advance(now) {
    if (slew) {
      var p = Math.min(1, (now - slew.start) / slew.duration);
      var eased = 1 - Math.pow(1 - p, 3);
      delta = slew.from + (slew.to - slew.from) * eased;
      if (p >= 1) slew = null;
    }
    render(trueNow());
  }

  function frame(now) {
    advance(now);
    window.requestAnimationFrame(frame);
  }

  /* ---------------- 设备时钟 ---------------- */

  var lastDeviceText = '';

  function renderDeviceClock() {
    var offsetMinutes = -new Date().getTimezoneOffset();
    if (offsetMinutes === 480) {
      if (!deviceClock.hidden) deviceClock.hidden = true;
      return;
    }

    var d = new Date();
    var hours = d.getHours();
    var sign = offsetMinutes >= 0 ? '+' : '−';
    var abs = Math.abs(offsetMinutes);
    var zone = 'UTC' + sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60);
    var text = '本机 ' + pad(hourInCycle(hours)) + ':' + pad(d.getMinutes()) + ':' +
      pad(d.getSeconds()) + (isHour12() ? ' ' + meridiemOf(hours) : '') + ' · ' + zone;

    if (text !== lastDeviceText) {
      deviceClock.textContent = text;
      lastDeviceText = text;
    }
    deviceClock.hidden = false;
  }

  /* ---------------- 状态与信息 ---------------- */

  function setStatus(state, text, title) {
    statusEl.dataset.state = state;
    statusText.textContent = text;
    if (title) statusEl.title = title;
    syncBtn.classList.toggle('is-spinning', state === 'syncing');
  }

  function formatOffset(ms) {
    var abs = Math.abs(ms);
    if (abs < 0.5) return '±0 ms';
    var sign = ms > 0 ? '+' : '−';
    if (abs < 1000) return sign + Math.round(abs) + ' ms';
    return sign + (abs / 1000).toFixed(3) + ' s';
  }

  function formatRtt(ms) {
    if (ms == null || !Number.isFinite(ms)) return '—';
    if (ms < 0.5) return '< 1 ms';
    return Math.round(ms) + ' ms';
  }

  function formatBeijingTime(t) {
    var d = new Date(Math.floor(t) + BEIJING_OFFSET);
    var hours = d.getUTCHours();
    var text = pad(hourInCycle(hours)) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
    return isHour12() ? text + ' ' + meridiemOf(hours) : text;
  }

  function renderFacts(result) {
    factSource.textContent = result.sourceLabel;
    factSource.title = result.detail;

    factOffset.textContent = formatOffset(result.offset);
    factOffset.title = '服务端时间 − 本机时间，正值表示本机偏慢';

    var rtt = result.ntpRtt != null ? result.ntpRtt : result.rtt;
    factRtt.textContent = formatRtt(rtt);
    factRtt.title = result.method === 'ntp' ? 'NTP 请求的往返延迟' : 'HTTP 请求的往返延迟';

    factLast.textContent = formatBeijingTime(result.at + result.offset);
    factLast.title = '上次完成校准的时间';
  }

  function renderCredit(result) {
    if (result.method === 'ntp') {
      var credit = SOURCE_CREDITS[String(result.source || '').toLowerCase()];
      if (credit) {
        creditName.textContent = credit[0];
        creditTail.textContent = credit[1];
      } else {
        creditName.textContent = 'NTP';
        creditTail.textContent = '· ' + result.source;
      }
      return;
    }
    creditName.textContent = 'HTTP';
    creditTail.textContent = '· ' + result.sourceLabel + ' 时间接口';
  }

  /* ---------------- 校准流程 ---------------- */

  var syncing = false;
  var lastSyncAt = 0;
  var lastResult = null;
  var retryTimer = null;

  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(function () {
      retryTimer = null;
      sync({ silent: true });
    }, config.retryMs);
  }

  function sync(options) {
    options = options || {};
    if (syncing) return Promise.resolve();
    if (!window.BJS || typeof window.BJS.getTime !== 'function') {
      setStatus('local', '本地时钟', '授时脚本未加载');
      hint.hidden = false;
      return Promise.resolve();
    }

    syncing = true;
    clearTimeout(retryTimer);
    retryTimer = null;

    if (!options.silent || !lastResult) setStatus('syncing', '正在校准');
    syncBtn.disabled = true;
    syncBtn.classList.add('is-spinning');
    syncBtn.setAttribute('aria-busy', 'true');

    return window.BJS.getTime(config).then(function (result) {
      applySample(result);
      lastSyncAt = Date.now();
      lastResult = result;

      renderFacts(result);
      renderCredit(result);
      setStatus(
        'ok',
        result.method === 'ntp' ? '已同步 · NTP' : '已同步 · HTTP',
        result.detail
      );
      hint.hidden = true;
      syncBtn.title = '立即同步';
    }).catch(function (error) {
      if (window.console) console.warn('[BJS] 授时失败：', error);
      var detail = error && error.causes && error.causes.length
        ? error.causes.join('\n')
        : (error && error.message) || '未知错误';

      if (lastResult) {
        setStatus(
          'ok',
          lastResult.method === 'ntp' ? '已同步 · NTP' : '已同步 · HTTP',
          '本次校准失败，继续使用上次结果\n' + detail
        );
      } else {
        setStatus('local', '本地时钟', detail);
        creditName.textContent = 'LOCAL';
        creditTail.textContent = '· 本机时钟';
        hint.hidden = false;
      }
      syncBtn.title = '同步失败，点击重试';
      scheduleRetry();
    }).finally(function () {
      syncing = false;
      syncBtn.disabled = false;
      syncBtn.classList.remove('is-spinning');
      syncBtn.removeAttribute('aria-busy');
    });
  }

  /* ---------------- 事件与定时任务 ---------------- */

  syncBtn.addEventListener('click', function () {
    sync();
  });

  hourBtn.addEventListener('click', function () {
    var next = isHour12() ? '24' : '12';
    try { localStorage.setItem(HOUR_CYCLE_KEY, next); } catch (e) {}
    applyHourCycle(next);

    lastMain = '';
    lastMs = '';
    lastDate = '';
    lastWeekday = '';
    lastMeridiem = '';
    lastTitleText = '';
    lastUtcText = '';
    lastDeviceText = '';

    render(trueNow());
    if (lastResult) renderFacts(lastResult);
    renderDeviceClock();
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && lastSyncAt && Date.now() - lastSyncAt > 60 * 1000) {
      sync({ silent: true });
    }
  });

  window.addEventListener('online', function () {
    sync({ silent: true });
  });

  window.setInterval(function () {
    if (!lastSyncAt || document.visibilityState !== 'visible') return;
    if (Date.now() - lastSyncAt >= config.autoSyncMs) sync({ silent: true });
  }, 30 * 1000);

  window.setInterval(renderDeviceClock, 1000);

  /* ---------------- 启动 ---------------- */

  applyHourCycle(readHourCycle());
  renderDeviceClock();
  window.requestAnimationFrame(frame);

  // rAF 在窗口被遮挡时可能完全暂停，用低频定时器保证时钟仍在走。
  window.setInterval(function () {
    advance(performance.now());
  }, 500);

  window.setTimeout(function () {
    sync({ silent: true });
  }, 120);
})();
