/* =========================================================================
 * 单词本 - 主逻辑
 * 结构：常量 → 状态 → 工具 → 存储 → 词典查询 → 判分 → 默写流程 → 视图渲染 → 事件 → 启动
 * 说明：使用经典 script（非 ES Module），保证 file:// 直接打开也能运行。
 * ========================================================================= */
(function () {
  'use strict';

  /* ===== 常量 ===== */
  var LS_KEY = 'wordbook_v1';
  var MAX_DEFS = 3;
  var WRONG_REMOVE_THRESHOLD = 5; // 错题本累计答对 5 次移除

  var DEFAULT_SETTINGS = {
    provider: 'deepseek',   // deepseek | qwen | custom
    apiKey: '',
    model: 'deepseek-chat',
    baseUrl: '',
    randomCount: 10         // 随机抽默默认数量
  };

  /* ===== 状态 ===== */
  var store = { words: [], settings: Object.assign({}, DEFAULT_SETTINGS) };
  // words[i] = { word, defs:[{pos,meaning}], date, addedAt, source,
  //              wrong, correctStreak, wrongCount, rightCount }
  var quiz = null; // { list, idx, mode:'c2e'|'e2c', results:[] }

  /* ===== 工具 ===== */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtDate(ts) {
    var d = new Date(ts);
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }
  function today() { return fmtDate(Date.now()); }
  function withinDays(ts, n) { return (Date.now() - ts) <= n * 24 * 60 * 60 * 1000; }
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function speak(text) {
    if (!window.speechSynthesis) return;
    var u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US'; u.rate = 0.9;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  /* ===== 存储层 ===== */
  function loadStore() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        store.words = Array.isArray(parsed.words) ? parsed.words : [];
        store.settings = Object.assign({}, DEFAULT_SETTINGS, parsed.settings || {});
      }
    } catch (e) {
      console.warn('读取本地数据失败，已重置', e);
      store = { words: [], settings: Object.assign({}, DEFAULT_SETTINGS) };
    }
  }
  function saveStore() { localStorage.setItem(LS_KEY, JSON.stringify(store)); }

  function getWord(word) {
    word = word.toLowerCase();
    for (var i = 0; i < store.words.length; i++) {
      if (store.words[i].word === word) return store.words[i];
    }
    return null;
  }
  function addWord(word, defs, source) {
    word = word.toLowerCase().trim();
    if (getWord(word)) return false;
    var ts = Date.now();
    store.words.push({
      word: word,
      defs: defs.slice(0, MAX_DEFS),
      date: fmtDate(ts),
      addedAt: ts,
      source: source,
      wrong: false, correctStreak: 0, wrongCount: 0, rightCount: 0
    });
    saveStore();
    return true;
  }
  function removeWord(word) {
    for (var i = 0; i < store.words.length; i++) {
      if (store.words[i].word === word) { store.words.splice(i, 1); saveStore(); return true; }
    }
    return false;
  }
  function setWrong(word, toWrong) {
    var w = getWord(word);
    if (!w) return false;
    w.wrong = toWrong;
    if (!toWrong) w.correctStreak = 0;
    saveStore();
    return true;
  }

  /* ===== 词典查询层 ===== */
  // 1) 本地四六级词库
  function lookupCET(word) {
    var d = window.CET_DICT && window.CET_DICT[word.toLowerCase().trim()];
    if (!d) return null;
    return { source: d.level === 'CET4' ? '四级词库' : '六级词库', defs: d.defs };
  }

  // 把 "n. 进入；使用权 v. 获取" 这类文本解析为 defs 数组
  function parseDefsText(text) {
    var posRe = /^[a-z]{1,5}\.$/i;
    var tokens = String(text).split(/\s+/);
    var defs = [], curPos = null, curMean = [];
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (posRe.test(t)) {
        if (curPos && curMean.length) defs.push({ pos: curPos.toLowerCase(), meaning: curMean.join(' ') });
        curPos = t; curMean = [];
      } else {
        curMean.push(t);
      }
    }
    if (curPos && curMean.length) defs.push({ pos: curPos.toLowerCase(), meaning: curMean.join(' ') });
    return defs.slice(0, MAX_DEFS);
  }

  // 2) 有道 suggest 接口（可能被 CORS 拦截，失败时降级）
  function fetchYoudao(word) {
    return fetch('https://dict.youdao.com/suggest?num=3&doctype=json&q=' + encodeURIComponent(word))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.data || !data.data.entries) return null;
        var entries = data.data.entries;
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].entry && entries[i].entry.toLowerCase() === word.toLowerCase() && entries[i].explain) {
            var defs = parseDefsText(entries[i].explain);
            if (defs.length) return { source: '有道词典', defs: defs };
          }
        }
        return null;
      })
      .catch(function () { return null; });
  }

  // 3) Free Dictionary API（英文释义，兜底）
  function fetchFreeDict(word) {
    return fetch('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!Array.isArray(data)) return null;
        var defs = [];
        for (var i = 0; i < data.length && defs.length < MAX_DEFS; i++) {
          var meanings = data[i].meanings || [];
          for (var j = 0; j < meanings.length && defs.length < MAX_DEFS; j++) {
            var m = meanings[j];
            var lines = (m.definitions || []).slice(0, 2).map(function (d) { return d.definition; }).join('；');
            if (lines) defs.push({ pos: (m.partOfSpeech || '') + '.', meaning: lines });
          }
        }
        return defs.length ? { source: 'FreeDict(英文释义)', defs: defs } : null;
      })
      .catch(function () { return null; });
  }

  // 在线查询降级链：有道 → FreeDict
  function lookupOnline(word) {
    return fetchYoudao(word).then(function (res) {
      if (res) return res;
      return fetchFreeDict(word);
    });
  }

  /* ===== 判分层 ===== */
  function apiBase(s) {
    if (s.provider === 'deepseek') return 'https://api.deepseek.com/v1/chat/completions';
    if (s.provider === 'qwen') return 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
    return s.baseUrl || '';
  }
  function apiModel(s) {
    if (s.model) return s.model;
    return s.provider === 'deepseek' ? 'deepseek-chat' : 'qwen-plus';
  }

  // 英译汉 LLM 判分：意思相近判对；相差较多判错；漏写释义在 missing 中补充
  function judgeLLM(word, defs, userAnswer) {
    var s = store.settings;
    var key = (s.apiKey || '').trim();
    if (!key) return Promise.reject(new Error('未配置 API Key'));
    var std = defs.map(function (d) { return d.pos + ' ' + d.meaning; }).join('\n');
    var prompt =
      '你是英语词汇默写判题助手。请根据标准释义评判学生的中文答案，并严格返回一个 JSON 对象（不要 markdown 代码块、不要多余解释）。\n' +
      'JSON 格式：{"judge":"对" 或 "错","comment":"简短说明","missing":["被漏写的释义，形如 \\"n. 接近，入口\\""]}\n\n' +
      '评判标准：\n' +
      '1. 学生答案与任意一条标准释义意思相近，judge 为 "对"；意思相差较多，judge 为 "错"。\n' +
      '2. 即使判对，若学生漏写了某些释义，也要在 missing 数组中列出。\n\n' +
      '单词：' + word + '\n' +
      '标准释义：\n' + std + '\n' +
      '学生答案：' + userAnswer;
    return fetch(apiBase(s), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: apiModel(s),
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        response_format: { type: 'json_object' }
      })
    }).then(function (r) {
      if (!r.ok) throw new Error('LLM 请求失败 HTTP ' + r.status);
      return r.json();
    }).then(function (data) {
      var content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!content) throw new Error('LLM 返回为空');
      var text = content.trim();
      var a = text.indexOf('{'), b = text.lastIndexOf('}');
      if (a > -1 && b > a) text = text.slice(a, b + 1);
      var result = JSON.parse(text);
      return {
        correct: result.judge === '对',
        comment: result.comment || '',
        missing: Array.isArray(result.missing) ? result.missing : []
      };
    });
  }

  // 本地判分（无 Key 或 LLM 不可用时的降级方案：关键词匹配）
  function judgeLocal(word, defs, userAnswer) {
    var ans = userAnswer.toLowerCase();
    var tokens = ans.split(/[。，；！!、\s]+/).filter(Boolean);
    var missing = [];
    var hitAny = false;
    defs.forEach(function (d) {
      var parts = d.meaning.split(/[；，、]/);
      var hit = false;
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i].trim().toLowerCase();
        if (!p) continue;
        if (ans.indexOf(p) > -1) { hit = true; break; }
        for (var k = 0; k < tokens.length; k++) {
          if (tokens[k].length > 1 && p.indexOf(tokens[k]) > -1) { hit = true; break; }
        }
        if (hit) break;
      }
      if (hit) hitAny = true; else missing.push(d.pos + ' ' + d.meaning);
    });
    return {
      correct: hitAny,
      comment: hitAny ? '本地判分：意思基本匹配' : '本地判分：未匹配到释义',
      missing: hitAny ? missing : []
    };
  }

  // 英译汉判分入口：有 Key 走 LLM，失败自动降级本地判分
  function judge(word, defs, userAnswer) {
    if (!(store.settings.apiKey || '').trim()) {
      return Promise.resolve(judgeLocal(word, defs, userAnswer));
    }
    return judgeLLM(word, defs, userAnswer).catch(function (e) {
      console.warn('LLM 判分失败，降级为本地判分：', e);
      var r = judgeLocal(word, defs, userAnswer);
      r.comment = '（LLM 不可用：' + e.message + '，已用本地判分）' + r.comment;
      return r;
    });
  }

  // 记录一次作答：更新统计与错题本状态
  function recordResult(word, correct) {
    var w = getWord(word);
    if (!w) return;
    if (correct) {
      w.rightCount++;
      if (w.wrong) {
        w.correctStreak++;
        if (w.correctStreak >= WRONG_REMOVE_THRESHOLD) {
          w.wrong = false;
          w.correctStreak = 0;
        }
      }
    } else {
      w.wrongCount++;
      w.wrong = true;
      w.correctStreak = 0;
    }
    saveStore();
  }

  /* ===== 默写流程 ===== */
  function quizCandidates(scope) {
    if (scope === 'wrongbook') {
      var wl = store.words.filter(function (w) { return w.wrong; });
      return wl.length ? shuffle(wl) : null; // null 表示错题本为空
    }
    var list = store.words.slice();
    if (scope === '3days') list = list.filter(function (w) { return withinDays(w.addedAt, 3); });
    if (scope === '7days') list = list.filter(function (w) { return withinDays(w.addedAt, 7); });
    if (scope === 'random') list = shuffle(list).slice(0, store.settings.randomCount || 10);
    return list.length ? shuffle(list) : [];
  }

  function startQuiz() {
    var scope = $('quiz-scope').value;
    var mode = $('quiz-mode').value;
    var msg = $('quiz-message');
    if (scope === 'wrongbook' && !store.words.some(function (w) { return w.wrong; })) {
      msg.textContent = '无错题';
      return;
    }
    var list = quizCandidates(scope);
    if (!list || !list.length) {
      msg.textContent = '当前范围内没有单词。';
      return;
    }
    msg.textContent = '';
    quiz = { list: list, idx: 0, mode: mode, results: [] };
    $('quiz-setup').style.display = 'none';
    $('quiz-summary').style.display = 'none';
    $('quiz-area').style.display = 'block';
    renderQuestion();
  }

  function renderQuestion() {
    if (!quiz || quiz.idx >= quiz.list.length) { showQuizSummary(); return; }
    var w = quiz.list[quiz.idx];
    $('quiz-progress').textContent = '第 ' + (quiz.idx + 1) + ' / ' + quiz.list.length + ' 题';
    $('quiz-input').value = '';
    $('quiz-result').style.display = 'none';
    $('quiz-next').style.display = 'none';
    if (quiz.mode === 'c2e') {
      // 英译汉：只显示英文单词（不泄露释义）
      $('quiz-prompt').innerHTML =
        '<strong class="quiz-word">' + esc(w.word) + '</strong>' +
        ' <button type="button" id="btn-speak">发音</button>';
      $('btn-speak').onclick = function () { speak(w.word); };
      $('quiz-input').placeholder = '请输入该单词的中文意思';
    } else {
      // 汉译英：显示中文释义，用户写英文单词
      var text = w.defs.map(function (d) { return esc(d.pos) + ' ' + esc(d.meaning); }).join('<br>');
      $('quiz-prompt').innerHTML = '<div class="quiz-defs">' + text + '</div>';
      $('quiz-input').placeholder = '请输入对应的英文单词';
    }
  }

  function onQuizSubmit() {
    if (!quiz || quiz.idx >= quiz.list.length) return;
    // 本题已提交过（结果面板显示中）时忽略，防止回车重复提交导致成绩翻倍
    if ($('quiz-result').style.display === 'block') return;
    var w = quiz.list[quiz.idx];
    var val = $('quiz-input').value.trim();
    if (!val) { alert('请输入答案'); return; }
    $('quiz-submit').disabled = true;

    var finish = function (res) {
      recordResult(w.word, res.correct);
      quiz.results.push({ word: w.word, correct: res.correct, userAnswer: val, missing: res.missing, comment: res.comment });
      var defsHtml = w.defs.map(function (d) { return esc(d.pos) + ' ' + esc(d.meaning); }).join('<br>');
      var html = '<p class="' + (res.correct ? 'ok' : 'bad') + '"><strong>' + (res.correct ? '✓ 答对了' : '✗ 答错了') + '</strong></p>' +
        (res.comment ? '<p>' + esc(res.comment) + '</p>' : '') +
        '<p>标准答案：<br>' + defsHtml + '</p>';
      if (res.missing && res.missing.length) {
        html += '<p>漏写释义：</p><ul>' + res.missing.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') + '</ul>';
      }
      if (!res.correct) html += '<p style="color:#c00">该词已自动加入错题本。</p>';
      $('quiz-result').innerHTML = html;
      $('quiz-result').style.display = 'block';
      $('quiz-next').style.display = 'inline-block';
      $('quiz-submit').disabled = false;
    };

    if (quiz.mode === 'e2c') {
      // 汉译英：直接匹配（忽略大小写与首尾空格）
      var correct = val.toLowerCase() === w.word.toLowerCase();
      finish({ correct: correct, comment: correct ? '拼写正确' : '正确拼写：' + w.word, missing: [] });
    } else {
      judge(w.word, w.defs, val).then(finish);
    }
  }

  function onQuizNext() {
    quiz.idx++;
    renderQuestion();
  }

  // 中途退出默写：回到设置面板重新选择范围/方向
  function exitQuiz() {
    if (!quiz) return;
    if (!confirm('确认退出本次默写吗？已作答的成绩会保留，当前进度将丢失。')) return;
    quiz = null;
    $('quiz-area').style.display = 'none';
    $('quiz-result').style.display = 'none';
    $('quiz-summary').style.display = 'none';
    $('quiz-setup').style.display = 'block';
  }

  function showQuizSummary() {
    $('quiz-area').style.display = 'none';
    $('quiz-summary').style.display = 'block';
    var total = quiz.results.length;
    var right = quiz.results.filter(function (r) { return r.correct; }).length;
    var html = '<p>共 ' + total + ' 题，答对 ' + right + ' 题，答错 ' + (total - right) + ' 题</p>';
    var wrongs = quiz.results.filter(function (r) { return !r.correct; });
    if (wrongs.length) {
      html += '<h3>错误清单</h3><table><thead><tr><th>单词</th><th>你的答案</th><th>标准答案</th></tr></thead><tbody>';
      wrongs.forEach(function (r) {
        var w = getWord(r.word);
        var defs = w ? w.defs.map(function (d) { return esc(d.pos) + ' ' + esc(d.meaning); }).join('<br>') : '-';
        html += '<tr><td><strong>' + esc(r.word) + '</strong></td><td>' + esc(r.userAnswer) + '</td><td>' + defs + '</td></tr>';
      });
      html += '</tbody></table>';
    } else {
      html += '<p>全部答对！</p>';
    }
    html += '<button type="button" id="quiz-back">返回</button>';
    $('quiz-summary').innerHTML = html;
    $('quiz-back').onclick = function () {
      $('quiz-summary').style.display = 'none';
      $('quiz-setup').style.display = 'block';
    };
  }

  /* ===== 视图渲染 ===== */
  function showView(id) {
    var sections = document.querySelectorAll('section.view');
    for (var i = 0; i < sections.length; i++) sections[i].style.display = 'none';
    $(id).style.display = 'block';
    // 导航高亮当前页
    var navBtns = document.querySelectorAll('nav button');
    for (var j = 0; j < navBtns.length; j++) {
      navBtns[j].className = navBtns[j].dataset.view === id ? 'active' : '';
    }
    if (id === 'view-book') renderBook();
    if (id === 'view-wrong') renderWrong();
    if (id === 'view-settings') renderSettings();
  }

  // --- 录入 ---
  function clearAddPreview() {
    $('add-preview').style.display = 'none';
    $('add-manual').style.display = 'none';
    $('add-input').value = '';
  }

  function onQueryWord() {
    var word = $('add-input').value.trim().toLowerCase();
    if (!word) { alert('请输入单词'); return; }
    if (getWord(word)) { alert('该单词已在单词本中'); return; }
    $('btn-query').disabled = true;
    $('btn-query').textContent = '查询中...';

    var done = function () { $('btn-query').disabled = false; $('btn-query').textContent = '查询并加入'; };

    var local = lookupCET(word);
    if (local) { done(); showAddPreview(word, local.defs, local.source); return; }

    lookupOnline(word).then(function (online) {
      done();
      if (online) {
        showAddPreview(word, online.defs, online.source);
      } else {
        alert('四六级词库与在线词典均未收录该词，请手动录入释义');
        showAddManual(word);
      }
    });
  }

  function showAddPreview(word, defs, source) {
    var container = $('add-preview');
    container.style.display = 'block';
    $('add-manual').style.display = 'none';
    var html = '<p>单词：<strong>' + esc(word) + '</strong>　来源：<strong>' + esc(source) + '</strong></p>' +
      '<table><thead><tr><th>词性</th><th>释义</th></tr></thead><tbody>';
    defs.forEach(function (d) {
      html += '<tr><td>' + esc(d.pos) + '</td><td>' + esc(d.meaning) + '</td></tr>';
    });
    html += '</tbody></table>' +
      '<button type="button" id="btn-confirm-add">确认加入</button> ' +
      '<button type="button" id="btn-cancel-add">取消</button>';
    container.innerHTML = html;
    $('btn-confirm-add').onclick = function () {
      if (addWord(word, defs, source)) { alert('已加入单词本'); clearAddPreview(); }
    };
    $('btn-cancel-add').onclick = clearAddPreview;
  }

  function showAddManual(word) {
    $('add-preview').style.display = 'none';
    var container = $('add-manual');
    container.style.display = 'block';
    $('manual-word').value = word || '';
    for (var i = 1; i <= 3; i++) {
      $('manual-pos' + i).value = '';
      $('manual-mean' + i).value = '';
    }
  }

  function onManualAdd() {
    var word = $('manual-word').value.trim().toLowerCase();
    if (!word) { alert('请输入单词'); return; }
    if (getWord(word)) { alert('该单词已在单词本中'); return; }
    var defs = [];
    for (var i = 1; i <= 3; i++) {
      var pos = $('manual-pos' + i).value.trim();
      var mean = $('manual-mean' + i).value.trim();
      if (pos && mean) defs.push({ pos: pos, meaning: mean });
    }
    if (!defs.length) { alert('请至少填写一条词性和释义'); return; }
    if (addWord(word, defs, '手动录入')) { alert('已加入单词本'); clearAddPreview(); }
  }

  // --- 单词本 ---
  function renderBook() {
    var container = $('book-list');
    var search = ($('book-search').value || '').trim().toLowerCase();
    var groups = {};
    store.words.forEach(function (w) {
      if (search && w.word.indexOf(search) === -1) return;
      var g = w.date || '未知日期';
      if (!groups[g]) groups[g] = [];
      groups[g].push(w);
    });
    var dates = Object.keys(groups).sort().reverse();
    // 顶部统计：总词数；搜索时附匹配数
    var matched = 0;
    dates.forEach(function (d) { matched += groups[d].length; });
    var countHtml = '<p class="book-count">共 <strong>' + store.words.length + '</strong> 个单词' +
      (search ? '，匹配 <strong>' + matched + '</strong> 个' : '') + '</p>';
    if (!store.words.length) { container.innerHTML = '<p>单词本为空</p>'; return; }
    if (!dates.length) { container.innerHTML = countHtml + '<p>没有匹配的单词</p>'; return; }
    var html = countHtml;
    dates.forEach(function (d) {
      html += '<h3>' + esc(d) + '（' + groups[d].length + ' 词）</h3>';
      html += '<table><thead><tr><th>单词</th><th>来源</th><th>词性 + 释义</th><th>操作</th></tr></thead><tbody>';
      groups[d].forEach(function (w) {
        var defsHtml = w.defs.map(function (df) { return '<span class="pos">' + esc(df.pos) + '</span> ' + esc(df.meaning); }).join('<br>');
        html += '<tr>' +
          '<td class="nowrap"><strong>' + esc(w.word) + '</strong>' + (w.wrong ? '<span class="tag-wrong">[错题本]</span>' : '') + '</td>' +
          '<td><span class="chip">' + esc(w.source || '-') + '</span></td>' +
          '<td>' + defsHtml + '</td>' +
          '<td class="nowrap">' +
          '<button type="button" data-action="speak" data-word="' + esc(w.word) + '">发音</button> ' +
          (w.wrong
            ? '<button type="button" data-action="unwrong" data-word="' + esc(w.word) + '">移出错题</button>'
            : '<button type="button" data-action="wrong" data-word="' + esc(w.word) + '">加入错题</button>') +
          ' <button type="button" data-action="del" data-word="' + esc(w.word) + '">删除</button>' +
          '</td></tr>';
      });
      html += '</tbody></table>';
    });
    container.innerHTML = html;
    container.onclick = function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      var w = btn.dataset.word;
      if (btn.dataset.action === 'del' && confirm('确认删除 ' + w + ' ?')) { removeWord(w); renderBook(); }
      if (btn.dataset.action === 'wrong') { setWrong(w, true); renderBook(); }
      if (btn.dataset.action === 'unwrong') { setWrong(w, false); renderBook(); }
      if (btn.dataset.action === 'speak') { speak(w); }
    };
  }

  // --- 错题本 ---
  function renderWrong() {
    var container = $('wrong-list');
    var list = store.words.filter(function (w) { return w.wrong; });
    if (!list.length) { container.innerHTML = '<p>无错题</p>'; return; }
    var html = '<table><thead><tr><th>单词</th><th>词性 + 释义</th><th>累计答对</th><th>历史 错/对</th><th>操作</th></tr></thead><tbody>';
    list.forEach(function (w) {
      var defs = w.defs.map(function (d) { return esc(d.pos) + ' ' + esc(d.meaning); }).join('<br>');
      html += '<tr>' +
        '<td><strong>' + esc(w.word) + '</strong></td>' +
        '<td>' + defs + '</td>' +
        '<td>' + w.correctStreak + ' / ' + WRONG_REMOVE_THRESHOLD + '</td>' +
        '<td>' + w.wrongCount + ' / ' + w.rightCount + '</td>' +
        '<td><button type="button" data-word="' + esc(w.word) + '">移出错题本</button></td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    container.innerHTML = html;
    container.onclick = function (e) {
      var btn = e.target.closest('button');
      if (btn && btn.dataset.word) { setWrong(btn.dataset.word, false); renderWrong(); }
    };
  }

  // --- 设置 ---
  function renderSettings() {
    var s = store.settings;
    $('set-provider').value = s.provider;
    $('set-key').value = s.apiKey;
    $('set-model').value = s.model;
    $('set-baseurl').value = s.baseUrl;
    $('set-randomcount').value = s.randomCount;
    onProviderChange();
  }
  function onProviderChange() {
    var p = $('set-provider').value;
    $('group-baseurl').style.display = p === 'custom' ? 'block' : 'none';
    // 切换服务商时给出默认模型名
    if (p === 'deepseek' && !$('set-model').value) $('set-model').value = 'deepseek-chat';
    if (p === 'qwen' && !$('set-model').value) $('set-model').value = 'qwen-plus';
  }
  function saveSettings() {
    store.settings.provider = $('set-provider').value;
    store.settings.apiKey = $('set-key').value.trim();
    store.settings.model = $('set-model').value.trim();
    store.settings.baseUrl = $('set-baseurl').value.trim();
    var rc = parseInt($('set-randomcount').value, 10);
    store.settings.randomCount = (isNaN(rc) || rc < 1) ? 10 : rc;
    saveStore();
    alert('设置已保存');
  }
  function exportData() {
    var blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'wordbook_backup_' + today() + '.json';
    a.click();
    URL.revokeObjectURL(url);
  }
  function importData() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = function () {
      var file = input.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var data = JSON.parse(reader.result);
          if (!Array.isArray(data.words)) throw new Error('备份格式不正确');
          if (!confirm('导入将覆盖当前 ' + store.words.length + ' 条记录，确认？')) return;
          store.words = data.words;
          if (data.settings) store.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);
          saveStore();
          alert('导入成功');
        } catch (e) {
          alert('导入失败：' + e.message);
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }

  /* ===== 事件绑定与启动 ===== */
  function init() {
    loadStore();

    // 导航
    var navBtns = document.querySelectorAll('nav button');
    for (var i = 0; i < navBtns.length; i++) {
      (function (btn) {
        btn.onclick = function () { showView(btn.dataset.view); };
      })(navBtns[i]);
    }

    // 录入
    $('btn-query').onclick = onQueryWord;
    $('add-input').addEventListener('keypress', function (e) { if (e.key === 'Enter') onQueryWord(); });
    $('btn-manual-add').onclick = onManualAdd;

    // 单词本搜索
    $('book-search').addEventListener('input', renderBook);

    // 默写
    $('btn-start-quiz').onclick = startQuiz;
    $('quiz-submit').onclick = onQuizSubmit;
    // 回车：未提交=提交答案；已出结果=进入下一题
    $('quiz-input').addEventListener('keypress', function (e) {
      if (e.key !== 'Enter') return;
      if ($('quiz-result').style.display === 'block') onQuizNext();
      else onQuizSubmit();
    });
    $('quiz-next').onclick = onQuizNext;
    $('quiz-exit').onclick = exitQuiz;
    $('btn-quiz-wrong').onclick = function () {
      showView('view-quiz');
      $('quiz-scope').value = 'wrongbook';
      startQuiz();
    };

    // 设置
    $('btn-save-settings').onclick = saveSettings;
    $('btn-export').onclick = exportData;
    $('btn-import').onclick = importData;
    $('set-provider').onchange = onProviderChange;

    // 默认视图
    showView('view-add');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
