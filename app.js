/* IT 자산관리시스템 v1.9.11 - 관리자 웹 (정적 페이지, Supabase 연동) */
(function () {
  'use strict';
  var $app = document.getElementById('app');
  var cfg = window.ITAM_CONFIG || {};
  var params = new URLSearchParams(location.search);
  var DEMO = params.has('demo') || !cfg.SUPABASE_URL || /YOUR-PROJECT/.test(cfg.SUPABASE_URL);
  var sb = null;
  if (!DEMO) sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  var PC_CATS = ['PC', '노트북', 'PC 본체'];
  var S = { assets: [], employees: [], devices: [], history: [], support: [], supportErr: false, imports: [], impErr: false, user: null };
  var CO = ['A+에셋', '파인랩', '원수사'];   // v1.9.6: 자산의 회사 (대시보드·회사별 자산)
  var F = { q: '', dept: '', cat: '', catg: '', status: '', company: '', collect: '', page: 1, sel: {} };
  var HOLD_KEY = 'itam_hold_v1';
  // v1.9.4: 조회 전용 계정은 쓰기를 화면에서도 막음 (서버 RLS가 최종으로 막음)
  if (sb) {
    var _from = sb.from.bind(sb);
    sb.from = function (t) {
      var q = _from(t);
      ['insert', 'update', 'upsert', 'delete'].forEach(function (m) {
        var o = q[m];
        q[m] = function () {
          if (t !== 'audit_log') needWrite();   // 이력 기록(내보내기·로그아웃)은 조회 전용 계정도 가능
          var b = o.apply(q, arguments), args = arguments;
          if (t === 'audit_log' || !AUDL[t]) return b;
          var th = b.then.bind(b);   // 저장에 성공하면 이력 관리에 자동 기록 (작업자·IP는 서버가 채움)
          b.then = function (res, rej) { return th(function (r) { try { if (r && !r.error) auditWrite(t, m, args, b); } catch (e) { } return res ? res(r) : r; }, rej); };
          return b;
        };
      });
      return q;
    };
  }

  // ---------- 유틸 ----------
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function ymd(d) { var x = new Date(d); if (isNaN(x)) return ''; return x.getFullYear() + '-' + ('0' + (x.getMonth() + 1)).slice(-2) + '-' + ('0' + x.getDate()).slice(-2); }
  function hm(d) { var x = new Date(d); return ('0' + x.getHours()).slice(-2) + ':' + ('0' + x.getMinutes()).slice(-2); }
  function dayDiff(d) {
    if (!d) return null;
    var a = new Date(d), b = new Date();
    a.setHours(0, 0, 0, 0); b.setHours(0, 0, 0, 0);
    return Math.round((b - a) / 86400000);
  }
  function seen(d) {
    var n = dayDiff(d);
    if (n == null) return { cls: '', txt: '—', lvl: 'none' };
    if (n <= 0) return { cls: '#1e8e3e', txt: '오늘 ' + hm(d), lvl: 'today' };
    if (n < 3) return { cls: '#1e8e3e', txt: n + '일 전', lvl: 'ok' };
    if (n < 7) return { cls: '#faad14', txt: n + '일 전', lvl: 'warn' };
    return { cls: '#c42b1c', txt: n + '일 전', lvl: 'stale' };
  }
  function seenHtml(d) { var s = seen(d); return s.cls ? '<span class="dot" style="background:' + s.cls + '"></span>' + esc(s.txt) : '—'; }
  function badge(t, c) { return '<span class="badge b-' + c + '">' + esc(t) + '</span>'; }
  function warrantyBadge(d, calc) {
    if (!d) return '—';
    var n = -dayDiff(d), t = esc(ymd(d)), c = calc ? ' <span class="note" title="제조년월 + 5년으로 계산">계산</span>' : '';
    if (n < 0) return '<span style="color:#c42b1c;font-weight:600">' + t + ' · 만료</span>' + c;
    if (n <= 90) return '<span style="color:#d46b08;font-weight:600">' + t + ' · 3개월 이내</span>' + c;
    return '<span style="color:#1e8e3e">' + t + '</span>' + c;
  }
  function warrOf(a) {   // 대장에 보증만료일이 있으면 그 값, 없으면 제조년월 + 5년(제조월 말일)
    if (a.warranty_end) return { d: a.warranty_end, calc: false };
    var m = /(\d{4})\D+(\d{1,2})/.exec(String(a.mfg_ym || ''));
    if (!m) return { d: null, calc: false };
    var y = +m[1] + 5, mo = +m[2]; if (mo < 1 || mo > 12) return { d: null, calc: false };
    var e = new Date(y, mo, 0);
    return { d: e.getFullYear() + '-' + ('0' + (e.getMonth() + 1)).slice(-2) + '-' + ('0' + e.getDate()).slice(-2), calc: true };
  }
  function cpuShort(c) {
    if (!c) return '';
    var m = /(i[3579]-\w+|Ryzen\s?\d\s?\w+|Core\s?Ultra\s?\w+|Xeon[^@]*|N\d{3,4}|Celeron[^@]*)/i.exec(c);
    return m ? m[1].trim() : c.replace(/\(R\)|\(TM\)|CPU|@.*$/g, '').trim().slice(0, 22);
  }
  function specStr(a) {
    if (!a.cpu && !a.ram_gb && !a.storage) return '—';
    return [cpuShort(a.cpu), a.ram_gb ? a.ram_gb + 'GB' : '', a.storage || ''].filter(Boolean).join(' / ');
  }
  function osShort(o) {
    if (!o) return '확인 안 됨';
    var m = /Windows\s*(\d+)/i.exec(o);
    return m ? 'Windows ' + m[1] : o.slice(0, 24);
  }
  function isPc(a) { return PC_CATS.indexOf(a.category) >= 0; }
  function groupCount(arr, fn) {
    var m = {}; arr.forEach(function (x) { var k = fn(x) || '(없음)'; m[k] = (m[k] || 0) + 1; });
    return Object.keys(m).map(function (k) { return [k, m[k]]; }).sort(function (a, b) { return b[1] - a[1]; });
  }
  function bars(list, color, kind) {
    var max = list.length ? list[0][1] : 1;
    return list.map(function (r) { return '<div class="bar' + (kind ? ' go" data-go="' + kind + ':' + esc(r[0]) + '"' : '"') + '><div class="l" title="' + esc(r[0]) + '">' + esc(r[0]) + '</div><div class="b"><i style="width:' + Math.max(2, r[1] / max * 100) + '%;' + (color ? 'background:' + color : '') + '"></i></div><div class="v">' + r[1].toLocaleString() + '</div></div>'; }).join('') || '<div class="note">데이터가 없습니다.</div>';
  }
  function getHold() { try { return JSON.parse(localStorage.getItem(HOLD_KEY) || '{}'); } catch (e) { return {}; } }
  function setHold(h) { try { localStorage.setItem(HOLD_KEY, JSON.stringify(h)); } catch (e) { } }
  function toast(msg) {
    var t = document.createElement('div');
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1a1a1a;color:#fff;padding:10px 18px;border-radius:8px;font-size:12.5px;z-index:99';
    t.textContent = msg; document.body.appendChild(t); setTimeout(function () { t.remove(); }, 2600);
  }
  function fail(e) { console.error(e); toast('오류: ' + (e && e.message ? e.message : e)); }

  // ---------- 데이터 계층 (Supabase / 데모) ----------
  function demoData() {
    var depts = [['IT지원팀', '경영지원본부'], ['영업1팀', '영업본부'], ['영업2팀', '영업본부'], ['재무팀', '경영지원본부'], ['인사팀', '경영지원본부'], ['개발팀', '기술본부']];
    var names = ['홍길동', '김민수', '이서연', '박지훈', '최유진', '정다은', '강현우', '오민재', '윤서아', '한지우', '송태윤', '임하준', '서지안', '문도윤', '배수아', '신유찬'];
    var emps = names.map(function (n, i) { return { emp_no: 'A' + (20230 + i), name: n, dept: depts[i % 6][0], team: depts[i % 6][1], title: ['사원', '대리', '과장', '파트장'][i % 4], active: true }; });
    var assets = [], devices = [], hist = [], now = Date.now();
    var models = [['PC', '삼성', 'DM500TFA'], ['PC', 'HP', 'ProDesk 400'], ['노트북', 'LG', '15U70P'], ['노트북', 'Lenovo', 'T14'], ['모니터', '삼성', 'S24R350'], ['모니터', 'LG', '27UL500']];
    for (var i = 0; i < 70; i++) {
      var m = models[i % 6], e = emps[i % emps.length], cat = m[0];
      var buy = new Date(now - (200 + (i * 53) % 2200) * 86400000);
      var a = { asset_no: 'A-' + (cat === 'PC' ? 'PC' : cat === '노트북' ? 'NB' : 'MN') + '-' + ('000000' + (100 + i)).slice(-6), category: cat, manufacturer: m[1], model: m[2], mfg_ym: ymd(buy).slice(0, 7), status: i % 17 === 16 ? '재고' : '사용중', user_name: i % 17 === 16 ? '(재고)' : e.name, user_id: e.emp_no, dept: e.dept, company: ({ 'IT지원팀': '파인랩', '영업1팀': 'A+에셋', '영업2팀': 'A+에셋', '재무팀': '원수사', '인사팀': '원수사', '개발팀': '파인랩' })[e.dept] || null, title: e.title, location: ['본사 3F', '본사 4F', '본사 5F'][i % 3], purchase_date: ymd(buy), warranty_end: ymd(new Date(buy.getTime() + 1095 * 86400000)), memo: '' };
      assets.push(a);
      if (PC_CATS.indexOf(cat) >= 0 && i % 17 !== 16 && i % 5 !== 4) {
        var age = i % 9 === 0 ? 9 : i % 11 === 0 ? 4 : 0;
        var who = i % 13 === 0 ? emps[(i + 3) % emps.length] : e;
        devices.push({ id: 'd' + i, mac: 'A4-BB-6D-' + ('0' + (i * 7 % 256).toString(16)).slice(-2).toUpperCase() + '-3F-90', computer_name: 'ENTIA_' + ('00' + i).slice(-3), ip: '192.168.0.' + (20 + i), os: i % 4 === 0 ? 'Windows 10 Pro' : 'Windows 11 Pro', cpu: ['Intel(R) Core(TM) i7-10700F CPU @ 2.90GHz', 'Intel(R) Core(TM) i5-12400 CPU', 'Intel(R) Core(TM) i3-8100 CPU @ 3.60GHz'][i % 3], ram_gb: [8, 16, 32][i % 3], storage: ['SSD 512 GB', 'SSD 256 GB', 'HDD 500 GB'][i % 3], gpu: '내장 그래픽', agent_version: '1.2.0.0', emp_no: who.emp_no, asset_no: a.asset_no, link_source: 'auto', first_seen: new Date(now - 90 * 86400000).toISOString(), last_seen: new Date(now - age * 86400000 - (i % 5) * 3600000).toISOString() });
      }
    }
    devices.push({ id: 'dX2', mac: 'D8-BB-C1-45-2E-99', computer_name: 'ENTIA_APLUS', ip: '192.168.1.13', os: 'Windows 11 Pro', cpu: 'Intel(R) Core(TM) i5-13400', ram_gb: 16, storage: 'SSD 512 GB', gpu: '내장 그래픽', agent_version: '1.9.5.0', emp_no: '99999012', asset_no: null, link_source: null, first_seen: new Date().toISOString(), last_seen: new Date().toISOString() });
    devices.push({ id: 'dX1', mac: 'D8-BB-C1-45-2E-18', computer_name: 'ENTIA_NEW01', ip: '192.168.0.201', os: 'Windows 11 Pro', cpu: 'Intel(R) Core(TM) i5-13400', ram_gb: 16, storage: 'SSD 512 GB', gpu: '내장 그래픽', agent_version: '1.2.0.0', emp_no: 'A20231', asset_no: null, link_source: null, first_seen: new Date().toISOString(), last_seen: new Date().toISOString() });
    hist.push({ id: 1, asset_no: 'A-NB-000102', kind: 'spec', detail: 'RAM(GB): 8 → 16', created_at: new Date(now - 86400000).toISOString() });
    hist.push({ id: 2, asset_no: 'A-PC-000100', kind: 'ip', detail: 'IP: 192.168.0.19 → 192.168.0.20', created_at: new Date(now - 2 * 86400000).toISOString() });
    hist.push({ id: 3, asset_no: 'A-PC-000106', kind: 'link', detail: '자동 연결 (사번 A20236)', created_at: new Date(now - 3 * 86400000).toISOString() });
    var sup = [
      { id: 's4', req_no: 'R-20261117-004', emp_no: emps[0].emp_no, computer_name: 'ENTIA_APLUS', ip: '192.168.0.23', asset_no: assets[0].asset_no, symptom: '프린터가 인쇄되지 않아요', status: 'received', handler: null, note: null, created_at: new Date(now - 600000).toISOString() },
      { id: 's3', req_no: 'R-20261117-003', emp_no: emps[1].emp_no, computer_name: 'SALES-NB-014', ip: '192.168.1.57', asset_no: null, symptom: '엑셀이 느려요', status: 'working', handler: '데모 관리자', note: null, created_at: new Date(now - 5400000).toISOString() },
      { id: 's2', req_no: 'R-20261117-002', emp_no: emps[2].emp_no, computer_name: 'FIN-PC-007', ip: '192.168.2.31', asset_no: null, symptom: 'VPN 연결 실패', status: 'done', handler: '데모 관리자', note: 'VPN 클라이언트 재설치', created_at: new Date(now - 21600000).toISOString() }
    ];
    var mAs = assets.filter(function (a) { return a.category === '모니터'; }), d0 = devices[0], monitors = [];
    mAs.forEach(function (a, k) { a.serial_no = 'ZZN5H4' + ('0000' + (k * 37 + 11)).slice(-4); });
    if (d0 && mAs[0]) { mAs[0].linked_pc = d0.asset_no; monitors.push({ id: 'm1', device_id: d0.id, maker: '삼성', model: mAs[0].model, serial: mAs[0].serial_no, made_ym: '2021-08', resolution: '1920×1080', size_inch: '24', asset_no: mAs[0].asset_no, link_source: 'auto', gone: false, last_seen: new Date().toISOString() }, { id: 'm2', device_id: d0.id, maker: 'LG', model: '24MK430H', serial: '003NTAB7001', made_ym: '2020-03', resolution: '1920×1080', size_inch: '24', asset_no: null, link_source: null, gone: false, last_seen: new Date().toISOString() }); }
    return { assets: assets, employees: emps, devices: devices, history: hist, support: sup, monitors: monitors };
  }
  async function fetchAll(table, order) {
    var out = [], from = 0, step = 1000;
    for (;;) {
      var r = await sb.from(table).select('*').order(order).range(from, from + step - 1);
      if (r.error) throw r.error;
      out = out.concat(r.data);
      if (r.data.length < step) break;
      from += step;
    }
    return out;
  }
  function demoDates() {
    var n = new Date(), y = n.getFullYear(), m = n.getMonth();
    S.employees.forEach(function (e, i) { if (e.joined_at === undefined) { e.joined_at = i < 4 ? dstr(new Date(y, m, 1 + i)) : (i < 8 ? dstr(new Date(y, m - 1, 5 + i)) : null); e.left_at = null; e.joined_est = i < 2; e.left_est = false; } });
    var q = S.employees[S.employees.length - 1]; if (q && !q.__d) { q.__d = 1; q.active = false; q.left_at = dstr(new Date(y, m, 2)); q.left_est = true; }
  }
  async function loadAll() {
    if (DEMO) { var d = demoData(); S.assets = d.assets.map(function (a) { return a; }); S.employees = d.employees; S.devices = d.devices; S.history = d.history; S.support = d.support; S.monitors = d.monitors; S.imports = S.imports || []; S.dates = true; S.est = true; demoDates(); rebuildAssets(); return; }
    var res = await Promise.all([fetchAll('assets', 'asset_no'), fetchAll('employees', 'emp_no'), fetchAll('devices', 'mac'),
      sb.from('asset_history').select('*').order('created_at', { ascending: false }).limit(50)]);
    S.assets = res[0]; S.employees = res[1]; S.devices = res[2]; S.history = res[3].data || [];
    var dr = await sb.from('employees').select('joined_at,left_at').limit(1); S.dates = !dr.error;
    var er = await sb.from('employees').select('joined_est,left_est').limit(1); S.est = !er.error;
    var ir = await sb.from('employee_imports').select('*').order('applied_at', { ascending: false }).limit(50);
    S.impErr = !!ir.error; S.imports = ir.error ? [] : ir.data;   // v1.6 DB 업데이트 전에도 나머지 화면은 동작
    var sr = await sb.from('support_requests').select('*').order('created_at', { ascending: false }).limit(300);
    S.supportErr = !!sr.error; S.support = sr.error ? [] : sr.data;   // v1.0 DB(표 없음)에서도 나머지 화면은 동작
    var mr = await sb.from('device_monitors').select('*').eq('gone', false).limit(5000);
    S.monErr = !!mr.error; S.monitors = mr.error ? [] : mr.data;   // v1.9.4 SQL 실행 전에도 나머지 화면은 동작
    rebuildAssets(); snapDaily();
  }
  // 자산 + 연결된 PC + 사용자 불일치를 클라이언트에서 계산 (v_assets 와 같은 규칙)
  function rebuildAssets() {
    var empBy = {}; S.employees.forEach(function (e) { empBy[e.emp_no] = e; });
    var devBy = {}; S.devices.forEach(function (d) { if (d.asset_no) devBy[d.asset_no] = d; });
    S.empBy = empBy;
    S.assets.forEach(function (a) {
      var d = devBy[a.asset_no], e = d && d.emp_no ? empBy[d.emp_no] : null;
      a._dev = d || null; a._emp = e || null; var w = warrOf(a); a.warr_end = w.d; a.warr_calc = w.calc;
      a.pc_name = d ? d.computer_name : null; a.ip = d ? d.ip : null; a.cpu = d ? d.cpu : null; a.ram_gb = d ? d.ram_gb : null;
      a.storage = d ? d.storage : null; a.os = d ? d.os : null; a.gpu = d ? d.gpu : null; a.mac = d ? d.mac : null; a.last_seen = d ? d.last_seen : null;
      a.user_mismatch = !!(a.user_name && e && a.user_name !== e.name && a.user_name.charAt(0) !== '(');
    });
  }
  async function dbUpdateAsset(no, patch, reason, quiet) {
    needWrite();
    var a0 = S.assets.filter(function (x) { return x.asset_no === no; })[0], ch = diffs(a0, patch);
    if (quiet || !ch.length) { if (!DEMO) AC = { skip: 1, table: 'assets', t: Date.now() }; }
    else audCtx({ table: 'assets', target: '자산 ' + no, summary: '자산 ' + no + ' 수정 (' + ch.length + '개 항목): ' + chgText(ch), detail: { via: '자산 화면 · 직접 수정', changes: ch }, reason: reason || null });
    patch.updated_at = new Date().toISOString();
    if (!DEMO) { var r = await sb.from('assets').update(patch).eq('asset_no', no); if (r.error) throw r.error; }
    var a = S.assets.filter(function (x) { return x.asset_no === no; })[0]; if (a) Object.assign(a, patch);
    rebuildAssets();
  }
  async function dbHistory(no, kind, detail, deviceId) {
    needWrite();
    var row = { asset_no: no, device_id: deviceId || null, kind: kind, detail: detail };
    if (!DEMO) { var r = await sb.from('asset_history').insert(row); if (r.error) throw r.error; }
    S.history.unshift(Object.assign({ id: Date.now(), created_at: new Date().toISOString() }, row));
  }
  async function dbLink(deviceId, assetNo) {
    var patch = { asset_no: assetNo, link_source: assetNo ? 'manual' : null };
    var dv0 = S.devices.filter(function (x) { return x.id === deviceId; })[0];
    audCtx({ table: 'devices', action: 'change', target: assetNo ? '자산 ' + assetNo : '수집 PC ' + (dv0 && dv0.computer_name || ''), summary: 'PC ' + (dv0 && dv0.computer_name || '') + ' ' + (assetNo ? '자산 ' + assetNo + ' 연결 (수동)' : '자산 연결 해제'), detail: { changes: [{ k: '연결 자산', from: (dv0 && dv0.asset_no) || '없음', to: assetNo || '없음' }] } });
    if (!DEMO) { var r = await sb.from('devices').update(patch).eq('id', deviceId); if (r.error) throw r.error; }
    var d = S.devices.filter(function (x) { return x.id === deviceId; })[0]; if (d) Object.assign(d, patch);
    rebuildAssets();
  }
  async function dbUpsert(table, rows, conflict) {
    needWrite();
    auditPost({ action: 'import', target: table === 'assets' ? '자산 대장' : '인사 명단', summary: (table === 'assets' ? '자산 대장 업로드' : '인사 명단 반영') + ' · ' + rows.length.toLocaleString() + '건', detail: { via: '엑셀 업로드·인사 명단 적용', note: '대상 ' + rows.length + '건 (새 항목 + 변경 항목)' } });
    for (var i = 0; i < rows.length; i += 500) {
      var chunk = rows.slice(i, i + 500);
      if (!DEMO) AC = { skip: 1, table: table, t: Date.now() };
      if (!DEMO) { var r = await sb.from(table).upsert(chunk, { onConflict: conflict }); if (r.error) throw r.error; }
    }
    if (DEMO) {
      var list = table === 'assets' ? S.assets : S.employees;
      rows.forEach(function (row) {
        var f = list.filter(function (x) { return x[conflict] === row[conflict]; })[0];
        if (f) Object.assign(f, row); else list.push(row);
      });
    }
  }

  // ---------- v1.9.4: 표 정렬 (제목 칸 클릭: ▲ 오름 → ▼ 내림 → 해제) ----------
  var SORT = {};
  function cmpV(a, b, t) {
    if (t === 'n') return (parseFloat(a) || 0) - (parseFloat(b) || 0);
    if (t === 'ip') { var pa = String(a).split('.'), pb = String(b).split('.'); for (var i = 0; i < 4; i++) { var d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0); if (d) return d; } return 0; }
    if (t === 'd') { var x = String(a), y = String(b); return x < y ? -1 : x > y ? 1 : 0; }
    return String(a).localeCompare(String(b), 'ko', { numeric: true, sensitivity: 'base' });
  }
  // v1.9.7: 엑셀식 열 필터 (머리글 ▾ → 오름·내림 정렬 + 값 체크 목록). cols: { 키: { f: 값 꺼내는 함수, t: 's'|'d'|'ip'|'n', l: 이름 } }
  // 비어 있는 값은 오름·내림 모두 맨 아래, 같은 값은 처음 순서 유지
  var FLT = {}, FALL = {}, FREDO = {}, EMPTYV = '(빈 값)';
  function fval(c, row) {
    var v = c.f(row); if (v == null || v === '') return EMPTYV;
    v = String(v); return c.t === 'd' ? v.slice(0, 10) : v;
  }
  function fltPass(row, cols, fl, skipK) {
    for (var k in fl) { if (k === skipK || !cols[k]) continue; if (fl[k].indexOf(fval(cols[k], row)) < 0) return false; }
    return true;
  }
  function sortRows(arr, key, cols) {
    FALL[key] = { arr: arr, cols: cols };
    var fl = FLT[key];
    if (fl && Object.keys(fl).length) arr = arr.filter(function (r) { return fltPass(r, cols, fl); });
    var s0 = SORT[key]; if (!s0 || !cols[s0.k]) return arr;
    var c = cols[s0.k], dir = s0.d === 'desc' ? -1 : 1;
    return arr.map(function (x, i) { return [x, i]; }).sort(function (p, q) {
      var a = c.f(p[0]), b = c.f(q[0]), ea = a == null || a === '', eb = b == null || b === '';
      if (ea && eb) return p[1] - q[1]; if (ea) return 1; if (eb) return -1;
      return cmpV(a, b, c.t) * dir || p[1] - q[1];
    }).map(function (x) { return x[0]; });
  }
  function thS(key, k, label, cls) {
    var s0 = SORT[key], on = s0 && s0.k === k, fo = FLT[key] && FLT[key][k], ar = fo ? '⛉' : on ? (s0.d === 'desc' ? '▼' : '▲') : '▾';
    return '<th class="srt' + (on || fo ? ' on' : '') + (cls ? ' ' + cls : '') + '" data-srt="' + key + '|' + k + '" title="누르면 정렬·필터">' + label + ' <i>' + ar + '</i></th>';
  }
  function sortBar(key, cols, total) {
    var s0 = SORT[key], fl = FLT[key] || {}, fk = Object.keys(fl).filter(function (k) { return cols[k]; }), h = '';
    if (!(s0 && cols[s0.k]) && !fk.length) return '';
    if (s0 && cols[s0.k]) h += '<span class="fchip on">정렬: ' + esc(cols[s0.k].l) + ' ' + (s0.d === 'desc' ? '▼ 내림차순' : '▲ 오름차순') + '</span><a href="#" data-sclr="' + key + '">정렬 해제</a>';
    fk.forEach(function (k) { var v = fl[k]; h += '<span class="fchip on">' + esc(cols[k].l) + ': ' + esc(v.length ? v[0] + (v.length > 1 ? ' 외 ' + (v.length - 1) : '') : '(없음)') + '<button type="button" data-fx="' + key + '|' + k + '" title="해제">✕</button></span>'; });
    if (fk.length) h += '<a href="#" data-fclr="' + key + '">필터 모두 해제</a>';
    return '<div class="sortbar"><span class="note">적용된 조건</span>' + h + '</div>';
  }
  function closeFlt() { var p = document.getElementById('fltpop'); if (p) p.parentNode.removeChild(p); document.removeEventListener('mousedown', fltOut, true); }
  function fltOut(e) { var p = document.getElementById('fltpop'); if (p && !p.contains(e.target)) closeFlt(); }
  function openFlt(th, key, k) {
    closeFlt();
    var A = FALL[key]; if (!A || !A.cols[k]) return;
    var c = A.cols[k], fl = FLT[key] || {}, rows = A.arr.filter(function (r) { return fltPass(r, A.cols, fl, k); }), cnt = {}, order = [];
    rows.forEach(function (r) { var v = fval(c, r); if (cnt[v] == null) { cnt[v] = 0; order.push(v); } cnt[v]++; });
    order.sort(function (x, y) { if (x === EMPTYV) return 1; if (y === EMPTYV) return -1; return cmpV(x, y, c.t); });
    var cur = fl[k], more = order.length > 800, shown = order.slice(0, 800);
    var p = document.createElement('div'); p.id = 'fltpop'; p.className = 'fltpop';
    p.innerHTML = '<a class="fi" data-a="asc">⇅ 오름차순 정렬</a><a class="fi" data-a="desc">⇅ 내림차순 정렬</a>' + (cur ? '<a class="fi fon" data-a="clr">⛉ ‘' + esc(c.l) + '’ 필터 해제</a>' : '<a class="fi dis">⛉ ‘' + esc(c.l) + '’ 필터 해제</a>') +
      '<div class="fq"><input type="text" id="fq" placeholder="검색" autocomplete="off"></div><div class="fl"><label class="fall"><input type="checkbox" id="fall"> <b>(모두 선택)</b></label>' +
      shown.map(function (v, i) { return '<label class="fr" data-v="' + i + '"><input type="checkbox" class="fck" data-i="' + i + '"' + (!cur || cur.indexOf(v) >= 0 ? ' checked' : '') + '> <span>' + esc(v) + '</span><em>' + cnt[v].toLocaleString() + '</em></label>'; }).join('') + '</div>' +
      (more ? '<div class="note" style="padding:2px 10px">값이 많아 앞 800개만 표시됩니다. 검색으로 좁혀 주세요.</div>' : '') + '<div class="fb"><button class="btn sm pri" id="fok" type="button">확인</button><button class="btn sm" id="fno" type="button">취소</button></div>';
    document.body.appendChild(p);
    var r = th.getBoundingClientRect(), x = Math.min(r.left + window.pageXOffset, window.pageXOffset + document.documentElement.clientWidth - 280), y = r.bottom + window.pageYOffset + 2;
    p.style.left = Math.max(4, x) + 'px'; p.style.top = y + 'px';
    var cks = [].slice.call(p.querySelectorAll('.fck')), all = p.querySelector('#fall');
    function vis(l) { return l.style.display !== 'none'; }
    function syncAll() { var v = cks.filter(function (q) { return vis(q.parentNode); }); all.checked = v.length > 0 && v.every(function (q) { return q.checked; }); }
    syncAll();
    all.onchange = function () { cks.forEach(function (q) { if (vis(q.parentNode)) q.checked = all.checked; }); };
    cks.forEach(function (q) { q.onchange = syncAll; });
    var fq = p.querySelector('#fq');
    fq.oninput = function () { var t = fq.value.trim().toLowerCase(); cks.forEach(function (q) { q.parentNode.style.display = !t || shown[+q.dataset.i].toLowerCase().indexOf(t) >= 0 ? '' : 'none'; }); syncAll(); };
    p.querySelectorAll('.fi[data-a]').forEach(function (a) {
      a.onclick = function () {
        var d = a.dataset.a; closeFlt();
        if (d === 'clr') { delete FLT[key][k]; } else { SORT[key] = { k: k, d: d }; }
        if (FREDO[key]) FREDO[key]();
      };
    });
    p.querySelector('#fno').onclick = closeFlt;
    p.querySelector('#fok').onclick = function () {
      var sel = [], vs = {}; cks.forEach(function (q) { if (q.checked) sel.push(shown[+q.dataset.i]); });
      if (more) { shown.forEach(function () { }); sel = sel.concat(order.slice(800).filter(function () { return !fq.value.trim(); })); }
      FLT[key] = FLT[key] || {};
      if (sel.length >= order.length) delete FLT[key][k]; else FLT[key][k] = sel;
      closeFlt(); if (FREDO[key]) FREDO[key]();
    };
    setTimeout(function () { document.addEventListener('mousedown', fltOut, true); fq.focus(); }, 0);
  }
  function bindSort(key, redo) {
    FREDO[key] = redo;
    $$('th[data-srt^="' + key + '|"]').forEach(function (t) { t.onclick = function (e) { e.stopPropagation(); openFlt(t, key, t.dataset.srt.split('|')[1]); }; });
    $$('[data-sclr="' + key + '"]').forEach(function (a) { a.onclick = function (e) { e.preventDefault(); delete SORT[key]; redo(); }; });
    $$('[data-fclr="' + key + '"]').forEach(function (a) { a.onclick = function (e) { e.preventDefault(); delete FLT[key]; redo(); }; });
    $$('[data-fx^="' + key + '|"]').forEach(function (b) { b.onclick = function () { var k = b.dataset.fx.split('|')[1]; if (FLT[key]) delete FLT[key][k]; redo(); }; });
  }

  // ---------- v1.9.4: 로그인 계정(사번)·권한 ----------
  function isViewer() { return !!(S.me && S.me.role === 'viewer'); }
  function isMain() { return !!(S.me && S.me.role === 'main'); }
  function needWrite() { if (isViewer()) throw new Error('조회 전용 계정은 수정·업로드·처리를 할 수 없습니다.'); }
  async function fnCall(name, body, token) {
    var res;
    try {
      res = await fetch(cfg.SUPABASE_URL + '/functions/v1/' + name, { method: 'POST', headers: { 'content-type': 'application/json', apikey: cfg.SUPABASE_ANON_KEY, authorization: 'Bearer ' + (token || cfg.SUPABASE_ANON_KEY) }, body: JSON.stringify(body || {}) });
    } catch (e) { throw new Error('서버에 연결하지 못했습니다. 인터넷 연결을 확인하세요.'); }
    var j = {}; try { j = await res.json(); } catch (e) { }
    if (!res.ok) { var er = new Error(j.error || (res.status === 404 ? '서버 함수(' + name + ')가 아직 배포되지 않았습니다. 설치가이드를 확인하세요.' : '요청에 실패했습니다. (' + res.status + ')')); er.status = res.status; throw er; }
    return j;
  }
  async function myToken() { var s0 = await sb.auth.getSession(); return s0.data.session ? s0.data.session.access_token : ''; }
  function genPw() {
    var A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789', b = new Uint32Array(12), o = '';
    (window.crypto || window.msCrypto).getRandomValues(b);
    for (var i = 0; i < 12; i++) { o += A[b[i] % A.length]; if (i === 3 || i === 7) o += '-'; }
    return o;
  }

  // ---------- 화면 틀 ----------
  // v1.9.4: 로그인 계정 표시 = 권한 · 부서명 · 성명 · 직책 (부서·성명·직책은 인사 명단에서 자동 반영)
  function whoParts() {
    var m = S.me || {}, e = m.sabun && S.empBy && S.empBy[m.sabun];
    return { dept: e ? e.dept : m.dept, name: e ? e.name : m.name, title: e ? e.title : m.title };
  }
  function adminLabel() { var w = whoParts(); if (w.name) return [w.dept, w.name, w.title].filter(Boolean).join(' '); return S.user ? S.user.email : '데모 관리자'; }
  function whoHtml() {
    var w = whoParts(), role = isViewer() ? '조회' : '관리자';
    return '<span class="rchip ' + (isViewer() ? 'v' : 'a') + '">' + role + '</span><span>' + esc(adminLabel()) + '</span>';
  }
  function coSel(id, val) { return '<div class="kv"><div class="k">회사</div><div class="v"><select id="' + id + '" style="width:100%"><option value="">미지정</option>' + CO.map(function (c) { return '<option' + (c === val ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select></div></div>'; }
  // v1.9.6: 자산 유형 묶음 (대시보드 고정 순서: 모니터 → PC → 노트북 → 스캐너 → 기타)
  var CATG = ['모니터', 'PC', '노트북', '스캐너', '기타'], CATG_COL = { '모니터': '#2f7df6', 'PC': '#1e8e3e', '노트북': '#c42b1c', '스캐너': '#e9a100', '기타': '#b0b7c3' };
  function catGrp(c) { c = String(c || ''); return c === '모니터' ? '모니터' : (c === 'PC' || c === 'PC 본체') ? 'PC' : c === '노트북' ? '노트북' : /스캐너/.test(c) ? '스캐너' : '기타'; }
  var ROUTES = [['dashboard', '대시보드'], ['assets', '자산 관리'], ['check', '현황 점검'], ['support', '원격 지원'], ['employees', '인사 정보'], ['data', '데이터 관리'], ['inventory', '실사 (재물조사)']];
  function navRoutes() { return isMain() ? ROUTES.concat([['audit', '이력 관리'], ['admins', '관리자'], ['reports', '보고서'], ['security', '보안 설정']]) : ROUTES; }   // v1.9.5: 이력 관리·관리자·보고서는 메인 관리자 전용 / v1.9.11: 보안 설정도 메인 관리자 전용
  function denyPage() { shell('dashboard', '<div class="card" style="text-align:center;padding:30px 20px;max-width:560px;margin:30px auto"><div style="font-size:30px">🔒</div><h2 style="margin:6px 0">접근 권한이 없습니다</h2><div class="note" style="line-height:1.8">이 메뉴(이력 관리 · 관리자 · 보고서)는 <b>메인 관리자</b>만 열 수 있습니다.<br>주소를 직접 입력해 들어와도 이 화면이 표시됩니다.</div><div style="margin-top:14px"><a class="btn pri" href="#/dashboard">대시보드로 이동</a></div></div>'); }
  function shell(active, html) {
    var nav = navRoutes().map(function (r) { var n = r[0] === 'support' ? S.support.filter(function (x) { return x.status === 'received'; }).length : 0; return '<a href="#/' + r[0] + '" class="' + (r[0] === active ? 'on' : '') + '">' + r[1] + (n ? '<span class="cnt">' + n + '</span>' : '') + '</a>'; }).join('');
    var soon = ['소프트웨어·라이선스', '수명주기·보증', '신청·승인'].map(function (t) { return '<div class="soon">' + t + '<i>예정</i></div>'; }).join('');
    $app.innerHTML = (DEMO ? '<div class="demo">데모 모드 — 예시 데이터이며 저장되지 않습니다. config.js 에 Supabase 정보를 넣으면 실제 데이터가 표시됩니다.</div>' : '') +
      '<div class="layout"' + (DEMO ? ' style="height:calc(100vh - 26px)"' : '') + '><div class="side"><div class="brand">IT Asset<span>v1.9.11</span></div><div class="nav">' + nav + '<div class="sep">다음 버전</div>' + soon + '</div></div>' +
      '<div class="main"><div class="top"><input type="search" id="gs" class="gs" placeholder="통합 검색 (관리번호·사용자·위치·메모 등 모든 항목) (Enter)" value="' + esc(F.q) + '"><a class="btn sm qrtop" href="#/scan" title="자산 QR 스티커 스캔 (모든 전산장비)">▣ QR 스캔</a><div class="sp"></div><div class="who" title="' + esc(adminLabel()) + '">' + whoHtml() + '</div>' + (DEMO ? '' : '<button class="btn sm" id="logout">로그아웃</button>') + '</div><div class="content" id="view">' + (isViewer() ? '<div class="vbanner">조회 전용 계정입니다. 수정·업로드·처리·QR 출력 기능은 사용할 수 없습니다.</div>' : '') + html + '</div></div></div>';
    document.body.classList.toggle('viewer', isViewer());
    var gs = $('#gs'); if (gs) gs.onkeydown = function (e) { if (e.key !== 'Enter') return; F.q = gs.value; F.dept = ''; F.cat = ''; F.catg = ''; F.status = ''; F.company = ''; F.collect = ''; F.page = 1; if (location.hash === '#/assets') pageAssets(); else location.hash = '#/assets'; };
    var lo = $('#logout'); if (lo) lo.onclick = async function () { await auditPost({ action: 'logout', target: '웹 로그인', summary: '로그아웃' }); await sb.auth.signOut(); location.reload(); };
  }

  // ---------- 대시보드 (v1.7) ----------
  var PAL = ['#2f7df6', '#1e8e3e', '#e9a100', '#c42b1c', '#7a4bd6', '#b0b7c3'];
  var ST_COL = { '사용중': '#2f7df6', '재고': '#1e8e3e', '수리중': '#e9a100', '폐기 예정': '#c42b1c', '폐기': '#c42b1c' };
  function top4(arr, fn, colFn) {
    var g = groupCount(arr, fn), parts = [], etc = 0;
    g.forEach(function (x, i) { if (i < 4) parts.push([x[0], x[1], colFn ? colFn(x[0], i) : PAL[i]]); else etc += x[1]; });
    if (etc) parts.push(['기타', etc, '#b0b7c3']);
    return parts;
  }
  function donut(parts, center, kind, co, allowEtc) {
    var tot = parts.reduce(function (t, p) { return t + p[1]; }, 0), r = 40, C = 2 * Math.PI * r, off = 0, segs = '<circle cx="55" cy="55" r="40" fill="none" stroke="#eef1f5" stroke-width="14"/>';
    parts.forEach(function (p) { if (!p[1]) return; var L = C * p[1] / tot; segs += '<circle' + (kind && (allowEtc || p[0] !== '기타') ? ' class="seg" data-go="' + kind + ':' + esc(p[0]) + '"' + (co ? ' data-co="' + esc(co) + '"' : '') : '') + ' cx="55" cy="55" r="40" fill="none" stroke="' + p[2] + '" stroke-width="14" stroke-dasharray="' + L.toFixed(1) + ' ' + (C - L).toFixed(1) + '" stroke-dashoffset="' + (-off).toFixed(1) + '" transform="rotate(-90 55 55)"><title>' + esc(p[0]) + ' ' + p[1].toLocaleString() + '</title></circle>'; off += L; });
    return '<svg width="104" height="104" viewBox="0 0 110 110" style="flex:none">' + segs + '<text x="55" y="52" text-anchor="middle" font-size="17" font-weight="700" fill="#1a1a1a">' + center + '</text><text x="55" y="68" text-anchor="middle" font-size="9" fill="#5c5c5c">전체</text></svg>';
  }
  function legend(parts, kind, co, allowEtc) { return parts.map(function (p) { return '<div class="lg' + (kind && (allowEtc || p[0] !== '기타') ? ' go" data-go="' + kind + ':' + esc(p[0]) + '"' + (co ? ' data-co="' + esc(co) + '"' : '') : '"') + '><i style="background:' + p[2] + '"></i><span>' + esc(p[0]) + '</span><b>' + p[1].toLocaleString() + '</b></div>'; }).join('') || '<div class="note">데이터가 없습니다.</div>'; }
  function ageYears(a) {
    var d = a.purchase_date ? new Date(a.purchase_date) : a.mfg_ym ? new Date(a.mfg_ym.length === 7 ? a.mfg_ym + '-01' : a.mfg_ym) : null;
    if (!d || isNaN(d)) return null;
    return (Date.now() - d.getTime()) / (365.25 * 86400000);
  }
  var DASH_CO = 'A+에셋';
  function pageDashboard() {
    var A = S.assets, pcs = A.filter(isPc), today = 0, stale = 0, within = 0;
    S.devices.forEach(function (d) { var l = seen(d.last_seen).lvl; if (l === 'today') today++; else if (l === 'stale') stale++; else within++; });
    var mism = A.filter(function (a) { return a.user_mismatch; }).length;
    var unreg = S.devices.filter(function (d) { return !d.asset_no; }).length;
    var noDev = pcs.filter(function (a) { return !a._dev; }).length;
    var recv = S.support.filter(function (x) { return x.status === 'received'; }).length;
    var todayKey = ymd(new Date()), recvToday = S.support.filter(function (x) { return ymd(x.created_at) === todayKey; }).length;
    var leaver = S.devices.filter(function (d) { var e = d.emp_no && S.empBy[d.emp_no]; return e && e.active === false; });
    // 보증 만료·교체 알림
    var wr = [];
    A.forEach(function (a) {
      if (/^폐기/.test(a.status || '')) return;
      var n = a.warr_end ? -dayDiff(a.warr_end) : null, yr = isPc(a) ? ageYears(a) : null;
      var who = (a.user_name || '') + (a.dept ? ' · ' + a.dept : '');
      if (n != null && n <= 30 && n >= -90) wr.push({ no: a.asset_no, cat: a.category, who: who, date: ymd(a.warr_end), st: n < 0 ? '만료됨' : 'D-' + n, col: n <= 14 ? '#c42b1c' : '#e9a100', k: n });
      else if (yr != null && yr >= 5) wr.push({ no: a.asset_no, cat: a.category, who: who, date: '사용 ' + Math.floor(yr) + '년차', st: '교체 권장', col: '#5c5c5c', k: 1000 - yr });
    });
    wr.sort(function (x, y) { return x.k - y.k; });
    var warrSoon = A.filter(function (a) { if (!a.warr_end) return false; var n = -dayDiff(a.warr_end); return n >= 0 && n <= 30; }).length;
    // 최근 활동 (자산 변경 이력 + 인사 명단 적용)
    var act = S.history.map(function (h) { return { t: h.created_at, a: h.asset_no || '(미등록 PC)', d: h.detail }; })
      .concat(S.imports.map(function (x) { return { t: x.applied_at, a: '인사 명단' + (x.reverted_at ? ' (되돌림)' : ''), d: (x.file_name || '') + ' · 신규 ' + x.added + ' · 변경 ' + x.changed + ' · 퇴사 ' + x.deactivated }; }))
      .sort(function (x, y) { return new Date(y.t) - new Date(x.t); }).slice(0, 6);
    function k(t, n, s, c, href, go) { return '<a class="dk" href="' + href + '"' + (go ? ' data-go="' + go + '"' : '') + '><span class="ic" style="background:' + c + '22"><i style="background:' + c + '"></i></span><span><span class="t">' + t + '</span><span class="n">' + n + '</span><span class="s">' + s + '</span></span></a>'; }
    function todoCard(t, cnt, sub, link, href) { var c = cnt ? (t === '미등록 PC' || t === '사용자 불일치' ? '#e9a100' : '#c42b1c') : '#1e8e3e'; return '<a class="todo" href="' + href + '"><div class="th"><span class="dot" style="background:' + c + '"></span>' + t + ' <b>' + cnt + '</b></div><div class="ts">' + sub + '</div><div class="tl">' + link + ' ›</div></a>'; }
    var allClear = !unreg && !stale && !mism && !leaver.length;
    var todo = allClear ? '<div class="note" style="padding:8px 0">오늘 처리할 일이 없습니다. ✓</div>' : '<div class="todos">' +
      todoCard('미등록 PC', unreg, '관리번호 연결 필요', '연결하기', '#/check/unreg') +
      todoCard('7일 이상 미확인', stale, '프로그램 실행 확인 필요', '목록 보기', '#/check/stale') +
      todoCard('사용자 불일치', mism, '대장 vs 실제 사용자', '확인', '#/check/mismatch') +
      todoCard('퇴사자 사번 PC', leaver.length, leaver.length ? esc(leaver.slice(0, 2).map(function (d) { return d.computer_name; }).join(', ')) + (leaver.length > 2 ? ' 외 ' + (leaver.length - 2) : '') + ' — 회수·초기화 확인' : '회수·초기화 확인', '명단 보기', '#/employees/all') + '</div>';
    var coll = [['오늘 확인', today, '#1e8e3e'], ['7일 이내', within, '#2f7df6'], ['7일 이상 미확인', stale, '#c42b1c'], ['미수집 PC(대장)', noDev, '#b0b7c3']];
    var ctot = coll.reduce(function (t, p) { return t + p[1]; }, 0) || 1;
    var cbar = '<div class="sbar">' + coll.map(function (p) { return p[1] ? '<i style="flex:' + p[1] + ';background:' + p[2] + '" title="' + esc(p[0]) + ' ' + p[1] + '"></i>' : ''; }).join('') + '</div>';
    var typ = top4(A, function (a) { return a.category; }), sts = top4(A, function (a) { return a.status; }, function (n, i) { return ST_COL[n] || PAL[Math.min(i, 5)]; });
    var wrows = wr.slice(0, 6).map(function (w) { return '<tr><td class="mono"><a href="#/asset/' + encodeURIComponent(w.no) + '">' + esc(w.no) + '</a></td><td>' + esc(w.cat || '') + '</td><td>' + esc(w.who) + '</td><td>' + esc(w.date) + '</td><td style="color:' + w.col + ';font-weight:600">' + w.st + '</td></tr>'; }).join('') || '<tr><td colspan="5" class="note" style="text-align:center;padding:12px">알림이 없습니다.</td></tr>';
    var arows = act.map(function (h) { return '<div class="ar' + (isMain() ? ' clk' : '') + '" data-at="' + esc(ymd(h.t)) + '" data-tg="' + esc(h.a === '(미등록 PC)' ? '미등록 PC' : h.a.indexOf('인사 명단') === 0 ? '인사 명단' : h.a) + '" title="' + (isMain() ? '누르면 이력 관리에서 확인' : '') + '"><span class="at">' + esc(ymd(h.t).slice(5) + ' ' + hm(h.t)) + '</span><span class="ab">' + esc(h.a) + '</span><span class="ad">' + esc(h.d) + '</span></div>'; }).join('') || '<div class="note">활동 이력이 없습니다.</div>';
    // v1.9.6: 회사별 자산 | 자산 유형 | 자산 상태 (회사를 고르면 오른쪽 두 카드가 그 회사 기준으로 바뀜, 기본 A+에셋)
    var co = DASH_CO, cA = co === '전체' ? A : A.filter(function (a) { return (a.company || '') === co; });
    var typC = CATG.map(function (g) { return [g, cA.filter(function (a) { return catGrp(a.category) === g; }).length, CATG_COL[g]]; });
    var stsC = top4(cA, function (a) { return a.status; }, function (n, i) { return ST_COL[n] || PAL[Math.min(i, 5)]; });
    var noCo = A.filter(function (a) { return CO.indexOf(a.company) < 0; }).length;
    var coRows = CO.concat(['전체']).map(function (n) {
      var cnt = n === '전체' ? A.length : A.filter(function (a) { return a.company === n; }).length;
      return (n === '전체' ? '<div class="cosep"></div>' : '') + '<div class="corow' + (n === co ? ' on' : '') + '" data-co="' + esc(n) + '"><span class="rd"><i></i></span><span class="nm">' + esc(n) + '</span><b>' + cnt.toLocaleString() + '</b><span class="pc">' + (n === '전체' ? '' : (A.length ? Math.round(cnt / A.length * 100) : 0) + '%') + '</span></div>';
    }).join('') + (noCo ? '<div class="note" style="margin-top:6px">회사 미지정 ' + noCo.toLocaleString() + '건 (전체에만 포함) · <a href="#/data">데이터 관리</a>에서 지정</div>' : '');
    shell('dashboard', '<div class="row"><h1>대시보드</h1><span class="note">' + esc(ymd(new Date()) + ' ' + hm(new Date())) + ' 기준</span></div>' +
      '<div class="dks">' + k('전체 자산', A.length.toLocaleString(), '엑셀 가져오기 기준', '#2f7df6', '#/assets') + k('오늘 확인된 PC', today.toLocaleString(), '수집률 ' + (pcs.length ? Math.round(today / pcs.length * 100) : 0) + '%', '#1e8e3e', '#/assets', 'collect:today') + k('점검 필요', stale.toLocaleString(), '7일 이상 미확인', '#c42b1c', '#/check/stale') + k('보증 만료 예정', warrSoon.toLocaleString(), '30일 이내', '#e9a100', '#/assets') + k('지원 요청', recv.toLocaleString(), '미처리 · 오늘 접수 ' + recvToday, '#7a4bd6', '#/support') + '</div>' +
      '<div class="card dwide" style="border-left:4px solid #e9a100"><h3>오늘 처리할 일 <span class="note" style="font-weight:400">— 누르면 해당 목록으로 이동</span></h3>' + todo + '</div>' +
      '<div class="dtop">' +
      '<div class="card"><h3>회사별 자산</h3>' + coRows + '<div class="note codet">회사를 누르면 오른쪽 두 카드가 바뀝니다<a href="#/company/' + encodeURIComponent(co) + '">회사별 상세 보기 ›</a></div></div>' +
      '<div class="card"><h3>자산 유형 · ' + esc(co) + '</h3><div class="dn">' + donut(typC, cA.length.toLocaleString(), 'catg', co, true) + '<div class="lgs">' + legend(typC, 'catg', co, true) + '</div></div></div>' +
      '<div class="card"><h3>자산 상태 · ' + esc(co) + '</h3><div class="dn">' + donut(stsC, cA.length.toLocaleString(), 'status', co) + '<div class="lgs">' + legend(stsC, 'status', co) + '</div></div></div></div>' +
      '<div class="dgrid">' +
      '<div class="card"><h3>부서별 자산 수 <span class="note" style="font-weight:400">상위 5개 · 누르면 해당 목록</span></h3>' + bars(groupCount(A, function (a) { return a.dept; }).slice(0, 5), null, 'dept') + '</div>' +
      '<div class="card"><h3>PC 수집 현황</h3>' + cbar + legend(coll) + '<div class="note" style="margin-top:6px">프로그램을 한 번도 실행하지 않은 PC는 미수집으로 집계됩니다.</div></div></div>' +
      '<div class="card dwide"><div class="row"><h3 style="flex:1;margin:0">보증 만료·교체 알림</h3>' + (wr.length > 6 ? '<span class="note">외 ' + (wr.length - 6) + '건</span>' : '') + '<a href="#/assets" style="font-size:11.5px">자산 목록 ›</a></div><table class="tbl dtbl"><thead><tr><th>자산번호</th><th>유형</th><th>사용자</th><th>만료일/기준</th><th>상태</th></tr></thead><tbody>' + wrows + '</tbody></table><div class="note" style="margin-top:6px">보증 만료 30일 전~만료 후 90일, 그리고 구매일(없으면 제조년월) 기준 5년 이상 사용한 PC·노트북을 표시합니다.</div></div>' +
      '<div class="card dwide"><h3>최근 활동</h3>' + arows + '</div>');
    if (isMain()) $$('.ar.clk').forEach(function (el) { el.onclick = function () { AUDV = { from: el.dataset.at, to: el.dataset.at, actor: '', target: el.dataset.tg, q: '', chip: 'all', page: 0 }; location.hash = '#/audit'; }; });
    $$('.corow').forEach(function (el) { el.onclick = function () { DASH_CO = el.getAttribute('data-co'); pageDashboard(); }; });
    $$('[data-go]').forEach(function (el) { el.onclick = function () { var p = el.getAttribute('data-go'), i = p.indexOf(':'); goAssets(p.slice(0, i), p.slice(i + 1), el.getAttribute('data-co')); }; });
  }
  // ---------- v1.9.6: 회사별 자산 상세 ----------
  function pageCompany(arg) {
    var co = decodeURIComponent(arg || ''); if (CO.concat(['전체']).indexOf(co) < 0) co = 'A+에셋';
    DASH_CO = co;
    var A = S.assets, cA = co === '전체' ? A : A.filter(function (a) { return a.company === co; }), tot = cA.length, pct = function (n, d) { return d ? Math.round(n / d * 1000) / 10 : 0; };
    var types = CATG.map(function (g) { return [g, cA.filter(function (a) { return catGrp(a.category) === g; }).length, CATG_COL[g]]; });
    var stats = groupCount(cA, function (a) { return a.status; }).map(function (x, i) { return [x[0], x[1], ST_COL[x[0]] || PAL[Math.min(i, 5)]]; });
    var used = cA.filter(function (a) { return a.status === '사용중'; }).length, dead = cA.filter(function (a) { return /^폐기/.test(a.status || ''); }).length, etc = tot - used - dead;
    function k(t, n, s, c) { return '<div class="dk"><span><span class="t">' + t + '</span><span class="n"' + (c ? ' style="color:' + c + '"' : '') + '>' + n + '</span><span class="s">' + s + '</span></span></div>'; }
    function tr(kind, n, v, c, mx) { return '<tr><td><i class="sw" style="background:' + c + '"></i>' + esc(n) + '</td><td class="barc"><div class="pbar"><i style="width:' + (mx ? Math.max(v ? 2 : 0, v / mx * 100) : 0) + '%;background:' + c + '"></i></div></td><td class="num"><b>' + v.toLocaleString() + '</b></td><td class="num note">' + pct(v, tot) + '%</td><td class="num">' + (v ? '<a href="#" class="cgo" data-go="' + kind + ':' + esc(n) + '">목록 보기 ›</a>' : '') + '</td></tr>'; }
    var mxT = Math.max.apply(null, types.map(function (x) { return x[1]; }).concat([1])), mxS = Math.max.apply(null, stats.map(function (x) { return x[1]; }).concat([1]));
    function mrow(n) {
      var l = n === '전체' ? A : A.filter(function (a) { return a.company === n; });
      return '<tr class="' + (n === co ? 'on' : '') + '"><td><b>' + n + '</b></td>' + CATG.map(function (g) { return '<td class="num">' + l.filter(function (a) { return catGrp(a.category) === g; }).length.toLocaleString() + '</td>'; }).join('') + '<td class="num"><b>' + l.length.toLocaleString() + '</b></td></tr>';
    }
    var noCo = A.filter(function (a) { return CO.indexOf(a.company) < 0; });
    var matrix = '<table class="tbl ctbl"><thead><tr><th>회사</th>' + CATG.map(function (g) { return '<th class="num">' + g + '</th>'; }).join('') + '<th class="num">합계</th></tr></thead><tbody>' + CO.map(mrow).join('') +
      (noCo.length ? '<tr><td>미지정</td>' + CATG.map(function (g) { return '<td class="num">' + noCo.filter(function (a) { return catGrp(a.category) === g; }).length.toLocaleString() + '</td>'; }).join('') + '<td class="num"><b>' + noCo.length.toLocaleString() + '</b></td></tr>' : '') + mrow('전체') + '</tbody></table>';
    shell('dashboard', '<div class="row wrap"><a href="#/dashboard">‹ 대시보드</a><h1>회사별 자산 상세</h1></div>' +
      '<div class="ctabs">' + CO.concat(['전체']).map(function (n) { return '<a href="#/company/' + encodeURIComponent(n) + '" class="' + (n === co ? 'on' : '') + '">' + n + '</a>'; }).join('') + '</div>' +
      '<div class="dks">' + k(esc(co) + ' 총 자산', tot.toLocaleString(), '전체의 ' + pct(tot, A.length) + '%') + k('사용중', used.toLocaleString(), pct(used, tot) + '%', '#0f6cbd') + k('재고·수리 등', etc.toLocaleString(), '사용중·폐기 외', '#a15c00') + k('폐기', dead.toLocaleString(), '') + '</div>' +
      '<div class="cwrap"><div class="card cmain"><h3>' + esc(co) + ' · 자산 유형별 수량</h3><div class="dn">' + donut(types, tot.toLocaleString(), null) + '<table class="tbl ctbl" style="flex:1"><thead><tr><th>자산 유형</th><th></th><th class="num">수량</th><th class="num">비율</th><th></th></tr></thead><tbody>' + types.map(function (x) { return tr('catg', x[0], x[1], x[2], mxT); }).join('') + '<tr class="tot"><td>합계</td><td></td><td class="num"><b>' + tot.toLocaleString() + '</b></td><td class="num">100%</td><td></td></tr></tbody></table></div></div>' +
      '<div class="cside"><div class="card"><h3>' + esc(co) + ' · 자산 상태별 수량</h3><table class="tbl ctbl"><thead><tr><th>자산 상태</th><th></th><th class="num">수량</th><th class="num">비율</th><th></th></tr></thead><tbody>' + (stats.map(function (x) { return tr('status', x[0], x[1], x[2], mxS); }).join('') || '<tr><td colspan="5" class="note">해당 자산이 없습니다.</td></tr>') + '</tbody></table></div>' +
      '<div class="card"><h3>회사 × 자산 유형 비교</h3>' + matrix + '</div></div></div>' +
      (noCo.length ? '<div class="note" style="margin-top:8px">회사가 지정되지 않은 자산 ' + noCo.length.toLocaleString() + '건은 \'전체\'에만 포함됩니다. <a href="#/data">데이터 관리</a>에서 소속명별로 회사를 지정하세요.</div>' : ''));
    $$('.cgo').forEach(function (el) { el.onclick = function (e) { e.preventDefault(); var p = el.getAttribute('data-go'), i = p.indexOf(':'); goAssets(p.slice(0, i), p.slice(i + 1), co); }; });
  }
  function goAssets(kind, val, co) {   // 대시보드 항목 → 조건이 걸린 자산 목록
    F.q = ''; F.dept = ''; F.cat = ''; F.catg = ''; F.status = ''; F.company = ''; F.collect = ''; F.page = 1; F.sel = {}; F[kind] = val; if (co && co !== '전체') F.company = co;
    location.hash = '#/assets';
  }

  // ---------- 자산 목록 ----------
  // ---------- 검색 (v1.9.2: 자산 상세 화면의 모든 항목) ----------
  // v1.9.4: 목록에서 모니터 ↔ PC 연동 상태 (연결됨=초록, 미연결=분홍)
  function monLink(a) {
    if (a.category === '모니터') {
      var pcNo = a.linked_pc, pc = pcNo ? S.assets.filter(function (x) { return x.asset_no === pcNo; })[0] : null;
      var rec = (S.monitors || []).filter(function (m) { return m.asset_no === a.asset_no; })[0];
      return { mon: true, pc: pc || null, pcNo: pcNo || null, how: rec ? (rec.link_source === 'manual' ? '수동 연결' : '시리얼 일치(자동)') : '연결됨' };
    }
    if (isPc(a)) { var n = a._dev ? (S.monitors || []).filter(function (m) { return m.device_id === a._dev.id; }).length : 0; return { mon: false, n: n }; }
    return null;
  }
  function monSpec(a) {
    var rec = (S.monitors || []).filter(function (m) { return m.asset_no === a.asset_no; })[0]; if (!rec) return '—';
    return [rec.size_inch ? rec.size_inch + '인치' : '', rec.resolution || ''].filter(Boolean).join(' · ') || '—';
  }
  function monBadge(a) {
    var L = monLink(a); if (!L) return '';
    if (L.mon) return L.pcNo ? '<span class="lkb ok">' + esc(L.pcNo) + ' · ' + L.how + '</span>' : '<span class="lkb no">PC 미연결</span>';
    return L.n ? '<span class="lkb gray">연결 모니터 ' + L.n + '대</span>' : '';
  }
  function searchFields(a) {
    var d = a._dev, e = a._emp;
    return [['관리번호', a.asset_no], ['자산분류', a.category], ['제조사', a.manufacturer], ['모델명', a.model], ['제조년월', a.mfg_ym], ['자산상태', a.status],
      ['사용자명', a.user_name], ['사용자 ID', a.user_id], ['소속명', a.dept], ['회사', a.company], ['직책', a.title], ['위치', a.location],
      ['구매일', a.purchase_date ? String(a.purchase_date).slice(0, 10) : ''], ['보증만료', a.warr_end ? ymd(a.warr_end) : ''], ['메모', a.memo],
      ['컴퓨터 이름', a.pc_name], ['OS', a.os], ['IP', a.ip], ['MAC', a.mac], ['CPU', a.cpu], ['RAM', a.ram_gb ? a.ram_gb + 'GB' : ''],
      ['저장장치', a.storage], ['그래픽카드', a.gpu], ['실행 사번', d && d.emp_no ? d.emp_no + (e ? ' ' + e.name : '') : '']];
  }
  var HID = { '사용자 ID': 1, '위치': 1, '구매일': 1, '보증만료': 1, '메모': 1, 'OS': 1, 'MAC': 1, '그래픽카드': 1, '실행 사번': 1 };   // 목록 칸에 없는 항목
  function searchHas(a, q) {
    var f = searchFields(a);
    for (var i = 0; i < f.length; i++) { var v = f[i][1]; if (v != null && v !== '' && String(v).toLowerCase().indexOf(q) >= 0) return true; }
    return false;
  }
  function searchHits(a, q) { return searchFields(a).filter(function (f) { return f[1] != null && f[1] !== '' && String(f[1]).toLowerCase().indexOf(q) >= 0; }); }
  function hl(text, q) {
    text = String(text); var i = text.toLowerCase().indexOf(q); if (i < 0) return esc(text);
    var s0 = Math.max(0, i - 14), e0 = Math.min(text.length, i + q.length + 24);
    return (s0 > 0 ? '…' : '') + esc(text.slice(s0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length, e0)) + (e0 < text.length ? '…' : '');
  }
  var ACOL = {
    asset_no: { f: function (a) { return a.asset_no; }, t: 's', l: '관리번호' }, category: { f: function (a) { return a.category; }, t: 's', l: '자산분류' },
    manufacturer: { f: function (a) { return a.manufacturer; }, t: 's', l: '제조사' }, model: { f: function (a) { return a.model; }, t: 's', l: '모델명' },
    mfg_ym: { f: function (a) { return a.mfg_ym; }, t: 'd', l: '제조년월' }, status: { f: function (a) { return a.status; }, t: 's', l: '자산상태' },
    user_name: { f: function (a) { return a.user_name; }, t: 's', l: '사용자명' }, dept: { f: function (a) { return a.dept; }, t: 's', l: '소속명' }, company: { f: function (a) { return a.company; }, t: 's', l: '회사' },
    title: { f: function (a) { return a.title; }, t: 's', l: '직책' }, warr: { f: function (a) { return a.warr_end || a.warr_calc; }, t: 'd', l: '보증' },
    pc_name: { f: function (a) { return a.pc_name; }, t: 's', l: '컴퓨터 이름' }, ip: { f: function (a) { return a.ip; }, t: 'ip', l: 'IP' },
    spec: { f: function (a) { return a.ram_gb; }, t: 'n', l: '사양(RAM)' }, last_seen: { f: function (a) { return a.last_seen; }, t: 'd', l: '최종 확인' }
  };
  function filtered() {
    var q = F.q.trim().toLowerCase();
    return sortRows(S.assets.filter(function (a) {
      if (F.dept && (a.dept || '(없음)') !== F.dept) return false;
      if (F.cat && (a.category || '(없음)') !== F.cat) return false;
      if (F.status && (a.status || '(없음)') !== F.status) return false;
      if (F.company && (a.company || '(미지정)') !== F.company) return false;
      if (F.catg && catGrp(a.category) !== F.catg) return false;
      if (F.collect) {
        var l = seen(a.last_seen).lvl;
        if (F.collect === 'today' && l !== 'today') return false;
        if (F.collect === 'stale' && l !== 'stale') return false;
        if (F.collect === 'none' && !(isPc(a) && !a._dev)) return false;
        if (F.collect === 'mismatch' && !a.user_mismatch) return false;
      }
      if (q && !searchHas(a, q)) return false;
      return true;
    }), 'assets', ACOL);
  }
  var PS = 20;
  function pageAssets(partial) {
    var list = filtered(), pages = Math.max(1, Math.ceil(list.length / PS)); if (F.page > pages) F.page = pages;
    var cats = groupCount(S.assets, function (a) { return a.category; }).map(function (x) { return x[0]; });
    var stats = groupCount(S.assets, function (a) { return a.status; }).map(function (x) { return x[0]; });
    var pageRows = list.slice((F.page - 1) * PS, F.page * PS), qLow = F.q.trim().toLowerCase();
    var rows = pageRows.map(function (a) {
      var hitCell = '';
      if (qLow) { var hs = searchHits(a, qLow).filter(function (f) { return HID[f[0]]; }).slice(0, 2); hitCell = '<td class="hit">' + hs.map(function (f) { return '<span>' + hl(f[1], qLow) + '</span>'; }).join('<br>') + (monBadge(a) ? '<div>' + monBadge(a) + '</div>' : '') + '</td>'; }
      var L = monLink(a), dPc = L && L.mon && L.pc ? L.pc : null;   // 연결된 모니터는 PC 값으로 표시
      var cName = a.pc_name || (dPc && dPc.pc_name) || '—', cIp = a.ip || (dPc && dPc.ip) || '—', cSeen = a.last_seen || (dPc && dPc.last_seen);
      var nameExtra = (!qLow && monBadge(a) ? '<div>' + monBadge(a) + '</div>' : '');
      return '<tr class="clk" data-no="' + esc(a.asset_no) + '"><td><input type="checkbox" class="sel" data-no="' + esc(a.asset_no) + '"' + (F.sel[a.asset_no] ? ' checked' : '') + '></td>' +
        '<td class="mono">' + esc(a.asset_no) + '</td>' + hitCell + '<td>' + esc(a.category) + '</td><td>' + esc(a.manufacturer) + '</td><td>' + esc(a.model) + '</td><td>' + esc(a.mfg_ym) + '</td><td>' + esc(a.status) + '</td><td>' + warrantyBadge(a.warr_end, a.warr_calc) + '</td>' +
        '<td>' + esc(a.user_name) + (a.user_mismatch ? ' ' + badge('불일치', 'warn') : '') + '</td><td>' + esc(a.dept) + '</td><td>' + esc(a.company || '') + '</td><td>' + esc(a.title) + '</td>' +
        '<td class="auto">' + esc(cName) + nameExtra + '</td><td class="auto mono">' + esc(cIp) + '</td><td class="auto">' + esc(a.category === '모니터' ? monSpec(a) : specStr(a)) + '</td><td class="auto">' + (cSeen ? seenHtml(cSeen) + (!a.last_seen && dPc ? '<div class="note" style="font-size:10.5px">연결 PC 기준</div>' : '') : seenHtml(a.last_seen)) + '</td></tr>';
    }).join('') || '<tr><td colspan="17" class="note" style="padding:24px;text-align:center">조건에 맞는 자산이 없습니다.</td></tr>';
    var nsel = Object.keys(F.sel).length;
    var hasFilter = !!(qLow || F.dept || F.cat || F.catg || F.status || F.company || F.collect);
    var nIn = hasFilter ? list.filter(function (a) { return F.sel[a.asset_no]; }).length : nsel;      // 현재 검색 결과 중 선택된 수
    var pageSel = pageRows.filter(function (a) { return F.sel[a.asset_no]; }).length;
    var CL = { today: '오늘 확인', stale: '7일 이상 미확인', none: '미수집 PC', mismatch: '사용자 불일치' };
    var chips = [];
    if (F.dept) chips.push(['dept', '소속: ' + F.dept]); if (F.cat) chips.push(['cat', '자산분류: ' + F.cat]); if (F.status) chips.push(['status', '자산상태: ' + F.status]); if (F.company) chips.push(['company', '회사: ' + F.company]); if (F.catg) chips.push(['catg', '자산유형: ' + F.catg]);
    if (F.collect) chips.push(['collect', '수집상태: ' + (CL[F.collect] || F.collect)]); if (qLow) chips.push(['q', '검색: ' + F.q.trim()]);
    var chipHtml = chips.length ? '<div class="fchips"><span class="note">적용된 조건</span>' + chips.map(function (c) { return '<span class="fchip">' + esc(c[1]) + '<button type="button" data-clr="' + c[0] + '" title="해제">✕</button></span>'; }).join('') + '<a href="#" id="clrall">모두 해제</a><span class="grow"></span><span class="note">해당 <b>' + list.length.toLocaleString() + '</b>건</span></div>' : '';
    var bulk = '';
    if (nsel) {
      bulk = '<div class="bulk"><b>' + (hasFilter ? '이 검색 결과 중 ' + nIn.toLocaleString() + '개 선택됨 (전체 선택 중 ' + nsel.toLocaleString() + '개)' : nsel.toLocaleString() + '개 선택됨') + '</b><span>|</span>' +
        '<button class="btn sm" id="b-status">상태 변경</button><button class="btn sm pri" id="b-qr">QR코드 출력</button><button class="btn sm" id="b-xl">선택 항목 엑셀</button>' + (isMain() ? '<button class="btn sm dng" id="b-del" type="button">선택 삭제</button>' : '') +
        '<span class="allwrap"><button class="btn sm" id="b-all">전체 선택 ▾</button><div class="allmenu" id="allmenu" hidden><a id="m-page">현재 페이지 ' + pageRows.length + '개만 선택</a><a id="m-all">조회된 ' + list.length.toLocaleString() + '건 모두 선택 (다른 페이지 포함)</a><a id="m-unpage">현재 페이지 선택 해제</a>' + (isMain() ? '<a id="m-del" class="dngm">조회된 ' + list.length.toLocaleString() + '건 전체 삭제…</a>' : '') + '</div></span>' +
        '<button class="btn sm" id="b-clear">선택 해제</button></div>';
      if (pageRows.length && pageSel === pageRows.length && list.length > pageRows.length && nIn < list.length) bulk += '<div class="selnote">현재 페이지의 <b>' + pageRows.length + '개</b>가 선택되었습니다. <a href="#" id="n-all">조회된 ' + list.length.toLocaleString() + '건 모두 선택</a></div>';
      else if (list.length > pageRows.length && nIn === list.length) bulk += '<div class="selnote">조회된 <b>' + list.length.toLocaleString() + '건</b>이 모두 선택되었습니다 (여러 페이지 포함). 페이지를 넘겨도 선택이 유지됩니다.</div>';
    }
    var innerHtml = (
      chipHtml + bulk +
      sortBar('assets', ACOL, list.length) + '<div style="overflow:auto"><table class="tbl ctr"><thead><tr><th><input type="checkbox" id="all"></th>' + thS('assets', 'asset_no', '관리번호') + (qLow ? '<th>일치한 항목</th>' : '') + thS('assets', 'category', '자산분류') + thS('assets', 'manufacturer', '제조사') + thS('assets', 'model', '모델명') + thS('assets', 'mfg_ym', '제조년월') + thS('assets', 'status', '자산상태') + thS('assets', 'warr', '보증 (제조년월+5년)') + thS('assets', 'user_name', '사용자명') + thS('assets', 'dept', '소속명') + thS('assets', 'company', '회사') + thS('assets', 'title', '직책') + thS('assets', 'pc_name', '컴퓨터 이름', 'auto') + thS('assets', 'ip', 'IP', 'auto') + thS('assets', 'spec', '사양', 'auto') + thS('assets', 'last_seen', '최종 확인', 'auto') + '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="pager"><span>' + (list.length ? ((F.page - 1) * PS + 1) + '–' + Math.min(list.length, F.page * PS) : 0) + ' / ' + list.length.toLocaleString() + '건</span><span><button class="btn sm" id="prev"' + (F.page <= 1 ? ' disabled' : '') + '>‹ 이전</button> ' + F.page + ' / ' + pages + ' <button class="btn sm" id="next"' + (F.page >= pages ? ' disabled' : '') + '>다음 ›</button></span></div>'
    );
    // v1.9.2: 위쪽 [QR코드 출력] — 선택한 항목이 있으면 선택한 것만, 없으면 검색·조건으로 걸러진 목록 전체
    function updTop() {
      var b = $('#qrtop'); if (!b) return;
      b.textContent = 'QR코드 출력 (' + (nIn > 0 ? '선택 ' + nIn.toLocaleString() + '개' : hasFilter ? '조회 ' + list.length.toLocaleString() + '건' : '전체 ' + list.length.toLocaleString() + '건') + ')';
      var da = $('#a_delall'); if (da) { da.textContent = '조회 ' + list.length.toLocaleString() + '건 전체 삭제…'; da.disabled = !list.length; da.onclick = function () { assetDeleteDlg('all', list); }; }
      b.disabled = !list.length;
      b.onclick = function () {
        if (!nIn && !hasFilter && !confirm('조건이 없어 전체 ' + list.length.toLocaleString() + '건이 출력 대상입니다. 계속할까요?')) return;
        openQrDialog(list);
      };
    }
    if (partial && $('#alist')) { $('#alist').innerHTML = innerHtml; bindList(); updTop(); return; }
    shell('assets', '<div class="row wrap"><h1>자산 관리</h1><span class="badge b-gray">전체 ' + S.assets.length.toLocaleString() + '</span><div class="grow"></div>' +
      '<input type="text" id="q" placeholder="통합 검색 (관리번호·사용자·위치·메모 등 모든 항목)" style="width:330px" value="' + esc(F.q) + '">' +
      sel('company', '회사: 전체', CO, F.company) + sel('cat', '자산분류: 전체', cats, F.cat) + sel('status', '자산상태: 전체', stats, F.status) +
      '<select id="collect"><option value="">수집상태: 전체</option><option value="today"' + (F.collect === 'today' ? ' selected' : '') + '>오늘 확인</option><option value="stale"' + (F.collect === 'stale' ? ' selected' : '') + '>7일 이상 미확인</option><option value="none"' + (F.collect === 'none' ? ' selected' : '') + '>미수집 PC</option><option value="mismatch"' + (F.collect === 'mismatch' ? ' selected' : '') + '>사용자 불일치</option></select>' +
      '<button class="btn pri" id="qrtop">QR코드 출력</button><button class="btn" id="xl">엑셀 다운로드</button>' + (isMain() ? '<button class="btn dng" id="a_delall" type="button">전체 삭제…</button>' : '') + '<button class="btn pri wonly" id="a_new" type="button">＋ 직접 등록</button></div>' +
      '<div class="note" style="margin:6px 0">기존 시스템 항목 · <span style="color:#0f6cbd">파란 배경 = 프로그램이 자동으로 채우는 항목</span> · <span class="dot" style="background:#1e8e3e"></span>오늘 <span class="dot" style="background:#faad14"></span>3일 이상 <span class="dot" style="background:#c42b1c"></span>7일 이상 미확인</div>' +
      '<div id="alist">' + innerHtml + '</div>');
    function sel(id, ph, opts, cur) { return '<select id="' + id + '"><option value="">' + ph + '</option>' + opts.map(function (o) { return '<option' + (o === cur ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') + '</select>'; }
    updTop();
    var qEl = $('#q');
    qEl.oninput = function () { F.q = qEl.value; F.page = 1; pageAssets(true); };   // 입력칸은 다시 그리지 않고 목록만 갱신 (한글 조합 유지)
    ['company', 'cat', 'status', 'collect'].forEach(function (id) { $('#' + id).onchange = function (e) { F[id] = e.target.value; F.page = 1; pageAssets(); }; });
    if (!window.__menuClose) { window.__menuClose = 1; document.addEventListener('click', function () { var m = document.getElementById('allmenu'); if (m) m.hidden = true; }); }
    function bindList() {
    bindSort('assets', function () { F.page = 1; pageAssets(true); });
    var selRows = function (on, rowsArr) { rowsArr.forEach(function (a) { if (on) F.sel[a.asset_no] = 1; else delete F.sel[a.asset_no]; }); pageAssets(true); };
    $('#prev').onclick = function () { F.page--; pageAssets(true); }; $('#next').onclick = function () { F.page++; pageAssets(true); };
    var all = $('#all'); all.checked = pageRows.length > 0 && pageSel === pageRows.length; all.indeterminate = pageSel > 0 && pageSel < pageRows.length;
    all.onchange = function () { selRows(pageSel < pageRows.length, pageRows); };   // 모두 선택된 상태에서 다시 누르면 해제
    $$('.sel').forEach(function (c) { c.onclick = function (e) { e.stopPropagation(); if (c.checked) F.sel[c.dataset.no] = 1; else delete F.sel[c.dataset.no]; pageAssets(true); }; });
    $$('tr.clk').forEach(function (r) { r.onclick = function () { location.hash = '#/asset/' + encodeURIComponent(r.dataset.no); }; });
    $$('[data-clr]').forEach(function (bt) { bt.onclick = function () { var k = bt.dataset.clr; F[k] = ''; F.page = 1; pageAssets(); }; });
    var ca = $('#clrall'); if (ca) ca.onclick = function (e) { e.preventDefault(); F.q = ''; F.dept = ''; F.cat = ''; F.catg = ''; F.status = ''; F.company = ''; F.collect = ''; F.page = 1; pageAssets(); };
    var bx = $('#b-xl'); if (bx) bx.onclick = function () { exportXlsx(S.assets.filter(function (a) { return F.sel[a.asset_no]; }), '선택자산'); };
    var bc = $('#b-clear'); if (bc) bc.onclick = function () { F.sel = {}; pageAssets(true); };
    var bd = $('#b-del'); if (bd) bd.onclick = function () { assetDeleteDlg('sel', S.assets.filter(function (a) { return F.sel[a.asset_no]; })); };
    var md = $('#m-del'); if (md) md.onclick = function () { assetDeleteDlg('all', list); };
    var bq = $('#b-qr'); if (bq) bq.onclick = function () { openQrDialog(list); };
    var ba = $('#b-all'); if (ba) ba.onclick = function (e) { e.stopPropagation(); var m = $('#allmenu'); m.hidden = !m.hidden; };
    var mp = $('#m-page'); if (mp) mp.onclick = function () { selRows(true, pageRows); };
    var mu = $('#m-unpage'); if (mu) mu.onclick = function () { selRows(false, pageRows); };
    var ma = $('#m-all'); if (ma) ma.onclick = function () { selRows(true, list); };
    var na = $('#n-all'); if (na) na.onclick = function (e) { e.preventDefault(); selRows(true, list); };
    var bs = $('#b-status'); if (bs) bs.onclick = async function () {
      var v = prompt('변경할 자산상태를 입력하세요 (예: 사용중, 재고, 수리중, 폐기)'); if (!v) return;
      try { for (var no in F.sel) { await dbUpdateAsset(no, { status: v.trim() }); await dbHistory(no, 'etc', '자산상태 변경 → ' + v.trim()); } F.sel = {}; toast('상태를 변경했습니다.'); pageAssets(true); } catch (e) { fail(e); }
    };
    }
    bindList();
    $('#xl').onclick = function () { exportXlsx(filtered(), '자산목록'); };
    $('#a_new').onclick = function () { location.hash = '#/asset-new'; };
  }
  function exportXlsx(list, name, silent) {
    var rows = list.map(function (a) {
      return { '관리번호': a.asset_no, '자산분류': a.category, '제조사': a.manufacturer, '모델명': a.model, '제조년월': a.mfg_ym, '자산상태': a.status, '사용자명': a.user_name, '사용자 ID': a.user_id, '소속명': a.dept, '회사': a.company, '직책': a.title, '위치': a.location, '구매일': a.purchase_date, '보증만료': a.warranty_end, '컴퓨터 이름': a.pc_name, 'IP': a.ip, 'MAC': a.mac, 'OS': a.os, 'CPU': a.cpu, 'RAM(GB)': a.ram_gb, '저장장치': a.storage, '그래픽카드': a.gpu, '최종 확인': a.last_seen ? ymd(a.last_seen) + ' ' + hm(a.last_seen) : '', '비고': a.memo };
    });
    var ws = XLSX.utils.json_to_sheet(rows), wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, name); XLSX.writeFile(wb, name + '_' + ymd(new Date()) + '.xlsx');
    if (!silent) logExport('자산 ' + name, rows.length);
  }
  // ---------- v1.9.6: 자산 삭제 (선택 삭제 · 조회 결과 전체 삭제, 메인 관리자 전용) ----------
  function assetDeleteDlg(mode, list) {
    if (!isMain()) { toast('자산 삭제는 메인 관리자만 할 수 있습니다.'); return; }
    var all = mode === 'all', n = list.length; if (!n) { toast(all ? '삭제할 조회 결과가 없습니다.' : '선택한 자산이 없습니다.'); return; }
    var nos = list.map(function (a) { return a.asset_no; }), word = all ? n.toLocaleString().replace(/,/g, '') + '건 삭제' : '삭제';
    var cond = [F.company && '회사 ' + F.company, F.catg && '유형 ' + F.catg, F.dept && '소속 ' + F.dept, F.cat && '분류 ' + F.cat, F.status && '상태 ' + F.status, F.collect && '수집상태 ' + F.collect, F.q.trim() && '검색 "' + F.q.trim() + '"'].filter(Boolean).join(' · ') || '조건 없음(전체)';
    var nDev = (S.devices || []).filter(function (d) { return nos.indexOf(d.asset_no) >= 0; }).length, nMon = (S.monitors || []).filter(function (x) { return nos.indexOf(x.asset_no) >= 0; }).length;
    var m = openModal('<div class="mh"><b>' + (all ? '조회된 ' + n.toLocaleString() + '건 전체 삭제' : '자산 ' + n.toLocaleString() + '건 삭제') + '</b><button class="mx" type="button">✕</button></div>' +
      '<div class="warnbox">' + (all ? '<b>현재 검색·필터 결과 ' + n.toLocaleString() + '건 전체</b>를 대장에서 완전히 삭제합니다.<br>조건: ' + esc(cond) + '<br>' : '선택한 자산 <b>' + n.toLocaleString() + '건</b>을 대장에서 완전히 삭제합니다.<br>') +
      '<b>삭제하면 되돌릴 수 없습니다.</b>' + (nDev || nMon ? '<br><span style="font-weight:400">PC 프로그램으로 수집된 PC ' + nDev + '대는 정보가 남고 \'미등록 PC\'로 바뀌며, 연결된 모니터 ' + nMon + '건은 연결이 해제됩니다.</span>' : '') + '</div>' +
      '<div class="ms">삭제 사유 (필수)</div><textarea id="ad_r" rows="2" style="width:100%;box-sizing:border-box" placeholder="예: 폐기 완료된 모니터 대장 정리"></textarea>' +
      '<label style="display:block;margin:8px 0"><input type="checkbox" id="ad_ex" checked' + (all ? ' disabled' : '') + '> 삭제 전에 ' + (all ? '조회된 ' + n.toLocaleString() + '건 전체 항목' : '선택한 자산') + '을 엑셀로 저장 ' + (all ? '<span style="color:#8a8a8a">(해제 불가)</span>' : '<span style="color:#1e8e3e">(권장)</span>') + '</label>' +
      (all ? '<label style="display:block;margin:8px 0"><input type="checkbox" id="ad_ok2"> 되돌릴 수 없음을 확인했습니다</label>' : '') +
      '<div class="ms">확인을 위해 <b>' + esc(word) + '</b> 을(를) 그대로 입력하세요</div><input type="text" id="ad_n" autocomplete="off" style="width:100%;box-sizing:border-box">' +
      '<div class="mf"><button class="btn" id="ad_x" type="button">취소</button><button class="btn dng sel" id="ad_ok" type="button" disabled>' + n.toLocaleString() + '건 삭제</button></div>', 480);
    function chk() { $('#ad_ok', m.d).disabled = !($('#ad_r', m.d).value.trim() && $('#ad_n', m.d).value.trim() === word && (!all || $('#ad_ok2', m.d).checked)); }
    $('#ad_r', m.d).oninput = chk; $('#ad_n', m.d).oninput = chk; if (all) $('#ad_ok2', m.d).onchange = chk; $('#ad_r', m.d).focus();
    $('#ad_x', m.d).onclick = m.close;
    $('#ad_ok', m.d).onclick = async function () {
      var rs = $('#ad_r', m.d).value.trim(), doEx = all || $('#ad_ex', m.d).checked, btn = this; btn.disabled = true; btn.textContent = '삭제 중…';
      try {
        needWrite();
        if (doEx) exportXlsx(list, '삭제한자산', true);
        var CH = 150;
        for (var i = 0; i < nos.length; i += CH) {
          var part = nos.slice(i, i + CH);
          if (!DEMO) { AC = { skip: 1, table: 'assets', t: Date.now() }; var r = await sb.from('assets').delete().in('asset_no', part); if (r.error) throw r.error; }
        }
        var set = {}; nos.forEach(function (x) { set[x] = 1; });
        S.assets = S.assets.filter(function (a) { return !set[a.asset_no]; });
        (S.devices || []).forEach(function (d) { if (set[d.asset_no]) { d.asset_no = null; d.link_source = null; } });
        S.monitors = (S.monitors || []).map(function (x) { if (set[x.asset_no]) x.asset_no = null; return x; });
        Object.keys(set).forEach(function (k) { delete F.sel[k]; });
        rebuildAssets();
        await auditPost({ action: 'delete', target: all ? '자산 목록 (조회 결과 전체)' : '자산 목록 (선택)', summary: '자산 ' + n.toLocaleString() + '건 삭제 (' + (all ? '조건: ' + cond : '선택 삭제') + ')' + (doEx ? ' · 삭제 전 엑셀 저장 완료' : ''), reason: rs, detail: { via: '자산 관리 · ' + (all ? '조회 결과 전체 삭제' : '선택 삭제'), note: '삭제 ' + n.toLocaleString() + '건 · 예: ' + nos.slice(0, 3).join(', ') + (n > 3 ? ' 외' : '') + ' · 자산별 삭제 내용은 삭제 전 엑셀에 저장' } });
        m.close(); toast('자산 ' + n.toLocaleString() + '건을 삭제했습니다.'); F.page = 1; pageAssets();
      } catch (e) { btn.disabled = false; btn.textContent = n.toLocaleString() + '건 삭제'; fail(e); }
    };
  }

  // ---------- QR 라벨 출력 (v1.9.2: 출력 대상·라벨 크기·여러 쪽) ----------
  var QRS = { small: { n: '작게', mm: 25, qr: 18, cols: 6, rows: 10 }, normal: { n: '보통', mm: 35, qr: 26, cols: 5, rows: 7 }, large: { n: '크게', mm: 45, qr: 36, cols: 4, rows: 5 } };
  var QRO = { size: 'normal', text: true, border: true, crisp: false }, QR_CHUNK = 500;
  function printQr(nos, o) {
    o = o || QRO; var s0 = QRS[o.size] || QRS.normal, per = s0.cols * s0.rows;
    logExport('QR 라벨', nos.length, 'QR 라벨 출력');
    var w = window.open('', '_blank'); if (!w) { toast('팝업이 차단되었습니다. 허용 후 다시 시도하세요.'); return; }
    var pages = '';
    for (var i = 0; i < nos.length; i += per) {
      pages += '<div class="pg">' + nos.slice(i, i + per).map(function (no) { var q = qrcode(0, 'M'); q.addData(no); q.make(); return '<div class="l">' + q.createSvgTag({ cellSize: 3, margin: 0 }) + (o.text ? '<div class="t">' + esc(no) + '</div>' : '') + '</div>'; }).join('') + '</div>';
    }
    var css = '@page{size:A4 portrait;margin:10mm}body{margin:0;font-family:"Malgun Gothic",sans-serif}.bar{padding:8px 12px;background:#f3f6fa;border-bottom:1px solid #d6dde6;font-size:13px}.bar button{height:30px;padding:0 16px;margin-right:10px}' +
      '.pg{display:grid;grid-template-columns:repeat(' + s0.cols + ',' + s0.mm + 'mm);grid-auto-rows:' + s0.mm + 'mm;justify-content:center;width:190mm;margin:6mm auto;page-break-after:always;break-after:page}.pg:last-child{page-break-after:auto;break-after:auto}' +
      '.l{box-sizing:border-box;width:' + s0.mm + 'mm;height:' + s0.mm + 'mm;display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden;' + (o.border ? 'outline:0.2mm dashed #999;outline-offset:-0.2mm;' : '') + '}' +
      '.l svg{width:' + s0.qr + 'mm;height:' + s0.qr + 'mm;' + (o.crisp ? 'shape-rendering:crispEdges;' : '') + '}.t{font-size:' + (s0.mm >= 45 ? 9 : s0.mm >= 35 ? 8 : 6) + 'pt;line-height:1.1;margin-top:.6mm;white-space:nowrap}@media print{.bar{display:none}.pg{margin:0 auto}}';
    w.document.write('<!doctype html><meta charset="utf-8"><title>QR 라벨 ' + nos.length + '개</title><style>' + css + '</style><div class="bar"><button onclick="print()">인쇄</button>' + nos.length.toLocaleString() + '개 · ' + Math.ceil(nos.length / per) + '쪽 · 라벨 ' + s0.mm + 'mm · 인쇄 창에서 배율을 100%(실제 크기)로 맞추세요</div>' + pages);
    w.document.close();
  }
  function openQrDialog(list) {
    if (isViewer()) { toast('조회 전용 계정은 QR 출력을 할 수 없습니다.'); return; }
    var inRes = list.filter(function (a) { return F.sel[a.asset_no]; }).map(function (a) { return a.asset_no; });
    var outN = Object.keys(F.sel).length - inRes.length, allNos = list.map(function (a) { return a.asset_no; });
    var cond = [F.company && '회사 ' + F.company, F.catg && '유형 ' + F.catg, F.dept && '소속 ' + F.dept, F.cat && '분류 ' + F.cat, F.status && '상태 ' + F.status, F.q.trim() && '검색 "' + F.q.trim() + '"'].filter(Boolean).join(' · ') || '조건 없음(전체)';
    var mode = inRes.length ? 'sel' : 'all', o = { size: QRO.size, text: QRO.text, border: QRO.border, crisp: QRO.crisp }, ci = 0;
    var d = document.createElement('div'); d.className = 'mdl';
    function sizeCard(k) { var z = QRS[k]; return '<label class="qsz' + (o.size === k ? ' on' : '') + '"><input type="radio" name="qs" value="' + k + '"' + (o.size === k ? ' checked' : '') + '> <b>' + z.n + (k === 'normal' ? ' (기본)' : '') + '</b><div>라벨 ' + z.mm + '×' + z.mm + 'mm · QR ' + z.qr + 'mm</div><div class="qn">한 장에 ' + (z.cols * z.rows) + '개 (' + z.cols + '×' + z.rows + ')</div></label>'; }
    function draw() {
      var N = mode === 'sel' ? inRes.length : allNos.length, z = QRS[o.size], per = z.cols * z.rows, pg = Math.ceil(N / per), K = Math.ceil(N / QR_CHUNK);
      if (ci >= K) ci = 0;
      d.innerHTML = '<div class="mbox"><div class="mh"><b>QR코드 출력</b><button type="button" class="mx" id="q-x">✕</button></div>' +
        '<div class="ms">출력 대상</div>' +
        '<label class="qtg' + (mode === 'sel' ? ' on' : '') + '"><input type="radio" name="qt" value="sel"' + (mode === 'sel' ? ' checked' : '') + (inRes.length ? '' : ' disabled') + '> <b>선택한 자산 ' + inRes.length.toLocaleString() + '개</b><div class="qn">체크한 항목만 출력합니다 (현재 검색 조건: ' + esc(cond) + ')</div></label>' +
        '<label class="qtg' + (mode === 'all' ? ' on' : '') + '"><input type="radio" name="qt" value="all"' + (mode === 'all' ? ' checked' : '') + '> <b>이 검색 결과 전체 ' + allNos.length.toLocaleString() + '건</b><div class="qn">체크하지 않아도 지금 화면의 검색·필터 결과를 모두 출력합니다 (여러 장)</div></label>' +
        (mode === 'sel' && outN > 0 ? '<div class="qwarn">이전 검색에서 체크해 둔 자산 <b>' + outN.toLocaleString() + '개</b>는 현재 검색 결과 밖에 있어 이번 출력에서 제외됩니다. <a href="#" id="q-clr">선택 해제</a></div>' : '') +
        '<div class="ms">라벨 크기 <span class="note">— 크기를 고르면 한 장에 들어가는 개수가 달라집니다 · 용지 A4 세로 · 여백 10mm</span></div>' +
        '<div class="qszs">' + sizeCard('small') + sizeCard('normal') + sizeCard('large') + '</div>' +
        '<div class="qopt"><label><input type="checkbox" id="qo-t"' + (o.text ? ' checked' : '') + '> 관리번호 글자 표시</label><label><input type="checkbox" id="qo-b"' + (o.border ? ' checked' : '') + '> 점선 테두리(자르는 선)</label><label><input type="checkbox" id="qo-c"' + (o.crisp ? ' checked' : '') + '> 흑백 선명 모드</label></div>' +
        '<div class="qsum">총 <b>' + N.toLocaleString() + '개</b> ÷ ' + per + '개 = <b>' + pg.toLocaleString() + '쪽</b>' + (N > QR_CHUNK ? ' · 한 번에 많이 열면 느릴 수 있어 <b>' + QR_CHUNK + '개씩(' + Math.ceil(QR_CHUNK / per) + '쪽)</b> 나눠 열 수 있습니다' : '') + '</div>' +
        (N > QR_CHUNK ? '<div class="qchunk">나눠 열기 <select id="q-ci">' + Array.apply(null, Array(K)).map(function (_, i) { return '<option value="' + i + '"' + (i === ci ? ' selected' : '') + '>' + QR_CHUNK + '개씩 · ' + K + '번째 중 ' + (i + 1) + '번째</option>'; }).join('') + '</select></div>' : '') +
        '<div class="mf"><button type="button" class="btn" id="q-cancel">취소</button><button type="button" class="btn pri" id="q-go"' + (N ? '' : ' disabled') + '>미리보기 · 인쇄</button></div></div>';
      $$('input[name=qt]', d).forEach(function (r) { r.onchange = function () { mode = r.value; draw(); }; });
      $$('input[name=qs]', d).forEach(function (r) { r.onchange = function () { o.size = r.value; draw(); }; });
      $('#qo-t', d).onchange = function () { o.text = this.checked; }; $('#qo-b', d).onchange = function () { o.border = this.checked; }; $('#qo-c', d).onchange = function () { o.crisp = this.checked; };
      var sc = $('#q-ci', d); if (sc) sc.onchange = function () { ci = +this.value; draw(); };
      var qc = $('#q-clr', d); if (qc) qc.onclick = function (e) { e.preventDefault(); F.sel = {}; close(); pageAssets(true); };
      $('#q-x', d).onclick = close; $('#q-cancel', d).onclick = close;
      $('#q-go', d).onclick = function () { var nos = (mode === 'sel' ? inRes : allNos); if (nos.length > QR_CHUNK) nos = nos.slice(ci * QR_CHUNK, (ci + 1) * QR_CHUNK); QRO = { size: o.size, text: o.text, border: o.border, crisp: o.crisp }; printQr(nos, QRO); };
    }
    function close() { document.removeEventListener('keydown', onKey); d.remove(); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey); d.onmousedown = function (e) { if (e.target === d) close(); };
    document.body.appendChild(d); draw();
  }

  // ---------- 자산 상세 ----------
  async function pageDetail(no) {
    var a = S.assets.filter(function (x) { return x.asset_no === no; })[0];
    if (!a) { shell('assets', '<h1>자산을 찾을 수 없습니다</h1><p><a href="#/assets">‹ 자산 목록</a></p>'); return; }
    var hist = S.history.filter(function (h) { return h.asset_no === no; });
    if (!DEMO) { var r = await sb.from('asset_history').select('*').eq('asset_no', no).order('created_at', { ascending: false }).limit(30); if (!r.error) hist = r.data; }
    var d = a._dev, e = a._emp, q = qrcode(0, 'M'); q.addData(no); q.make();
    function kv(k, v) { return '<div class="kv"><div class="k">' + k + '</div><div class="v">' + (v == null || v === '' ? '—' : v) + '</div></div>'; }
    function inp(id, label, val, type) { return '<div class="kv"><div class="k">' + label + '</div><div class="v"><input type="' + (type || 'text') + '" id="f_' + id + '" value="' + esc(val || '') + '" style="width:100%"></div></div>'; }
    shell('assets', '<div class="row wrap"><a href="#/assets">‹ 자산</a><h1 class="mono">' + esc(no) + '</h1>' + badge(a.status || '—', a.status === '사용중' ? 'ok' : 'gray') + (a.user_mismatch ? badge('사용자 불일치', 'warn') : '') + '<div class="grow"></div><button class="btn" id="qr">QR코드 출력</button><button class="btn pri" id="save">저장</button></div>' +
      '<div class="cards" style="margin-top:12px"><div class="card" style="flex:1.2"><h3>기본 정보 (대장)</h3><div class="row" style="align-items:flex-start"><div class="grow">' +
      kv('자산분류', esc(a.category)) + kv('제조사', esc(a.manufacturer)) + kv('모델명', esc(a.model)) + kv('제조년월', esc(a.mfg_ym)) +
      inp('status', '자산상태', a.status) + inp('user_name', '사용자명', a.user_name) + inp('user_id', '사용자 ID', a.user_id) + inp('dept', '소속명', a.dept) + coSel('f_company', a.company) + inp('title', '직책', a.title) + inp('location', '위치', a.location) + inp('serial_no', '시리얼 번호', a.serial_no) + inp('purchase_date', '구매일', a.purchase_date, 'date') + inp('warranty_end', '보증 만료', a.warranty_end, 'date') +
      '</div><div style="text-align:center;font-size:10px;color:#8a8a8a">' + q.createSvgTag({ cellSize: 3, margin: 0 }) + '<div>QR = 관리번호</div></div></div><div class="kv"><div class="k">메모</div><div class="v"><textarea id="f_memo">' + esc(a.memo || '') + '</textarea></div></div></div>' +
      '<div class="card" style="background:#f2f8fe"><h3>자동 수집 정보' + (d ? '' : ' <span class="badge b-gray">미수집</span>') + '</h3>' +
      (d ? kv('컴퓨터 이름', esc(d.computer_name)) + kv('OS', esc(d.os)) + kv('IP / MAC', esc(d.ip) + ' / ' + esc(d.mac)) + kv('CPU', esc(d.cpu)) + kv('RAM / 저장장치', esc((d.ram_gb || '—') + ' GB / ' + (d.storage || '—'))) + kv('그래픽카드', esc(d.gpu)) + kv('최종 확인', seenHtml(d.last_seen)) +
        kv('실행 사번', e ? esc(d.emp_no + ' (' + e.name + ', ' + (e.dept || '') + ')') : esc(d.emp_no)) +
        '<div style="margin-top:8px">' + (a.user_mismatch ? badge('대장 사용자와 다름', 'warn') : badge('대장 사용자와 일치', 'ok')) + ' ' + badge(d.link_source === 'auto' ? '자동 연결' : '수동 연결', 'gray') + ' <button class="btn sm" id="unlink">연결 해제</button></div>'
        : '<div class="note">이 자산에 연결된 PC가 없습니다. 사용자가 프로그램을 실행하면 자동으로 연결되거나, <a href="#/check/unreg">현황 점검 &gt; 미등록 PC</a>에서 연결할 수 있습니다.' + (isPc(a) ? '' : '<br>(모니터·서버 등은 자동 수집 대상이 아닙니다)') + '</div>') + '</div></div>' +
      monCardHtml(a, d) +
      '<div class="card" style="margin-top:12px"><h3>변경 이력</h3>' + (hist.map(function (h) { return '<div class="hist"><span class="d"></span><span class="t">' + esc(ymd(h.created_at) + ' ' + hm(h.created_at)) + '</span><span>' + esc(h.detail) + '</span></div>'; }).join('') || '<div class="note">이력이 없습니다.</div>') + '</div>');
    $('#qr').onclick = function () { printQr([no]); };
    bindMonCard(a, function () { pageDetail(no); });
    var ul = $('#unlink'); if (ul) ul.onclick = async function () { if (!confirm('연결을 해제할까요?')) return; try { await dbLink(d.id, null); await dbHistory(no, 'link', '연결 해제 (수동)', d.id); pageDetail(no); } catch (er) { fail(er); } };
    $('#save').onclick = async function () {
      var patch = {}; ['status', 'user_name', 'user_id', 'dept', 'company', 'title', 'location', 'serial_no', 'purchase_date', 'warranty_end', 'memo'].forEach(function (k) { var v = $('#f_' + k).value.trim(); patch[k] = v === '' ? null : v; });
      try {
        if ((patch.user_name || '') !== (a.user_name || '')) await dbHistory(no, 'user', '사용자 변경: ' + (a.user_name || '없음') + ' → ' + (patch.user_name || '없음') + ' (수동)', d && d.id);
        await dbUpdateAsset(no, patch); toast('저장했습니다.'); pageDetail(no);
      } catch (er) { fail(er); }
    };
  }

  // ---------- PC 점검 ----------
  function cpuYear(c) {   // CPU 이름에서 출시 연도를 추정 (모르면 null)
    c = String(c || ''); var m;
    if ((m = /Core\(TM\)\s*Ultra/i.exec(c))) return 2024;
    if ((m = /i[3579]-\s*(\d{4,5})/i.exec(c))) { var n = m[1], g = n.length === 5 ? +n.slice(0, 2) : +n.slice(0, 1);
      var T = { 2: 2011, 3: 2012, 4: 2013, 5: 2015, 6: 2015, 7: 2017, 8: 2017, 9: 2018, 10: 2020, 11: 2021, 12: 2021, 13: 2022, 14: 2023 }; return T[g] || null; }
    if ((m = /Ryzen\s*\d\s*(?:PRO\s*)?(\d)\d{3}/i.exec(c))) { var R = { 1: 2017, 2: 2018, 3: 2019, 4: 2021, 5: 2021, 6: 2022, 7: 2022, 8: 2024, 9: 2024 }; return R[m[1]] || null; }
    return null;
  }
  function assetYear(a) { var m = /(\d{4})/.exec(String(a.mfg_ym || a.purchase_date || '')); return m ? +m[1] : null; }
  var CKM = {
    asset_no: { f: function (a) { return a.asset_no; }, t: 's', l: '관리번호' }, pc: { f: function (a) { return a.pc_name; }, t: 's', l: '컴퓨터 이름' },
    user: { f: function (a) { return a.user_name; }, t: 's', l: '대장 사용자' }, emp: { f: function (a) { return a._dev && a._dev.emp_no; }, t: 's', l: '실제 실행 사번/성명' },
    seen: { f: function (a) { return a.last_seen; }, t: 'd', l: '최종 확인' }
  };
  var CKS = {
    asset_no: { f: function (d) { return d.asset_no; }, t: 's', l: '관리번호' }, pc: { f: function (d) { return d.computer_name; }, t: 's', l: '컴퓨터 이름' },
    user: { f: function (d) { var e = S.empBy[d.emp_no]; return e ? e.name : d.emp_no; }, t: 's', l: '사용자(실행 사번)' }, ip: { f: function (d) { return d.ip; }, t: 'ip', l: 'IP' },
    seen: { f: function (d) { return d.last_seen; }, t: 'd', l: '최종 확인' }
  };
  var CKU = {
    pc: { f: function (d) { return d.computer_name; }, t: 's', l: '컴퓨터 이름' }, emp: { f: function (d) { return d.emp_no; }, t: 's', l: '사번' },
    seen: { f: function (d) { return d.last_seen; }, t: 'd', l: '최종 확인' }
  };
  function pageCheck(tab) {
    tab = tab || 'mismatch';
    var hold = getHold();
    var mism = S.assets.filter(function (a) { return a.user_mismatch && !hold[a.asset_no]; });
    var stale = S.devices.filter(function (d) { return seen(d.last_seen).lvl === 'stale'; });
    var unreg = S.devices.filter(function (d) { return !d.asset_no; });
    function tabA(id, t, n) { return '<a href="#/check/' + id + '" class="' + (tab === id ? 'on' : '') + '">' + t + '<span class="c">' + n + '</span></a>'; }
    var body = '';
    if (tab === 'mismatch') {
      body = '<div class="note">자산대장의 사용자와 실제로 프로그램을 실행한 사번이 다른 PC입니다. 인사 이동이나 PC 교환이 대장에 반영되지 않았을 수 있습니다.</div>' + sortBar('chk1', CKM, mism.length) + '<table class="tbl" style="margin-top:10px"><thead><tr>' + thS('chk1', 'asset_no', '관리번호') + thS('chk1', 'pc', '컴퓨터 이름') + thS('chk1', 'user', '대장 사용자') + thS('chk1', 'emp', '실제 실행 사번 / 성명') + thS('chk1', 'seen', '최종 확인') + '<th>조치</th></tr></thead><tbody>' +
        (sortRows(mism, 'chk1', CKM).map(function (a) { var e = a._emp; return '<tr><td class="mono"><a href="#/asset/' + encodeURIComponent(a.asset_no) + '">' + esc(a.asset_no) + '</a></td><td>' + esc(a.pc_name) + '</td><td>' + esc(a.user_name) + ' (' + esc(a.dept) + ')</td><td>' + esc(a._dev.emp_no) + ' / ' + esc(e.name) + ' (' + esc(e.dept) + ')</td><td>' + seenHtml(a.last_seen) + '</td><td><button class="btn sm pri fix" data-no="' + esc(a.asset_no) + '">대장을 실제 사용자로 수정</button> <button class="btn sm hold" data-no="' + esc(a.asset_no) + '">보류</button></td></tr>'; }).join('') || '<tr><td colspan="6" class="note" style="padding:20px;text-align:center">불일치 건이 없습니다.</td></tr>') + '</tbody></table>';
    } else if (tab === 'stale') {
      body = '<div class="note">7일 이상 프로그램이 실행되지 않은 PC입니다. 휴가·퇴사·고장 여부를 확인하세요.</div>' + sortBar('chk2', CKS, stale.length) + '<table class="tbl" style="margin-top:10px"><thead><tr>' + thS('chk2', 'asset_no', '관리번호') + thS('chk2', 'pc', '컴퓨터 이름') + thS('chk2', 'user', '사용자(실행 사번)') + thS('chk2', 'ip', 'IP') + thS('chk2', 'seen', '최종 확인') + '</tr></thead><tbody>' +
        (sortRows(stale.sort(function (a, b) { return new Date(a.last_seen) - new Date(b.last_seen); }), 'chk2', CKS).map(function (d) { var e = S.empBy[d.emp_no]; return '<tr><td class="mono">' + (d.asset_no ? '<a href="#/asset/' + encodeURIComponent(d.asset_no) + '">' + esc(d.asset_no) + '</a>' : '미등록') + '</td><td>' + esc(d.computer_name) + '</td><td>' + esc(e ? e.name + ' (' + e.dept + ')' : d.emp_no) + '</td><td class="mono">' + esc(d.ip) + '</td><td>' + seenHtml(d.last_seen) + '</td></tr>'; }).join('') || '<tr><td colspan="5" class="note" style="padding:20px;text-align:center">해당 PC가 없습니다.</td></tr>') + '</tbody></table>';
    } else {
      var linked = {}; S.devices.forEach(function (d) { if (d.asset_no) linked[d.asset_no] = 1; });
      var free = S.assets.filter(function (a) { return isPc(a) && !linked[a.asset_no]; });
      S.skip = S.skip || {};
      function fld(k, v) { return '<div class="uk"><div class="note">' + k + '</div><b>' + esc(v || '—') + '</b></div>'; }
      body = '<div class="note">프로그램은 실행됐지만 대장의 관리번호(QR 스티커 번호)와 연결되지 않은 PC입니다. 수집한 사양과 대장 정보를 비교해 연결하세요.</div><div class="row" style="margin:8px 0"><span class="note">정렬</span><select id="ursort">' + [['', '기본 순서'], ['pc|asc', '컴퓨터 이름 ▲'], ['pc|desc', '컴퓨터 이름 ▼'], ['emp|asc', '사번 ▲'], ['emp|desc', '사번 ▼'], ['seen|desc', '최종 확인 ▼ (최근순)'], ['seen|asc', '최종 확인 ▲ (오래된 순)']].map(function (o) { var c = SORT.chk3 ? SORT.chk3.k + '|' + SORT.chk3.d : ''; return '<option value="' + o[0] + '"' + (o[0] === c ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></div><datalist id="free">' + free.slice(0, 800).map(function (a) { return '<option value="' + esc(a.asset_no) + '">' + esc((a.user_name || '') + ' ' + (a.model || '')) + '</option>'; }).join('') + '</datalist>' +
        (sortRows(unreg.filter(function (d) { return !S.skip[d.id]; }), 'chk3', CKU).map(function (d) {
          var e = S.empBy[d.emp_no], cy = cpuYear(d.cpu);
          var cands = free.filter(function (a) { return e && a.user_name === e.name; }).map(function (a) {
            var ay = assetYear(a), ok = null, diff = null;
            if (cy && ay) { diff = ay - cy; ok = diff >= 0 && diff <= 3 ? true : (diff < 0 || diff > 5 ? false : null); }
            return { a: a, ay: ay, ok: ok, diff: diff };
          });
          var best = null; cands.forEach(function (c) { if (c.ok === true && (!best || c.diff < best.diff)) best = c; });
          var sel = best || cands[0] || null;
          var cards = cands.length ? cands.map(function (c) {
            var why = c.ok === true ? '<span style="color:#1e8e3e">CPU 출시 ' + cy + '년 → 제조년월 ' + esc(c.a.mfg_ym || '') + '과 <b>시기 일치</b></span>' :
              c.ok === false ? '<span style="color:#c42b1c">CPU 출시(' + cy + '년)와 이 PC의 제조 시기(' + c.ay + '년)가 맞지 않음 → <b>시기 불일치</b></span>' :
              '<span class="note">' + (cy ? '시기를 판단하기 어렵습니다.' : '수집된 CPU로 출시 연도를 알 수 없어 비교하지 않았습니다.') + '</span>';
            return '<label class="ucand' + (sel === c ? ' on' : '') + '"><div class="ut"><input type="radio" name="pk' + esc(d.id) + '" value="' + esc(c.a.asset_no) + '"' + (sel === c ? ' checked' : '') + '> <b class="mono">' + esc(c.a.asset_no) + '</b>' + (best === c ? ' ' + badge('추천', 'ok') : '') + '</div>' +
              '<div style="font-size:12px;line-height:1.7">' + esc(c.a.manufacturer || '') + ' ' + esc(c.a.model || '') + ' · 제조년월 ' + esc(c.a.mfg_ym || '—') + ' · 구매일 ' + esc(c.a.purchase_date ? ymd(c.a.purchase_date) : '—') + '<br>소속 ' + esc(c.a.dept || '—') + ' · ' + esc(c.a.title || '') + ' · 상태 ' + esc(c.a.status || '') + '</div><div class="uw">' + why + '</div></label>';
          }).join('') : '<div class="note">같은 사용자(' + esc(e ? e.name : '?') + ') 명의의 연결 가능한 PC가 대장에 없습니다. 아래에 관리번호를 직접 입력하세요.</div>';
          return '<div class="card ucard" data-id="' + esc(d.id) + '"><div style="margin-bottom:8px"><b style="font-size:14px">' + esc(d.computer_name) + '</b> <span class="note">프로그램 실행: ' + seenHtml(d.last_seen) + ' · 사번 ' + esc(d.emp_no) + ' / ' + esc(e ? e.name : '?') + '</span></div>' +
            '<div class="uspec">' + fld('CPU', d.cpu) + fld('RAM', d.ram_gb ? d.ram_gb + ' GB' : '') + fld('그래픽카드', d.gpu) + fld('저장장치', d.storage) + fld('Windows', d.os) + fld('MAC', d.mac) + fld('IP', d.ip) + '</div>' +
            '<div style="font-size:12px;font-weight:600;margin:10px 0 6px">연결할 관리번호 선택' + (cands.length > 1 ? ' <span class="note" style="font-weight:400">· 같은 사용자 명의의 PC ' + cands.length + '대입니다. 수집한 사양과 대장 정보를 비교해 보세요</span>' : '') + '</div>' +
            '<div class="ucands">' + cards + '</div>' +
            '<div class="row" style="margin-top:10px"><span class="note">목록에 없으면</span><input type="text" list="free" class="ln" data-id="' + esc(d.id) + '" placeholder="관리번호 직접 입력" style="width:190px"><span class="grow"></span><button class="btn skip" data-id="' + esc(d.id) + '">건너뛰기</button><button class="btn pri link" data-id="' + esc(d.id) + '">' + (sel ? esc(sel.a.asset_no) + ' 으로 연결' : '연결') + '</button></div></div>';
        }).join('') || '<div class="note" style="padding:20px;text-align:center">미등록 PC가 없습니다.</div>') +
        '<div class="note">추천은 참고용입니다. CPU 출시 연도와 대장의 제조년월·구매일을 비교해 가장 가까운 후보를 미리 선택해 둡니다. 연결 후에는 이 PC에서 프로그램을 실행할 때마다 해당 자산이 자동으로 갱신됩니다.</div>';
    }
    shell('check', '<h1>현황 점검</h1><div class="tabs">' + tabA('mismatch', '사용자 불일치', mism.length) + tabA('stale', '7일 이상 미확인', stale.length) + tabA('unreg', '미등록 PC', unreg.length) + '</div>' + body);
    bindSort('chk1', function () { pageCheck(tab); }); bindSort('chk2', function () { pageCheck(tab); });
    var urs = $('#ursort'); if (urs) urs.onchange = function () { if (!urs.value) delete SORT.chk3; else { var p0 = urs.value.split('|'); SORT.chk3 = { k: p0[0], d: p0[1] }; } pageCheck('unreg'); };
    $$('.fix').forEach(function (b) { b.onclick = async function () {
      var a = S.assets.filter(function (x) { return x.asset_no === b.dataset.no; })[0], e = a._emp;
      try { await dbHistory(a.asset_no, 'user', '사용자 정정: ' + a.user_name + ' → ' + e.name + ' (점검 화면)', a._dev && a._dev.id);
        await dbUpdateAsset(a.asset_no, { user_name: e.name, user_id: e.emp_no, dept: e.dept, title: e.title }); toast('대장을 수정했습니다.'); pageCheck('mismatch'); } catch (er) { fail(er); }
    }; });
    $$('.hold').forEach(function (b) { b.onclick = function () { var h = getHold(); h[b.dataset.no] = 1; setHold(h); pageCheck('mismatch'); }; });
    $$('.skip').forEach(function (b) { b.onclick = function () { S.skip = S.skip || {}; S.skip[b.dataset.id] = 1; pageCheck('unreg'); }; });
    $$('.ucand input').forEach(function (r) { r.onchange = function () { var card = r.closest('.ucard'); card.querySelectorAll('.ucand').forEach(function (x) { x.classList.remove('on'); }); r.closest('.ucand').classList.add('on'); card.querySelector('.link').textContent = r.value + ' 으로 연결'; }; });
    $$('.link').forEach(function (b) { b.onclick = async function () {
      var rd = document.querySelector('input[name="pk' + b.dataset.id + '"]:checked'), no = ($('.ln[data-id="' + b.dataset.id + '"]').value.trim()) || (rd ? rd.value : '');
      var a = S.assets.filter(function (x) { return x.asset_no === no; })[0];
      if (!a) { toast('대장에 없는 관리번호입니다.'); return; }
      if (S.devices.some(function (d) { return d.asset_no === no; })) { toast('이미 다른 PC와 연결된 관리번호입니다.'); return; }
      try { await dbLink(b.dataset.id, no); await dbHistory(no, 'link', '수동 연결 (미등록 PC 점검)', b.dataset.id); toast('연결했습니다.'); pageCheck('unreg'); } catch (er) { fail(er); }
    }; });
  }

  // ---------- 데이터 관리 (엑셀 업로드/다운로드) ----------
  var ASSET_MAP = { asset_no: ['관리번호', '자산번호', 'QR번호', '자산코드'], category: ['자산분류', '분류', '자산유형'], manufacturer: ['제조사'], model: ['모델명', '모델'], mfg_ym: ['제조년월', '제조일'], status: ['자산상태', '상태'], user_name: ['사용자명', '사용자', '사용자 이름'], user_id: ['사용자 ID', '사용자ID', '사번', '사용자ID(사번)'], dept: ['소속명', '부서', '부서명', '조직명'], company: ['회사', '회사명', '법인', '법인명'], title: ['직책', '직위'], location: ['위치', '설치위치', '소속위치'], purchase_date: ['구매일', '구입일', '구매일자', '입고일자', '취득일자'], warranty_end: ['보증만료', '보증 만료', '보증만료일'], memo: ['비고', '메모'], serial_no: ['시리얼 넘버', '시리얼넘버', '시리얼번호', '시리얼 번호', '시리얼', '일련번호', 'S/N'] };
  var EMP_MAP = {
    emp_no: ['사번', '사원번호', '직원번호', '인사ID', '인사아이디'], name: ['성명', '이름'],
    dept: ['조직명', '부서', '부서명'], team: ['본부/팀', '소속', '본부', '소속명'],
    title: ['임직원호칭', '직책', '직위', '직급'], sales_title: ['영업직책'], duty: ['업무'],
    ext_no: ['회사번호(내선번호)', '내선번호', '회사번호'], address: ['주소'], joined_at: ['입사일', '입사일자'], status: ['재직상태', '재직구분']
  };
  var IMP = { assets: null, employees: null };
  function normDate(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') { var d = new Date(Math.round((v - 25569) * 86400 * 1000)); return isNaN(d) ? null : ymd(d); }
    if (v instanceof Date) return ymd(v);
    var s = String(v).trim().replace(/[./]/g, '-'); var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    return m ? m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2) : null;
  }
  function normYm(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number' && v > 20000) return ymd(normDate(v)).slice(0, 7);
    var s = String(v).trim().replace(/[./]/g, '-'); var m = /^(\d{4})-?(\d{1,2})/.exec(s);
    return m ? m[1] + '-' + ('0' + m[2]).slice(-2) : s;
  }
  function normH(h) { return String(h == null ? '' : h).replace(/\s+/g, '').toLowerCase(); }
  function parseSheet(buf, map, keyField) {
    var wb = XLSX.read(buf, { type: 'array', cellDates: true }), ws = wb.Sheets[wb.SheetNames[0]];
    var grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true, blankrows: false });
    if (!grid.length) return { rows: [], cols: [], skipped: 0 };
    // 항목 이름 줄 찾기: 위쪽 15줄 중 인식되는 항목이 가장 많은 줄 (보통 첫 줄)
    function matchRow(row) {
      var hs = row.map(normH), pick = {}, cols = [];
      Object.keys(map).forEach(function (f) {
        var idx = -1;
        map[f].some(function (n) { var k = hs.indexOf(normH(n)); if (k >= 0) { idx = k; return true; } return false; });
        if (idx >= 0) { pick[f] = idx; cols.push(f); }
      });
      return { pick: pick, cols: cols };
    }
    var best = { pick: {}, cols: [] }, bestAt = 0;
    for (var hi = 0; hi < Math.min(grid.length, 15); hi++) { var m = matchRow(grid[hi]); if (m.cols.length > best.cols.length) { best = m; bestAt = hi; } }
    var pick = best.pick, cols = best.cols, rows = [], skipped = 0;
    if (cols.indexOf(keyField) < 0) return { rows: [], cols: cols, skipped: 0 };
    grid.slice(bestAt + 1).forEach(function (r0) {
      var o = {};
      cols.forEach(function (f) {
        var v = r0[pick[f]];
        if (f === 'purchase_date' || f === 'warranty_end' || f === 'joined_at') v = normDate(v);
        else if (f === 'mfg_ym') v = normYm(v);
        else {
          v = (v == null || String(v).trim() === '') ? null : String(v).trim();
          if (v !== null && f !== keyField && /^[.\-]+$/.test(v)) v = null;   // "." 같은 빈칸 표시
        }
        o[f] = v;
      });
      if (!o[keyField]) { skipped++; return; }
      if (keyField === 'emp_no') o.emp_no = o.emp_no.toUpperCase();
      rows.push(o);
    });
    return { rows: rows, cols: cols, skipped: skipped };
  }

  // ---------- 지원 요청 (원격 지원 접수) ----------
  var SUP_ST = { received: ['접수', 'warn'], working: ['진행중', 'blue'], done: ['완료', 'ok'] };
  async function dbSupport(id, patch) {
    needWrite();
    var sq = S.support.filter(function (q) { return q.id === id; })[0] || {}, SL = { received: '접수 대기', working: '진행중', done: '완료' }, sch = [];
    if (patch.status && patch.status !== sq.status) sch.push({ k: '상태', from: SL[sq.status] || '없음', to: SL[patch.status] });
    if (patch.handler !== undefined && (patch.handler || '') !== (sq.handler || '')) sch.push({ k: '처리자', from: sq.handler || '없음', to: patch.handler || '없음' });
    if (patch.note !== undefined && (patch.note || '') !== (sq.note || '')) sch.push({ k: '처리 내용', from: sq.note || '없음', to: patch.note || '없음' });
    audCtx({ table: 'support_requests', action: patch.status && patch.status !== sq.status ? 'change' : 'update', target: '지원 요청 ' + (sq.req_no || '') + (sq.asset_no ? ' (자산 ' + sq.asset_no + ')' : ''), summary: '지원 요청 ' + (sq.req_no || '') + ' ' + (sch.length ? chgText(sch) : '수정'), detail: { changes: sch } });
    patch.updated_at = new Date().toISOString();
    if (!DEMO) { var r = await sb.from('support_requests').update(patch).eq('id', id); if (r.error) throw r.error; }
    var x = S.support.filter(function (q) { return q.id === id; })[0]; if (x) Object.assign(x, patch);
  }
  var SUPC = {
    req_no: { f: function (x) { return x.req_no; }, t: 's', l: '접수번호' }, created: { f: function (x) { return x.created_at; }, t: 'd', l: '접수 시각' },
    user: { f: function (x) { var e = S.empBy[x.emp_no]; return e ? e.name : x.emp_no; }, t: 's', l: '사용자' }, pc: { f: function (x) { return x.computer_name; }, t: 's', l: '컴퓨터 이름' },
    symptom: { f: function (x) { return x.symptom; }, t: 's', l: '증상' }, status: { f: function (x) { return { received: 0, working: 1, done: 2 }[x.status]; }, t: 'n', l: '상태' }
  };
  function pageSupport(arg) {
    var f = (arg || '').split('/'), sel = f[1] || '';
    var open = S.support.filter(function (x) { return x.status !== 'done'; }), done = S.support.filter(function (x) { return x.status === 'done'; });
    var todayL = S.support.filter(function (x) { return dayDiff(x.created_at) <= 0; }), today = todayL.length;
    var recL = S.support.filter(function (x) { return x.status === 'received'; }), wkL = S.support.filter(function (x) { return x.status === 'working'; });
    var rec = recL.length, wk = wkL.length;
    var TABS = ['received', 'working', 'done', 'today', 'all'];
    var tab = TABS.indexOf(f[0]) >= 0 ? f[0] : (rec ? 'received' : wk ? 'working' : S.support.length ? 'all' : 'received');   // 카드·탭으로 이동 (v1.9.2)
    var list = sortRows(tab === 'received' ? recL : tab === 'working' ? wkL : tab === 'done' ? done : tab === 'today' ? todayL : S.support, 'sup', SUPC);
    var cur = S.support.filter(function (x) { return x.id === sel; })[0] || list[0] || null;
    if (cur && list.indexOf(cur) < 0) cur = list[0] || null;
    function tabA(id, t, n) { return '<a href="#/support/' + id + '" class="' + (tab === id ? 'on' : '') + '">' + t + '<span class="c">' + n + '</span></a>'; }
    function kc(id, cls, t, n) { return '<a class="kpi go ' + cls + (tab === id ? ' on' : '') + '" href="#/support/' + id + '" title="누르면 ' + t + ' 목록으로 이동"><div class="t">' + t + '<span class="go-a">›</span></div><div class="n">' + n + '</div></a>'; }
    var kpi = '<div class="kpis">' + kc('received', 'warn', '접수 대기', rec) + kc('working', '', '진행중', wk) + kc('done', 'ok', '완료', done.length) + kc('today', '', '오늘 접수', today) + '</div>';
    var rows = list.map(function (x) {
      var e = S.empBy[x.emp_no], st = SUP_ST[x.status] || SUP_ST.received;
      return '<tr class="' + (cur && cur.id === x.id ? 'sel' : '') + '" data-id="' + esc(x.id) + '" style="cursor:pointer"><td class="mono">' + esc(x.req_no) + '</td><td>' + esc(ymd(x.created_at).slice(5) + ' ' + hm(x.created_at)) + '</td><td>' + esc(e ? e.name + ' / ' + e.dept : x.emp_no) + '</td><td>' + esc(x.computer_name) + '</td><td>' + esc(x.symptom || '—') + '</td><td>' + badge(st[0], st[1]) + '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="note" style="padding:20px;text-align:center">해당 요청이 없습니다.</td></tr>';
    var side = '';
    if (cur) {
      var e = S.empBy[cur.emp_no], a = S.assets.filter(function (z) { return z.asset_no === cur.asset_no; })[0], dv = S.devices.filter(function (z) { return z.computer_name === cur.computer_name; })[0] || (a && a._dev);
      side = '<div class="card"><h3 style="margin:0 0 8px;font-size:13px">선택: ' + esc(cur.req_no) + '</h3><div style="font-size:12px;line-height:1.9"><b>' + esc(e ? e.name : cur.emp_no) + '</b> / ' + esc(e ? e.dept : '') + ' / 사번 ' + esc(cur.emp_no) + '<br>' + esc(cur.computer_name) + ' · ' + esc(cur.ip || '') + '<br>' +
        (dv ? esc(osShort(dv.os)) + ' · ' + esc(cpuShort(dv.cpu)) + (dv.ram_gb ? ' · ' + esc(dv.ram_gb) + 'GB' : '') + '<br>' : '') +
        '연결 자산: ' + (cur.asset_no ? '<b><a href="#/asset/' + encodeURIComponent(cur.asset_no) + '">' + esc(cur.asset_no) + '</a></b>' : '미연결') + '<br>증상: ' + esc(cur.symptom || '—') + (cur.note ? '<br>처리 메모: ' + esc(cur.note) : '') + (cur.handler ? '<br>담당: ' + esc(cur.handler) : '') + '</div>' +
        '<textarea id="supnote" class="ln" rows="2" placeholder="처리 메모 (완료 시 자산 이력에 기록)" style="width:100%;margin-top:8px;box-sizing:border-box">' + esc(cur.note || '') + '</textarea>' +
        '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap"><button class="btn sm pri" id="supremote">원격 접속 열기</button>' +
        (cur.status === 'received' ? '<button class="btn sm" id="supwork">처리 시작</button>' : '') + (cur.status !== 'done' ? '<button class="btn sm" id="supdone">완료 처리</button>' : '<button class="btn sm" id="supreopen">다시 열기</button>') + '</div></div>' +
        '<div class="card" style="margin-top:10px"><h3 style="margin:0 0 6px;font-size:13px">접속 방법</h3><div class="note" style="line-height:1.7">1. [원격 접속 열기] → 원격 접속 매니저(ezHelpManager)가 실행됨<br>2. 로그인 후 대기 목록의 접속코드 6자리를 확인<br>3. 접속코드를 직원에게 전화·메신저로 안내 → 직원이 입력하면 연결<br>4. 처리 후 [완료 처리] + 메모 → 자산 이력에 기록<br><span style="color:#8a8a8a">※ 이 PC에 \"IT 자산 확인\" 프로그램이 한 번 실행된 적이 있어야 합니다. 별도 프로그램은 필요 없습니다.</span></div></div>';
    }
    var warn = S.supportErr ? '<div class="note" style="color:#c42b1c;margin-bottom:8px">지원 요청 표를 읽지 못했습니다. db/update_v1.1.sql 을 SQL Editor에서 실행했는지 확인하세요.</div>' : '';
    shell('support', '<h1>원격 지원</h1>' + warn + kpi + '<div class="tabs">' + tabA('received', '접수 대기', rec) + tabA('working', '진행중', wk) + tabA('done', '완료', done.length) + tabA('today', '오늘 접수', today) + tabA('all', '전체', S.support.length) + '</div>' +
      sortBar('sup', SUPC, list.length) + '<div style="display:flex;gap:14px;align-items:flex-start"><div style="flex:1;min-width:0"><table class="tbl"><thead><tr>' + thS('sup', 'req_no', '접수번호') + thS('sup', 'created', '접수 시각') + thS('sup', 'user', '사용자') + thS('sup', 'pc', '컴퓨터 이름') + thS('sup', 'symptom', '증상') + thS('sup', 'status', '상태') + '</tr></thead><tbody>' + rows + '</tbody></table></div><div style="width:320px;flex:none">' + side + '</div></div>');
    bindSort('sup', function () { pageSupport(arg); });
    $$('tr[data-id]').forEach(function (tr) { tr.onclick = function () { location.hash = '#/support/' + tab + '/' + tr.dataset.id; }; });
    if (!cur) return;
    var note = function () { var n = $('#supnote'); return n ? n.value.trim() : ''; };
    var who = adminLabel;
    var rm = $('#supremote'); if (rm) rm.onclick = function () {
      // v1.9.2: IT 자산 확인.exe 가 ezHelpManager 를 실행 (설치되어 있지 않으면 내장 설치 파일로 설치 후 실행)
      var fr = document.createElement('iframe'); fr.style.display = 'none'; fr.src = 'itasset-remote://open'; document.body.appendChild(fr);
      setTimeout(function () { fr.remove(); }, 3000);
      toast('원격 접속을 실행합니다. 아무 반응이 없으면 이 PC에서 "IT 자산 확인" 프로그램을 한 번 실행한 뒤 다시 눌러 주세요.');
    };
    var w = $('#supwork'); if (w) w.onclick = async function () { try { await dbSupport(cur.id, { status: 'working', handler: who() }); pageSupport(arg); } catch (er) { fail(er); } };
    var dn = $('#supdone'); if (dn) dn.onclick = async function () {
      try {
        await dbSupport(cur.id, { status: 'done', handler: cur.handler || who(), note: note() || null });
        if (cur.asset_no) await dbHistory(cur.asset_no, 'etc', '원격 지원 완료 (' + cur.req_no + '): ' + (cur.symptom || '') + (note() ? ' → ' + note() : ''), null);
        toast('완료 처리했습니다.'); pageSupport(arg);
      } catch (er) { fail(er); }
    };
    var ro = $('#supreopen'); if (ro) ro.onclick = async function () { try { await dbSupport(cur.id, { status: 'working' }); pageSupport(arg); } catch (er) { fail(er); } };
  }

  // ---------- v1.9.6: 회사 지정 (소속명 기준 일괄) ----------
  function coAssignHtml() {
    var g = {}; S.assets.forEach(function (a) { var d = a.dept || ''; if (!d) return; var o = g[d] = g[d] || { n: 0, co: {} }; o.n++; var c = CO.indexOf(a.company) >= 0 ? a.company : '미지정'; o.co[c] = (o.co[c] || 0) + 1; });
    var ds = Object.keys(g).sort(function (x, y) { return g[y].n - g[x].n || x.localeCompare(y); }), noCo = S.assets.filter(function (a) { return CO.indexOf(a.company) < 0; }).length;
    var rows = ds.map(function (d, i) {
      var o = g[d], cur = Object.keys(o.co).map(function (c) { return c + ' ' + o.co[c]; }).join(' · ');
      return '<tr><td>' + esc(d) + '</td><td class="num">' + o.n.toLocaleString() + '</td><td class="note">' + esc(cur) + '</td><td><select class="co_sel" data-i="' + i + '"><option value="">변경 안 함</option>' + CO.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('') + '<option value="__none">미지정으로</option></select></td></tr>';
    }).join('');
    return '<div class="card" style="margin-top:12px" id="co_card"><h2>회사 지정 <span class="note" style="font-weight:400">소속명별로 자산의 회사(원수사·A+에셋·파인랩)를 한 번에 지정</span></h2>' +
      '<div class="note" style="margin:4px 0 8px">회사 미지정 자산 <b style="color:' + (noCo ? '#c42b1c' : '#1e8e3e') + '">' + noCo.toLocaleString() + '건</b> · 소속명 ' + ds.length + '개 · 오른쪽에서 회사를 고르고 [적용]을 누르면 그 소속의 모든 자산에 반영됩니다. 자산 엑셀에 \'회사\' 열을 넣어 올려도 됩니다.</div>' +
      (ds.length ? '<div style="max-height:320px;overflow:auto"><table class="tbl"><thead><tr><th>소속명</th><th class="num">자산 수</th><th>현재 회사</th><th>지정할 회사</th></tr></thead><tbody>' + rows + '</tbody></table></div><div class="row" style="margin-top:8px"><span class="note" id="co_n">선택한 소속 없음</span><div class="grow"></div><button class="btn pri wonly" id="co_go" type="button" disabled>적용</button></div>' : '<div class="note">소속명이 있는 자산이 없습니다.</div>') + '</div>';
  }
  function bindCoAssign() {
    var ds = {}, order = []; S.assets.forEach(function (a) { var d = a.dept || ''; if (d && !ds[d]) { ds[d] = 1; } });
    var g = {}; S.assets.forEach(function (a) { var d = a.dept || ''; if (d) g[d] = (g[d] || 0) + 1; });
    order = Object.keys(g).sort(function (x, y) { return g[y] - g[x] || x.localeCompare(y); });
    function upd() { var n = $$('.co_sel').filter(function (s) { return s.value; }).length, b = $('#co_go'); if (!b) return; $('#co_n').textContent = n ? '선택한 소속 ' + n + '개' : '선택한 소속 없음'; b.disabled = !n; }
    $$('.co_sel').forEach(function (s) { s.onchange = upd; });
    var b = $('#co_go'); if (!b) return;
    b.onclick = async function () {
      var jobs = $$('.co_sel').filter(function (s) { return s.value; }).map(function (s) { return { dept: order[+s.dataset.i], co: s.value === '__none' ? null : s.value }; });
      if (!jobs.length) return;
      var cnt = jobs.reduce(function (t, j) { return t + g[j.dept]; }, 0);
      if (!confirm('소속 ' + jobs.length + '개, 자산 ' + cnt.toLocaleString() + '건의 회사를 바꿉니다. 계속할까요?')) return;
      b.disabled = true; b.textContent = '적용 중…';
      try {
        needWrite();
        for (var i = 0; i < jobs.length; i++) {
          var j = jobs[i], list = S.assets.filter(function (a) { return a.dept === j.dept; }), prev = {};
          list.forEach(function (a) { var c = CO.indexOf(a.company) >= 0 ? a.company : '미지정'; prev[c] = (prev[c] || 0) + 1; });
          audCtx({ table: 'assets', action: 'update', target: '회사 지정 · ' + j.dept, summary: '소속 ' + j.dept + ' 자산 ' + list.length.toLocaleString() + '건 회사 지정 → ' + (j.co || '미지정'), detail: { via: '데이터 관리 · 회사 지정', changes: [{ k: '회사', from: Object.keys(prev).map(function (c) { return c + ' ' + prev[c]; }).join(', '), to: (j.co || '미지정') + ' ' + list.length + '건' }] } });
          if (!DEMO) { var r = await sb.from('assets').update({ company: j.co, updated_at: new Date().toISOString() }).eq('dept', j.dept); if (r.error) throw r.error; }
          list.forEach(function (a) { a.company = j.co; });
        }
        rebuildAssets(); toast('회사를 지정했습니다. (' + cnt.toLocaleString() + '건)'); pageData();
      } catch (e) { fail(e); b.disabled = false; b.textContent = '적용'; if (/company/.test(String(e && e.message))) toast('SQL(update_v1.9.6.sql)을 실행했는지 확인하세요.'); }
    };
  }
  // ---------- v1.9.7: 시리얼 번호 채우기 (엑셀 다시 올리기) ----------
  function serialHtml() {
    var n = S.assets.filter(function (a) { return a.serial_no; }).length;
    return '<div class="card" style="margin-top:12px" id="ser_card"><h2>시리얼 번호 채우기 <span class="note" style="font-weight:400">처음 등록한 자산현황 엑셀의 ‘시리얼 넘버’를 읽어 대장의 빈 시리얼 번호를 채움</span></h2>' +
      '<div class="note" style="margin:4px 0 8px">현재 대장에 시리얼 번호가 있는 자산 <b>' + n.toLocaleString() + '</b> / ' + S.assets.length.toLocaleString() + '건 · 관리번호(자산코드)로 짝을 맞추고, 대장에서 비어 있는 칸만 채웁니다.</div>' +
      '<div class="drop"><input type="file" id="f_serial" accept=".xlsx,.xls,.csv"><div class="note" style="margin-top:6px">필수: 관리번호(자산코드), 시리얼 넘버(시리얼 번호)</div></div><div id="pv_serial" style="margin-top:10px"></div></div>';
  }
  function bindSerial() {
    var inp = $('#f_serial'); if (!inp) return;
    inp.onchange = function (e) {
      var f = e.target.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        var pv = $('#pv_serial');
        try {
          var p = parseSheet(rd.result, { asset_no: ASSET_MAP.asset_no, serial_no: ASSET_MAP.serial_no }, 'asset_no');
          if (p.cols.indexOf('asset_no') < 0 || p.cols.indexOf('serial_no') < 0) { pv.innerHTML = '<div class="err">관리번호(자산코드)와 시리얼 넘버(시리얼 번호) 항목을 모두 찾지 못했습니다. 첫 줄이 항목 이름인지 확인하세요.</div>'; return; }
          var by = {}; S.assets.forEach(function (a) { by[String(a.asset_no).toUpperCase()] = a; });
          var cnt = {}; p.rows.forEach(function (r) { if (r.serial_no) cnt[r.serial_no.toUpperCase()] = (cnt[r.serial_no.toUpperCase()] || 0) + 1; });
          var fill = [], diff = [], same = 0, nomatch = 0, noxl = 0;
          p.rows.forEach(function (r) {
            var a = by[String(r.asset_no).toUpperCase()];
            if (!a) { nomatch++; return; }
            if (!r.serial_no) { noxl++; return; }
            if (!a.serial_no) fill.push({ a: a, v: r.serial_no });
            else if (String(a.serial_no).trim().toUpperCase() === r.serial_no.toUpperCase()) same++;
            else diff.push({ a: a, v: r.serial_no });
          });
          var dupKeys = Object.keys(cnt).filter(function (k) { return cnt[k] > 1; }), dupN = dupKeys.reduce(function (t, k) { return t + cnt[k]; }, 0);
          function draw(over) {
            var tg = fill.length + (over ? diff.length : 0);
            var dl = diff.slice(0, 8).map(function (x) { return '<tr><td class="mono">' + esc(x.a.asset_no) + '</td><td class="mono">' + esc(x.a.serial_no) + '</td><td class="mono">' + esc(x.v) + '</td></tr>'; }).join('');
            pv.innerHTML = '<div class="card" style="background:#fafbfc"><h3>미리보기 <span class="note" style="font-weight:400">· ' + esc(f.name) + '</span></h3>' +
              '<div class="kpis"><div class="kpi ok"><div class="t">채울 항목 (대장이 빈 칸)</div><div class="n">' + fill.length.toLocaleString() + '</div></div><div class="kpi warn"><div class="t">다른 값이 이미 있음</div><div class="n">' + diff.length.toLocaleString() + '</div></div><div class="kpi"><div class="t">이미 같음</div><div class="n">' + same.toLocaleString() + '</div></div><div class="kpi"><div class="t">엑셀에 시리얼 없음·대장에 없는 관리번호</div><div class="n">' + (noxl + nomatch).toLocaleString() + '</div></div></div>' +
              '<div style="font-size:12px;margin:6px 0">다른 값이 이미 있으면 <label><input type="radio" name="ser_mode" value="keep"' + (over ? '' : ' checked') + '> 현재 값 유지</label> <label><input type="radio" name="ser_mode" value="over"' + (over ? ' checked' : '') + '> 엑셀 값으로 덮어쓰기</label></div>' +
              (diff.length ? '<div style="max-height:200px;overflow:auto"><table class="tbl"><thead><tr><th>관리번호</th><th>현재 대장 값</th><th>엑셀 값</th></tr></thead><tbody>' + dl + '</tbody></table></div>' + (diff.length > 8 ? '<div class="note">상위 8건만 표시 (전체 ' + diff.length + '건)</div>' : '') : '') +
              (dupKeys.length ? '<div class="note" style="margin-top:6px">같은 시리얼이 여러 자산에 있는 경우 ' + dupKeys.length + '종(' + dupN + '건)이 있습니다. 그대로 입력합니다. 예: ' + esc(dupKeys.slice(0, 3).join(', ')) + '</div>' : '') +
              '<div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn" id="ser_cancel">취소</button><button class="btn pri" id="ser_go"' + (tg ? '' : ' disabled') + '>시리얼 채우기 (' + tg.toLocaleString() + '건)</button></div></div>';
            $$('input[name=ser_mode]').forEach(function (r) { r.onchange = function () { draw(r.value === 'over'); }; });
            $('#ser_cancel').onclick = function () { pv.innerHTML = ''; inp.value = ''; };
            $('#ser_go').onclick = async function () {
              var btn = this; btn.disabled = true;
              var list = fill.concat(over ? diff : []);
              try {
                needWrite();
                var aoa = [['관리번호', '변경 전', '변경 후']]; list.forEach(function (x) { aoa.push([x.a.asset_no, x.a.serial_no || '', x.v]); });
                try { var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1'); XLSX.writeFile(wb, '시리얼_변경내역_' + new Date().toISOString().slice(0, 10) + '.xlsx'); } catch (x1) { }
                auditPost({ action: 'import', target: '자산 대장 · 시리얼 번호', summary: '시리얼 번호 일괄 채움 · ' + list.length.toLocaleString() + '건', detail: { via: '데이터 관리 · 시리얼 번호 채우기', note: esc(f.name), changes: [{ k: '시리얼 번호', from: '공란 ' + fill.length + '건' + (over ? ' · 다른 값 ' + diff.length + '건' : ''), to: '엑셀 값 ' + list.length + '건' }] } });
                var now = new Date().toISOString();
                for (var i = 0; i < list.length; i += 500) {
                  btn.textContent = '채우는 중… ' + Math.min(i + 500, list.length).toLocaleString() + ' / ' + list.length.toLocaleString();
                  var chunk = list.slice(i, i + 500).map(function (x) { return { asset_no: x.a.asset_no, serial_no: x.v, updated_at: now }; });
                  if (!DEMO) { AC = { skip: 1, table: 'assets', t: Date.now() }; var r = await sb.from('assets').upsert(chunk, { onConflict: 'asset_no' }); if (r.error) throw r.error; }
                }
                list.forEach(function (x) { x.a.serial_no = x.v; });
                if (!DEMO) await loadAll();
                toast('시리얼 번호 ' + list.length.toLocaleString() + '건을 채웠습니다.'); pageData();
                $('#pv_wide').innerHTML = '<div class="badge b-ok">완료: 시리얼 번호 ' + list.length.toLocaleString() + '건 (변경 내역 엑셀을 내려받았습니다)</div>';
              } catch (er) { fail(er); btn.disabled = false; }
            };
          }
          draw(false);
        } catch (er) { fail(er); }
      };
      rd.readAsArrayBuffer(f);
    };
  }
  function pageData() {
    var cats = groupCount(S.assets, function (a) { return a.category; }).map(function (x) { return x[0]; });
    var stats = groupCount(S.assets, function (a) { return a.status; }).map(function (x) { return x[0]; });
    var act = S.employees.filter(function (e) { return e.active !== false; }).length;
    function opts(ph, arr) { return '<option value="">' + ph + '</option>' + arr.map(function (o) { return '<option>' + esc(o) + '</option>'; }).join(''); }
    function sec(t, s) { return '<div class="dsec"><i></i>' + t + ' <span class="note">' + s + '</span></div>'; }
    function drop(id, msg) { return '<div class="drop"><input type="file" id="' + id + '" accept=".xlsx,.xls,.csv"><div class="note" style="margin-top:6px;line-height:1.7">' + msg + '</div></div>'; }
    shell('data', '<h1>데이터 관리</h1><div class="note" style="margin:4px 0 12px">자산 대장·인사 대장을 엑셀로 올리고 내려받습니다. 내려받은 파일은 올리는 파일과 같은 항목이라 그대로 다시 올릴 수 있습니다.</div>' +
      (!S.dates ? '<div class="note" style="color:#c42b1c;margin-bottom:8px">입사일·퇴사일 열이 아직 없습니다. 신규 입사자·퇴사자 조회를 쓰려면 SQL Editor에서 db/update_v1.8.sql 을 한 번 실행하세요.</div>' : '') +
      '<div class="dcards"><div class="card dcol"><h2>자산 대장</h2>' +
      sec('업로드', '관리번호(자산코드) 기준으로 추가·덮어쓰기') + drop('f_assets', '필수: 관리번호(자산코드) · 읽는 항목: 자산분류, 제조사, 모델명, 제조년월, 자산상태, 사용자, 소속, 직책, 위치, 구매일, 보증만료, 메모<br>itmgr의 [전체 다운로드] 파일을 그대로 올릴 수 있습니다.') +
      '<div class="dsep"></div>' + sec('다운로드', '현재 시스템에 등록된 자산') +
      '<div class="row wrap"><select id="dl_cat">' + opts('자산분류: 전체', cats) + '</select><select id="dl_st">' + opts('자산상태: 전체', stats) + '</select><span class="note" id="dl_cnt"></span><span class="grow"></span><button class="btn pri" id="dl_assets">엑셀 내려받기</button></div>' +
      '<div class="note" style="margin-top:8px">내려받은 파일은 위 업로드에 그대로 다시 올릴 수 있습니다. <button class="btn sm" id="tpl_assets">빈 양식 내려받기</button></div></div>' +
      '<div class="card dcol"><h2>인사 대장</h2>' +
      sec('업로드', '미리보기 → 적용 · 적용 이력에서 되돌리기') + drop('f_emp', '필수: 인사ID(사번), 이름(성명) · 읽는 항목: 본부/팀, 조직명, 임직원호칭, 영업직책, 업무, 회사번호(내선번호), 주소, 입사일<br><b>[적용]을 누르기 전에는 아무것도 바뀌지 않습니다.</b>') +
      '<div class="dsep"></div>' + sec('다운로드', '현재 시스템에 등록된 인사 명단') +
      '<div class="row wrap"><label style="font-size:12px"><input type="radio" name="dl_hr" value="act" checked> 재직자만 (' + act.toLocaleString() + '명)</label><label style="font-size:12px"><input type="radio" name="dl_hr" value="all"> 퇴사 포함 (' + S.employees.length.toLocaleString() + '명)</label><span class="grow"></span><button class="btn pri" id="dl_hr">엑셀 내려받기</button></div>' +
      '<div class="note" style="margin-top:8px">퇴사 포함 파일을 다시 올려도 "재직상태"가 퇴사인 사람은 재직으로 되돌아가지 않습니다. <button class="btn sm" id="tpl_hr">빈 양식 내려받기</button></div></div></div>' +
      coAssignHtml() + serialHtml() +
      '<div id="pv_wide" style="margin-top:12px"></div>');
    bindCoAssign(); bindSerial();
    function filt() { return S.assets.filter(function (a) { return (!$('#dl_cat').value || a.category === $('#dl_cat').value) && (!$('#dl_st').value || a.status === $('#dl_st').value); }); }
    function cnt() { $('#dl_cnt').innerHTML = '해당 <b style="color:#1a1a1a">' + filt().length.toLocaleString() + '</b>건'; }
    $('#dl_cat').onchange = cnt; $('#dl_st').onchange = cnt; cnt();
    $('#dl_assets').onclick = function () { var l = filt(); if (!l.length) { toast('내려받을 자산이 없습니다.'); return; } exportXlsx(l, '자산대장'); };
    $('#dl_hr').onclick = function () {
      var all = document.querySelector('input[name=dl_hr]:checked').value === 'all';
      var l = S.employees.filter(function (e) { return all || e.active !== false; }); if (!l.length) { toast('내려받을 명단이 없습니다.'); return; }
      empXlsx(l, all ? '인사명단_퇴사포함' : '인사명단');
    };
    function tpl(heads, name) { var ws = XLSX.utils.aoa_to_sheet([heads]), wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Sheet1'); XLSX.writeFile(wb, name + '.xlsx'); }
    $('#tpl_assets').onclick = function () { tpl(['관리번호', '자산분류', '제조사', '모델명', '제조년월', '자산상태', '사용자명', '사용자 ID', '소속명', '회사', '직책', '위치', '구매일', '보증만료', '비고'], '자산대장_양식'); };
    $('#tpl_hr').onclick = function () { tpl(['인사ID', '이름', '본부/팀', '조직명', '임직원호칭', '영업직책', '업무', '회사번호(내선번호)', '주소', '입사일'], '인사대장_양식'); };

    // ---- 자산 대장 업로드
    $('#f_assets').onchange = function (e) {
      var f = e.target.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        try {
          var p = parseSheet(rd.result, ASSET_MAP, 'asset_no'), pv = $('#pv_wide');
          if (p.cols.indexOf('asset_no') < 0) { pv.innerHTML = '<div class="err">필수 항목(관리번호 또는 자산코드)을 찾지 못했습니다. 첫 줄이 항목 이름인지 확인하세요.</div>'; return; }
          var head = p.cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('');
          var body = p.rows.slice(0, 5).map(function (r) { return '<tr>' + p.cols.map(function (c) { return '<td>' + esc(r[c]) + '</td>'; }).join('') + '</tr>'; }).join('');
          pv.innerHTML = '<div class="card"><h3>자산 대장 미리보기 <span class="note" style="font-weight:400">· ' + esc(f.name) + '</span></h3><div style="margin-bottom:6px"><b>' + p.rows.length.toLocaleString() + '건</b> 인식' + (p.skipped ? ' · 관리번호가 없어 제외 ' + p.skipped + '건' : '') + ' · 같은 관리번호는 덮어쓰고, 파일에 없는 항목은 그대로 둡니다.</div><div style="overflow:auto"><table class="tbl"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div><div class="note">처음 5건만 보여 줍니다.</div><div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn" id="a_cancel">취소</button><button class="btn pri" id="a_go">가져오기 실행 (' + p.rows.length.toLocaleString() + '건)</button></div></div>';
          $('#a_cancel').onclick = function () { pv.innerHTML = ''; $('#f_assets').value = ''; };
          $('#a_go').onclick = async function () {
            var btn = this; btn.disabled = true; btn.textContent = '가져오는 중…';
            try { await dbUpsert('assets', p.rows, 'asset_no'); await loadAll(); toast(p.rows.length.toLocaleString() + '건을 가져왔습니다.'); pageData(); $('#pv_wide').innerHTML = '<div class="badge b-ok">완료: 자산 ' + p.rows.length.toLocaleString() + '건</div>'; }
            catch (er) { fail(er); btn.disabled = false; btn.textContent = '다시 시도'; }
          };
        } catch (er) { fail(er); }
      };
      rd.readAsArrayBuffer(f);
    };

    // ---- 인사 대장 업로드 (미리보기 → 적용)
    $('#f_emp').onchange = function (ev) {
      var f = ev.target.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        try {
          var p = parseSheet(rd.result, EMP_MAP, 'emp_no'), pv = $('#pv_wide');
          if (p.cols.indexOf('emp_no') < 0 || p.cols.indexOf('name') < 0) { pv.innerHTML = '<div class="err">필수 항목(사번 또는 인사ID, 성명 또는 이름)을 찾지 못했습니다. 항목 이름 줄을 확인하세요.</div>'; return; }
          var baseD = firstOfMonth();
          function draw(deact) {
            var plan = planEmployees(p, deact);
            var outPct = act ? plan.outs.length / act : 0;
            var sum = '<div class="kpis"><div class="kpi ok"><div class="t">신규</div><div class="n">+' + plan.news.length + '</div></div><div class="kpi warn"><div class="t">변경</div><div class="n">' + plan.chgs.length + '</div></div><div class="kpi bad"><div class="t">퇴사(명단에서 빠짐)</div><div class="n">' + plan.outs.length + '</div></div><div class="kpi"><div class="t">오류·제외</div><div class="n">' + (plan.errs.length + p.skipped) + '</div><div class="s">동일 ' + plan.same + '명</div></div></div>';
            var rows = [];
            plan.chgs.forEach(function (x) { rows.push([x.r.emp_no, x.r.name, x.r.dept, x.r.team, x.r.title, '', '', tagH('변경 · ' + x.diffs.map(function (d) { return DF[d]; }).join('·'), 'warn')]); });
            plan.news.forEach(function (x) { rows.push([x.r.emp_no, x.r.name, x.r.dept, x.r.team, x.r.title, (S.dates ? (x.r.joined_at ? esc(x.r.joined_at) : esc(baseD) + ' <span class="note">예상</span>') : ''), '', tagH('신규', 'ok')]); });
            plan.outs.forEach(function (x) { rows.push([x.c.emp_no, x.c.name, x.c.dept, x.c.team, x.c.title, '', (S.dates ? esc(prevDay(baseD)) + ' <span class="note">예상</span>' : ''), tagH('퇴사 · 명단에서 빠짐', 'bad')]); });
            var shown = rows.slice(0, 200).map(function (r) { return '<tr><td class="mono">' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2] || '') + '</td><td>' + esc(r[3] || '') + '</td><td>' + esc(r[4] || '') + '</td><td>' + (r[5] || '') + '</td><td>' + (r[6] || '') + '</td><td>' + r[7] + '</td></tr>'; }).join('') || '<tr><td colspan="8" class="note" style="padding:14px;text-align:center">바뀌는 내용이 없습니다.</td></tr>';
            var err = plan.errs.length ? '<div class="err" style="margin:6px 0">오류 ' + plan.errs.length + '건은 제외됩니다: ' + esc(plan.errs.slice(0, 5).join(', ')) + (plan.errs.length > 5 ? ' …' : '') + '</div>' : '';
            var big = deact && outPct > 0.3 ? '<div class="err" style="margin:6px 0">퇴사 처리가 재직 인원의 ' + Math.round(outPct * 100) + '%입니다. 일부 인원만 담긴 파일이 아닌지 확인하세요. 아래 체크를 눌러야 적용할 수 있습니다.<br><label><input type="checkbox" id="emp_ok"> 확인했습니다</label></div>' : '';
            var total = plan.news.length + plan.chgs.length + plan.outs.length;
            pv.innerHTML = '<div class="card"><h3>인사 대장 미리보기 <span class="note" style="font-weight:400">· ' + esc(f.name) + ' · ' + p.rows.length.toLocaleString() + '명 인식' + (p.skipped ? ' · 사번 없는 행 ' + p.skipped + '건 제외' : '') + '</span></h3>' + sum +
              (S.dates ? '<div class="basebox"><b>명단 기준일</b><input type="date" id="emp_base" value="' + baseD + '"><span class="chips"><button class="chip' + (baseD === firstOfMonth() ? ' on' : '') + '" data-bd="cur">이번 달 1일</button><button class="chip" data-bd="next">다음 달 1일</button></span><span class="note" style="flex:1;min-width:300px">이 명단을 뽑은 날짜입니다. 새로 나온 사람의 <b>입사일 = 기준일(' + esc(baseD) + ')</b>, 빠진 사람의 <b>퇴사일 = 기준일 전날(' + esc(prevDay(baseD)) + ')</b>로 기록합니다(예상). 엑셀에 입사일 열이 있으면 그 값을 우선합니다.</span></div>' : '') +
              '<label style="font-size:12px;display:block;margin:6px 0"><input type="checkbox" id="emp_deact"' + (deact ? ' checked' : '') + '> 파일에 없는 사번은 퇴사 처리(사번 확인 불가)</label>' + err + big +
              '<div style="overflow:auto;max-height:340px"><table class="tbl"><thead><tr><th>사번(인사ID)</th><th>이름</th><th>조직명</th><th>본부/팀</th><th>호칭</th><th>입사일</th><th>퇴사일</th><th>상태</th></tr></thead><tbody>' + shown + '</tbody></table></div>' + (rows.length > 200 ? '<div class="note">상위 200건만 표시 (전체 ' + rows.length + '건 모두 적용됩니다)</div>' : '') +
              '<div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn" id="emp_cancel">취소</button><button class="btn pri" id="emp_go"' + (total ? '' : ' disabled') + '>적용 (' + (S.dates ? '기준일 ' + esc(baseD) + ' · ' : '') + '신규 ' + plan.news.length + ' · 변경 ' + plan.chgs.length + ' · 퇴사 ' + plan.outs.length + ')</button></div></div>';
            $('#emp_deact').onchange = function () { draw(this.checked); };
            var bi = $('#emp_base');
            if (bi) {
              bi.onchange = function () { if (/^\d{4}-\d{2}-\d{2}$/.test(this.value)) { baseD = this.value; draw($('#emp_deact').checked); } };
              $$('[data-bd]').forEach(function (b) { b.onclick = function () { var n = new Date(); baseD = b.dataset.bd === 'next' ? dstr(new Date(n.getFullYear(), n.getMonth() + 1, 1)) : firstOfMonth(); draw($('#emp_deact').checked); }; });
            }
            $('#emp_cancel').onclick = function () { pv.innerHTML = ''; $('#f_emp').value = ''; };
            $('#emp_go').onclick = async function () {
              var ok = $('#emp_ok'); if (big && !(ok && ok.checked)) { toast('퇴사 비율이 높습니다. 확인 체크가 필요합니다.'); return; }
              var btn = this; btn.disabled = true; btn.textContent = '적용 중…';
              try { await applyEmployees(plan, f.name, p.cols, S.dates ? baseD : null); toast('적용했습니다. (신규 ' + plan.news.length + ' · 변경 ' + plan.chgs.length + ' · 퇴사 ' + plan.outs.length + ')'); pageData(); $('#pv_wide').innerHTML = '<div class="badge b-ok">완료: 인사 대장 (신규 ' + plan.news.length + ' · 변경 ' + plan.chgs.length + ' · 퇴사 ' + plan.outs.length + ') — 인사 명단 > 적용 이력에서 되돌릴 수 있습니다.</div>'; }
              catch (er) { fail(er); btn.disabled = false; btn.textContent = '다시 시도'; }
            };
          }
          draw(true);
        } catch (er) { fail(er); }
      };
      rd.readAsArrayBuffer(f);
    };
  }

  // ---------- 인사 명단 (재적·전체·신규 입사자·퇴사자·적용 이력) ----------
  var EMP_FIELDS = ['name', 'dept', 'team', 'title', 'sales_title', 'duty', 'ext_no', 'address'];
  function EF() { return S.dates ? EMP_FIELDS.concat(['joined_at', 'left_at']) : EMP_FIELDS; }
  function tdy() { return ymd(new Date()); }
  function estH(e, k) { return (S.est && e[k + '_est'] && e[k + '_at']) ? ' <span class="note" title="엑셀 명단 기준일로 추정한 날짜입니다. [수정]에서 직접 입력하면 사라집니다.">예상</span>' : ''; }
  function prevDay(d) { var x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() - 1); return x.getFullYear() + '-' + ('0' + (x.getMonth() + 1)).slice(-2) + '-' + ('0' + x.getDate()).slice(-2); }
  function firstOfMonth() { var n = new Date(); return n.getFullYear() + '-' + ('0' + (n.getMonth() + 1)).slice(-2) + '-01'; }
  function empSnap(c) { var o = { emp_no: c.emp_no, active: c.active !== false }; EF().forEach(function (f) { o[f] = c[f] == null ? null : c[f]; }); if (S.est) { o.joined_est = !!c.joined_est; o.left_est = !!c.left_est; } return o; }
  var EMPV = { q: '', st: 'all', from: null, to: null, chip: '이번 달' };
  function pad2(n) { return ('0' + n).slice(-2); }
  function dstr(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function periodFor(chip) {
    var n = new Date(), y = n.getFullYear(), m = n.getMonth();
    if (chip === '이번 달') return [dstr(new Date(y, m, 1)), dstr(new Date(y, m + 1, 0))];
    if (chip === '지난 달') return [dstr(new Date(y, m - 1, 1)), dstr(new Date(y, m, 0))];
    if (chip === '최근 3개월') return [dstr(new Date(y, m - 2, 1)), dstr(new Date(y, m + 1, 0))];
    if (chip === '올해') return [y + '-01-01', y + '-12-31'];
    return null;
  }
  function period() { if (!EMPV.from) { var p = periodFor('이번 달'); EMPV.from = p[0]; EMPV.to = p[1]; } return [EMPV.from, EMPV.to]; }
  function inRange(d, p) { return !!d && String(d).slice(0, 10) >= p[0] && String(d).slice(0, 10) <= p[1]; }
  function srcOf(no, kind) {
    for (var i = 0; i < S.imports.length; i++) {
      var x = S.imports[i]; if (x.reverted_at) continue;
      var hit = kind === 'add' ? (x.added_keys || []).indexOf(no) >= 0 : (x.deactivated > 0 && (x.before_rows || []).some(function (b) { return b.emp_no === no; }));
      if (hit) return /^직접/.test(x.file_name || '') ? (kind === 'add' ? '직접 등록' : '직접 처리') : '엑셀 적용';
    }
    return '—';
  }
  function devCount(no) { return S.devices.filter(function (d) { return d.emp_no === no; }).length; }
  var EMPV_PLAN = null;
  function planEmployees(p, deactivateMissing) {
    var cur = {}; S.employees.forEach(function (e) { cur[e.emp_no] = e; });
    var seen = {}, plan = { rows: [], news: [], chgs: [], outs: [], same: 0, errs: [] };
    p.rows.forEach(function (r) {
      if (!r.name) { plan.errs.push(r.emp_no + ': 성명 없음'); return; }
      if (seen[r.emp_no]) { plan.errs.push(r.emp_no + ': 파일 안에서 중복'); return; }
      seen[r.emp_no] = 1;
      var c = cur[r.emp_no];
      if (r.status && /퇴사|퇴직/.test(r.status)) { if (c && c.active !== false) plan.outs.push({ c: c }); else plan.same++; return; }   // 내려받은 파일의 '재직상태' 열
      if (!c) { plan.news.push({ r: r }); return; }
      var diffs = [];
      EF().forEach(function (f) { if (f === 'left_at') return; if (p.cols.indexOf(f) >= 0 && String(c[f] == null ? '' : c[f]) !== String(r[f] == null ? '' : r[f])) diffs.push(f); });
      if (c.active === false) diffs.push('active');
      if (diffs.length) plan.chgs.push({ r: r, c: c, diffs: diffs }); else plan.same++;
    });
    if (deactivateMissing) S.employees.forEach(function (e) { if (e.active !== false && !seen[e.emp_no]) plan.outs.push({ c: e }); });
    return plan;
  }
  var DF = { name: '이름', dept: '조직명', team: '본부/팀', title: '호칭', sales_title: '영업직책', duty: '업무', ext_no: '내선', address: '주소', joined_at: '입사일', active: '재직 복귀' };
  function tagH(t, k) { return '<span class="badge b-' + k + '">' + esc(t) + '</span>'; }
  async function applyEmployees(plan, fileName, cols, baseDate) {
    var before = [], addedKeys = [], now = new Date().toISOString(), td = baseDate || tdy(), outD = baseDate ? prevDay(baseDate) : tdy();
    var up = [];
    function mk(x, base) {
      var o = { emp_no: x.r.emp_no, active: true, updated_at: now };
      EMP_FIELDS.forEach(function (f) { o[f] = cols.indexOf(f) >= 0 ? (x.r[f] == null ? null : x.r[f]) : (base && base[f] != null ? base[f] : null); });
      if (S.dates) {
        var hasJ = cols.indexOf('joined_at') >= 0 && x.r.joined_at;
        o.joined_at = hasJ ? x.r.joined_at : (base ? (base.joined_at || null) : td);
        o.left_at = null;
        if (S.est) { o.joined_est = hasJ ? false : (base ? !!base.joined_est : true); o.left_est = false; }
      }
      return o;
    }
    plan.news.forEach(function (x) { addedKeys.push(x.r.emp_no); up.push(mk(x, null)); });
    plan.chgs.forEach(function (x) { before.push(empSnap(x.c)); up.push(mk(x, x.c)); });
    plan.outs.forEach(function (x) { before.push(empSnap(x.c)); var o = empSnap(x.c); o.active = false; o.updated_at = now; if (S.dates) o.left_at = outD; if (S.est) o.left_est = true; up.push(o); });
    await dbUpsert('employees', up, 'emp_no');
    var rec = { applied_at: now, applied_by: adminLabel(), file_name: fileName, added: plan.news.length, changed: plan.chgs.length, deactivated: plan.outs.length, added_keys: addedKeys, before_rows: before, reverted_at: null };
    if (!DEMO) { var r = await sb.from('employee_imports').insert(rec).select().single(); if (r.error) throw r.error; rec = r.data; }
    else rec.id = Date.now();
    S.imports.unshift(rec);
    if (DEMO) { /* dbUpsert 가 데모 목록을 갱신함 */ } else await loadAll();
  }
  async function revertImport(rec) {
    var up = (rec.before_rows || []).map(function (b) { return Object.assign({}, b, { updated_at: new Date().toISOString() }); });
    (rec.added_keys || []).forEach(function (k) {
      var c = S.empBy && S.empBy[k] ? S.empBy[k] : (S.employees.filter(function (e) { return e.emp_no === k; })[0]);
      if (c) { var o = empSnap(c); o.active = false; o.updated_at = new Date().toISOString(); up.push(o); }
    });
    await dbUpsert('employees', up, 'emp_no');
    var ts = new Date().toISOString();
    if (!DEMO) { var r = await sb.from('employee_imports').update({ reverted_at: ts }).eq('id', rec.id); if (r.error) throw r.error; }
    rec.reverted_at = ts;
    if (!DEMO) await loadAll(); else rebuildAssets();
  }
  function dupGroups() {
    var by = {}; S.devices.forEach(function (d) { if (d.emp_no) (by[d.emp_no] = by[d.emp_no] || []).push(d); });
    return Object.keys(by).filter(function (k) { return by[k].length > 1; }).map(function (k) { return { emp_no: k, devs: by[k] }; });
  }
  async function dbDevEmp(deviceId, empNo, hist) {
    audCtx({ table: 'devices', action: 'change', target: '수집 PC ' + deviceId, summary: 'PC 사용자 사번 변경 → ' + (empNo || '없음') });
    needWrite();
    if (!DEMO) { var r = await sb.from('devices').update({ emp_no: empNo }).eq('id', deviceId); if (r.error) throw r.error; }
    var d = S.devices.filter(function (x) { return x.id === deviceId; })[0]; if (d) d.emp_no = empNo;
    await dbHistory(d ? d.asset_no : null, 'user', hist, deviceId);
    rebuildAssets();
  }
  // 직접 등록·수정·퇴사 처리 (적용 이력에 "직접 등록"으로 남고 되돌릴 수 있음)
  async function saveManual(rowsBefore, addedKeys, up, label, counts) {
    await dbUpsert('employees', up, 'emp_no');
    var now = new Date().toISOString();
    var rec = { applied_at: now, applied_by: adminLabel(), file_name: label, added: counts[0], changed: counts[1], deactivated: counts[2], added_keys: addedKeys, before_rows: rowsBefore, reverted_at: null };
    if (!DEMO) {
      if (!S.impErr) { var r = await sb.from('employee_imports').insert(rec).select().single(); if (r.error) throw r.error; rec = r.data; }
    } else rec.id = Date.now();
    if (DEMO || !S.impErr) S.imports.unshift(rec);
    if (!DEMO) await loadAll(); else rebuildAssets();
  }
  async function empQuick(no, activate, tab) {
    var c = S.employees.filter(function (e) { return e.emp_no === no; })[0]; if (!c) return;
    if (!confirm(c.name + ' (' + no + ') 님을 ' + (activate ? '재직(복직) 상태로 되돌립니다.' : '퇴사 처리합니다.\n이후 PC 프로그램의 [사번 확인]에서 확인되지 않습니다. (적용 이력에서 되돌릴 수 있습니다)') + '\n계속할까요?')) return;
    var o = empSnap(c); o.active = !!activate; o.updated_at = new Date().toISOString(); if (S.dates) { o.left_at = activate ? null : tdy(); if (S.est) o.left_est = false; }
    try { await saveManual([empSnap(c)], [], [o], '직접 등록 (' + (activate ? '복직' : '퇴사 처리') + ')', [0, activate ? 1 : 0, activate ? 0 : 1]); toast(activate ? '복직 처리했습니다.' : '퇴사 처리했습니다.'); pageEmployees(tab); } catch (er) { fail(er); }
  }
  function empForm(no, tab) {
    var cur = no ? S.employees.filter(function (e) { return e.emp_no === no; })[0] : null;
    var old = $('#emp_dr'); if (old) old.remove();
    function f(id, label, req, ph, val, ro, type) { return '<div class="ff"><label for="ef_' + id + '">' + label + (req ? ' <span style="color:#c42b1c">*</span>' : '') + '</label><input type="' + (type || 'text') + '" id="ef_' + id + '" placeholder="' + ph + '" value="' + esc(val == null ? '' : val) + '"' + (ro ? ' readonly style="background:#f3f4f6"' : '') + ' autocomplete="off"></div>'; }
    var v = cur || {};
    var d = document.createElement('div'); d.id = 'emp_dr'; d.className = 'drawer-wrap';
    d.innerHTML = '<div class="drawer-bg"></div><div class="drawer"><div class="row" style="margin-bottom:12px"><h2 style="flex:1">' + (cur ? '직원 정보 수정' : '직원 직접 등록') + '</h2><button class="btn sm" id="ef_x">✕</button></div>' +
      '<div class="two">' + f('emp_no', '사번(인사ID)', true, '예: 10000003', v.emp_no, !!cur) + f('name', '이름', true, '예: 홍길동', v.name) + '</div>' +
      '<div class="two">' + f('team', '본부/팀', false, '예: 경영지원본부', v.team) + f('dept', '조직명', false, '예: IT지원팀', v.dept) + '</div>' +
      '<div class="two">' + f('title', '임직원호칭', false, '예: 사원', v.title) + f('sales_title', '영업직책', false, '예: TFA', v.sales_title) + '</div>' +
      '<div class="two">' + f('duty', '업무', false, '예: IT 지원', v.duty) + f('ext_no', '회사번호(내선번호)', false, '예: 02-2009-5620', v.ext_no) + '</div>' +
      f('address', '주소', false, '예: 서울 강남구 테헤란로4길 14', v.address) +
      (S.dates ? '<div class="two">' + f('joined_at', '입사일', false, '', v.joined_at, false, 'date') + f('left_at', '퇴사일', false, '', v.left_at, false, 'date') + '</div>' : '') +
      '<div class="note" id="ef_msg" style="background:#f3f8fd;border-radius:6px;padding:8px 10px;margin:8px 0 12px">· 사번이 이미 있으면 "수정"으로 저장되고, 없으면 신규로 등록됩니다.' + (S.dates ? ' 입사일을 비워 두면 오늘 날짜로 기록됩니다.' : '') + '<br>· 저장하면 바로 반영되고, 적용 이력에 "직접 등록"으로 남아 되돌릴 수 있습니다.</div>' +
      '<div class="row" style="justify-content:flex-end"><button class="btn" id="ef_cancel">취소</button><button class="btn pri" id="ef_save">저장</button></div></div>';
    document.body.appendChild(d);
    function close() { d.remove(); document.removeEventListener('keydown', esc2); }
    function esc2(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', esc2);
    $('#ef_x').onclick = close; $('#ef_cancel').onclick = close; $('.drawer-bg', d).onclick = close;
    setTimeout(function () { var t = $(cur ? '#ef_name' : '#ef_emp_no'); if (t) t.focus(); }, 30);
    $('#ef_save').onclick = async function () {
      var g = function (id) { return $('#ef_' + id).value.trim(); };
      var key = g('emp_no').replace(/\s+/g, '').toUpperCase(), nm = g('name'), msg = $('#ef_msg');
      if (!key || !nm) { msg.style.cssText += ';background:#fdecea;color:#c42b1c'; msg.textContent = '사번(인사ID)과 이름은 꼭 입력해야 합니다.'; return; }
      var ex = S.employees.filter(function (e) { return e.emp_no === key; })[0];
      if (!cur && ex && !confirm(key + ' 는 이미 등록된 사번입니다 (' + ex.name + ').\n입력한 내용으로 수정할까요?')) return;
      var o = { emp_no: key, active: ex ? ex.active !== false : true, updated_at: new Date().toISOString() };
      EMP_FIELDS.forEach(function (fl) { o[fl] = fl === 'name' ? nm : (g(fl) || null); });
      if (S.dates) { var jd = g('joined_at') || null, ld = g('left_at') || null; if (!ex && !jd) jd = tdy(); o.joined_at = jd; o.left_at = ld; if (S.est) { o.joined_est = (ex && jd === ex.joined_at) ? !!ex.joined_est : false; o.left_est = (ex && ld === ex.left_at) ? !!ex.left_est : false; } }
      var btn = this; btn.disabled = true; btn.textContent = '저장 중…';
      try {
        if (ex) await saveManual([empSnap(ex)], [], [o], '직접 등록 (수정)', [0, 1, 0]);
        else await saveManual([], [key], [o], '직접 등록 (신규)', [1, 0, 0]);
        close(); toast(ex ? '수정했습니다.' : '등록했습니다.'); pageEmployees(tab);
      } catch (er) { fail(er); btn.disabled = false; btn.textContent = '저장'; }
    };
  }
  function empXlsx(list, name) {
    var rows = list.map(function (e) { return { '인사ID': e.emp_no, '이름': e.name, '본부/팀': e.team, '조직명': e.dept, '임직원호칭': e.title, '영업직책': e.sales_title, '업무': e.duty, '회사번호(내선번호)': e.ext_no, '주소': e.address, '입사일': e.joined_at, '퇴사일': e.left_at, '재직상태': e.active === false ? '퇴사' : '재직' }; });
    var ws = XLSX.utils.json_to_sheet(rows), wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, name); XLSX.writeFile(wb, name + '_' + ymd(new Date()) + '.xlsx');
    logExport('인사 명단', rows.length);
  }
  var EC = {
    emp_no: { f: function (e) { return e.emp_no; }, t: 's', l: '사번' }, name: { f: function (e) { return e.name; }, t: 's', l: '이름' },
    dept: { f: function (e) { return e.dept; }, t: 's', l: '조직명' }, team: { f: function (e) { return e.team; }, t: 's', l: '본부/팀' },
    title: { f: function (e) { return e.title; }, t: 's', l: '호칭' }, sales: { f: function (e) { return e.sales_title; }, t: 's', l: '영업직책' },
    duty: { f: function (e) { return e.duty; }, t: 's', l: '업무' }, ext: { f: function (e) { return e.ext_no; }, t: 's', l: '내선' },
    st: { f: function (e) { return e.active === false ? 1 : 0; }, t: 'n', l: '상태' }, joined: { f: function (e) { return e.joined_at; }, t: 'd', l: '입사일' },
    left: { f: function (e) { return e.left_at; }, t: 'd', l: '퇴사일' }
  };
  function pageEmployees(arg) {
    var tab = { all: 'all', 'new': 'new', out: 'out', history: 'history' }[arg] || 'act';
    var P = period();
    var act = S.employees.filter(function (e) { return e.active !== false; });
    var nw = S.employees.filter(function (e) { return inRange(e.joined_at, P); });
    var outs = S.employees.filter(function (e) { return e.active === false && inRange(e.left_at, P); });
    var dups = dupGroups();
    var warn = S.impErr ? '<div class="note" style="color:#c42b1c;margin-bottom:8px">적용 이력 표를 읽지 못했습니다. db/update_v1.6.sql 을 SQL Editor에서 실행했는지 확인하세요.</div>' : '';
    var warn2 = !S.dates ? '<div class="note" style="color:#c42b1c;margin-bottom:8px">입사일·퇴사일 열이 아직 없습니다. SQL Editor에서 db/update_v1.8.sql 을 한 번 실행하면 신규 입사자·퇴사자 기간 조회가 켜집니다. (그 전에도 나머지 기능은 동작합니다.)</div>' : '';
    function tabA(id, t, n) { return '<a href="#/employees/' + id + '" class="' + (tab === id ? 'on' : '') + '">' + t + (n != null ? '<span class="c">' + n + '</span>' : '') + '</a>'; }
    function kc(id, t, n, s, cls) { return '<a class="kpi ' + (cls || '') + (tab === id ? ' sel' : '') + '" href="#/employees/' + id + '"><div class="t">' + t + '</div><div class="n">' + n + '</div><div class="s">' + s + '</div></a>'; }
    var pl = EMPV.chip === '직접 선택' ? '선택 기간' : EMPV.chip;
    var kpi = '<div class="kpis">' + kc('act', '재적 인원', act.length.toLocaleString(), '현재 명단') + kc('all', '전체 인원', S.employees.length.toLocaleString(), '퇴사자 포함') +
      kc('new', '신규 입사자', '+' + nw.length, pl + ' · 기간 조회', 'ok') + kc('out', '퇴사자', outs.length.toLocaleString(), pl + ' · 기간 조회', 'bad') +
      kc('history', '여러 PC에 등록된 사번', dups.length, '적용 이력 탭에서 확인', 'warn') + '</div>';
    var tabsH = '<div class="tabs">' + tabA('act', '재적 인원', act.length.toLocaleString()) + tabA('all', '전체 인원 (퇴사자 포함)', S.employees.length.toLocaleString()) + tabA('new', '신규 입사자', nw.length) + tabA('out', '퇴사자', outs.length) + tabA('history', '적용 이력·중복 등록', S.imports.length + '/' + dups.length) + '</div>';
    function th(cols) { return '<thead><tr>' + cols.map(function (c) { return '<th>' + c + '</th>'; }).join('') + '</tr></thead>'; }
    var body = '';
    if (tab === 'act' || tab === 'all') {
      body = '<div class="row" style="margin-bottom:8px"><input type="search" id="emp_q" placeholder="사번·이름·조직·내선 검색" style="width:280px;height:30px;padding:0 8px" value="' + esc(EMPV.q || '') + '">' +
        (tab === 'all' ? '<span class="chips">' + [['all', '전체'], ['in', '재직'], ['out', '퇴사']].map(function (c) { return '<span class="chip' + (EMPV.st === c[0] ? ' on' : '') + '" data-st="' + c[0] + '">' + c[1] + '</span>'; }).join('') + '</span>' : '') +
        '<span class="grow"></span><button class="btn pri" id="emp_new">＋ 직접 등록</button></div><div id="emp_tbl"></div>';
    } else if (tab === 'new' || tab === 'out') {
      var isNew = tab === 'new', list = isNew ? nw : outs;
      var chips = ['이번 달', '지난 달', '최근 3개월', '올해', '직접 선택'].map(function (c) { return '<span class="chip' + (EMPV.chip === c ? ' on' : '') + '" data-chip="' + c + '">' + c + '</span>'; }).join('');
      var now = new Date(), months = [];
      for (var i = 5; i >= 0; i--) { var dm = new Date(now.getFullYear(), now.getMonth() - i, 1); months.push([dm.getFullYear() + '-' + pad2(dm.getMonth() + 1), (dm.getMonth() + 1) + '월']); }
      var cnt = months.map(function (m) { return S.employees.filter(function (e) { return isNew ? String(e.joined_at || '').slice(0, 7) === m[0] : (e.active === false && String(e.left_at || '').slice(0, 7) === m[0]); }).length; });
      var mx = Math.max.apply(null, cnt.concat([1]));
      var mbar = '<div class="card mbar"><div class="ml"><b>' + (isNew ? '신규 입사자' : '퇴사자') + '</b><div class="note">월별 추이 (참고)</div></div>' + months.map(function (m, i) { return '<div class="mc"><span>' + cnt[i] + '</span><i style="height:' + (4 + Math.round(46 * cnt[i] / mx)) + 'px;background:' + (isNew ? '#1e8e3e' : '#c42b1c') + '"></i><span class="note">' + m[1] + '</span></div>'; }).join('') + '</div>';
      var rows = list.sort(function (a, b) { return String(isNew ? b.joined_at : b.left_at).localeCompare(String(isNew ? a.joined_at : a.left_at)); }).slice(0, 300).map(function (e) {
        var pc = devCount(e.emp_no);
        return isNew ?
          '<tr><td class="mono">' + esc(e.emp_no) + '</td><td>' + esc(e.name) + '</td><td>' + esc(e.dept || '') + '</td><td>' + esc(e.team || '') + '</td><td>' + esc(e.title || '') + '</td><td>' + esc(ymd(e.joined_at)) + estH(e, 'joined') + '</td><td>' + tagH(srcOf(e.emp_no, 'add'), 'gray') + '</td><td>' + (pc ? tagH('연동됨', 'ok') : tagH('미연동', 'warn')) + '</td></tr>' :
          '<tr><td class="mono">' + esc(e.emp_no) + '</td><td>' + esc(e.name) + '</td><td>' + esc(e.dept || '') + '</td><td>' + esc(e.team || '') + '</td><td>' + esc(e.title || '') + '</td><td>' + esc(ymd(e.left_at)) + estH(e, 'left') + '</td><td>' + tagH(srcOf(e.emp_no, 'out'), 'gray') + '</td><td>' + (pc ? '<b style="color:#c42b1c">PC ' + pc + '대 회수 필요</b>' : '<span style="color:#1e8e3e">PC 없음</span>') + '</td><td><button class="btn sm" data-rs="' + esc(e.emp_no) + '">복직</button></td></tr>';
      }).join('') || '<tr><td colspan="9" class="note" style="padding:16px;text-align:center">' + (S.dates ? '이 기간에 해당하는 사람이 없습니다.' : '입사일·퇴사일 열 추가(db/update_v1.8.sql, update_v1.9.sql) 후 조회할 수 있습니다.') + '</td></tr>';
      body = '<div class="card pbox"><b>기간</b><input type="date" id="p_from" value="' + P[0] + '"><span>~</span><input type="date" id="p_to" value="' + P[1] + '"><span class="chips">' + chips + '</span><span class="grow"></span><span class="note">' + (isNew ? '신규 입사자' : '퇴사자') + ' <b style="font-size:14px;color:#1a1a1a">' + list.length + '명</b></span><button class="btn" id="p_xl">엑셀 내려받기</button></div>' + mbar +
        '<div style="overflow:auto"><table class="tbl">' + th(isNew ? ['사번(인사ID)', '이름', '조직명', '본부/팀', '호칭', '입사일', '등록 방법', 'PC 연동'] : ['사번(인사ID)', '이름', '조직명', '본부/팀', '호칭', '퇴사일', '처리 방법', '사용 PC', '관리']) + '<tbody>' + rows + '</tbody></table></div>' +
        '<div class="note" style="margin-top:6px">' + (isNew ? '입사일은 엑셀의 입사일 항목이 있으면 그 값을, 없으면 명단에 처음 반영한 날(적용일)입니다. 사번 [수정]에서 고칠 수 있습니다. "PC 연동"이 미연동인 사람은 아직 PC 프로그램에서 사번 확인을 하지 않은 사람입니다.' : '"사용 PC"는 해당 사번으로 연동된 PC 수입니다. 회수·초기화가 끝나면 자산 상세에서 사용자를 정리하세요. 퇴사일은 엑셀에서 빠진 날(적용일) 또는 [퇴사 처리]한 날입니다.') + ' v1.8 이전에 올라온 명단은 입사일·퇴사일이 비어 있어 기간 조회에 나타나지 않습니다.</div>';
    } else {
      var hrows = S.imports.map(function (x, i) {
        var canRevert = !x.reverted_at && S.imports.filter(function (y) { return !y.reverted_at; })[0] === x;
        return '<tr><td>' + esc(ymd(x.applied_at) + ' ' + hm(x.applied_at)) + '</td><td>' + esc(x.applied_by || '') + '</td><td>' + esc(x.file_name || '') + '</td><td>+' + x.added + '</td><td>' + x.changed + '</td><td>' + x.deactivated + '</td><td>' + (x.reverted_at ? tagH('되돌림 ' + ymd(x.reverted_at).slice(5), 'bad') : canRevert ? '<button class="btn sm" data-rv="' + i + '">이 적용 되돌리기</button>' : '') + '</td></tr>';
      }).join('') || '<tr><td colspan="7" class="note" style="padding:16px;text-align:center">적용 이력이 없습니다.</td></tr>';
      var drows = '';
      dups.forEach(function (g) {
        var e = S.empBy[g.emp_no];
        g.devs.forEach(function (d, i) {
          drows += '<tr><td class="mono">' + (i === 0 ? esc(g.emp_no) : '') + '</td><td>' + (i === 0 ? esc(e ? e.name : '(명단에 없음)') : '') + '</td><td>' + esc(d.computer_name) + ' <span class="note">· ' + esc((d.mac || '').slice(-5)) + '</span></td><td>' + esc(ymd(d.last_seen) + ' ' + hm(d.last_seen)) + '</td><td><button class="btn sm" data-fix="' + esc(d.id) + '">사번 수정</button> <button class="btn sm" data-unl="' + esc(d.id) + '">연동 해제</button></td></tr>';
        });
      });
      if (!drows) drows = '<tr><td colspan="5" class="note" style="padding:16px;text-align:center">여러 PC에 등록된 사번이 없습니다.</td></tr>';
      body = '<h3 style="margin:4px 0 8px;font-size:13px">적용 이력</h3><table class="tbl"><thead><tr><th>적용 일시</th><th>적용자</th><th>파일</th><th>신규</th><th>변경</th><th>퇴사</th><th></th></tr></thead><tbody>' + hrows + '</tbody></table>' +
        '<h3 style="margin:16px 0 4px;font-size:13px">한 사번이 여러 PC에 등록됨</h3><div class="note" style="margin-bottom:8px">노트북+데스크톱처럼 정상일 수도 있습니다. 잘못 등록된 PC는 [사번 수정] 또는 [연동 해제]로 정리하세요.</div>' +
        '<table class="tbl"><thead><tr><th>사번</th><th>성명</th><th>PC</th><th>마지막 확인</th><th></th></tr></thead><tbody>' + drows + '</tbody></table>' +
        '<div class="note" style="margin-top:10px;line-height:1.6">인사 명단에서 빠진(퇴사) 사번은 PC 프로그램의 [사번 확인]에서 확인되지 않습니다. 틀린 사번·성명을 짧은 시간에 여러 번 조회하면 잠시 조회가 막힙니다(같은 PC 5분에 5회, 같은 사번 10분에 10회).</div>';
    }
    shell('employees', '<h1>인사 정보</h1><div class="note" style="margin:4px 0 10px">명단 확인·직접 등록·수정. 엑셀 올리기·내려받기는 <a href="#/data"><b>데이터 관리</b></a> 메뉴에서 합니다. PC 프로그램은 사번과 성명이 이 명단과 모두 일치할 때만 서버와 연동됩니다.</div>' + warn + warn2 + kpi + tabsH + body);
    if (tab === 'act' || tab === 'all') {
      var drawList = function () {
        var q = ($('#emp_q').value || '').trim().toLowerCase();
        var list = (tab === 'act' ? act : S.employees).filter(function (e) {
          if (tab === 'all' && EMPV.st === 'in' && e.active === false) return false;
          if (tab === 'all' && EMPV.st === 'out' && e.active !== false) return false;
          return !q || [e.emp_no, e.name, e.dept, e.team, e.title, e.sales_title, e.duty, e.ext_no].join(' ').toLowerCase().indexOf(q) >= 0;
        });
        list = sortRows(list, 'emp', EC);   // 전체 명단을 정렬한 뒤 상위 300명만 표시
        var rows = list.slice(0, 300).map(function (e) {
          var btn = tab === 'all' && e.active === false ? '<button class="btn sm" data-ed="' + esc(e.emp_no) + '">수정</button> <button class="btn sm" data-rs="' + esc(e.emp_no) + '">복직</button>' : '<button class="btn sm" data-ed="' + esc(e.emp_no) + '">수정</button> <button class="btn sm" data-out="' + esc(e.emp_no) + '">퇴사 처리</button>';
          return '<tr><td class="mono">' + esc(e.emp_no) + '</td><td>' + esc(e.name) + '</td><td>' + esc(e.dept || '') + '</td><td>' + esc(e.team || '') + '</td><td>' + esc(e.title || '') + '</td><td>' + esc(e.sales_title || '') + '</td><td>' + esc(e.duty || '') + '</td><td>' + esc(e.ext_no || '') + '</td>' +
            (tab === 'all' ? '<td>' + (e.active === false ? tagH('퇴사', 'bad') : tagH('재직', 'ok')) + '</td>' : '') + '<td>' + (e.joined_at ? esc(ymd(e.joined_at)) + estH(e, 'joined') : '<span class="note">미등록</span>') + '</td>' + (tab === 'all' ? '<td>' + (e.left_at ? esc(ymd(e.left_at)) + estH(e, 'left') : '—') + '</td>' : '') + '<td>' + btn + '</td></tr>';
        }).join('') || '<tr><td colspan="12" class="note" style="padding:16px;text-align:center">표시할 명단이 없습니다.</td></tr>';
        $('#emp_tbl').innerHTML = '<div class="note" style="margin-bottom:6px">' + list.length.toLocaleString() + '명' + (list.length > 300 ? ' (상위 300명만 표시, 검색으로 좁혀 보세요)' : '') + '</div>' + sortBar('emp', EC, list.length) + '<div style="overflow:auto"><table class="tbl"><thead><tr>' + [['emp_no', '사번(인사ID)'], ['name', '이름'], ['dept', '조직명'], ['team', '본부/팀'], ['title', '호칭'], ['sales', '영업직책'], ['duty', '업무'], ['ext', '내선']].concat(tab === 'all' ? [['st', '상태']] : []).concat([['joined', '입사일']]).concat(tab === 'all' ? [['left', '퇴사일']] : []).map(function (c) { return thS('emp', c[0], c[1]); }).join('') + '<th>관리</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
        bindSort('emp', drawList);
        $$('[data-ed]').forEach(function (b) { b.onclick = function () { empForm(b.dataset.ed, tab); }; });
        $$('[data-out]').forEach(function (b) { b.onclick = function () { empQuick(b.dataset.out, false, tab); }; });
        $$('[data-rs]').forEach(function (b) { b.onclick = function () { empQuick(b.dataset.rs, true, tab); }; });
      };
      $('#emp_q').oninput = function (e) { EMPV.q = this.value; if (e && e.isComposing) return; drawList(); }; $('#emp_q').addEventListener('compositionend', function () { EMPV.q = this.value; drawList(); }); drawList();
      $('#emp_new').onclick = function () { empForm(null, tab); };
      $$('[data-st]').forEach(function (c) { c.onclick = function () { EMPV.st = c.dataset.st; pageEmployees('all'); }; });
      return;
    }
    if (tab === 'new' || tab === 'out') {
      $$('[data-chip]').forEach(function (c) { c.onclick = function () { var p = periodFor(c.dataset.chip); EMPV.chip = c.dataset.chip; if (p) { EMPV.from = p[0]; EMPV.to = p[1]; } pageEmployees(tab); }; });
      var pf = $('#p_from'), pt = $('#p_to');
      function chg() { if (pf.value && pt.value) { EMPV.from = pf.value; EMPV.to = pt.value; EMPV.chip = '직접 선택'; pageEmployees(tab); } }
      pf.onchange = chg; pt.onchange = chg;
      $('#p_xl').onclick = function () { empXlsx(tab === 'new' ? nw : outs, tab === 'new' ? '신규입사자' : '퇴사자'); };
      $$('[data-rs]').forEach(function (b) { b.onclick = function () { empQuick(b.dataset.rs, true, tab); }; });
      return;
    }
    $$('[data-rv]').forEach(function (b) { b.onclick = async function () {
      var rec = S.imports[+b.dataset.rv];
      if (!confirm('이 적용(' + ymd(rec.applied_at) + ' ' + hm(rec.applied_at) + ')을 되돌립니다.\n변경·퇴사 처리된 사번은 적용 전 값으로 돌아가고, 새로 들어온 사번은 비활성 처리됩니다.\n계속할까요?')) return;
      try { await revertImport(rec); toast('되돌렸습니다.'); pageEmployees('history'); } catch (er) { fail(er); }
    }; });
    $$('[data-fix]').forEach(function (b) { b.onclick = async function () {
      var d = S.devices.filter(function (x) { return x.id === b.dataset.fix; })[0]; if (!d) return;
      var n = (prompt(d.computer_name + ' 의 올바른 사번을 입력하세요.', '') || '').trim().toUpperCase(); if (!n) return;
      if (!S.empBy[n]) { toast('인사 명단에 없는 사번입니다.'); return; }
      try { await dbDevEmp(d.id, n, '관리자 사번 수정: ' + d.emp_no + ' → ' + n); toast('수정했습니다.'); pageEmployees('history'); } catch (er) { fail(er); }
    }; });
    $$('[data-unl]').forEach(function (b) { b.onclick = async function () {
      var d = S.devices.filter(function (x) { return x.id === b.dataset.unl; })[0]; if (!d) return;
      if (!confirm(d.computer_name + ' 의 사번 연동을 해제할까요? (PC 정보는 그대로 남고 사용자만 비워집니다. 다음 실행 때 다시 사번 확인을 하면 연결됩니다.)')) return;
      try { await dbDevEmp(d.id, null, '관리자 연동 해제: ' + d.emp_no); toast('해제했습니다.'); pageEmployees('history'); } catch (er) { fail(er); }
    }; });
  }

  // ---------- 로그인 / 라우팅 ----------
  function pageLogin(msg) {
    $app.innerHTML = '<div class="login"><div class="lgh"><div class="lgt">IT 자산관리시스템</div><div class="lgs">관리자 로그인</div></div><label>사번</label><input type="text" id="sbn" autocomplete="username" autocapitalize="characters"><label>비밀번호</label><input type="password" id="pw" autocomplete="current-password"><div style="margin-top:16px"><button class="btn pri" id="go" style="width:100%;height:36px">로그인</button></div><div class="err" id="er">' + esc(msg || '') + '</div><div class="note" style="margin-top:10px;font-size:11px">비밀번호를 잊으셨다면 메인 관리자(전산지원파트)에게 초기화를 요청하세요.</div></div>';
    var busy = false;
    async function go() {
      if (busy) return;
      var n = $('#sbn').value.trim().toUpperCase(), pw = $('#pw').value;
      $('#er').textContent = '';
      if (!n || !pw) { $('#er').textContent = '사번과 비밀번호를 입력하세요.'; return; }
      busy = true; $('#go').disabled = true;
      try {
        var j = await fnCall('admin-login', { sabun: n, password: pw });
        if (j.need_otp) { busy = false; pageLoginOtp(n, pw); return; }   // v1.9.11: 메인 관리자는 비밀번호가 맞아도 OTP 단계로 전환
        var r = await sb.auth.setSession({ access_token: j.access_token, refresh_token: j.refresh_token });
        if (r.error) throw r.error;
        busy = false; start();
      } catch (e) { busy = false; $('#go').disabled = false; $('#er').textContent = e.message || '로그인에 실패했습니다.'; $('#pw').value = ''; }
    }
    $('#go').onclick = go; $('#pw').onkeydown = function (e) { if (e.key === 'Enter') go(); }; $('#sbn').onkeydown = function (e) { if (e.key === 'Enter') $('#pw').focus(); };
    $('#sbn').focus();
  }
  // v1.9.11: 메인 관리자 2단계 인증(OTP) 입력 화면 — 사번·비밀번호는 이미 확인된 상태로, 화면에는 비밀번호를 다시 보여주지 않음
  function pageLoginOtp(sabun, password) {
    $app.innerHTML = '<div class="login"><div class="lgh"><div class="lgt">인증 코드 입력</div><div class="lgs">Google Authenticator 앱의 6자리 숫자</div></div><input type="text" id="otpc" inputmode="numeric" maxlength="6" style="width:100%;box-sizing:border-box;text-align:center;letter-spacing:6px;font-size:20px"><div style="margin-top:16px"><button class="btn pri" id="go2" style="width:100%;height:36px">확인하고 로그인</button></div><div class="err" id="er2"></div><div class="note" style="margin-top:10px;font-size:11px"><a href="#" id="back2">‹ 사번으로 돌아가기</a></div></div>';
    var busy = false;
    $('#back2').onclick = function (e) { e.preventDefault(); pageLogin(); };
    async function go2() {
      if (busy) return;
      var code = $('#otpc').value.trim(); $('#er2').textContent = '';
      if (!/^\d{6}$/.test(code)) { $('#er2').textContent = '6자리 숫자를 입력하세요.'; return; }
      busy = true; $('#go2').disabled = true;
      try {
        var j = await fnCall('admin-login', { sabun: sabun, password: password, otp_code: code });
        var r = await sb.auth.setSession({ access_token: j.access_token, refresh_token: j.refresh_token });
        if (r.error) throw r.error;
        busy = false; start();
      } catch (e) { busy = false; $('#go2').disabled = false; $('#er2').textContent = e.message || '인증에 실패했습니다.'; $('#otpc').value = ''; }
    }
    $('#go2').onclick = go2; $('#otpc').onkeydown = function (e) { if (e.key === 'Enter') go2(); };
    $('#otpc').focus();
  }
  // ---------- v1.9.4: 관리자 등록 (메인 관리자 전용) ----------
  var ADM = { list: null, demo: null };
  function roleText(r) { return r === 'main' ? '메인 관리자' : r === 'viewer' ? '조회 전용' : '일반 관리자'; }
  function roleBadge(r) { return '<span class="rchip2 ' + (r === 'main' ? 'm' : r === 'viewer' ? 'v' : 'a') + '">' + roleText(r) + '</span>'; }
  async function admCall(action, body) {
    if (DEMO) return demoAdm(action, body);
    return fnCall('admin-users', Object.assign({ action: action }, body || {}), await myToken());
  }
  function demoAdm(action, b) {
    if (action !== 'list') { var rowD = (ADM.demo || []).filter(function (x) { return x.sabun === b.sabun; })[0] || {}, nm = '관리자 ' + (rowD.name || (S.empBy[b.sabun] || {}).name || '') + '(' + b.sabun + ')', RT = { main: '메인 관리자', admin: '일반 관리자', viewer: '조회 전용' };
      auditPost({ action: action === 'create' ? 'create' : action === 'delete' ? 'delete' : 'change', target: nm, summary: { create: '관리자 등록 · 권한 ' + RT[b.role], setrole: '권한 변경 ' + RT[rowD.role] + ' → ' + RT[b.role], setactive: b.active ? '다시 사용' : '사용 중지', resetpw: '비밀번호 초기화', 'delete': '관리자 삭제' }[action], reason: b.reason || null }); }
    if (!ADM.demo) ADM.demo = [
      { sabun: '99999012', role: 'main', active: true, name: '배병욱', dept: '전산지원파트', last_login: new Date().toISOString() },
      { sabun: 'A20871', role: 'admin', active: true, name: '김서연', dept: 'IT지원팀', last_login: '2026-11-18T08:05:00Z' },
      { sabun: '70000212', role: 'viewer', active: true, name: '최도윤', dept: '영업2팀', last_login: '2026-11-17T00:40:00Z' },
      { sabun: '20000006', role: 'viewer', active: false, name: '박옥경', dept: '센트럴사업단', last_login: '2026-10-30T05:12:00Z' }];
    var L = ADM.demo, row = function () { return L.filter(function (x) { return x.sabun === b.sabun; })[0]; };
    if (action === 'list') return Promise.resolve({ admins: L.slice() });
    if (action === 'create') { var e = S.empBy[b.sabun] || {}; L.push({ sabun: b.sabun, role: b.role, active: true, name: e.name, dept: e.dept, last_login: null }); return Promise.resolve({ ok: 1 }); }
    if (action === 'setrole') { row().role = b.role; return Promise.resolve({ ok: 1 }); }
    if (action === 'setactive') { row().active = !!b.active; return Promise.resolve({ ok: 1 }); }
    if (action === 'resetpw') return Promise.resolve({ password: genPw() });
    if (action === 'delete') { ADM.demo = L.filter(function (x) { return x.sabun !== b.sabun; }); return Promise.resolve({ ok: 1 }); }
    return Promise.resolve({});
  }
  var ADC = {
    sabun: { f: function (x) { return x.sabun; }, t: 's', l: '사번' }, name: { f: function (x) { return admName(x); }, t: 's', l: '성명' },
    dept: { f: function (x) { return admDept(x); }, t: 's', l: '조직명' }, role: { f: function (x) { return { main: 0, admin: 1, viewer: 2 }[x.role]; }, t: 'n', l: '권한' },
    active: { f: function (x) { return x.active ? 0 : 1; }, t: 'n', l: '상태' }, last: { f: function (x) { return x.last_login; }, t: 'd', l: '최근 접속' }
  };
  function admName(x) { var e = S.empBy[x.sabun]; return e ? e.name : x.name; }
  function admDept(x) { var e = S.empBy[x.sabun]; return e ? e.dept : x.dept; }
  function pwDialog(title, sub, pw) {
    var d = document.createElement('div'); d.className = 'mdl';
    d.innerHTML = '<div class="mbox" style="width:420px"><div class="mh"><b>' + esc(title) + '</b><button class="mx" type="button">✕</button></div><div class="note" style="margin-bottom:8px">' + sub + '</div><div class="pwbox"><code id="pwv">' + esc(pw) + '</code><button class="btn sm" id="pwc" type="button">복사</button></div><div class="note" style="margin-top:8px;color:#c42b1c">이 화면을 닫으면 다시 볼 수 없습니다. 해당 직원에게 직접 알려 주세요. 첫 로그인 후 본인이 비밀번호를 바꿉니다.</div><div class="mf"><button class="btn pri" id="pwx" type="button">확인</button></div></div>';
    document.body.appendChild(d);
    var close = function () { d.remove(); };
    $('.mx', d).onclick = close; $('#pwx', d).onclick = close;
    $('#pwc', d).onclick = function () { try { navigator.clipboard.writeText(pw); toast('복사했습니다.'); } catch (e) { toast('직접 선택해서 복사하세요.'); } };
  }
  async function pageAdmins() {
    if (!isMain()) { denyPage(); return; }
    var rows;
    try { rows = (await admCall('list')).admins; } catch (e) { shell('admins', '<h1>관리자</h1><div class="note" style="color:#c42b1c;margin-top:8px">' + esc(e.message) + '</div>'); return; }
    ADM.list = rows;
    var n = rows.length, nOn = rows.filter(function (x) { return x.active; }).length;
    var sorted = sortRows(rows, 'adm', ADC);
    var body = sorted.map(function (x) {
      var main = x.role === 'main', me = S.me && x.sabun === S.me.sabun;
      var act = main ? '<span class="note" style="color:#b45309">🔒 고정</span>' :
        (x.active ? '<a href="#" data-a="role" data-s="' + esc(x.sabun) + '">권한 변경</a> · <a href="#" data-a="pw" data-s="' + esc(x.sabun) + '">비밀번호 초기화</a> · <a href="#" data-a="off" data-s="' + esc(x.sabun) + '">사용 중지</a>' :
          '<a href="#" data-a="on" data-s="' + esc(x.sabun) + '">다시 사용</a> · <a href="#" data-a="del" data-s="' + esc(x.sabun) + '">삭제</a>');
      return '<tr><td class="mono">' + esc(x.sabun) + '</td><td>' + esc(admName(x) || '') + (me ? ' (나)' : '') + '</td><td>' + esc(admDept(x) || '') + '</td><td>' + roleBadge(x.role) + '</td><td>' + (x.active ? badge('사용 중', 'ok') : badge('사용 중지', 'bad')) + '</td><td>' + (x.last_login ? esc(ymd(x.last_login).slice(5) + ' ' + hm(x.last_login)) : '<span class="note">없음</span>') + '</td><td class="admact">' + act + '</td></tr>';
    }).join('') || '<tr><td colspan="7" class="note" style="padding:20px;text-align:center">등록된 관리자가 없습니다.</td></tr>';
    shell('admins', '<div class="row wrap"><h1>관리자</h1><span class="note">IT Asset 웹페이지에 로그인할 수 있는 사람과 권한을 관리합니다 · 로그인 ID = 사번</span><div class="grow"></div><button class="btn pri" id="adnew">관리자 등록</button></div>' +
      '<div class="note" style="margin:6px 0">관리자 ' + n + '명 (사용 중 ' + nOn + ')</div>' + sortBar('adm', ADC, n) +
      '<table class="tbl"><thead><tr>' + thS('adm', 'sabun', '사번 (로그인 ID)') + thS('adm', 'name', '성명') + thS('adm', 'dept', '조직명') + thS('adm', 'role', '권한') + thS('adm', 'active', '상태') + thS('adm', 'last', '최근 접속') + '<th>관리</th></tr></thead><tbody>' + body + '</tbody></table>' +
      '<div class="card" style="margin-top:12px"><div class="note" style="line-height:1.8">· 메인 관리자는 1명이며 변경·중지·삭제할 수 없습니다 (Supabase에서 처음 한 번 등록)<br>· 인사 명단에서 <b>퇴사 처리된 사람은 관리자도 자동으로 사용 중지</b>되어 로그인할 수 없습니다<br>· [삭제]하면 Supabase 로그인 계정도 함께 지워집니다 (Supabase 화면은 직접 열 필요가 없습니다)</div></div>');
    bindSort('adm', pageAdmins);
    $('#adnew').onclick = admNewDialog;
    $$('.admact a').forEach(function (a) {
      a.onclick = async function (e) {
        e.preventDefault(); var sab = a.dataset.s, k = a.dataset.a, nm = (rows.filter(function (x) { return x.sabun === sab; })[0] || {}); var who = sab + ' ' + (admName(nm) || '');
        try {
          if (k === 'role') { admRoleDialog(nm); return; }
          if (k === 'pw') { var rs1 = await askReason('비밀번호 초기화', esc(who) + ' 의 비밀번호를 초기화합니다. 새 비밀번호가 한 번만 표시됩니다.', '초기화'); if (!rs1) return; var r = await admCall('resetpw', { sabun: sab, reason: rs1 }); pwDialog('비밀번호 초기화 완료', esc(who) + ' 의 새 비밀번호입니다.', r.password); return; }
          if (k === 'off') { var rs2 = await askReason('사용 중지', esc(who) + ' 을(를) 사용 중지합니다. 로그인할 수 없게 됩니다.', '사용 중지'); if (!rs2) return; await admCall('setactive', { sabun: sab, active: false, reason: rs2 }); toast('사용 중지했습니다.'); }
          if (k === 'on') { await admCall('setactive', { sabun: sab, active: true }); toast('다시 사용하도록 했습니다.'); }
          if (k === 'del') { var rs3 = await askReason('관리자 삭제', esc(who) + ' 을(를) 삭제합니다. 로그인 계정도 함께 삭제되며 되돌릴 수 없습니다.', '삭제'); if (!rs3) return; await admCall('delete', { sabun: sab, reason: rs3 }); toast('삭제했습니다.'); }
          pageAdmins();
        } catch (er) { fail(er); }
      };
    });
  }
  function admRoleDialog(x) {
    var d = document.createElement('div'); d.className = 'mdl';
    d.innerHTML = '<div class="mbox" style="width:400px"><div class="mh"><b>권한 변경</b><button class="mx" type="button">✕</button></div><div style="margin-bottom:8px">' + esc(x.sabun + ' ' + (admName(x) || '')) + '</div>' + roleRadios(x.role === 'viewer' ? 'viewer' : 'admin') + '<div class="ms">사유 (필수)</div><textarea id="rcr" rows="2" style="width:100%;box-sizing:border-box" placeholder="예: 업무 변경으로 조회만 필요"></textarea><div class="mf"><button class="btn" id="rcx" type="button">취소</button><button class="btn pri" id="rcok" type="button">변경</button></div></div>';
    document.body.appendChild(d); var close = function () { d.remove(); };
    $('.mx', d).onclick = close; $('#rcx', d).onclick = close;
    $('#rcok', d).onclick = async function () { var v = $('input[name="rl"]:checked', d).value, rs = $('#rcr', d).value.trim(); if (!rs) { toast('사유를 입력하세요.'); return; } try { await admCall('setrole', { sabun: x.sabun, role: v, reason: rs }); close(); toast('권한을 변경했습니다.'); pageAdmins(); } catch (e) { fail(e); } };
  }
  function roleRadios(cur) {
    return '<label class="rrow"><input type="radio" name="rl" value="admin"' + (cur === 'admin' ? ' checked' : '') + '><span><b>일반 관리자</b><br><i>자산 관리·현황 점검·원격 지원·인사 정보·데이터 관리 사용</i></span></label>' +
      '<label class="rrow"><input type="radio" name="rl" value="viewer"' + (cur === 'viewer' ? ' checked' : '') + '><span><b>조회 전용</b><br><i>화면 조회만 가능 (수정·업로드·완료 처리 불가)</i></span></label>' +
      '<label class="rrow dis"><input type="radio" disabled><span><b>메인 관리자</b><br><i>배병욱(99999012) 1명 고정 (선택 불가)</i></span></label>';
  }
  function admNewDialog() {
    var pick = null, pw = genPw(), d = document.createElement('div'); d.className = 'mdl';
    d.innerHTML = '<div class="mbox" style="width:480px"><div class="mh"><b>관리자 등록</b><button class="mx" type="button">✕</button></div>' +
      '<div class="ms">1. 사번 또는 성명 조회 <span class="note">(선택한 사번이 로그인 ID가 됩니다)</span></div><input type="text" id="adq" placeholder="사번·성명·조직명 (재직자만)" style="width:100%;box-sizing:border-box;height:32px;padding:0 10px"><div id="adres" class="adres"></div><div id="adpick"></div>' +
      '<div class="ms">2. 권한 설정</div>' + roleRadios('admin') +
      '<div class="ms">3. 사유 <span class="note">(선택 · 이력 관리에 남습니다)</span></div><input type="text" id="adr" placeholder="예: 전산지원 업무 인수" style="width:100%;box-sizing:border-box"><div class="ms">4. 초기 비밀번호</div><div class="pwbox"><code id="adpw">' + esc(pw) + '</code><button class="btn sm" id="adcp" type="button">복사</button></div><div class="note" style="margin-top:4px">※ 등록한 뒤 해당 직원에게 직접 알려 주세요. 첫 로그인 후 본인이 비밀번호를 바꿉니다.</div>' +
      '<div class="mf"><button class="btn" id="adx" type="button">취소</button><button class="btn pri" id="adok" type="button" disabled>등록</button></div></div>';
    document.body.appendChild(d); var close = function () { d.remove(); };
    $('.mx', d).onclick = close; $('#adx', d).onclick = close;
    $('#adcp', d).onclick = function () { try { navigator.clipboard.writeText(pw); toast('복사했습니다.'); } catch (e) { toast('직접 선택해서 복사하세요.'); } };
    var have = {}; (ADM.list || []).forEach(function (x) { have[x.sabun] = 1; });
    function search() {
      var q = ($('#adq', d).value || '').trim().toLowerCase(), box = $('#adres', d);
      if (!q) { box.innerHTML = ''; return; }
      var hit = S.employees.filter(function (e) { return e.active !== false && [e.emp_no, e.name, e.dept].join(' ').toLowerCase().indexOf(q) >= 0; }).slice(0, 8);
      box.innerHTML = hit.map(function (e) {
        var dup = have[e.emp_no];
        return '<div class="ares' + (dup ? ' dis' : '') + (pick && pick.emp_no === e.emp_no ? ' on' : '') + '" data-e="' + esc(e.emp_no) + '"><span class="mono" style="width:76px">' + esc(e.emp_no) + '</span><b style="width:64px">' + esc(e.name) + '</b><span style="flex:1;color:#5c5c5c">' + esc((e.dept || '') + (e.title ? ' · ' + e.title : '')) + '</span>' + (dup ? '<i class="tg">이미 등록됨</i>' : '') + '</div>';
      }).join('') || '<div class="note" style="padding:8px">재직자 중 일치하는 사람이 없습니다.</div>';
      $$('.ares', box).forEach(function (r) { r.onclick = function () {
        if (r.classList.contains('dis')) return;
        pick = S.empBy[r.dataset.e]; $('#adok', d).disabled = false; search();
        $('#adpick', d).innerHTML = '<div class="pickd"><b>선택됨</b> · 사번(로그인 ID) ' + esc(pick.emp_no) + ' · 성명 ' + esc(pick.name) + ' · 조직명 ' + esc(pick.dept || '') + (pick.title ? ' · 호칭 ' + esc(pick.title) : '') + ' <span class="note">(인사 명단에서 자동으로 채워짐)</span></div>';
      }; });
    }
    var qe = $('#adq', d); qe.oninput = function (e) { if (e && e.isComposing) return; search(); }; qe.addEventListener('compositionend', search); qe.focus();
    $('#adok', d).onclick = async function () {
      if (!pick) return; var v = $('input[name="rl"]:checked', d).value; this.disabled = true;
      try { await admCall('create', { sabun: pick.emp_no, role: v, password: pw, reason: ($('#adr', d) ? $('#adr', d).value.trim() : '') }); close(); toast(pick.name + ' 을(를) ' + roleText(v) + '로 등록했습니다.'); pwDialog('관리자 등록 완료', esc(pick.emp_no + ' ' + pick.name) + ' 의 초기 비밀번호입니다.', pw); pageAdmins(); }
      catch (e) { this.disabled = false; fail(e); }
    };
  }
  // =====================================================================
  // v1.9.4: 공통 창 · 사유 입력 · 이력 기록
  // =====================================================================
  function openModal(html, width) {
    var d = document.createElement('div'); d.className = 'mdl';
    d.innerHTML = '<div class="mbox"' + (width ? ' style="width:' + width + 'px"' : '') + '>' + html + '</div>';
    document.body.appendChild(d);
    var close = function () { d.remove(); };
    $$('.mx', d).forEach(function (x) { x.onclick = close; });
    return { d: d, close: close };
  }
  function askReason(title, msg, okLabel) {   // 사유를 꼭 입력해야 진행되는 창 (입력한 사유는 이력 관리에 남음)
    return new Promise(function (resolve) {
      var m = openModal('<div class="mh"><b>' + esc(title) + '</b><button class="mx" type="button">✕</button></div><div class="warnbox">' + msg + '</div>' +
        '<div class="ms">사유 (필수)</div><textarea id="rsn" rows="3" style="width:100%;box-sizing:border-box" placeholder="예: 직원 부서 이동 / 폐기 처리 완료"></textarea>' +
        '<div class="note" style="margin-top:4px">※ 입력한 사유는 이력 관리에 함께 남습니다. 비워 두면 진행할 수 없습니다.</div>' +
        '<div class="mf"><button class="btn" id="rx" type="button">취소</button><button class="btn pri" id="rok" type="button" disabled>' + esc(okLabel || '확인') + '</button></div>', 420);
      var t = $('#rsn', m.d); t.focus();
      t.oninput = function () { $('#rok', m.d).disabled = !t.value.trim(); };   // 버튼 상태만 바꿈 (입력창은 다시 그리지 않음)
      $('#rx', m.d).onclick = function () { m.close(); resolve(null); };
      $('.mx', m.d).onclick = $('#rx', m.d).onclick;
      $('#rok', m.d).onclick = function () { var v = t.value.trim(); if (!v) return; m.close(); resolve(v); };
    });
  }
  function askText(title, label, val, okLabel, multi) {   // 한 줄(또는 여러 줄) 입력 창
    return new Promise(function (resolve) {
      var m = openModal('<div class="mh"><b>' + esc(title) + '</b><button class="mx" type="button">✕</button></div><div class="ms">' + esc(label) + '</div>' +
        (multi ? '<textarea id="atx" rows="3" style="width:100%;box-sizing:border-box">' + esc(val || '') + '</textarea>' : '<input type="text" id="atx" value="' + esc(val || '') + '" style="width:100%;box-sizing:border-box">') +
        '<div class="mf"><button class="btn" id="ax" type="button">취소</button><button class="btn pri" id="aok" type="button">' + esc(okLabel || '확인') + '</button></div>', 400);
      var t = $('#atx', m.d); t.focus();
      $('#ax', m.d).onclick = function () { m.close(); resolve(null); }; $('.mx', m.d).onclick = $('#ax', m.d).onclick;
      $('#aok', m.d).onclick = function () { var v = t.value.trim(); if (!v) { t.focus(); return; } m.close(); resolve(v); };
    });
  }
  // ---------- v1.9.11: 보안 설정 (메인 관리자 전용) ----------
  async function secCall(action, body) {
    return fnCall('admin-security', Object.assign({ action: action }, body || {}), await myToken());
  }
  function demoSec(action, b) {
    if (action === 'status') return { otp_enabled: !!S.secOtp, telegram_configured: true, geo_block: true, auto_logout_minutes: 30 };
    if (action === 'otp_begin') return { secret: 'JBSWY3DPEHPK3PXP', otpauth: 'otpauth://totp/demo' };
    if (action === 'otp_confirm') { if (String(b.code || '') !== '000000') throw new Error('인증 코드가 올바르지 않습니다. (데모에서는 000000 을 입력하세요)'); S.secOtp = true; return { ok: true }; }
    if (action === 'otp_disable') { S.secOtp = false; return { ok: true }; }
    if (action === 'test_telegram') return { ok: true };
    throw new Error('알 수 없는 요청입니다.');
  }
  async function pageSecurity() {
    if (!isMain()) { denyPage(); return; }
    var st; try { st = DEMO ? demoSec('status') : await secCall('status'); } catch (e) { shell('security', '<h1>보안 설정</h1><div class="note" style="color:#c42b1c;margin-top:8px">' + esc(e.message) + '</div>'); return; }
    shell('security', '<h1>보안 설정 <span class="note" style="font-weight:400">· 메인 관리자만 볼 수 있습니다</span></h1>' +
      '<div class="secg">' +
      '<div class="card seccard"><div class="row"><b>텔레그램 로그인 알림</b>' + (st.telegram_configured ? badge('연결됨', 'ok') : badge('미설정', 'bad')) + '</div><div class="note" style="margin-top:4px">관리자 계정으로 로그인에 성공할 때마다 설정된 텔레그램 방으로 알림을 보냅니다. (서버 환경변수 TELEGRAM_BOT_TOKEN·TELEGRAM_CHAT_ID 설정 필요 — 설치가이드 참고)</div><div style="margin-top:10px"><button class="btn sm" id="sec_tg_test"' + (st.telegram_configured ? '' : ' disabled') + '>테스트 알림 보내기</button></div></div>' +
      '<div class="card seccard"><div class="row"><b>2단계 인증 (OTP)</b>' + (st.otp_enabled ? badge('설정됨', 'ok') : badge('미설정', 'gray')) + '</div><div class="note" style="margin-top:4px">메인 관리자(나) 계정에만 적용됩니다. 켜면 로그인 시 Google Authenticator 등 OTP 앱의 6자리 코드를 추가로 입력해야 합니다.</div><div style="margin-top:10px">' + (st.otp_enabled ? '<button class="btn sm" id="sec_otp_redo">다시 등록 (QR 재발급)</button> <button class="btn sm dng" id="sec_otp_off">해제</button>' : '<button class="btn sm pri" id="sec_otp_on">OTP로 등록</button>') + '</div></div>' +
      '<div class="card seccard"><div class="row"><b>자동 로그아웃</b>' + badge(st.auto_logout_minutes + '분 고정', 'gray') + '</div><div class="note" style="margin-top:4px">모든 관리자 계정은 화면 조작 없이 ' + st.auto_logout_minutes + '분이 지나면 자동으로 로그아웃됩니다(설정 변경 불가). 다른 사이트에 갔다가 뒤로가기로 돌아와도 즉시 다시 로그인해야 합니다.</div></div>' +
      '<div class="card seccard"><div class="row"><b>해외 접속 차단</b>' + (st.geo_block ? badge('켜짐', 'ok') : badge('꺼짐', 'bad')) + '</div><div class="note" style="margin-top:4px">접속 IP가 대한민국이 아니면 로그인 자체가 차단됩니다. 해외 출장 등 예외가 필요하면 전산지원파트(서버 환경변수 GEO_BLOCK)에서 임시로 꺼야 합니다.</div></div>' +
      '</div>');
    var tgBtn = $('#sec_tg_test'); if (tgBtn) tgBtn.onclick = async function () { tgBtn.disabled = true; tgBtn.textContent = '보내는 중…'; try { await (DEMO ? demoSec('test_telegram') : secCall('test_telegram')); toast('테스트 알림을 보냈습니다. 텔레그램 방을 확인하세요.'); } catch (e) { fail(e); } tgBtn.disabled = false; tgBtn.textContent = '테스트 알림 보내기'; };
    var onBtn = $('#sec_otp_on'); if (onBtn) onBtn.onclick = otpSetupDialog;
    var redoBtn = $('#sec_otp_redo'); if (redoBtn) redoBtn.onclick = otpSetupDialog;
    var offBtn = $('#sec_otp_off'); if (offBtn) offBtn.onclick = async function () {
      var code = await askText('2단계 인증 해제', '해제하려면 지금 OTP 앱에 표시된 6자리 코드를 입력하세요.', '', '해제');
      if (code === null) return;
      try { await (DEMO ? demoSec('otp_disable', { code: code }) : secCall('otp_disable', { code: code })); toast('2단계 인증을 해제했습니다.'); pageSecurity(); } catch (e) { fail(e); }
    };
  }
  function otpSetupDialog() {
    (async function () {
      var r; try { r = DEMO ? demoSec('otp_begin') : await secCall('otp_begin'); } catch (e) { fail(e); return; }
      var q = qrcode(0, 'M'); q.addData(r.otpauth); q.make();
      var key = (r.secret.match(/.{1,4}/g) || [r.secret]).join(' ');
      var m = openModal('<div class="mh"><b>2단계 인증(OTP) 등록</b><button class="mx" type="button">✕</button></div>' +
        '<div class="note" style="margin-bottom:10px">Google Authenticator(또는 Microsoft Authenticator) 앱을 켜고 아래 QR코드를 스캔하세요.</div>' +
        '<div style="display:flex;gap:16px;align-items:flex-start">' + q.createSvgTag({ cellSize: 4, margin: 0 }) +
        '<div style="flex:1"><div class="note">QR코드를 스캔할 수 없으면 아래 키를 앱에 직접 입력하세요.</div><div class="pwbox" style="margin-top:6px"><code>' + esc(key) + '</code></div></div></div>' +
        '<div class="ms">앱에 표시된 6자리 코드</div><input type="text" id="otp_c" inputmode="numeric" maxlength="6" style="width:140px;letter-spacing:3px;font-size:16px;text-align:center">' +
        '<div class="mf"><button class="btn" id="otp_x" type="button">취소</button><button class="btn pri" id="otp_ok" type="button">등록 완료</button></div>', 480);
      $('#otp_x', m.d).onclick = m.close;
      $('#otp_c', m.d).focus();
      $('#otp_ok', m.d).onclick = async function () {
        var code = $('#otp_c', m.d).value.trim(); if (!/^\d{6}$/.test(code)) { toast('6자리 숫자를 입력하세요.'); return; }
        var btn = this; btn.disabled = true; btn.textContent = '확인 중…';
        try { await (DEMO ? demoSec('otp_confirm', { code: code }) : secCall('otp_confirm', { secret: r.secret, code: code })); m.close(); toast('2단계 인증을 등록했습니다.'); pageSecurity(); }
        catch (e) { btn.disabled = false; btn.textContent = '등록 완료'; toast(e.message || '확인에 실패했습니다.'); }
      };
    })();
  }
  function demoAudit() {
    var t = function (h, m) { var d = new Date(); d.setHours(h, m, 12, 0); return d.toISOString(); };
    var W = function (s, n, dp, ti, r) { return { actor_sabun: s, actor_name: n, actor_dept: dp, actor_title: ti, actor_role: r, ip: '121.134.13.253', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130' }; };
    var main = W('99999012', '배병욱', '전산지원파트', '파트장', 'main'), kim = W('A10442', '김형범', '전산지원파트', '차장', 'admin'), seo = W('A20871', '김서연', 'IT지원팀', '사원', 'admin');
    var L = [
      Object.assign({ id: 'a0m', at: t(22, 1), action: 'login', target: '웹 로그인', summary: '로그인 성공 (Android · Chrome)' }, main, { ip: '211.177.20.188', ua: 'Mozilla/5.0 (Linux; Android 15; SM-F966N) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36' }),
      Object.assign({ id: 'a0h', at: t(21, 59), action: 'login', target: '웹 로그인', summary: '로그인 성공 (Windows · Chrome) · 외부 접속' }, main, { ip: '211.177.20.188', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130' }),
      Object.assign({ id: 'a0p', at: t(21, 57), action: 'change', target: '자산 A-PC-2020-043', summary: '프로그램 종료 · PC ENTIA_APLUS · 사번 99999012' }, main, { actor_role: 'program', actor_name: 'PC 프로그램', ip: '121.134.13.253', ip_local: '192.168.1.13', ua: '' }),
      Object.assign({ id: 'a1', at: t(21, 56), action: 'login', target: '웹 로그인', summary: '로그인 성공 (Chrome · Windows)' }, main),
      Object.assign({ id: 'a2', at: t(21, 58), action: 'create', target: '관리자 김서연(A20871)', summary: '관리자 등록 · 권한 일반 관리자', reason: '전산지원 업무 인수' }, main),
      Object.assign({ id: 'a3', at: t(21, 40), action: 'update', target: '자산 A-PC-2020-043', summary: '자산 A-PC-2020-043 수정 (2개 항목): 사용자명 홍길동→김민수, 소속명 영업1팀→영업2팀', detail: { via: '자산 화면 · 직접 수정', changes: [{ k: '사용자명', from: '홍길동', to: '김민수' }, { k: '소속명', from: '영업1팀', to: '영업2팀' }] }, reason: '직원 부서 이동에 따른 사용자 변경' }, kim),
      Object.assign({ id: 'a4', at: t(21, 12), action: 'change', target: '관리자 최도윤(70000212)', summary: '권한 변경 일반 관리자 → 조회 전용', reason: '업무 변경으로 조회만 필요', detail: { changes: [{ k: '권한', from: '일반 관리자', to: '조회 전용' }] } }, main),
      Object.assign({ id: 'a5', at: t(20, 51), action: 'change', target: '지원 요청 R-20261118-001 (자산 A-PC-2020-043)', summary: '지원 요청 상태 진행중→완료 · 처리 내용: 크롬 오류로 재설치', detail: { changes: [{ k: '상태', from: '진행중', to: '완료' }] } }, seo),
      Object.assign({ id: 'a6', at: t(20, 30), action: 'export', target: '자산 목록', summary: '엑셀 내보내기 · 70건' }, seo),
      { id: 'a7', at: t(20, 11), action: 'login_fail', target: '웹 로그인', summary: '비밀번호 오류 5회 → 15분 잠김', actor_sabun: '99999013', actor_name: null, actor_role: null, ip: '203.0.113.9', ua: 'Chrome · Windows' },
      { id: 'a9', at: t(21, 59), action: 'change', target: '자산 A-PC-2020-043', summary: '프로그램 종료 · PC ENTIA_APLUS · 사번 99999012', actor_sabun: '99999012', actor_name: 'PC 프로그램', actor_role: 'program', ip: '13.125.82.49', ip_local: '192.168.1.13' },
      Object.assign({ id: 'a8', at: t(19, 5), action: 'import', target: '인사 명단', summary: '인사 명단 업로드 · 신규 1 · 변경 0 · 퇴사 0' }, main)
    ];
    return L;
  }
  var AUDL = { assets: '자산', employees: '인사 명단', devices: '수집 PC', support_requests: '지원 요청', admin_users: '관리자', device_monitors: '모니터 연결', inventories: '실사' };
  var AC = null;   // 다음 쓰기에 붙일 이력 내용 (무엇을·어떻게·왜)
  function audCtx(c) { c.t = Date.now(); if (DEMO) auditPost(c); else AC = c; }
  function auditPost(r) {
    var row = { action: r.action || 'update', target: r.target || null, summary: r.summary || null, detail: r.detail || null, reason: r.reason || null };
    if (DEMO) { S.audit = S.audit || demoAudit(); var w = whoParts(); S.audit.unshift(Object.assign({ id: 'd' + Date.now() + Math.random(), at: new Date().toISOString(), actor_sabun: S.me.sabun, actor_role: S.me.role, actor_name: w.name, actor_dept: w.dept, actor_title: w.title, ip: '121.134.13.253', ua: 'Chrome · Windows' }, row)); return Promise.resolve(); }
    return Promise.resolve(sb.from('audit_log').insert(row)).then(function () { }, function (e) { console.warn('이력 저장 실패', e); });
  }
  function auditWrite(t, m, args, b) {
    var c = AC; AC = null;
    if (c && Date.now() - c.t > 8000) c = null;
    if (c && c.table && c.table !== t) c = null;
    if (c && c.skip) return;
    var act = m === 'insert' ? 'create' : m === 'delete' ? 'delete' : 'update', n = Array.isArray(args[0]) ? args[0].length : 1, tg = '';
    try { b.url.searchParams.forEach(function (v) { if (!tg && /^eq\./.test(v)) tg = v.slice(3); }); } catch (e) { }
    var lbl = AUDL[t];
    auditPost({ action: (c && c.action) || act, target: (c && c.target) || lbl + (tg ? ' ' + tg : n > 1 ? ' ' + n + '건' : ''), summary: (c && c.summary) || lbl + ' ' + ({ create: '생성', update: '수정', delete: '삭제' }[act]) + (n > 1 ? ' (' + n + '건)' : ''), detail: c && c.detail, reason: c && c.reason });
  }
  var FLBL = { status: '자산상태', user_name: '사용자명', user_id: '사용자 ID', dept: '소속명', company: '회사', title: '직책', location: '위치', purchase_date: '구매일', warranty_end: '보증만료일', memo: '메모', serial_no: '시리얼 번호', linked_pc: '연결 PC', category: '자산분류', manufacturer: '제조사', model: '모델명', mfg_ym: '제조년월' };
  function diffs(old, patch) {
    var out = [];
    Object.keys(patch).forEach(function (k) {
      if (!FLBL[k]) return;
      var a = old && old[k] != null ? String(old[k]) : '', b = patch[k] != null ? String(patch[k]) : '';
      if (a !== b) out.push({ k: FLBL[k], from: a || '없음', to: b || '없음' });
    });
    return out;
  }
  function chgText(ch) { return ch.slice(0, 3).map(function (c) { return c.k + ' ' + c.from + '→' + c.to; }).join(', ') + (ch.length > 3 ? ' 외 ' + (ch.length - 3) + '개' : ''); }
  function logExport(target, n, extra) { auditPost({ action: 'export', target: target, summary: (extra || '엑셀 내보내기') + ' · ' + n + '건' }); }

  // =====================================================================
  // v1.9.4: 이력 관리 (메인 관리자 전용)
  // =====================================================================
  var AUDV = { from: '', to: '', actor: '', target: '', q: '', chip: 'all', page: 0 };
  var CHIPS = [['all', '전체', null], ['login', '로그인', ['login', 'logout']], ['fail', '로그인 실패', ['login_fail']], ['create', '생성', ['create']], ['update', '수정', ['update', 'import']], ['delete', '삭제', ['delete', 'purge']], ['change', '변경', ['change', 'scan']], ['export', '내보내기', ['export']]];
  var ACT_L = { login: '로그인', logout: '로그아웃', login_fail: '로그인 실패', create: '생성', update: '수정', delete: '삭제', purge: '이력 삭제', change: '변경', export: '내보내기', import: '업로드', scan: '스캔' };
  function actBadge(a) { return '<span class="abx a-' + esc(a) + '">' + esc(ACT_L[a] || a) + '</span>'; }
  function actorRole(r) { return r === 'main' ? '메인 관리자' : r === 'viewer' ? '조회 전용' : r === 'program' ? 'PC 프로그램' : r ? '관리자' : ''; }
  function actorHtml(r) { return r.actor_name ? '<b>' + esc(r.actor_name) + '</b> <span class="note">' + esc(r.actor_sabun || '') + '</span>' : r.actor_sabun ? '<b>알 수 없음</b> <span class="note">' + esc(r.actor_sabun) + '</span>' : '<span class="note">—</span>'; }
  function safeQ(s) { return String(s).replace(/[,()%*\\"']/g, ' ').trim(); }
  async function auditFetch(page, size) {
    var v = AUDV, chip = CHIPS.filter(function (c) { return c[0] === v.chip; })[0], acts = chip[2];
    if (DEMO) {
      var L = (S.audit = S.audit || demoAudit()).filter(function (r) {
        var day = ymd(r.at);
        return (!v.from || day >= v.from) && (!v.to || day <= v.to) && (!acts || acts.indexOf(r.action) >= 0) &&
          (!v.actor || (r.actor_sabun + ' ' + r.actor_name).toLowerCase().indexOf(v.actor.toLowerCase()) >= 0) &&
          (!v.target || String(r.target || '').toLowerCase().indexOf(v.target.toLowerCase()) >= 0) &&
          (!v.q || [r.summary, r.reason, r.target].join(' ').toLowerCase().indexOf(v.q.toLowerCase()) >= 0);
      }).sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
      return { rows: L.slice(page * size, page * size + size), count: L.length };
    }
    var q = sb.from('audit_log').select('*', { count: 'exact' }).order('at', { ascending: false }).order('id', { ascending: false });
    if (v.from) q = q.gte('at', v.from + 'T00:00:00+09:00');
    if (v.to) q = q.lte('at', v.to + 'T23:59:59+09:00');
    if (acts) q = q.in('action', acts);
    if (v.actor) { var a = safeQ(v.actor); q = q.or('actor_sabun.ilike.%' + a + '%,actor_name.ilike.%' + a + '%'); }
    if (v.target) q = q.ilike('target', '%' + safeQ(v.target) + '%');
    if (v.q) { var w = safeQ(v.q); q = q.or('summary.ilike.%' + w + '%,reason.ilike.%' + w + '%,target.ilike.%' + w + '%'); }
    var r = await q.range(page * size, page * size + size - 1);
    if (r.error) throw r.error;
    return { rows: r.data, count: r.count };
  }
  var AUD_PS = 50;
  async function pageAudit() {
    if (!isMain()) { denyPage(); return; }
    if (!AUDV.from) { AUDV.from = dstr(new Date(Date.now() - 6 * 86400000)); AUDV.to = dstr(new Date()); }
    var v = AUDV;
    shell('audit', '<div class="row wrap"><h1>이력 관리</h1><span class="note">로그인 기록과 모든 작업(생성·수정·삭제·변경)을 누가·언제·무엇을·어떻게·왜 했는지 남깁니다</span></div>' +
      '<div class="card audf"><div class="row wrap" style="align-items:flex-end;gap:10px">' +
      '<label class="fl">기간<br><input type="date" id="au_f" value="' + esc(v.from) + '"> ~ <input type="date" id="au_t" value="' + esc(v.to) + '"></label>' +
      '<label class="fl">작업자<br><input type="text" id="au_a" value="' + esc(v.actor) + '" placeholder="사번·성명" style="width:120px"></label>' +
      '<label class="fl">대상<br><input type="text" id="au_g" value="' + esc(v.target) + '" placeholder="자산번호 등" style="width:140px"></label>' +
      '<label class="fl">검색<br><input type="text" id="au_q" value="' + esc(v.q) + '" placeholder="내용·사유 포함 검색" style="width:180px"></label>' +
      '<button class="btn pri" id="au_go" type="button">조회</button><button class="btn" id="au_rs" type="button">초기화</button><div class="grow"></div><button class="btn pri" id="au_ex" type="button">내보내기</button></div>' +
      '<div class="fchips" id="au_chips" style="margin-top:8px">' + CHIPS.map(function (c) { return '<button type="button" class="achip' + (v.chip === c[0] ? ' on' : '') + '" data-c="' + c[0] + '">' + c[1] + '</button>'; }).join('') + '</div></div>' +
      '<div id="audres"><div class="note" style="padding:16px">불러오는 중…</div></div>');
    function read() { AUDSEL = {}; v.from = $('#au_f').value; v.to = $('#au_t').value; v.actor = $('#au_a').value.trim(); v.target = $('#au_g').value.trim(); v.q = $('#au_q').value.trim(); v.page = 0; }
    $('#au_go').onclick = function () { read(); loadAuditList(); };
    ['au_a', 'au_g', 'au_q'].forEach(function (id) { $('#' + id).onkeydown = function (e) { if (e.key === 'Enter' && !e.isComposing) { read(); loadAuditList(); } }; });
    $('#au_rs').onclick = function () { AUDSEL = {}; AUDV = { from: '', to: '', actor: '', target: '', q: '', chip: 'all', page: 0 }; pageAudit(); };
    $$('#au_chips .achip').forEach(function (b) { b.onclick = function () { read(); v.chip = b.dataset.c; $$('#au_chips .achip').forEach(function (x) { x.classList.toggle('on', x === b); }); loadAuditList(); }; });
    $('#au_ex').onclick = function () { read(); auditExportDialog(); };
    loadAuditList();
  }
  async function loadAuditList() {
    var box = $('#audres'); if (!box) return;
    var res;
    await loadOfficeIps();
    try { res = await auditFetch(AUDV.page, AUD_PS); } catch (e) { box.innerHTML = '<div class="note" style="color:#c42b1c;padding:14px">' + esc(e.message || e) + '<br>v1.9.5 SQL(update_v1.9.5.sql)을 실행했는지 확인하세요.</div>'; return; }
    var rows = res.rows, pages = Math.max(1, Math.ceil(res.count / AUD_PS));
    var trs = rows.map(function (r, i) {
      return '<tr class="clk' + (AUDSEL[r.id] ? ' rsel' : '') + '" data-i="' + i + '"><td class="cbx wonly"><input type="checkbox" class="au_c" value="' + esc(r.id) + '"' + (AUDSEL[r.id] ? ' checked' : '') + '></td><td style="white-space:nowrap">' + esc(ymd(r.at).slice(5) + ' ' + hm(r.at)) + '</td><td>' + actorHtml(r) + '</td><td>' + actBadge(r.action) + '</td><td>' + esc(r.target || '') + '</td><td>' + esc(r.summary || '') + (r.reason ? ' <span class="note">· 사유: ' + esc(r.reason) + '</span>' : '') + '</td><td>' + ipLocalHtml(r) + '</td><td class="mono">' + esc(r.ip || '') + '</td></tr>';
    }).join('') || '<tr><td colspan="8" class="note" style="padding:22px;text-align:center">조건에 맞는 이력이 없습니다.' + (AUDV.target ? '<br>(PC 프로그램이 자동으로 올리는 점검·사양 변경은 이력 관리에 기록하지 않으며, 자산 상세의 "변경 이력"에서 확인합니다.)' : '') + '</td></tr>';
    box.innerHTML = '<div class="note" style="margin:8px 0">검색 결과 ' + res.count.toLocaleString() + '건 · 최근순 · 한 번에 ' + AUD_PS + '건' + (AUDV.target ? ' · <span class="fchip">대상: ' + esc(AUDV.target) + '</span>' : '') + '</div>' +
      '<div class="bulk noprint" id="au_bar" style="display:none"><b id="au_n"></b><span>|</span><button class="btn sm dng" id="au_del" type="button">선택 삭제</button><button class="btn sm" id="au_menu" type="button">전체 선택 ▾</button><button class="btn sm" id="au_clr" type="button">선택 해제</button></div>' +
      '<table class="tbl audtb"><colgroup><col style="width:3%"><col style="width:8%"><col style="width:11%"><col style="width:8%"><col style="width:11%"><col style="width:27%"><col style="width:18%"><col style="width:14%"></colgroup><thead><tr><th class="cbx"><input type="checkbox" id="au_all" title="이 페이지 전체 선택"></th><th>일시</th><th>작업자</th><th>구분</th><th>대상</th><th>내용</th><th class="ipth">접속 IP (내부) · 접속 구분</th><th class="ipth">접속 IP (공인)</th></tr></thead><tbody>' + trs + '</tbody></table>' +
      '<div class="row" style="justify-content:center;gap:10px;margin:10px 0"><button class="btn sm" id="au_pv"' + (AUDV.page <= 0 ? ' disabled' : '') + '>‹ 이전</button><span class="note">' + (AUDV.page + 1) + ' / ' + pages + '쪽</span><button class="btn sm" id="au_nx"' + (AUDV.page + 1 >= pages ? ' disabled' : '') + '>다음 ›</button></div>' +
      '<div class="card"><div class="note" style="line-height:1.8">· 행을 누르면 상세(누가·언제·무엇을·어떻게·왜·어디서)가 열립니다<br>· 이력은 <b>수정할 수 없고</b>, 삭제는 메인 관리자만 사유를 남기고 할 수 있습니다 (삭제 기록은 삭제 불가) · 이 메뉴는 메인 관리자에게만 보입니다<br>· PC 프로그램이 자동으로 올리는 점검 정보는 건수가 많아 기록하지 않고, 모니터 연결·분리만 기록합니다</div></div>';
    AUDROWS = rows;
    $$('tr.clk', box).forEach(function (tr) { tr.onclick = function (e) { if (e.target && e.target.tagName === 'INPUT') return; auditDetail(rows[+tr.dataset.i]); }; });
    $$('.au_c', box).forEach(function (c) { c.onclick = function (e) { e.stopPropagation(); }; c.onchange = function () { if (c.checked) AUDSEL[c.value] = 1; else delete AUDSEL[c.value]; c.closest('tr').classList.toggle('rsel', c.checked); audSync(); }; });
    var ha = $('#au_all', box); if (ha) ha.onchange = function () { $$('.au_c', box).forEach(function (c) { c.checked = ha.checked; if (ha.checked) AUDSEL[c.value] = 1; else delete AUDSEL[c.value]; c.closest('tr').classList.toggle('rsel', c.checked); }); audSync(); };
    $('#au_clr', box).onclick = function () { AUDSEL = {}; $$('.au_c', box).forEach(function (c) { c.checked = false; c.closest('tr').classList.remove('rsel'); }); audSync(); };
    $('#au_del', box).onclick = function () { auditDeleteDlg(); };
    $('#au_menu', box).onclick = function (e) { e.stopPropagation(); audMenu(this, res.count); };
    audSync();
    $('#au_pv', box).onclick = function () { AUDV.page--; loadAuditList(); }; $('#au_nx', box).onclick = function () { AUDV.page++; loadAuditList(); };
  }
  // v1.9.6: 접속 구분(모바일 / PC / PC 프로그램) + 접속 IP (내부)
  //  · PC 프로그램 기록: 프로그램이 직접 보낸 실제 내부 IP
  //  · 모바일 웹 접속: 브라우저는 내부 IP를 알 수 없으므로 '-'
  //  · PC 웹 접속: 접속 공인 IP가 PC 프로그램이 보고한 사무실 공인 IP와 같을 때만 같은 사번 PC의 내부 IP를 'PC 기준'으로 표시, 아니면(집·외부) '-'
  var OFFICE_IPS = {}, KIND_L = { prog: 'PC 프로그램', mobile: '모바일', pc: 'PC' };
  async function loadOfficeIps() {
    if (DEMO) { OFFICE_IPS = { '121.134.13.253': 1 }; return; }
    try {
      var r = await sb.from('audit_log').select('ip').not('ip_local', 'is', null).order('at', { ascending: false }).limit(1000), m = {};
      (r.data || []).forEach(function (x) { if (x.ip) m[x.ip] = 1; }); OFFICE_IPS = m;
    } catch (e) { }
  }
  function accessKind(r) {
    if (r.actor_role === 'program' || r.ip_local) return 'prog';
    return /Android|iPhone|iPad|iPod|iOS|Mobile/i.test(r.ua || '') ? 'mobile' : 'pc';
  }
  function bestDev(sabun) {
    var best = null;
    (S.devices || []).forEach(function (d) { if (d.ip && sabun && d.emp_no === sabun && (!best || new Date(d.last_seen || 0) > new Date(best.last_seen || 0))) best = d; });
    return best;
  }
  function ipLocal(r) {
    var k = accessKind(r);
    if (r.ip_local) return { ip: r.ip_local, est: false, kind: k };
    if (k === 'mobile') return { ip: null, kind: k };
    if (k === 'pc' && !r.actor_sabun) return null;
    var d = bestDev(r.actor_sabun);
    if (k === 'prog') return d ? { ip: d.ip, est: true, kind: k } : { ip: null, kind: k };
    return d && r.ip && OFFICE_IPS[r.ip] ? { ip: d.ip, est: true, kind: k } : { ip: null, kind: k };
  }
  function ipLocalHtml(r) {
    var x = ipLocal(r); if (!x) return '<span class="note">확인 불가</span>';
    return (x.ip ? '<span class="mono' + (x.est ? ' note' : '') + '">' + esc(x.ip) + '</span>' : '<span class="mono note">-</span>') + ' <span class="kdb k-' + x.kind + '">' + KIND_L[x.kind] + '</span>';
  }
  // v1.9.5: 이력 선택·삭제 (메인 관리자 전용)
  var AUDSEL = {}, AUDROWS = [], AUD_MAX = 500;
  function audSync() {
    var box = $('#audres'); if (!box) return;
    var ids = Object.keys(AUDSEL), cs = $$('.au_c', box), on = cs.filter(function (c) { return c.checked; }).length, bar = $('#au_bar', box);
    if (bar) { bar.style.display = ids.length ? '' : 'none'; $('#au_n', box).textContent = ids.length + '개 선택됨'; }
    var ha = $('#au_all', box); if (ha) { ha.checked = cs.length > 0 && on === cs.length; ha.indeterminate = on > 0 && on < cs.length; }
  }
  function audMenu(btn, total) {
    $$('.audmenu').forEach(function (m) { m.remove(); });
    var m = document.createElement('div'); m.className = 'audmenu';
    m.innerHTML = '<button type="button" data-k="page">이 페이지 ' + AUDROWS.length + '건 모두 선택</button><button type="button" data-k="all">조회된 ' + total.toLocaleString() + '건 모두 선택 (다른 페이지 포함, 최대 ' + AUD_MAX + '건)</button><button type="button" data-k="none">선택 해제</button>';
    var r = btn.getBoundingClientRect(); m.style.left = Math.max(8, r.left) + 'px'; m.style.top = (r.bottom + 4) + 'px'; document.body.appendChild(m);
    function close() { m.remove(); document.removeEventListener('click', close); }
    setTimeout(function () { document.addEventListener('click', close); }, 0);
    $$('button', m).forEach(function (b) {
      b.onclick = async function () {
        var k = b.dataset.k; close();
        try {
          if (k === 'none') AUDSEL = {};
          else if (k === 'page') AUDROWS.forEach(function (x) { AUDSEL[x.id] = 1; });
          else { var res = await auditFetch(0, AUD_MAX); res.rows.forEach(function (x) { AUDSEL[x.id] = 1; }); if (res.count > AUD_MAX) toast('한 번에 최대 ' + AUD_MAX + '건까지 선택됩니다. (' + res.count.toLocaleString() + '건 중 최근 ' + AUD_MAX + '건)'); }
          $$('.au_c', $('#audres')).forEach(function (c) { c.checked = !!AUDSEL[c.value]; c.closest('tr').classList.toggle('rsel', c.checked); }); audSync();
        } catch (e) { fail(e); }
      };
    });
  }
  async function auditDeleteDlg() {
    if (!isMain()) { toast('이력 삭제는 메인 관리자만 할 수 있습니다.'); return; }
    var ids = Object.keys(AUDSEL); if (!ids.length) return;
    if (ids.length > AUD_MAX) { toast('한 번에 최대 ' + AUD_MAX + '건까지 삭제할 수 있습니다.'); return; }
    var m = openModal('<div class="mh"><b>이력 ' + ids.length + '건 삭제</b><button class="mx" type="button">✕</button></div>' +
      '<div class="warnbox">선택한 이력 <b>' + ids.length + '건</b>을 삭제합니다.<br><b>삭제한 이력은 되돌릴 수 없습니다.</b> 삭제한 사실은 새 이력으로 남습니다.</div>' +
      '<div class="ms">삭제 사유 (필수)</div><textarea id="ad_r" rows="2" style="width:100%;box-sizing:border-box" placeholder="예: 테스트 중 생긴 로그인 실패 기록 정리"></textarea>' +
      '<label style="display:block;margin:8px 0"><input type="checkbox" id="ad_ex" checked> 삭제 전에 선택한 이력을 엑셀로 내보내기 <span style="color:#1e8e3e">(권장)</span></label>' +
      '<div class="ms">확인을 위해 <b>이력 삭제</b> 를 그대로 입력하세요</div><input type="text" id="ad_n" autocomplete="off" style="width:100%;box-sizing:border-box">' +
      '<div class="mf"><button class="btn" id="ad_x" type="button">취소</button><button class="btn dng sel" id="ad_ok" type="button" disabled>' + ids.length + '건 삭제</button></div>', 480);
    function chk() { $('#ad_ok', m.d).disabled = !($('#ad_r', m.d).value.trim() && $('#ad_n', m.d).value.trim() === '이력 삭제'); }
    $('#ad_r', m.d).oninput = chk; $('#ad_n', m.d).oninput = chk; $('#ad_r', m.d).focus();
    $('#ad_x', m.d).onclick = m.close;
    $('#ad_ok', m.d).onclick = async function () {
      var rs = $('#ad_r', m.d).value.trim(), doEx = $('#ad_ex', m.d).checked, btn = this; btn.disabled = true; btn.textContent = '삭제 중…';
      try {
        var rows;
        if (DEMO) rows = (S.audit || []).filter(function (x) { return AUDSEL[x.id]; });
        else { var r = await sb.from('audit_log').select('*').in('id', ids).order('at', { ascending: false }); if (r.error) throw r.error; rows = r.data; }
        if (!rows.length) throw new Error('선택한 이력을 찾지 못했습니다.');
        if (doEx) {
          var ex = rows.map(function (x) { return { '일시': ymd(x.at) + ' ' + hm(x.at), '작업자 사번': x.actor_sabun || '', '성명': x.actor_name || '', '구분': ACT_L[x.action] || x.action, '대상': x.target || '', '내용': x.summary || '', '사유': x.reason || '', '접속 IP (내부)': x.ip_local || '', '접속 IP (공인)': x.ip || '' }; });
          var ws = XLSX.utils.json_to_sheet(ex), wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, '삭제한 이력'); XLSX.writeFile(wb, '삭제한이력_' + ymd(new Date()).replace(/-/g, '') + '.xlsx');
        }
        var from = rows[rows.length - 1].at, to = rows[0].at, cnt = rows.length;
        if (DEMO) S.audit = S.audit.filter(function (x) { return !AUDSEL[x.id]; });
        else { var d = await sb.from('audit_log').delete().in('id', ids); if (d.error) throw d.error; }
        await auditPost({ action: 'purge', target: '이력 관리', summary: '이력 ' + cnt + '건 삭제 (' + ymd(from).slice(5) + ' ~ ' + ymd(to).slice(5) + ' 기록)' + (doEx ? ' · 삭제 전 엑셀 내보내기 완료' : ''), reason: rs, detail: { via: '이력 관리 · 선택 삭제', note: '삭제 ' + cnt + '건 · 기간 ' + ymd(from) + ' ~ ' + ymd(to) } });
        AUDSEL = {}; m.close(); toast('이력 ' + cnt + '건을 삭제했습니다.'); loadAuditList();
      } catch (e) { btn.disabled = false; btn.textContent = ids.length + '건 삭제'; fail(e); }
    };
  }
  function auditHow(r) {
    var ch = r.detail && r.detail.changes, via = (r.detail && r.detail.via) || '';
    var html = '<div>' + esc(via || r.summary || '') + '</div>';
    if (ch && ch.length) html += '<table class="tbl" style="margin-top:6px"><thead><tr><th>항목</th><th>변경 전</th><th>변경 후</th></tr></thead><tbody>' + ch.map(function (c) { return '<tr><td>' + esc(c.k) + '</td><td>' + esc(c.from) + '</td><td><b>' + esc(c.to) + '</b></td></tr>'; }).join('') + '</tbody></table>';
    else if (r.detail && r.detail.note) html += '<div class="note">' + esc(r.detail.note) + '</div>';
    return html;
  }
  function auditDetail(r) {
    function kv(k, v) { return '<div class="kv"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>'; }
    var w = r.actor_name ? '<span class="rchip a">' + (r.actor_role === 'viewer' ? '조회' : '관리자') + '</span> ' + esc([r.actor_dept, r.actor_name, r.actor_title].filter(Boolean).join(' ')) + ' <span class="note">(사번 ' + esc(r.actor_sabun || '') + (actorRole(r.actor_role) ? ' · ' + actorRole(r.actor_role) : '') + ')</span>' : esc(r.actor_sabun ? '알 수 없음 (입력한 사번 ' + r.actor_sabun + ')' : '—');
    var m = openModal('<div class="mh"><b>이력 상세</b> ' + actBadge(r.action) + '<span style="flex:1"></span><button class="mx" type="button">✕</button></div>' +
      kv('누가', w) + kv('언제', esc(ymd(r.at) + ' ' + hm(r.at) + ':' + ('0' + new Date(r.at).getSeconds()).slice(-2))) + kv('무엇을', esc(r.target || '') + (r.summary ? '<div class="note">' + esc(r.summary) + '</div>' : '')) +
      kv('어떻게', auditHow(r)) + kv('왜 (사유)', r.reason ? esc(r.reason) : '<span class="note">입력된 사유 없음</span>') + kv('어디서', (function () { var x = ipLocal(r), k = accessKind(r); return '접속 구분 <span class="kdb k-' + k + '">' + KIND_L[k] + '</span><br>공인 IP ' + esc(r.ip || '—') + '<br>내부 IP ' + (!x ? '<span class="note">확인 불가</span>' : x.ip ? esc(x.ip) + ' <span class="note">(' + (x.est ? '출처: 같은 사번 PC의 최근 내부 IP · PC 기준' : '출처: PC 프로그램이 직접 보낸 값') + ')</span>' : '<span class="note">' + (k === 'mobile' ? '확인 불가 (모바일 브라우저는 내부 IP를 알 수 없음)' : '확인 불가 (사무실 밖 접속)') + '</span>'); })() + (r.ua ? '<div class="note">' + esc(r.ua) + '</div>' : '')) +
      '<div class="mf"><button class="btn" id="ad_t" type="button">이 대상 이력만 보기</button><button class="btn pri" id="ad_x" type="button">닫기</button></div>', 520);
    $('#ad_x', m.d).onclick = m.close;
    $('#ad_t', m.d).onclick = function () { AUDV.target = r.target || ''; AUDV.page = 0; m.close(); pageAudit(); };
  }
  function auditExportDialog() {
    var v = AUDV, m = openModal('<div class="mh"><b>이력 내보내기</b><button class="mx" type="button">✕</button></div>' +
      '<div class="note" style="margin-bottom:8px">현재 화면의 <b>기간·구분·작업자·대상·검색 조건</b> 그대로 내보냅니다.</div><div class="kv"><div class="k">기간</div><div class="v">' + esc((v.from || '전체') + ' ~ ' + (v.to || '전체')) + '</div></div>' +
      '<div class="ms">파일 형식</div><label style="margin-right:14px"><input type="radio" name="aef" value="xlsx" checked> 엑셀 (.xlsx)</label><label><input type="radio" name="aef" value="csv"> CSV (.csv)</label>' +
      '<div class="note" style="margin-top:8px">포함 항목: 일시 · 작업자(사번·권한·부서·성명·직책) · 구분 · 대상 · 내용 · 변경 전→후 · 사유 · 접속 IP (내부) · 접속 IP (공인)<br>※ 내보낸 사실도 이력에 "내보내기"로 남습니다. (최대 20,000건)</div>' +
      '<div class="mf"><button class="btn" id="ae_x" type="button">취소</button><button class="btn pri" id="ae_ok" type="button">내보내기</button></div>', 460);
    $('#ae_x', m.d).onclick = m.close;
    $('#ae_ok', m.d).onclick = async function () {
      var fmt = $('input[name=aef]:checked', m.d).value, btn = this; btn.disabled = true; btn.textContent = '준비 중…';
      try {
        var all = [], pg = 0;
        for (; pg < 20; pg++) { var r = await auditFetch(pg, 1000); all = all.concat(r.rows); if (r.rows.length < 1000) break; }
        var rows = all.map(function (r) {
          var ch = r.detail && r.detail.changes ? r.detail.changes.map(function (c) { return c.k + ': ' + c.from + ' → ' + c.to; }).join(' / ') : '';
          return { '일시': ymd(r.at) + ' ' + hm(r.at) + ':' + ('0' + new Date(r.at).getSeconds()).slice(-2), '작업자 사번': r.actor_sabun || '', '권한': actorRole(r.actor_role), '부서': r.actor_dept || '', '성명': r.actor_name || '', '직책': r.actor_title || '', '구분': ACT_L[r.action] || r.action, '대상': r.target || '', '내용': r.summary || '', '변경 전→후': ch, '사유': r.reason || '', '접속 구분': (function () { return KIND_L[accessKind(r)] || ''; })(), '접속 IP (내부)': (function () { var x = ipLocal(r); return x && x.ip ? x.ip + (x.est ? ' (PC 기준)' : '') : ''; })(), '접속 IP (공인)': r.ip || '', '브라우저': r.ua || '' };
        });
        var name = '이력관리_' + (v.from || 'all').replace(/-/g, '') + '-' + (v.to || 'all').replace(/-/g, '');
        if (fmt === 'xlsx') { var ws = XLSX.utils.json_to_sheet(rows), wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, '이력'); XLSX.writeFile(wb, name + '.xlsx'); }
        else { var csv = XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet(rows)), bl = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), a = document.createElement('a'); a.href = URL.createObjectURL(bl); a.download = name + '.csv'; document.body.appendChild(a); a.click(); a.remove(); }
        logExport('이력 관리', rows.length, '이력 내보내기(' + fmt + ')');
        m.close(); toast(rows.length.toLocaleString() + '건을 내보냈습니다.');
      } catch (e) { btn.disabled = false; btn.textContent = '내보내기'; fail(e); }
    };
  }

  // =====================================================================
  // v1.9.4: 모니터 연결 (PC 프로그램 자동 감지 + QR 연결)
  // =====================================================================
  function monsOf(dev) { return dev ? (S.monitors || []).filter(function (m) { return m.device_id === dev.id && !m.gone; }) : []; }
  function devOfMon(mon) { return S.devices.filter(function (d) { return d.id === mon.device_id; })[0] || null; }
  async function linkMonitor(mon, assetNo) {
    needWrite();
    var dev = devOfMon(mon), pc = dev && dev.asset_no || null, mrow = { asset_no: assetNo, link_source: 'manual' };
    audCtx({ table: 'device_monitors', action: 'change', target: '자산 ' + assetNo, summary: '모니터 ' + assetNo + ' ↔ PC ' + (pc || (dev && dev.computer_name) || '') + ' 연결 (수동)', detail: { via: '모니터 연결 (자산 화면·QR 스캔)', changes: [{ k: '연결 PC', from: '없음', to: pc || (dev && dev.computer_name) || '' }, { k: '시리얼 번호', from: '(대장 값)', to: mon.serial || '없음' }] } });
    if (!DEMO) { var r = await sb.from('device_monitors').update(mrow).eq('id', mon.id); if (r.error) throw r.error; }
    Object.assign(mon, mrow);
    var patch = { linked_pc: pc }; if (mon.serial) patch.serial_no = mon.serial;
    await dbUpdateAsset(assetNo, patch, null, true);
    await dbHistory(assetNo, 'link', '모니터 연결: PC ' + (pc || (dev && dev.computer_name) || '') + ' (수동)', null);
    if (pc) await dbHistory(pc, 'link', '모니터 연결: ' + assetNo + ' (' + (mon.model || '') + ')', dev && dev.id);
  }
  async function unlinkMonitor(mon) {
    needWrite();
    var no = mon.asset_no; if (!no) return;
    audCtx({ table: 'device_monitors', action: 'change', target: '자산 ' + no, summary: '모니터 ' + no + ' 연결 해제', detail: { changes: [{ k: '연결 PC', from: '연결됨', to: '없음' }] } });
    if (!DEMO) { var r = await sb.from('device_monitors').update({ asset_no: null, link_source: null }).eq('id', mon.id); if (r.error) throw r.error; }
    mon.asset_no = null; mon.link_source = null;
    await dbUpdateAsset(no, { linked_pc: null }, null, true);
  }
  function monCardHtml(a, d) {
    var h = '<div class="card" style="margin-top:12px"><h3>연관 자산 · 모니터 <span class="note" style="font-weight:400">(PC 프로그램이 모니터에서 읽은 정보)</span></h3>';
    if (isPc(a)) {
      if (!d) return h + '<div class="note">연결된 PC 정보가 없어 모니터를 읽어 올 수 없습니다.</div></div>';
      var ms = monsOf(d);
      if (!ms.length) return h + '<div class="note">아직 읽어 온 모니터 정보가 없습니다. (PC 프로그램 v1.9.4 이상이 실행되면 자동으로 채워집니다)</div></div>';
      return h + '<table class="tbl"><thead><tr><th>모니터(모델)</th><th>시리얼 번호</th><th>제조 년월</th><th>해상도</th><th>연결 상태</th><th>최종 확인</th></tr></thead><tbody>' + ms.map(function (m) {
        var st = m.asset_no ? badge('자산 연결됨', 'ok') + ' <a href="#/asset/' + encodeURIComponent(m.asset_no) + '" class="mono">' + esc(m.asset_no) + '</a> <a href="#" class="mon-un" data-m="' + esc(m.id) + '">해제</a>' : badge('자산 미연결', 'pink') + ' <a href="#" class="mon-ln" data-m="' + esc(m.id) + '">모니터 자산 선택</a>';
        return '<tr><td>' + esc([m.maker, m.model].filter(Boolean).join(' ')) + '</td><td class="mono">' + esc(m.serial || '—') + '</td><td>' + esc(m.made_ym || '—') + '</td><td>' + esc(m.resolution || '—') + '</td><td>' + st + '</td><td>' + esc(ymd(m.last_seen).slice(5) + ' ' + hm(m.last_seen)) + '</td></tr>';
      }).join('') + '</tbody></table><div class="note" style="margin-top:6px">시리얼이 모니터 자산의 시리얼 번호와 같으면 자동으로 연결됩니다. 자동 연결이 안 되는 모니터는 [모니터 자산 선택] 또는 모니터 QR 스캔으로 연결하세요.</div></div>';
    }
    if (a.category === '모니터') {
      var mm = (S.monitors || []).filter(function (m) { return m.asset_no === a.asset_no && !m.gone; })[0], pcNo = a.linked_pc;
      h = h.replace('연관 자산 · 모니터', '연결 PC');
      if (pcNo) return h + '<div>연결된 PC: <a href="#/asset/' + encodeURIComponent(pcNo) + '" class="mono">' + esc(pcNo) + '</a>' + (mm ? ' · ' + esc((mm.maker || '') + ' ' + (mm.model || '')) + ' · 시리얼 ' + esc(mm.serial || '—') + ' ' + badge(mm.link_source === 'auto' ? '시리얼 일치(자동)' : 'QR·수동 연결', 'gray') + ' <a href="#" class="mon-un" data-m="' + esc(mm.id) + '">연결 해제</a>' : '') + '</div></div>';
      return h + '<div class="note">연결된 PC가 없습니다. PC 프로그램이 읽은 시리얼이 이 자산의 시리얼 번호와 같으면 자동 연결되고, 아니면 아래 버튼으로 연결하세요.</div><div style="margin-top:8px"><button class="btn pri sm wonly" id="mon-pick" type="button">PC와 연결</button></div></div>';
    }
    return '';
  }
  function bindMonCard(a, rerender) {
    $$('.mon-un').forEach(function (x) { x.onclick = async function (e) { e.preventDefault(); var m = (S.monitors || []).filter(function (y) { return y.id === x.dataset.m; })[0]; if (!m || !confirm('모니터 연결을 해제할까요?')) return; try { await unlinkMonitor(m); rerender(); } catch (er) { fail(er); } }; });
    $$('.mon-ln').forEach(function (x) { x.onclick = function (e) { e.preventDefault(); var m = (S.monitors || []).filter(function (y) { return y.id === x.dataset.m; })[0]; if (m) pickMonitorAsset(m, rerender); }; });
    var pk = $('#mon-pick'); if (pk) pk.onclick = function () { pickPcMonitor(a, rerender); };
  }
  function pickMonitorAsset(mon, done) {   // PC 쪽에서: 이 모니터(읽은 정보)에 해당하는 모니터 자산 고르기
    var cands = S.assets.filter(function (x) { return x.category === '모니터' && !x.linked_pc; });
    var m = openModal('<div class="mh"><b>모니터 자산 선택</b><button class="mx" type="button">✕</button></div><div class="note" style="margin-bottom:6px">읽어 온 모니터: <b>' + esc((mon.maker || '') + ' ' + (mon.model || '')) + '</b> · 시리얼 ' + esc(mon.serial || '—') + '</div><input type="text" id="pm_q" placeholder="관리번호·모델·사용자" style="width:100%;box-sizing:border-box"><div id="pm_l" class="pickl"></div>', 480);
    function draw() {
      var q = ($('#pm_q', m.d).value || '').toLowerCase(), key = ((mon.model || '') + '').toLowerCase().replace(/[^a-z0-9]/g, '');
      var l = cands.filter(function (x) { return !q || [x.asset_no, x.model, x.user_name].join(' ').toLowerCase().indexOf(q) >= 0; });
      l.sort(function (x, y) { var sx = key && String(x.model || '').toLowerCase().replace(/[^a-z0-9]/g, '').indexOf(key) >= 0 ? 0 : 1, sy = key && String(y.model || '').toLowerCase().replace(/[^a-z0-9]/g, '').indexOf(key) >= 0 ? 0 : 1; return sx - sy; });
      $('#pm_l', m.d).innerHTML = l.slice(0, 30).map(function (x) { return '<div class="pickr" data-no="' + esc(x.asset_no) + '"><b class="mono">' + esc(x.asset_no) + '</b> ' + esc((x.manufacturer || '') + ' ' + (x.model || '')) + ' <span class="note">· ' + esc(x.user_name || '') + ' ' + esc(x.dept || '') + '</span></div>'; }).join('') || '<div class="note" style="padding:8px">연결할 수 있는 모니터 자산이 없습니다.</div>';
      $$('.pickr', m.d).forEach(function (r) { r.onclick = async function () { try { await linkMonitor(mon, r.dataset.no); m.close(); toast('모니터를 연결했습니다.'); done(); } catch (e) { fail(e); } }; });
    }
    var qe = $('#pm_q', m.d); qe.oninput = function (e) { if (e && e.isComposing) return; draw(); }; qe.addEventListener('compositionend', draw); draw(); qe.focus();
  }
  function pickPcMonitor(a, done) {   // 모니터 자산 쪽에서: 감지된 미연결 모니터(PC) 고르기
    var cands = (S.monitors || []).filter(function (m) { return !m.gone && !m.asset_no; }), key = String(a.model || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    cands.sort(function (x, y) { var sx = key && String(x.model || '').toLowerCase().replace(/[^a-z0-9]/g, '').indexOf(key) >= 0 ? 0 : 1, sy = key && String(y.model || '').toLowerCase().replace(/[^a-z0-9]/g, '').indexOf(key) >= 0 ? 0 : 1; return sx - sy; });
    var m = openModal('<div class="mh"><b>연결할 PC 선택</b><button class="mx" type="button">✕</button></div><div class="note" style="margin-bottom:6px">모니터 <b class="mono">' + esc(a.asset_no) + '</b> · ' + esc((a.manufacturer || '') + ' ' + (a.model || '')) + ' (PC 프로그램이 감지한 미연결 모니터 중에서 고릅니다)</div><div class="pickl">' +
      (cands.slice(0, 30).map(function (c) { var dv = devOfMon(c), ae = dv && dv.asset_no ? S.assets.filter(function (x) { return x.asset_no === dv.asset_no; })[0] : null; return '<div class="pickr" data-id="' + esc(c.id) + '"><b class="mono">' + esc((dv && dv.asset_no) || (dv && dv.computer_name) || '') + '</b> ' + esc(ae ? (ae.user_name || '') : '') + '<br><span class="note">' + esc((c.maker || '') + ' ' + (c.model || '')) + ' · 시리얼 ' + esc(c.serial || '—') + ' · 제조 ' + esc(c.made_ym || '—') + '</span></div>'; }).join('') || '<div class="note" style="padding:8px">감지된 미연결 모니터가 없습니다. PC 프로그램이 실행되면 목록에 나타납니다.</div>') + '</div>', 480);
    $$('.pickr', m.d).forEach(function (r) { r.onclick = async function () { var mon = (S.monitors || []).filter(function (y) { return y.id === r.dataset.id; })[0]; try { await linkMonitor(mon, a.asset_no); m.close(); toast('PC와 연결했습니다.'); done(); } catch (e) { fail(e); } }; });
  }

  // =====================================================================
  // v1.9.4: QR 스캔 (모든 전산장비 공통) — 카메라 + 직접 입력
  // =====================================================================
  var SCAN = { stream: null, raf: 0, on: false };
  function scanStop() { SCAN.on = false; cancelAnimationFrame(SCAN.raf); if (SCAN.stream) SCAN.stream.getTracks().forEach(function (t) { t.stop(); }); SCAN.stream = null; }
  function scanStart(videoEl, onCode) {
    scanStop();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return Promise.reject(new Error('이 브라우저는 카메라를 쓸 수 없습니다. 관리번호를 직접 입력하세요. (카메라는 https 주소에서만 동작합니다)'));
    return navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }).then(function (st) {
      SCAN.stream = st; videoEl.srcObject = st; videoEl.setAttribute('playsinline', 'true'); videoEl.play(); SCAN.on = true;
      var det = window.BarcodeDetector ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null, cv = document.createElement('canvas'), last = 0;
      (function tick(ts) {
        if (!SCAN.on) return; SCAN.raf = requestAnimationFrame(tick);
        if (ts - last < 150 || videoEl.readyState < 2) return; last = ts;
        if (det) det.detect(videoEl).then(function (r) { if (r && r[0]) onCode(r[0].rawValue); }).catch(function () { });
        else if (window.jsQR) {
          var w = videoEl.videoWidth, h = videoEl.videoHeight; if (!w) return; cv.width = w; cv.height = h;
          var cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(videoEl, 0, 0, w, h);
          var c = window.jsQR(cx.getImageData(0, 0, w, h).data, w, h); if (c && c.data) onCode(c.data);
        }
      })(0);
    });
  }
  function normScan(v) { var s0 = String(v || '').trim(), m = /#\/asset\/([^?#]+)/.exec(s0); if (m) s0 = decodeURIComponent(m[1]); return s0.toUpperCase(); }
  // 스캔 창: handle(no, api) 가 끝나면 api.release() 로 다음 스캔을 받음
  function scanOverlay(title, handle, onClose) {
    var ov = document.createElement('div'); ov.className = 'scanov';
    ov.innerHTML = '<div class="sch"><b>' + esc(title) + '</b><span style="flex:1"></span><button class="btn sm" id="sc_x" type="button">닫기</button></div>' +
      '<div class="scv"><video id="sc_v" muted playsinline></video><div class="scfr"></div></div><div id="sc_msg" class="scmsg">QR 스티커를 비춰 주세요 (카메라를 준비하는 중…)</div><div id="sc_sheet" class="scsheet" style="display:none"></div>' +
      '<div class="scman"><input id="sc_in" type="text" placeholder="관리번호 직접 입력 (예: A-PC-2020-043)"><button class="btn pri" id="sc_go" type="button">조회</button></div>';
    document.body.appendChild(ov);
    var busy = false, api = {
      close: function () { scanStop(); ov.remove(); if (onClose) onClose(); },
      msg: function (t) { $('#sc_msg', ov).textContent = t; },
      sheet: function (html) { var s0 = $('#sc_sheet', ov); s0.innerHTML = html; s0.style.display = html ? '' : 'none'; return s0; },
      release: function () { busy = false; api.sheet(''); api.msg('QR 스티커를 비춰 주세요'); }
    };
    function got(v) { var no = normScan(v); if (!no || busy) return; busy = true; api.msg(no + ' 확인 중…'); Promise.resolve(handle(no, api)).catch(function (e) { fail(e); api.release(); }); }
    $('#sc_x', ov).onclick = api.close;
    $('#sc_go', ov).onclick = function () { got($('#sc_in', ov).value); $('#sc_in', ov).value = ''; };
    $('#sc_in', ov).onkeydown = function (e) { if (e.key === 'Enter' && !e.isComposing) $('#sc_go', ov).onclick(); };
    scanStart($('#sc_v', ov), got).then(function () { api.msg('QR 스티커를 비춰 주세요'); }, function (e) { api.msg((e && e.message) || '카메라를 시작하지 못했습니다. 관리번호를 직접 입력하세요.'); });
    return api;
  }
  function readPhoto(file) {   // 사진은 가로 800px·JPEG로 줄여서 저장 (DB 용량 절약)
    return new Promise(function (resolve, reject) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () { var k = Math.min(1, 800 / Math.max(img.width, img.height)), c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); resolve(c.toDataURL('image/jpeg', 0.6)); };
      img.onerror = function () { reject(new Error('사진을 읽지 못했습니다.')); }; img.src = url;
    });
  }

  // =====================================================================
  // v1.9.4: 실사(재물조사)
  // =====================================================================
  var INVD = null;
  var ICOLS = 'id,inventory_id,asset_no,category,dept,user_name,location,result,method,changed,new_location,new_user,abn_type,note,checked_by,checked_name,checked_at,resolution,resolved_note';
  function mkItem(a, invId, autoDays) {
    var it = { inventory_id: invId, asset_no: a.asset_no, category: a.category || null, dept: a.dept || null, user_name: a.user_name || null, location: a.location || null, result: 'pending' };
    if (autoDays && isPc(a) && a._dev && a._dev.last_seen && (Date.now() - new Date(a._dev.last_seen).getTime()) / 86400000 <= autoDays) { it.result = 'auto'; it.method = 'auto'; it.checked_by = 'PC 프로그램'; it.checked_at = a._dev.last_seen; }
    return it;
  }
  function demoInvInit() {
    if (INVD) return INVD;
    var items = [];
    S.assets.forEach(function (a, i) {
      var it = mkItem(a, 1, 7); it.id = i + 1;
      if (it.result === 'pending') {
        if (i % 3 === 0) { it.result = 'ok'; it.method = 'scan'; it.checked_by = 'A20871'; it.checked_name = '김서연'; it.checked_at = new Date(Date.now() - i * 3600000).toISOString(); if (i % 9 === 0) { it.changed = true; it.new_location = '본사 5F'; } }
        else if (i % 17 === 5) { it.result = 'abnormal'; it.method = 'scan'; it.abn_type = '분실 의심'; it.note = '자리에 없음. 복귀 후 재확인'; it.checked_by = 'A20871'; it.checked_name = '김서연'; it.checked_at = new Date().toISOString(); }
      }
      items.push(it);
    });
    var d1 = dstr(new Date(Date.now() - 3 * 86400000)), d2 = dstr(new Date(Date.now() + 12 * 86400000));
    INVD = { invs: [{ id: 1, name: '2026년 4분기 정기 실사', start_date: d1, end_date: d2, scope: { mode: 'all', values: [] }, auto_days: 7, status: 'open', created_by: '99999012', created_at: new Date().toISOString() },
      { id: 2, name: '2026년 2분기 정기 실사', start_date: '2026-05-12', end_date: '2026-05-31', scope: { mode: 'all', values: [] }, auto_days: 7, status: 'closed', created_at: '2026-05-12T01:00:00Z', closed_at: '2026-05-31T09:00:00Z', summary: { total: 3512, pct: 100 } }], items: { 1: items }, seq: 1000 };
    return INVD;
  }
  async function invList() {
    if (DEMO) return demoInvInit().invs.slice().sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });
    var r = await sb.from('inventories').select('*').order('created_at', { ascending: false }); if (r.error) throw r.error; return r.data;
  }
  async function invItems(id) {
    if (DEMO) return demoInvInit().items[id] || [];
    var out = [], from = 0;
    for (;;) { var r = await sb.from('inventory_items').select(ICOLS).eq('inventory_id', id).order('id').range(from, from + 999); if (r.error) throw r.error; out = out.concat(r.data); if (r.data.length < 1000) break; from += 1000; }
    return out;
  }
  function invDone(it) { return it.result === 'ok' || it.result === 'auto'; }
  function invResolved(it) { return invDone(it) || ['reason', 'lost', 'disposed'].indexOf(it.resolution) >= 0; }
  function invStats(items) {
    var s0 = { total: items.length, auto: 0, scan: 0, pending: 0, abnormal: 0 };
    items.forEach(function (i) { if (i.result === 'auto') s0.auto++; else if (i.result === 'ok') s0.scan++; else if (i.result === 'abnormal') s0.abnormal++; else s0.pending++; });
    s0.pct = s0.total ? Math.round((s0.auto + s0.scan) / s0.total * 100) : 0; return s0;
  }
  function invBars(items, key) {
    var g = {}; items.forEach(function (i) { var k = i[key] || '(없음)'; g[k] = g[k] || { n: 0, d: 0 }; g[k].n++; if (invDone(i)) g[k].d++; });
    return Object.keys(g).sort(function (a, b) { return g[b].n - g[a].n; }).slice(0, 5).map(function (k) { var p = Math.round(g[k].d / g[k].n * 100), c = p >= 90 ? '#1e8e3e' : p < 40 ? '#a15c00' : '#0f6cbd'; return '<div class="prow"><span class="pn">' + esc(k) + '</span><span class="pb"><i style="width:' + p + '%;background:' + c + '"></i></span><span class="pv">' + p + '%</span></div>'; }).join('') || '<div class="note">대상이 없습니다.</div>';
  }
  async function pageInventory() {
    var invs; try { invs = await invList(); } catch (e) { shell('inventory', '<h1>실사 (재물조사)</h1><div class="note" style="color:#c42b1c;margin-top:8px">' + esc(e.message || e) + '<br>v1.9.5 SQL(update_v1.9.5.sql)을 실행했는지 확인하세요.</div>'); return; }
    var cur = invs.filter(function (x) { return x.status === 'open'; })[0] || null, items = cur ? await invItems(cur.id) : [], st = invStats(items);
    var head = '<div class="row wrap"><h1>실사 (재물조사)</h1><span class="note">장부의 자산이 실제 있는지 확인합니다</span><div class="grow"></div><button class="btn pri wonly" id="in_new" type="button">새 실사 만들기</button></div>';
    var curH = cur ? '<div class="card"><div class="row wrap"><b style="font-size:14px">' + esc(cur.name) + '</b>' + badge('진행 중', 'blue') + '<span class="note">' + esc((cur.start_date || '') + ' ~ ' + (cur.end_date || '')) + ' · 대상 ' + st.total.toLocaleString() + '대</span><div class="grow"></div><button class="btn wonly" id="in_scan" type="button">현장 스캔</button><button class="btn pri" id="in_det" type="button">결과 · 마감</button></div>' +
      '<div class="row" style="margin-top:8px;gap:10px"><span style="width:60px;font-size:12px">전체 진행</span><span class="pb big"><i style="width:' + st.pct + '%"></i></span><b>' + st.pct + '%</b><span class="note">확인 ' + (st.auto + st.scan).toLocaleString() + ' / ' + st.total.toLocaleString() + '</span></div></div>' +
      '<div class="kpis">' + [['PC 프로그램 자동 확인', st.auto, '점검 정보로 자동 완료', '#0f6cbd'], ['현장 QR 스캔 확인', st.scan, '담당자가 스캔', '#1a1a1a'], ['미확인', st.pending, '마감일까지', '#a15c00'], ['이상 보고', st.abnormal, '분실 의심·파손·위치 불일치', '#c42b1c']].map(function (k) { return '<div class="card kpi"><div class="note">' + k[0] + '</div><div class="kv2" style="color:' + k[3] + '">' + k[1].toLocaleString() + '</div><div class="note">' + k[2] + '</div></div>'; }).join('') + '</div>' +
      '<div class="cards"><div class="card" style="flex:1"><h3>부서별 진행</h3>' + invBars(items, 'dept') + '</div><div class="card" style="flex:1"><h3>자산 분류별 진행</h3>' + invBars(items, 'category') + '</div></div>'
      : '<div class="card"><div class="note" style="padding:8px;line-height:1.8">진행 중인 실사가 없습니다. [새 실사 만들기]로 시작하세요.<br>· PC 프로그램이 최근 점검한 PC·노트북은 자동으로 확인 처리되고, 나머지는 담당자가 폰으로 QR 스티커를 스캔해 확인합니다.</div></div>';
    var hist = '<div class="bulk noprint" id="ih_bar" style="display:none"><b id="ih_n"></b><span>|</span><button class="btn sm dng" id="ih_del" type="button">선택 삭제</button><button class="btn sm" id="ih_all2" type="button">전체 선택</button><button class="btn sm" id="ih_clr" type="button">선택 해제</button></div><table class="tbl"><thead><tr><th class="wonly cbx"><input type="checkbox" id="ih_all" title="전체 선택"></th><th>회차</th><th>기간</th><th>대상</th><th>진행률</th><th>상태</th></tr></thead><tbody>' + invs.map(function (x) {
      var pct = x.status === 'open' ? st.pct : (x.summary && x.summary.pct != null ? x.summary.pct : ''), tot = x.status === 'open' ? st.total : (x.summary && x.summary.total);
      return '<tr class="clk" data-id="' + x.id + '"><td class="wonly cbx"><input type="checkbox" class="ih_c" value="' + x.id + '"></td><td>' + esc(x.name) + '</td><td>' + esc((x.start_date || '') + ' ~ ' + (x.end_date || '')) + '</td><td>' + (tot != null ? esc(Number(tot).toLocaleString() + '대') : '') + '</td><td>' + (pct !== '' ? pct + '%' : '') + '</td><td>' + (x.status === 'open' ? badge('진행 중', 'blue') : badge('마감', 'ok')) + '</td></tr>';
    }).join('') + '</tbody></table>';
    shell('inventory', head + curH + hist);
    var nb = $('#in_new'); if (nb) nb.onclick = invNewDialog;
    var sc = $('#in_scan'); if (sc) sc.onclick = function () { location.hash = '#/inv-scan/' + cur.id; };
    var dt = $('#in_det'); if (dt) dt.onclick = function () { location.hash = '#/inventory/' + cur.id; };
    $$('tr.clk').forEach(function (tr) { tr.onclick = function (e) { if (e.target.closest && e.target.closest('td.cbx')) return; location.hash = '#/inventory/' + tr.dataset.id; }; });
    // v1.9.4: 회차 선택 · 선택 삭제 (표를 다시 그리지 않고 막대만 갱신)
    function chosen() { return $$('.ih_c').filter(function (c) { return c.checked; }).map(function (c) { return c.value; }); }
    function sync() {
      var ids = chosen(), all = $$('.ih_c'), bar = $('#ih_bar'); if (!bar) return;
      bar.style.display = ids.length ? '' : 'none'; $('#ih_n').textContent = ids.length + '개 선택됨';
      var ha = $('#ih_all'); if (ha) { ha.checked = all.length > 0 && ids.length === all.length; ha.indeterminate = ids.length > 0 && ids.length < all.length; }
      $$('.ih_c').forEach(function (c) { c.closest('tr').classList.toggle('rsel', c.checked); });
    }
    $$('.ih_c').forEach(function (c) { c.onchange = sync; });
    var ha = $('#ih_all'); if (ha) ha.onchange = function () { $$('.ih_c').forEach(function (c) { c.checked = ha.checked; }); sync(); };
    var a2 = $('#ih_all2'); if (a2) a2.onclick = function () { $$('.ih_c').forEach(function (c) { c.checked = true; }); sync(); };
    var cl0 = $('#ih_clr'); if (cl0) cl0.onclick = function () { $$('.ih_c').forEach(function (c) { c.checked = false; }); sync(); };
    var dl0 = $('#ih_del'); if (dl0) dl0.onclick = function () { var ids = chosen(); invDelete(invs.filter(function (x) { return ids.indexOf(String(x.id)) >= 0; }), function () { pageInventory(); }); };
  }
  // v1.9.4: 실사 삭제 · 수정 · 재시작 (모두 사유 필수, 이력 관리에 기록)
  async function invDelete(list, after) {
    try { needWrite(); } catch (e) { fail(e); return; }
    if (!list.length) return;
    var counts = {}; try { for (var i = 0; i < list.length; i++) counts[list[i].id] = (await invItems(list[i].id)).length; } catch (e) { fail(e); return; }
    var one = list.length === 1, key = one ? list[0].name : '삭제';
    var m = openModal('<div class="mh"><b>' + (one ? '현재 실사 삭제' : '실사 ' + list.length + '개 삭제') + '</b><button class="mx" type="button">✕</button></div>' +
      '<div class="warnbox">아래 회차와 <b>확인 결과가 모두 삭제되며 되돌릴 수 없습니다.</b><br>(이미 마감해서 자산에 반영된 내용은 그대로 남습니다)</div>' +
      '<div style="line-height:1.9;margin:6px 0">' + list.map(function (x) { return '· <b>' + esc(x.name) + '</b> <span class="note">' + esc((x.start_date || '') + ' ~ ' + (x.end_date || '')) + ' · 대상 ' + counts[x.id].toLocaleString() + '대 · ' + (x.status === 'open' ? '진행 중' : '마감') + '</span>'; }).join('<br>') + '</div>' +
      '<div class="ms">삭제 사유 (필수)</div><textarea id="dl_r" rows="2" style="width:100%;box-sizing:border-box" placeholder="예: 테스트로 만든 실사"></textarea>' +
      '<div class="ms">확인을 위해 <b>' + esc(key) + '</b> 을(를) 그대로 입력하세요</div><input type="text" id="dl_n" autocomplete="off" style="width:100%;box-sizing:border-box">' +
      '<div class="mf"><button class="btn" id="dl_x" type="button">취소</button><button class="btn dng sel" id="dl_ok" type="button" disabled>삭제</button></div>', 480);
    function chk() { $('#dl_ok', m.d).disabled = !($('#dl_r', m.d).value.trim() && $('#dl_n', m.d).value.trim() === key); }
    $('#dl_r', m.d).oninput = chk; $('#dl_n', m.d).oninput = chk; $('#dl_r', m.d).focus();
    $('#dl_x', m.d).onclick = m.close;
    $('#dl_ok', m.d).onclick = async function () {
      var rs = $('#dl_r', m.d).value.trim(), btn = this; btn.disabled = true; btn.textContent = '삭제 중…';
      try {
        for (var i = 0; i < list.length; i++) {
          var x = list[i];
          audCtx({ table: 'inventories', action: 'delete', target: '실사 ' + x.name, summary: '실사 삭제 · ' + x.name + ' (대상 ' + counts[x.id] + '대, 확인 결과 포함)', reason: rs, detail: { via: '실사 · ' + (one ? '현재 실사 삭제' : '선택 삭제'), changes: [{ k: '회차', from: x.name, to: '삭제됨' }, { k: '기간', from: (x.start_date || '') + ' ~ ' + (x.end_date || ''), to: '-' }, { k: '상태', from: x.status === 'open' ? '진행 중' : '마감', to: '-' }] } });
          if (DEMO) { var D = demoInvInit(); D.invs = D.invs.filter(function (v) { return v.id !== x.id; }); delete D.items[x.id]; }
          else { var r = await sb.from('inventories').delete().eq('id', x.id); if (r.error) throw r.error; }
        }
        m.close(); toast('실사 ' + list.length + '개를 삭제했습니다.'); if (after) after();
      } catch (e) { btn.disabled = false; btn.textContent = '삭제'; fail(e); }
    };
  }
  function invEdit(inv, after) {
    try { needWrite(); } catch (e) { fail(e); return; }
    var m = openModal('<div class="mh"><b>실사 수정</b><button class="mx" type="button">✕</button></div>' +
      '<div class="ms">실사 이름</div><input type="text" id="ie_n" value="' + esc(inv.name) + '" style="width:100%;box-sizing:border-box">' +
      '<div class="ms">기간</div><input type="date" id="ie_s" value="' + esc(inv.start_date || '') + '"> ~ <input type="date" id="ie_e" value="' + esc(inv.end_date || '') + '">' +
      '<div class="note" style="margin-top:6px">대상 범위·확인 결과는 여기서 바꾸지 않습니다. (처음부터 다시 하려면 [실사 재시작])</div>' +
      '<div class="ms">수정 사유 (필수)</div><textarea id="ie_r" rows="2" style="width:100%;box-sizing:border-box" placeholder="예: 기간 연장 요청"></textarea>' +
      '<div class="mf"><button class="btn" id="ie_x" type="button">취소</button><button class="btn pri" id="ie_ok" type="button">저장</button></div>', 460);
    $('#ie_x', m.d).onclick = m.close;
    $('#ie_ok', m.d).onclick = async function () {
      var nm = $('#ie_n', m.d).value.trim(), s0 = $('#ie_s', m.d).value, e0 = $('#ie_e', m.d).value, rs = $('#ie_r', m.d).value.trim();
      if (!nm) { toast('실사 이름을 입력하세요.'); return; } if (s0 && e0 && s0 > e0) { toast('마감일이 시작일보다 빠릅니다.'); return; } if (!rs) { toast('수정 사유를 입력하세요.'); return; }
      var patch = { name: nm, start_date: s0 || null, end_date: e0 || null }, ch = [];
      if (nm !== inv.name) ch.push({ k: '실사 이름', from: inv.name, to: nm }); if ((s0 || '') !== (inv.start_date || '')) ch.push({ k: '시작일', from: inv.start_date || '없음', to: s0 || '없음' }); if ((e0 || '') !== (inv.end_date || '')) ch.push({ k: '마감일', from: inv.end_date || '없음', to: e0 || '없음' });
      if (!ch.length) { m.close(); return; }
      var btn = this; btn.disabled = true;
      try {
        audCtx({ table: 'inventories', action: 'change', target: '실사 ' + inv.name, summary: '실사 수정: ' + chgText(ch), reason: rs, detail: { via: '실사 결과 · 수정', changes: ch } });
        if (DEMO) Object.assign(inv, patch); else { var r = await sb.from('inventories').update(patch).eq('id', inv.id); if (r.error) throw r.error; }
        m.close(); toast('수정했습니다.'); after();
      } catch (e) { btn.disabled = false; fail(e); }
    };
  }
  async function invRestart(inv, after) {
    try { needWrite(); } catch (e) { fail(e); return; }
    var others = (await invList()).filter(function (x) { return x.status === 'open' && x.id !== inv.id; });
    if (others.length) { toast('진행 중인 다른 실사(' + others[0].name + ')가 있습니다. 먼저 마감하거나 삭제하세요.'); return; }
    var open = inv.status === 'open';
    var m = openModal('<div class="mh"><b>실사 재시작</b><button class="mx" type="button">✕</button></div>' +
      (open ? '' : '<label style="display:block;margin:4px 0"><input type="radio" name="rsm" value="keep" checked> <b>확인 결과 유지</b>하고 다시 진행 중으로 열기<br><span class="note" style="margin-left:20px">마감을 풀고 미확인을 계속 확인합니다</span></label>') +
      '<label style="display:block;margin:4px 0"><input type="radio" name="rsm" value="reset"' + (open ? ' checked' : '') + '> <b>모든 확인 결과 지우고</b> 처음부터 다시 시작<br><span class="note" style="margin-left:20px">확인·이상·변경 보고가 모두 초기화되고, PC 프로그램 자동 확인은 다시 계산됩니다</span></label>' +
      '<div class="warnbox" id="rs_w" style="display:' + (open ? '' : 'none') + '">처음부터 다시 시작하면 지금까지의 확인 결과를 되돌릴 수 없습니다. 이미 마감으로 자산에 반영된 내용은 그대로 남습니다.</div>' +
      '<div class="ms">재시작 사유 (필수)</div><textarea id="rs_r" rows="2" style="width:100%;box-sizing:border-box" placeholder="예: 기간 내 재확인 필요"></textarea>' +
      '<div class="mf"><button class="btn" id="rs_x" type="button">취소</button><button class="btn pri" id="rs_ok" type="button">재시작</button></div>', 480);
    $$('input[name=rsm]', m.d).forEach(function (r) { r.onchange = function () { $('#rs_w', m.d).style.display = $('input[name=rsm]:checked', m.d).value === 'reset' ? '' : 'none'; }; });
    $('#rs_x', m.d).onclick = m.close;
    $('#rs_ok', m.d).onclick = async function () {
      var mode = $('input[name=rsm]:checked', m.d).value, rs = $('#rs_r', m.d).value.trim(); if (!rs) { toast('재시작 사유를 입력하세요.'); return; }
      var btn = this; btn.disabled = true; btn.textContent = '처리 중…';
      try {
        if (mode === 'reset') {
          var clr = { result: 'pending', method: null, changed: false, new_location: null, new_user: null, abn_type: null, note: null, photo: null, checked_by: null, checked_name: null, checked_at: null, resolution: null, resolved_note: null };
          if (DEMO) demoInvInit().items[inv.id].forEach(function (it) { Object.assign(it, clr); });
          else { var r0 = await sb.from('inventory_items').update(clr).eq('inventory_id', inv.id); if (r0.error) throw r0.error; }
        }
        var upd = { status: 'open', closed_at: null, closed_by: null, summary: null };
        audCtx({ table: 'inventories', action: 'change', target: '실사 ' + inv.name, summary: '실사 재시작 · ' + (mode === 'reset' ? '확인 결과 모두 지우고 처음부터' : '확인 결과 유지하고 다시 진행 중으로'), reason: rs, detail: { via: '실사 결과 · 재시작', changes: [{ k: '상태', from: open ? '진행 중' : '마감', to: '진행 중' }, { k: '확인 결과', from: '-', to: mode === 'reset' ? '모두 초기화' : '유지' }] } });
        if (DEMO) Object.assign(inv, upd); else { var r = await sb.from('inventories').update(upd).eq('id', inv.id); if (r.error) throw r.error; }
        if (mode === 'reset') { var fresh = await invItems(inv.id); S._invItems = fresh; try { await invRefreshAuto(inv, fresh); } catch (e) { } }
        m.close(); toast('실사를 다시 시작했습니다.'); after();
      } catch (e) { btn.disabled = false; btn.textContent = '재시작'; fail(e); }
    };
  }
  function invNewDialog() {
    needWrite();
    var d0 = dstr(new Date()), d1 = dstr(new Date(Date.now() + 15 * 86400000)), nowD = new Date(), qn = Math.floor(nowD.getMonth() / 3) + 1;
    var coOpts = CO.map(function (c) { return [c, S.assets.filter(function (a) { return a.company === c; }).length]; }).filter(function (o) { return o[1] > 0; });
    var opts = { cat: groupCount(S.assets, function (a) { return a.category; }), dept: groupCount(S.assets, function (a) { return a.dept; }), loc: groupCount(S.assets, function (a) { return a.location; }), co: coOpts };
    var dashCo = (typeof DASH_CO !== 'undefined' && DASH_CO && DASH_CO !== '전체') ? DASH_CO : '';
    var nmPrefix = dashCo ? dashCo + ' ' : '';
    var m = openModal('<div class="mh"><b>새 실사 만들기</b><button class="mx" type="button">✕</button></div>' +
      '<div class="ms">1. 실사 이름</div><input type="text" id="in_n" value="' + nmPrefix + nowD.getFullYear() + '년 ' + qn + '분기 정기 실사" style="width:100%;box-sizing:border-box">' +
      '<div class="ms">2. 기간</div><input type="date" id="in_s" value="' + d0 + '"> ~ <input type="date" id="in_e" value="' + d1 + '">' +
      '<div class="ms">3. 대상 범위 <span class="note" id="in_cnt"></span></div><div><label><input type="radio" name="isc" value="all"' + (dashCo ? '' : ' checked') + '> 전체 자산</label> <label><input type="radio" name="isc" value="cat"> 분류 선택</label> <label><input type="radio" name="isc" value="dept"> 부서 선택</label> <label><input type="radio" name="isc" value="loc"> 위치 선택</label> <label><input type="radio" name="isc" value="co"' + (dashCo ? ' checked' : '') + '> 회사 선택</label></div>' +
      ['cat', 'dept', 'loc', 'co'].map(function (k) { return '<div class="scl" id="sc_' + k + '" style="display:none">' + opts[k].slice(0, 60).map(function (o) { return '<label><input type="checkbox" data-k="' + k + '" value="' + esc(o[0]) + '"' + (k === 'co' && dashCo && o[0] === dashCo ? ' checked' : '') + '> ' + esc(o[0]) + ' <span class="note">' + o[1] + '</span></label>'; }).join('') + '</div>'; }).join('') +
      (dashCo ? '<div class="note" style="margin-top:2px">대시보드에서 고른 "' + esc(dashCo) + '"가 미리 체크되어 있습니다. 필요하면 바꿀 수 있습니다.</div>' : '') +
      '<div class="ms">4. 확인 방법</div><label><input type="checkbox" id="in_auto" checked> PC 프로그램 점검 정보가 최근 <select id="in_ad"><option>3</option><option selected>7</option><option>14</option></select>일 이내이면 자동 확인</label><br><label><input type="checkbox" checked disabled> 나머지는 담당자가 현장에서 QR 스티커를 스캔해 확인</label>' +
      '<div class="ms">5. 담당자</div><div class="note">메인·일반 관리자 계정은 누구나 폰에서 현장 스캔을 할 수 있습니다. 현장 목록은 부서별로 걸러서 볼 수 있습니다. (조회 전용은 진행 현황만 봅니다)</div>' +
      '<div class="note" style="margin-top:8px;background:#eef5fc;border-radius:6px;padding:7px 10px">시작하면 대상 자산이 "내 실사" 목록에 나타나고, 생성·확인·마감 등 모든 처리가 이력 관리에 기록됩니다. (폐기·분실 자산은 제외)</div>' +
      '<div class="mf"><button class="btn" id="in_x" type="button">취소</button><button class="btn pri" id="in_ok" type="button">실사 시작</button></div>', 560);
    function scope() { var mode = $('input[name=isc]:checked', m.d).value, vals = $$('input[type=checkbox][data-k=' + mode + ']:checked', m.d).map(function (x) { return x.value; }); return { mode: mode, values: vals }; }
    function targets() {
      var sc = scope(), key = { cat: 'category', dept: 'dept', loc: 'location', co: 'company' }[sc.mode];
      return S.assets.filter(function (a) { return a.status !== '폐기' && a.status !== '분실' && (sc.mode === 'all' || (sc.values.length && sc.values.indexOf(a[key]) >= 0)); });
    }
    function upd() { $('#in_cnt', m.d).textContent = '→ 대상 ' + targets().length.toLocaleString() + '대 (폐기·분실 제외)'; ['cat', 'dept', 'loc', 'co'].forEach(function (k) { $('#sc_' + k, m.d).style.display = $('input[name=isc]:checked', m.d).value === k ? '' : 'none'; }); }
    $$('input', m.d).forEach(function (x) { if (x.type !== 'text' && x.type !== 'date') x.onchange = upd; }); upd();
    $('#in_x', m.d).onclick = m.close;
    $('#in_ok', m.d).onclick = async function () {
      var name = $('#in_n', m.d).value.trim(), sd = $('#in_s', m.d).value, ed = $('#in_e', m.d).value, tg = targets(), btn = this;
      if (!name) { toast('실사 이름을 입력하세요.'); return; } if (!tg.length) { toast('대상 자산이 없습니다.'); return; } if (ed && sd && ed < sd) { toast('마감일이 시작일보다 빠릅니다.'); return; }
      var auto = $('#in_auto', m.d).checked ? +$('#in_ad', m.d).value : 0, sc = scope(); btn.disabled = true; btn.textContent = '만드는 중…';
      try {
        var id;
        var nAuto = tg.filter(function (a) { return mkItem(a, 0, auto).result === 'auto'; }).length;
        audCtx({ table: 'inventories', action: 'create', target: '실사 ' + name, summary: '실사 생성 · 대상 ' + tg.length.toLocaleString() + '대 · 기간 ' + sd + '~' + ed + ' · 자동 확인 ' + nAuto + '대', detail: { via: '새 실사 만들기', note: '범위: ' + ({ all: '전체 자산', cat: '분류', dept: '부서', loc: '위치', co: '회사' }[sc.mode]) + (sc.values.length ? ' (' + sc.values.join(', ') + ')' : '') + ' · 자동 확인 기준 ' + (auto ? '최근 ' + auto + '일' : '사용 안 함') } });
        if (DEMO) {
          var D = demoInvInit(); id = ++D.seq; D.invs.push({ id: id, name: name, start_date: sd, end_date: ed, scope: sc, auto_days: auto, status: 'open', created_by: S.me.sabun, created_at: new Date().toISOString() });
          D.items[id] = tg.map(function (a, i) { var it = mkItem(a, id, auto); it.id = ++D.seq; return it; });
        } else {
          var r = await sb.from('inventories').insert({ name: name, start_date: sd || null, end_date: ed || null, scope: sc, auto_days: auto, status: 'open', created_by: S.me.sabun }).select().single(); if (r.error) throw r.error; id = r.data.id;
          var rows = tg.map(function (a) { return mkItem(a, id, auto); });
          for (var i = 0; i < rows.length; i += 500) { var r2 = await sb.from('inventory_items').insert(rows.slice(i, i + 500)); if (r2.error) throw r2.error; btn.textContent = '만드는 중… ' + Math.min(i + 500, rows.length) + '/' + rows.length; }
        }
        m.close(); toast('실사를 시작했습니다.'); location.hash = '#/inventory'; route();
      } catch (e) { btn.disabled = false; btn.textContent = '실사 시작'; fail(e); }
    };
  }
  async function invSaveRows(ids, patch, inv, summary, reason, changes) {   // 여러 항목 한 번에 (마감 전 처리)
    needWrite();
    if (!DEMO) { for (var i = 0; i < ids.length; i += 200) { var r = await sb.from('inventory_items').update(patch).in('id', ids.slice(i, i + 200)); if (r.error) throw r.error; } }
    var set = {}; ids.forEach(function (x) { set[x] = 1; });
    (DEMO ? demoInvInit().items[inv.id] : (S._invItems || [])).forEach(function (it) { if (set[it.id]) Object.assign(it, patch); });
    auditPost({ action: 'change', target: '실사 ' + inv.name, summary: summary + ' (' + ids.length + '건)', reason: reason || null, detail: { via: '실사 결과 · 마감 화면', changes: changes || [] } });
  }
  var RES_L = { reconfirm: '재확인 요청', reason: '사유 입력', lost: '분실 확정', disposed: '폐기' };
  var INV_V = { chip: 'pending', cat: '', dept: '', page: 0 };
  async function pageInvDetail(id) {
    var invs; try { invs = await invList(); } catch (e) { fail(e); return; }
    var inv = invs.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!inv) { shell('inventory', '<h1>실사를 찾을 수 없습니다</h1><p><a href="#/inventory">‹ 실사</a></p>'); return; }
    var items = await invItems(inv.id); S._invItems = items;
    var st = invStats(items), open = inv.status === 'open', v = INV_V;
    var unres = items.filter(function (i) { return !invResolved(i); });
    var list = items.filter(function (i) { return (v.chip === 'pending' ? i.result === 'pending' || (i.result === 'abnormal') : v.chip === 'abnormal' ? i.result === 'abnormal' : v.chip === 'resolved' ? (!invDone(i) && invResolved(i)) : true) && (!v.cat || i.category === v.cat) && (!v.dept || i.dept === v.dept); });
    if (v.chip === 'pending') list = list.filter(function (i) { return !invDone(i); });
    var PS2 = 50, pages = Math.max(1, Math.ceil(list.length / PS2)); if (v.page >= pages) v.page = pages - 1;
    var rows = list.slice(v.page * PS2, v.page * PS2 + PS2).map(function (i) {
      var s0 = i.result === 'abnormal' ? '<span class="abx a-delete">이상</span> ' + esc(i.abn_type || '') : i.result === 'pending' ? '<span class="abx a-change">미확인</span>' : '<span class="abx a-create">확인</span>';
      var act = !open ? '' : '<a href="#" data-a="reconfirm" data-i="' + i.id + '">재확인</a> · <a href="#" data-a="reason" data-i="' + i.id + '">사유</a> · <a href="#" data-a="lost" data-i="' + i.id + '">분실 확정</a> · <a href="#" data-a="disposed" data-i="' + i.id + '">폐기</a>';
      return '<tr><td class="mono"><a href="#/asset/' + encodeURIComponent(i.asset_no) + '">' + esc(i.asset_no) + '</a></td><td>' + esc(i.category || '') + '</td><td>' + esc((i.user_name || '') + (i.dept ? ' · ' + i.dept : '')) + '</td><td>' + s0 + (i.note ? '<div class="note">' + esc(i.note) + '</div>' : '') + '</td><td>' + (i.resolution ? badge(RES_L[i.resolution] || i.resolution, i.resolution === 'reconfirm' ? 'warn' : 'gray') + (i.resolved_note ? '<div class="note">' + esc(i.resolved_note) + '</div>' : '') : '') + '</td><td class="admact wonly">' + act + '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="note" style="padding:18px;text-align:center">해당하는 항목이 없습니다.</td></tr>';
    var chg = { loc: items.filter(function (i) { return i.changed && i.new_location; }).length, usr: items.filter(function (i) { return i.changed && i.new_user; }).length, lost: items.filter(function (i) { return i.resolution === 'lost'; }).length, disp: items.filter(function (i) { return i.resolution === 'disposed'; }).length };
    var cats = groupCount(items, function (i) { return i.category; }).map(function (x) { return x[0]; }), depts = groupCount(items, function (i) { return i.dept; }).map(function (x) { return x[0]; });
    var chips = [['pending', '미확인·이상'], ['abnormal', '이상만'], ['resolved', '처리됨'], ['all', '전체']];
    shell('inventory', '<div class="row wrap"><a href="#/inventory">‹ 실사</a><h1>결과 · 마감</h1><span class="note">' + esc(inv.name) + ' · ' + (open ? '마감 예정 ' + esc(inv.end_date || '') : '마감됨 ' + esc(ymd(inv.closed_at))) + '</span><div class="grow"></div>' +
      (open ? '<button class="btn wonly" id="iv_sc" type="button">현장 스캔</button><button class="btn wonly" id="iv_re" type="button">자동 확인 다시 계산</button>' : '') + '<button class="btn wonly" id="iv_ed" type="button">수정</button><button class="btn wonly dng" id="iv_del" type="button">현재 실사 삭제</button><button class="btn wonly" id="iv_rs" type="button">실사 재시작</button><button class="btn" id="iv_ex" type="button">결과 내보내기</button>' + (open ? '<button class="btn pri wonly" id="iv_cl" type="button">실사 마감</button>' : badge('마감', 'ok')) + '</div>' +
      '<div class="kpis">' + [['확인 완료', st.auto + st.scan, st.pct + '%', '#1e8e3e'], ['미확인', st.pending, '처리 필요', '#a15c00'], ['이상', st.abnormal, '처리 필요', '#c42b1c'], ['변경 보고', chg.loc + chg.usr, '마감 시 반영', '#1a1a1a']].map(function (k) { return '<div class="card kpi"><div class="note">' + k[0] + '</div><div class="kv2" style="color:' + k[3] + '">' + k[1].toLocaleString() + '</div><div class="note">' + k[2] + '</div></div>'; }).join('') + '</div>' +
      '<div class="fchips" style="margin:6px 0">' + chips.map(function (c) { return '<button type="button" class="achip' + (v.chip === c[0] ? ' on' : '') + '" data-c="' + c[0] + '">' + c[1] + '</button>'; }).join('') + ' <select id="iv_cat"><option value="">분류 전체</option>' + cats.map(function (c) { return '<option' + (v.cat === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select> <select id="iv_dept"><option value="">부서 전체</option>' + depts.map(function (c) { return '<option' + (v.dept === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select>' +
      (open && v.chip === 'pending' ? ' <button class="btn sm wonly" id="iv_bulk" type="button">현재 목록의 미확인 일괄 사유 입력</button>' : '') + '</div>' +
      '<div class="note" style="margin-bottom:4px">' + list.length.toLocaleString() + '건 · ' + (v.page + 1) + '/' + pages + '쪽 <button class="btn sm" id="iv_pv"' + (v.page <= 0 ? ' disabled' : '') + '>‹</button><button class="btn sm" id="iv_nx"' + (v.page + 1 >= pages ? ' disabled' : '') + '>›</button></div>' +
      '<table class="tbl"><thead><tr><th>관리번호</th><th>유형</th><th>사용자 · 부서</th><th>상태</th><th>처리</th><th class="wonly">처리 방법</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="card" style="margin-top:12px"><div class="note" style="line-height:1.9">· <b>마감 조건</b>: 미확인·이상 항목에 처리 방법(분실 확정·폐기·사유 입력)을 모두 정해야 마감할 수 있습니다. ("재확인"은 처리 완료가 아니며 현장에서 다시 스캔해야 합니다) · 지금 남은 항목 <b>' + unres.length.toLocaleString() + '건</b><br>· <b>마감하면</b>: 위치 변경 ' + chg.loc + '건·사용자 변경 ' + chg.usr + '건이 자산에 반영되고, 분실 확정 ' + chg.lost + '건·폐기 ' + chg.disp + '건은 자산 상태에 반영됩니다. 그 뒤에는 수정되지 않습니다<br>· 실사 생성·확인·이상·마감·내보내기는 모두 이력 관리에 기록됩니다</div></div>');
    $$('.achip').forEach(function (b) { b.onclick = function () { v.chip = b.dataset.c; v.page = 0; pageInvDetail(id); }; });
    $('#iv_cat').onchange = function () { v.cat = this.value; v.page = 0; pageInvDetail(id); }; $('#iv_dept').onchange = function () { v.dept = this.value; v.page = 0; pageInvDetail(id); };
    $('#iv_pv').onclick = function () { v.page--; pageInvDetail(id); }; $('#iv_nx').onclick = function () { v.page++; pageInvDetail(id); };
    var sc = $('#iv_sc'); if (sc) sc.onclick = function () { location.hash = '#/inv-scan/' + inv.id; };
    var re = $('#iv_re'); if (re) re.onclick = async function () { try { var n = await invRefreshAuto(inv, items); toast(n ? n + '건을 자동 확인으로 바꿨습니다.' : '새로 자동 확인할 항목이 없습니다.'); pageInvDetail(id); } catch (e) { fail(e); } };
    $('#iv_ex').onclick = function () { invExport(inv, items); };
    $('#iv_ed').onclick = function () { invEdit(inv, function () { pageInvDetail(id); }); };
    $('#iv_del').onclick = function () { invDelete([inv], function () { location.hash = '#/inventory'; }); };
    $('#iv_rs').onclick = function () { invRestart(inv, function () { pageInvDetail(id); }); };
    var bk = $('#iv_bulk'); if (bk) bk.onclick = async function () {
      var ids = list.filter(function (i) { return i.result === 'pending'; }).map(function (i) { return i.id; }); if (!ids.length) { toast('일괄 처리할 미확인 항목이 없습니다.'); return; }
      var rs = await askReason('미확인 일괄 처리', '현재 목록의 미확인 <b>' + ids.length + '건</b>에 같은 사유를 입력합니다.', '일괄 처리'); if (!rs) return;
      try { await invSaveRows(ids, { resolution: 'reason', resolved_note: rs }, inv, '미확인 일괄 사유 입력', rs); pageInvDetail(id); } catch (e) { fail(e); }
    };
    $$('.admact a').forEach(function (a) {
      a.onclick = async function (e) {
        e.preventDefault(); var it = items.filter(function (x) { return String(x.id) === a.dataset.i; })[0], k = a.dataset.a; if (!it) return;
        try {
          if (k === 'reconfirm') { await invSaveRows([it.id], { resolution: 'reconfirm', resolved_note: null }, inv, '재확인 요청 · ' + it.asset_no, null); }
          else {
            var ttl = { reason: '사유 입력', lost: '분실 확정', disposed: '폐기 처리' }[k], rs = await askReason(ttl, esc(it.asset_no) + ' · ' + esc(it.category || '') + (k === 'lost' ? '<br>분실로 확정하면 마감 때 자산 상태가 "분실"로 바뀝니다.' : k === 'disposed' ? '<br>마감 때 자산 상태가 "폐기"로 바뀝니다.' : ''), '저장'); if (!rs) return;
            await invSaveRows([it.id], { resolution: k, resolved_note: rs }, inv, RES_L[k] + ' · ' + it.asset_no, rs);
          }
          pageInvDetail(id);
        } catch (er) { fail(er); }
      };
    });
    var cl = $('#iv_cl'); if (cl) cl.onclick = function () { invClose(inv, items, unres, chg); };
  }
  async function invRefreshAuto(inv, items) {
    needWrite(); var ids = [], now = Date.now();
    items.forEach(function (it) {
      if (it.result !== 'pending' || !inv.auto_days) return;
      var a = S.assets.filter(function (x) { return x.asset_no === it.asset_no; })[0];
      if (a && isPc(a) && a._dev && a._dev.last_seen && (now - new Date(a._dev.last_seen).getTime()) / 86400000 <= inv.auto_days) ids.push(it.id);
    });
    if (ids.length) await invSaveRows(ids, { result: 'auto', method: 'auto', checked_by: 'PC 프로그램', checked_at: new Date().toISOString() }, inv, '자동 확인 다시 계산', null);
    return ids.length;
  }
  function invExport(inv, items) {
    var RL = { auto: '자동 확인', ok: '현장 확인', pending: '미확인', abnormal: '이상' };
    var rows = items.map(function (i) { return { '관리번호': i.asset_no, '자산분류': i.category || '', '부서': i.dept || '', '사용자': i.user_name || '', '위치(장부)': i.location || '', '결과': RL[i.result] || i.result, '확인 방법': i.method === 'auto' ? 'PC 프로그램' : i.method === 'scan' ? 'QR 스캔' : '', '확인자': i.checked_name || i.checked_by || '', '확인 일시': i.checked_at ? ymd(i.checked_at) + ' ' + hm(i.checked_at) : '', '변경 위치': i.new_location || '', '변경 사용자': i.new_user || '', '이상 종류': i.abn_type || '', '메모': i.note || '', '처리 방법': RES_L[i.resolution] || '', '처리 사유': i.resolved_note || '' }; });
    var ws = XLSX.utils.json_to_sheet(rows), wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, '실사 결과'); XLSX.writeFile(wb, '실사결과_' + inv.name.replace(/[\\/:*?"<>|\s]/g, '') + '_' + ymd(new Date()) + '.xlsx');
    logExport('실사 ' + inv.name, rows.length, '실사 결과 내보내기');
  }
  async function invClose(inv, items, unres, chg) {
    if (unres.length) { toast('처리 방법을 정하지 않은 미확인·이상 항목이 ' + unres.length + '건 남아 있습니다.'); return; }
    var m = openModal('<div class="mh"><b>실사 마감</b><button class="mx" type="button">✕</button></div><div class="warnbox">마감하면 아래 내용이 자산에 반영되고, 그 뒤에는 수정할 수 없습니다.</div><div style="line-height:2">· 위치 변경 <b>' + chg.loc + '건</b> → 자산 위치 반영<br>· 사용자 변경 <b>' + chg.usr + '건</b> → 자산 사용자명 반영<br>· 분실 확정 <b>' + chg.lost + '건</b> → 자산 상태 "분실"<br>· 폐기 <b>' + chg.disp + '건</b> → 자산 상태 "폐기"</div><div class="mf"><button class="btn" id="cl_x" type="button">취소</button><button class="btn pri" id="cl_ok" type="button">마감하고 반영</button></div>', 440);
    $('#cl_x', m.d).onclick = m.close;
    $('#cl_ok', m.d).onclick = async function () {
      var btn = this; btn.disabled = true; btn.textContent = '반영 중…';
      try {
        var todo = items.filter(function (i) { return (i.changed && (i.new_location || i.new_user)) || i.resolution === 'lost' || i.resolution === 'disposed'; }), n = 0, sum = [];
        for (var k = 0; k < todo.length; k++) {
          var i = todo[k], patch = {};
          if (i.changed && i.new_location) patch.location = i.new_location;
          if (i.changed && i.new_user) patch.user_name = i.new_user;
          if (i.resolution === 'lost') patch.status = '분실'; if (i.resolution === 'disposed') patch.status = '폐기';
          await dbUpdateAsset(i.asset_no, patch, '실사 반영 (' + inv.name + ')', true); n++; if (sum.length < 100) sum.push({ k: i.asset_no, from: '(장부)', to: Object.keys(patch).map(function (x) { return (FLBL[x] || x) + ' ' + patch[x]; }).join(', ') });
          if (n % 10 === 0) btn.textContent = '반영 중… ' + n + '/' + todo.length;
        }
        var summary = { total: items.length, pct: invStats(items).pct, loc: chg.loc, usr: chg.usr, lost: chg.lost, disposed: chg.disp, closed_by_name: whoParts().name };
        audCtx({ table: 'inventories', action: 'change', target: '실사 ' + inv.name, summary: '실사 마감 · 자산 ' + n + '건 반영 (위치 ' + chg.loc + ' · 사용자 ' + chg.usr + ' · 분실 ' + chg.lost + ' · 폐기 ' + chg.disp + ')', detail: { via: '실사 결과 · 마감', changes: sum } });
        var upd = { status: 'closed', closed_at: new Date().toISOString(), closed_by: S.me.sabun, summary: summary };
        if (DEMO) Object.assign(inv, upd); else { var r = await sb.from('inventories').update(upd).eq('id', inv.id); if (r.error) throw r.error; }
        m.close(); toast('실사를 마감했습니다.'); pageInvDetail(inv.id);
      } catch (e) { btn.disabled = false; btn.textContent = '마감하고 반영'; fail(e); }
    };
  }
  // ---- 현장 확인 (모바일): 내 실사 목록 → QR 스캔 → 일치 / 위치 변경 / 사용자 변경 / 이상 보고 ----
  function invAbnDialog() {
    return new Promise(function (resolve) {
      var type = '분실 의심', photo = null, TYPES = ['분실 의심', '파손', '위치 불일치', '라벨 훼손', '기타'];
      var m = openModal('<div class="mh"><b>이상 보고</b><button class="mx" type="button">✕</button></div><div class="ms">이상 종류</div><div id="ab_t">' + TYPES.map(function (t) { return '<button type="button" class="achip' + (t === type ? ' on' : '') + '" data-t="' + t + '">' + t + '</button>'; }).join('') + '</div>' +
        '<div class="ms">사진 (선택)</div><input type="file" id="ab_f" accept="image/*" capture="environment"><div id="ab_p"></div><div class="ms">메모 (필수)</div><textarea id="ab_n" rows="3" style="width:100%;box-sizing:border-box" placeholder="예: 영업2팀 자리에 없음. 복귀 후 재확인"></textarea>' +
        '<div class="mf"><button class="btn" id="ab_x" type="button">취소</button><button class="btn pri" id="ab_ok" type="button" style="background:#c42b1c">이상 보고 저장</button></div>', 420);
      $$('#ab_t .achip', m.d).forEach(function (b) { b.onclick = function () { type = b.dataset.t; $$('#ab_t .achip', m.d).forEach(function (x) { x.classList.toggle('on', x === b); }); }; });
      $('#ab_f', m.d).onchange = function () { var f = this.files[0]; if (!f) return; readPhoto(f).then(function (u) { photo = u; $('#ab_p', m.d).innerHTML = '<img src="' + u + '" style="max-width:120px;border-radius:6px;margin-top:6px">'; }, fail); };
      $('#ab_x', m.d).onclick = function () { m.close(); resolve(null); }; $('.mx', m.d).onclick = $('#ab_x', m.d).onclick;
      $('#ab_ok', m.d).onclick = function () { var n = $('#ab_n', m.d).value.trim(); if (!n) { toast('메모를 입력하세요.'); return; } m.close(); resolve({ type: type, note: n, photo: photo }); };
    });
  }
  async function invCheck(it, inv, kind) {
    needWrite();
    var w = whoParts(), patch = { method: 'scan', checked_by: S.me.sabun, checked_name: w.name || '', checked_at: new Date().toISOString() }, desc;
    if (kind === 'ok') { Object.assign(patch, { result: 'ok', changed: false, new_location: null, new_user: null, abn_type: null, note: null, photo: null }); desc = '일치'; }
    else if (kind === 'loc') { var v1 = await askText('위치 변경', '실제 위치', it.new_location || it.location || '', '저장'); if (!v1) return false; Object.assign(patch, { result: 'ok', changed: true, new_location: v1, abn_type: null, note: null }); desc = '위치 변경 ' + (it.location || '없음') + '→' + v1; }
    else if (kind === 'user') { var v2 = await askText('사용자 변경', '실제 사용자명', it.new_user || it.user_name || '', '저장'); if (!v2) return false; Object.assign(patch, { result: 'ok', changed: true, new_user: v2, abn_type: null, note: null }); desc = '사용자 변경 ' + (it.user_name || '없음') + '→' + v2; }
    else { var r = await invAbnDialog(); if (!r) return false; Object.assign(patch, { result: 'abnormal', changed: false, abn_type: r.type, note: r.note, photo: r.photo }); desc = '이상 보고 (' + r.type + ')'; }
    if (!DEMO) { var q = await sb.from('inventory_items').update(patch).eq('id', it.id); if (q.error) throw q.error; }
    var hadPhoto = patch.photo; delete patch.photo; Object.assign(it, patch); it.has_photo = !!hadPhoto;
    auditPost({ action: 'change', target: '실사 ' + inv.name + ' · 자산 ' + it.asset_no, summary: '실사 확인 · ' + desc, reason: patch.note || null, detail: { via: '모바일 QR 스캔 실사', note: hadPhoto ? '사진 첨부' : '' } });
    return true;
  }
  function invStatusText(it) { return it.result === 'auto' ? '자동 확인 (PC 프로그램)' : it.result === 'ok' ? '현장 확인' + (it.changed ? ' · 변경 보고' : ' · 일치') + ' (' + esc((it.checked_name || '') + ' ' + (it.checked_at ? ymd(it.checked_at).slice(5) + ' ' + hm(it.checked_at) : '')) + ')' : it.result === 'abnormal' ? '이상 보고: ' + esc(it.abn_type || '') : '미확인'; }
  function invBtns(host, it, inv, done) {   // 일치 / 위치 변경 / 사용자 변경 / 이상 보고 버튼
    host.innerHTML = '<div class="invb"><button type="button" class="ib ok" data-k="ok">✔ 일치</button><button type="button" class="ib" data-k="loc">위치 변경</button><button type="button" class="ib" data-k="user">사용자 변경</button><button type="button" class="ib bad" data-k="abn">⚠ 이상 보고</button></div>';
    $$('.ib', host).forEach(function (b) { b.onclick = async function () { try { var ok = await invCheck(it, inv, b.dataset.k); if (ok) { toast('저장했습니다.'); done(); } } catch (e) { fail(e); } }; });
  }
  async function pageInvScan(id) {
    if (isViewer()) { location.hash = '#/inventory'; return; }
    var invs = await invList(), inv = invs.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!inv) { location.hash = '#/inventory'; return; }
    var items = await invItems(inv.id), v = { chip: 'pending', dept: '' };
    var depts = groupCount(items, function (i) { return i.dept; }).map(function (x) { return x[0]; });
    function draw() {
      var mine = items.filter(function (i) { return !v.dept || i.dept === v.dept; }), st = invStats(mine);
      var list = mine.filter(function (i) { return v.chip === 'pending' ? !invDone(i) : v.chip === 'abnormal' ? i.result === 'abnormal' : true; }).slice(0, 100);
      shell('inventory', '<div class="row wrap"><a href="#/inventory">‹ 실사</a><h1>내 실사 · ' + esc(inv.name) + '</h1></div>' +
        '<div class="card"><div class="row" style="gap:10px"><select id="is_d"><option value="">부서 전체</option>' + depts.map(function (d) { return '<option' + (v.dept === d ? ' selected' : '') + '>' + esc(d) + '</option>'; }).join('') + '</select><span class="note">대상 ' + st.total + '대</span><span class="pb big"><i style="width:' + st.pct + '%"></i></span><b>' + st.pct + '%</b></div><div class="note">확인 ' + (st.auto + st.scan) + ' · 미확인 ' + st.pending + ' · 이상 ' + st.abnormal + (inv.end_date ? ' · 마감 ' + esc(inv.end_date) : '') + '</div></div>' +
        '<div class="fchips" style="margin:8px 0">' + [['pending', '미확인'], ['abnormal', '이상'], ['all', '전체']].map(function (c) { return '<button type="button" class="achip' + (v.chip === c[0] ? ' on' : '') + '" data-c="' + c[0] + '">' + c[1] + '</button>'; }).join('') + '</div>' +
        '<div class="invlist">' + (list.map(function (i) { return '<div class="invrow" data-id="' + i.id + '"><div><b class="mono">' + esc(i.asset_no) + '</b> · ' + esc(i.category || '') + '<div class="note">' + esc((i.location || '') + ' · ' + (i.user_name || '') + (i.dept ? ' · ' + i.dept : '')) + '</div></div><div>' + (invDone(i) ? badge('확인', 'ok') : i.result === 'abnormal' ? badge('이상', 'bad') : i.resolution === 'reconfirm' ? badge('재확인 요청', 'warn') : badge('미확인', 'warn')) + '</div></div>'; }).join('') || '<div class="note" style="padding:16px">해당하는 항목이 없습니다.</div>') + '</div>' +
        '<div class="scanfab"><button class="btn pri big" id="is_go" type="button">▣ QR 스캔 시작</button></div>');
      $('#is_d').onchange = function () { v.dept = this.value; draw(); };
      $$('.achip').forEach(function (b) { b.onclick = function () { v.chip = b.dataset.c; draw(); }; });
      $$('.invrow').forEach(function (r) { r.onclick = function () { openSheet(items.filter(function (i) { return String(i.id) === r.dataset.id; })[0]); }; });
      $('#is_go').onclick = startScan;
    }
    function openSheet(it) {
      var m = openModal('<div class="mh"><b class="mono">' + esc(it.asset_no) + '</b><button class="mx" type="button">✕</button></div>' + sheetInfo(it) + '<div id="is_b"></div>', 440);
      invBtns($('#is_b', m.d), it, inv, function () { m.close(); draw(); });
    }
    function sheetInfo(it) { var a = S.assets.filter(function (x) { return x.asset_no === it.asset_no; })[0] || {}; return '<div style="line-height:1.9;margin-bottom:8px"><b>' + esc((a.manufacturer || '') + ' ' + (a.model || '')) + '</b> · ' + esc(it.category || '') + '<br>위치 ' + esc(it.location || '—') + ' · 사용자 ' + esc(it.user_name || '—') + ' · ' + esc(it.dept || '') + '<br>장부상 상태 <b>' + esc(a.status || '—') + '</b><br><span class="note">현재: ' + invStatusText(it) + '</span></div><div class="note" style="margin-bottom:8px;background:#eef5fc;border-radius:6px;padding:6px 9px">장부 내용과 현장이 같으면 [일치]를 누르세요. 다르면 바꿔서 확인합니다.</div>'; }
    function startScan() {
      scanOverlay('실사 QR 스캔 · ' + inv.name, function (no, api) {
        var it = items.filter(function (i) { return i.asset_no === no; })[0];
        if (!it) { var s0 = api.sheet('<b class="mono">' + esc(no) + '</b><div class="note" style="margin:6px 0">이 실사의 대상이 아닌 자산입니다.</div><div class="invb"><button type="button" class="ib" id="sn_a">자산 화면 열기</button><button type="button" class="ib" id="sn_x">닫기</button></div>'); $('#sn_x', s0).onclick = api.release; $('#sn_a', s0).onclick = function () { api.close(); location.hash = '#/asset/' + encodeURIComponent(no); }; return; }
        var s1 = api.sheet('<b class="mono">' + esc(it.asset_no) + '</b>' + sheetInfo(it) + '<div id="sn_b"></div><button type="button" class="btn sm" id="sn_n" style="margin-top:8px">건너뛰기 (다음 스캔)</button>');
        invBtns($('#sn_b', s1), it, inv, function () { api.release(); }); $('#sn_n', s1).onclick = api.release;
      }, draw);
    }
    draw();
  }

  // ---- QR 스캔 결과 (모든 전산장비 공통) ----
  async function pageScan(arg) {
    if (!arg) {
      shell('scan', '<div class="row wrap"><h1>QR 스캔</h1><span class="note">PC·노트북·모니터·서버·스위치·스캐너·프린터 등 모든 전산장비의 QR 스티커를 비춰 주세요</span></div><div class="card"><button class="btn pri big" id="sc_start" type="button">▣ QR 스캔 시작</button><div class="note" style="margin-top:8px">카메라가 안 되면 관리번호를 직접 입력할 수 있습니다. (카메라는 https 주소에서만 동작합니다)</div></div>');
      var go = function () { scanOverlay('QR 스캔', function (no, api) { api.close(); location.hash = '#/scan/' + encodeURIComponent(no); }); };
      $('#sc_start').onclick = go; go(); return;
    }
    var no = decodeURIComponent(arg), a = S.assets.filter(function (x) { return x.asset_no.toUpperCase() === no.toUpperCase(); })[0];
    if (!a) { shell('scan', '<div class="row wrap"><h1>QR 스캔</h1></div><div class="card"><b class="mono">' + esc(no) + '</b><div class="note" style="margin:6px 0">등록되지 않은 관리번호입니다.</div><a class="btn" href="#/scan">다시 스캔</a></div>'); return; }
    no = a.asset_no;
    var invs = []; try { invs = (await invList()).filter(function (x) { return x.status === 'open'; }); } catch (e) { /* 실사 표가 없어도 스캔은 동작 */ }
    var its = [];
    for (var i = 0; i < invs.length; i++) {
      var all = DEMO ? demoInvInit().items[invs[i].id] || [] : ((await sb.from('inventory_items').select(ICOLS).eq('asset_no', no).eq('inventory_id', invs[i].id)).data || []);
      var f = all.filter(function (x) { return x.asset_no === no; })[0]; if (f) its.push({ inv: invs[i], it: f });
    }
    var kind = isPc(a) ? 'PC' : a.category === '모니터' ? '모니터' : /서버|스위치/.test(a.category || '') ? '서버·스위치' : '기타';
    var viewer = isViewer(), mon = kind === 'PC' ? monsOf(a._dev) : [];
    shell('scan', '<div class="row wrap"><a href="#/scan">‹ 다시 스캔</a><h1 class="mono">' + esc(no) + '</h1>' + badge(a.category || '—', 'gray') + badge(a.status || '—', a.status === '사용중' ? 'ok' : 'gray') + '</div>' +
      '<div class="card"><div style="line-height:1.9"><b>' + esc((a.manufacturer || '') + ' ' + (a.model || '')) + '</b><br>위치 ' + esc(a.location || '—') + ' · 사용자 ' + esc((a.user_name || '—') + (a.dept ? ' · ' + a.dept : '')) + '<br>보증 ' + warrantyBadge(a.warr_end, a.warr_calc) + (a.pc_name ? '<br>컴퓨터 이름 ' + esc(a.pc_name) + ' · 최종 확인 ' + seenHtml(a.last_seen) : '') + (kind === '모니터' ? '<br>연결 PC ' + (a.linked_pc ? '<a class="mono" href="#/asset/' + encodeURIComponent(a.linked_pc) + '">' + esc(a.linked_pc) + '</a>' : '<span class="note">없음</span>') : '') + '</div></div>' +
      (kind === 'PC' ? '<div class="card"><h3>연관 모니터</h3>' + (mon.length ? mon.map(function (m) { return '<div style="padding:4px 0">' + esc((m.maker || '') + ' ' + (m.model || '')) + ' · ' + esc(m.serial || '시리얼 없음') + ' ' + (m.asset_no ? badge('연결됨 ' + m.asset_no, 'ok') : badge('미연결', 'pink')) + '</div>'; }).join('') : '<div class="note">읽어 온 모니터 정보가 없습니다.</div>') + '</div>' : '') +
      '<div id="sc_inv"></div><div class="card"><div class="scbtns">' +
      (viewer ? '' : '<button class="btn" id="s_chg" type="button">위치·사용자 변경</button><button class="btn" id="s_sup" type="button">지원 요청 등록</button>' + (kind === '모니터' && !a.linked_pc ? '<button class="btn pri" id="s_mon" type="button">PC와 연결</button>' : '')) +
      '<a class="btn" href="#/asset/' + encodeURIComponent(no) + '">이력·상세 보기</a></div>' + (viewer ? '<div class="note" style="margin-top:6px">조회 전용 계정은 정보·이력 보기만 가능합니다.</div>' : '') + '</div>');
    var host = $('#sc_inv');
    if (!viewer) its.forEach(function (x) { var c = document.createElement('div'); c.className = 'card'; c.innerHTML = '<h3>실사 확인 · ' + esc(x.inv.name) + '</h3><div class="note" style="margin-bottom:8px">현재: ' + invStatusText(x.it) + '</div><div class="ibh"></div>'; host.appendChild(c); invBtns($('.ibh', c), x.it, x.inv, function () { pageScan(arg); }); });
    var ch = $('#s_chg'); if (ch) ch.onclick = async function () {
      var m = openModal('<div class="mh"><b>위치·사용자 변경</b><button class="mx" type="button">✕</button></div><div class="ms">위치</div><input type="text" id="c_l" value="' + esc(a.location || '') + '" style="width:100%;box-sizing:border-box"><div class="ms">사용자명</div><input type="text" id="c_u" value="' + esc(a.user_name || '') + '" style="width:100%;box-sizing:border-box"><div class="mf"><button class="btn" id="c_x" type="button">취소</button><button class="btn pri" id="c_ok" type="button">저장</button></div>', 400);
      $('#c_x', m.d).onclick = m.close;
      $('#c_ok', m.d).onclick = async function () { var p = { location: $('#c_l', m.d).value.trim() || null, user_name: $('#c_u', m.d).value.trim() || null }; try { if ((p.user_name || '') !== (a.user_name || '')) await dbHistory(no, 'user', '사용자 변경: ' + (a.user_name || '없음') + ' → ' + (p.user_name || '없음') + ' (QR 스캔)', a._dev && a._dev.id); await dbUpdateAsset(no, p); m.close(); toast('저장했습니다.'); pageScan(arg); } catch (e) { fail(e); } };
    };
    var sp = $('#s_sup'); if (sp) sp.onclick = async function () {
      var sy = await askText('지원 요청 등록', '증상·요청 내용', '', '등록', true); if (!sy) return;
      try {
        needWrite(); var emp = (a.user_id && S.empBy[a.user_id]) ? a.user_id : null, row = { emp_no: emp, computer_name: a.pc_name || null, ip: a.ip || null, asset_no: no, symptom: sy + ' (QR 스캔으로 등록)' };
        if (DEMO) { S.support.unshift(Object.assign({ id: 's' + Date.now(), req_no: 'R-' + ymd(new Date()).replace(/-/g, '') + '-009', status: 'received', created_at: new Date().toISOString() }, row)); }
        else { audCtx({ table: 'support_requests', action: 'create', target: '지원 요청 (자산 ' + no + ')', summary: '지원 요청 등록 (QR 스캔) · ' + sy.slice(0, 60) }); var r = await sb.from('support_requests').insert(row).select().single(); if (r.error) throw r.error; S.support.unshift(r.data); }
        toast('지원 요청을 등록했습니다.');
      } catch (e) { fail(e); }
    };
    var sm = $('#s_mon'); if (sm) sm.onclick = function () { pickPcMonitor(a, function () { pageScan(arg); }); };
  }

  // ---------- v1.9.4: 자산 직접 등록 ----------
  var CAT_CODE = { 'PC': 'PC', '모니터': 'MO', '노트북': 'NB', 'PC 본체': 'PC' };
  function catCode(cat) {   // 기존 대장에서 같은 분류의 관리번호 코드(A-XX-...)를 배워 씀. 없으면 기본표
    var hit = S.assets.filter(function (a) { return a.category === cat && /^A-[A-Z]+-/.test(a.asset_no || ''); })[0];
    if (hit) return hit.asset_no.split('-')[1];
    return CAT_CODE[cat] || '';
  }
  function nextAssetNo(cat, mfg) {
    var code = catCode(cat); if (!code) return '';
    var yr = /^\d{4}/.test(mfg || '') ? mfg.slice(0, 4) : String(new Date().getFullYear()), mx = 0;
    S.assets.forEach(function (a) { var m = /^A-([A-Z]+)-\d{4}-(\d+)$/.exec(a.asset_no || ''); if (m && m[1] === code) mx = Math.max(mx, parseInt(m[2], 10)); });
    return 'A-' + code + '-' + yr + '-' + ('00' + (mx + 1)).slice(-3);
  }
  function pageAssetNew() {
    if (isViewer()) { shell('assets', '<h1>자산 직접 등록</h1><div class="note" style="margin-top:8px">조회 전용 계정은 자산을 등록할 수 없습니다.</div>'); return; }
    var cats = groupCount(S.assets, function (a) { return a.category; }).map(function (x) { return x[0]; }).filter(Boolean);
    Object.keys(CAT_CODE).forEach(function (c) { if (cats.indexOf(c) < 0) cats.push(c); });
    var stats = groupCount(S.assets, function (a) { return a.status; }).map(function (x) { return x[0]; }).filter(Boolean); if (stats.indexOf('사용중') < 0) stats.unshift('사용중');
    function fr(id, label, inner, req, hint) { return '<div class="frow"><div class="fl">' + label + (req ? ' <span style="color:#c42b1c">*</span>' : '') + '</div><div class="fv">' + inner + '<div class="note" id="h_' + id + '">' + (hint || '') + '</div></div></div>'; }
    function inp(id, ph, type, w) { return '<input type="' + (type || 'text') + '" id="n_' + id + '" placeholder="' + (ph || '') + '" autocomplete="off"' + (w ? ' style="width:' + w + '"' : '') + '>'; }
    var form = fr('category', '자산분류', '<input type="text" id="n_category" list="n_cats" placeholder="예: 모니터" autocomplete="off"><datalist id="n_cats">' + cats.map(function (c) { return '<option value="' + esc(c) + '">'; }).join('') + '</datalist>', true, '고르거나 직접 입력합니다. 선택하면 관리번호가 자동으로 정해집니다') +
      fr('asset_no', '관리번호', '<input type="text" id="n_asset_no" class="mono" placeholder="분류를 선택하면 자동 부여" autocomplete="off" style="background:#f2f8fe;color:#0f6cbd;font-weight:700">', true, '분류·제조년도·다음 번호가 자동으로 붙습니다. 필요하면 직접 고칠 수 있고, 이미 있는 번호는 저장되지 않습니다') +
      fr('manufacturer', '제조사', inp('manufacturer', '예: DELL'), true) + fr('model', '모델명', inp('model', '예: S275DS'), true) +
      fr('mfg_ym', '제조년월', inp('mfg_ym', '예: 2025-01', 'text', '180px'), false, '입력하면 보증(제조년월+5년)이 자동 계산됩니다') +
      fr('status', '자산상태', '<select id="n_status">' + stats.map(function (t) { return '<option' + (t === '사용중' ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join('') + '</select>', true) +
      fr('user_id', '사용자 ID', inp('user_id', '사번을 입력하면 아래가 자동으로 채워집니다', 'text', '260px'), false, '') +
      fr('user_name', '사용자명', inp('user_name')) + fr('dept', '소속명', inp('dept')) + fr('company', '회사', '<select id="n_company" style="width:100%"><option value="">선택 안 함 (나중에 지정)</option>' + CO.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('') + '</select>') + fr('title', '직책', inp('title')) + fr('location', '위치', inp('location')) +
      fr('serial_no', '시리얼 번호', inp('serial_no'), false, '모니터는 PC 프로그램이 읽은 시리얼과 같으면 자동 연결됩니다') +
      fr('purchase_date', '구매일', inp('purchase_date', '', 'date', '200px')) + fr('warranty_end', '보증 만료', inp('warranty_end', '', 'date', '200px'), false, '비워 두면 제조년월+5년으로 계산합니다') +
      fr('memo', '메모', '<textarea id="n_memo" rows="3" style="width:100%"></textarea>');
    shell('assets', '<div class="row wrap"><a href="#/assets" class="note">‹ 자산 관리</a><h1>자산 직접 등록</h1><div class="grow"></div><button class="btn" id="n_cancel" type="button">취소</button><button class="btn pri" id="n_save" type="button">등록</button></div>' +
      '<div style="display:flex;align-items:flex-start;gap:14px"><div class="card" style="flex:1.6">' + form + '</div><div class="card" style="flex:1;line-height:1.85"><b>등록하면</b><br>① 관리번호가 확정되고 목록에 바로 나타납니다<br>② 상세 화면이 열리며 QR 코드를 바로 출력할 수 있습니다<br>③ 이력 관리에 "자산 직접 등록"이 남습니다<br><br><b>입력 확인</b><br>· 필수(*): 자산분류, 관리번호, 제조사, 모델명, 자산상태<br>· 같은 시리얼 번호가 이미 있으면 저장 전에 알려 드립니다<br>· 모니터는 등록 후 상세 화면의 "PC와 연결"로 수동 연결도 가능합니다<div id="n_msg" style="margin-top:10px"></div></div></div>');
    var edited = false;
    function V(id) { return $('#n_' + id).value.trim(); }
    function msg(t, bad) { var m = $('#n_msg'); m.innerHTML = t ? '<div class="' + (bad ? 'warnbox' : 'note') + '" style="' + (bad ? '' : 'background:#e6f4ea;color:#1e8e3e;border-radius:6px;padding:6px 10px') + '">' + esc(t) + '</div>' : ''; }
    function autoNo() { if (edited) return; var no = nextAssetNo(V('category'), V('mfg_ym')); $('#n_asset_no').value = no; $('#h_asset_no').textContent = no ? '분류·제조년도·다음 번호가 자동으로 붙습니다. 필요하면 직접 고칠 수 있고, 이미 있는 번호는 저장되지 않습니다' : '이 분류의 관리번호 규칙을 알 수 없습니다. 관리번호를 직접 입력하세요'; }
    $('#n_category').oninput = autoNo; $('#n_category').onchange = autoNo; $('#n_mfg_ym').oninput = autoNo;
    $('#n_asset_no').oninput = function () { edited = true; };
    $('#n_user_id').oninput = function () {   // 값만 채우므로 입력 중인 칸은 다시 그리지 않음 (한글 입력 안전)
      var e = S.empBy[V('user_id').toUpperCase()] || S.empBy[V('user_id')], h = $('#h_user_id');
      if (e) { $('#n_user_name').value = e.name || ''; $('#n_dept').value = e.dept || ''; $('#n_title').value = e.title || ''; h.innerHTML = '<span style="background:#e6f4ea;color:#1e8e3e;border-radius:4px;padding:2px 8px">인사 정보 일치: ' + esc((e.name || '') + ' · ' + (e.dept || '') + ' · ' + (e.title || '')) + ' (자동 입력)</span>'; }
      else h.textContent = V('user_id') ? '인사 정보에 없는 사번입니다. 사용자명·소속명·직책을 직접 입력하세요' : '';
    };
    $('#n_cancel').onclick = function () { location.hash = '#/assets'; };
    $('#n_save').onclick = async function () {
      var no = V('asset_no').toUpperCase(), row = { asset_no: no, category: V('category'), manufacturer: V('manufacturer'), model: V('model'), mfg_ym: V('mfg_ym') || null, status: V('status') || '사용중', user_id: V('user_id') || null, user_name: V('user_name') || null, dept: V('dept') || null, company: V('company') || null, title: V('title') || null, location: V('location') || null, serial_no: V('serial_no') || null, purchase_date: V('purchase_date') || null, warranty_end: V('warranty_end') || null, memo: V('memo') || null };
      if (!row.category || !no || !row.manufacturer || !row.model) { msg('자산분류·관리번호·제조사·모델명은 꼭 입력해야 합니다.', true); return; }
      if (row.mfg_ym && !/^\d{4}-(0[1-9]|1[0-2])$/.test(row.mfg_ym)) { msg('제조년월은 2025-01 처럼 입력하세요.', true); return; }
      if (S.assets.some(function (a) { return a.asset_no === no; })) { msg(no + ' 는 이미 있는 관리번호입니다. 번호를 바꿔 주세요.', true); return; }
      var dup = row.serial_no ? S.assets.filter(function (a) { return a.serial_no && a.serial_no.toUpperCase() === row.serial_no.toUpperCase(); })[0] : null;
      if (dup && !confirm('같은 시리얼 번호(' + row.serial_no + ')가 이미 ' + dup.asset_no + ' 에 등록되어 있습니다.\n그래도 등록할까요?')) return;
      var btn = this; btn.disabled = true; btn.textContent = '등록 중…';
      try {
        needWrite();
        var ch = Object.keys(row).filter(function (k) { return k !== 'asset_no' && row[k] != null && row[k] !== ''; }).map(function (k) { return { k: FLBL[k] || k, from: '없음', to: String(row[k]) }; });
        audCtx({ table: 'assets', action: 'create', target: '자산 ' + no, summary: '자산 직접 등록 · ' + no + ' (' + row.category + ' ' + row.manufacturer + ' ' + row.model + ')', detail: { via: '자산 관리 · 직접 등록', changes: ch } });
        if (!DEMO) { var r = await sb.from('assets').insert(row); if (r.error) throw r.error; }
        S.assets.push(Object.assign({ created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, row));
        rebuildAssets(); toast(no + ' 을(를) 등록했습니다.'); location.hash = '#/asset/' + encodeURIComponent(no);
      } catch (er) { fail(er); btn.disabled = false; btn.textContent = '등록'; }
    };
    setTimeout(function () { $('#n_category').focus(); }, 30);
  }

  // =====================================================================
  // v1.9.4: 보고서 (월별 · 기간별 · 부서별 · 보증 · 현황 점검 · 원격 지원 · 실사 · 이력 요약)
  // =====================================================================
  var CGRP = ['PC', '노트북', '모니터', '기타'];
  function catGroup(c) { return c === 'PC' || c === 'PC 본체' ? 'PC' : c === '노트북' ? '노트북' : c === '모니터' ? '모니터' : '기타'; }
  function liveAssets() { return S.assets.filter(function (a) { return a.status !== '폐기'; }); }
  function catCounts(list) { var o = { PC: 0, 노트북: 0, 모니터: 0, 기타: 0 }; list.forEach(function (a) { o[catGroup(a.category)]++; }); return o; }
  function pcStats() {
    var pcs = S.assets.filter(function (a) { return isPc(a) && a.status !== '폐기'; }), td = ymd(new Date()), o = { total: pcs.length, today: 0, stale: 0, none: 0, mismatch: 0 };
    pcs.forEach(function (a) { if (!a.last_seen) o.none++; else { if (ymd(a.last_seen) === td) o.today++; if ((Date.now() - new Date(a.last_seen).getTime()) / 86400000 > 7) o.stale++; } if (a.user_mismatch) o.mismatch++; });
    return o;
  }
  async function snapDaily() {   // 관리자가 접속한 날 하루 1번, 그날의 수량을 저장 (월별 자산 현황의 재료)
    try {
      if (DEMO || isViewer()) return; var td = ymd(new Date());
      var r = await sb.from('asset_snapshots').select('snap_date').eq('snap_date', td).maybeSingle(); if (r.error || r.data) return;
      var c = catCounts(liveAssets()); var byCo = {}; CO.forEach(function (co) { byCo[co] = catCounts(liveAssets().filter(function (a) { return a.company === co; })); }); c._co = byCo;   // v1.9.9: 회사별 보고서 필터용 (이 저장 시점부터)
      await sb.from('asset_snapshots').insert({ snap_date: td, total: liveAssets().length, counts: c, pc: pcStats() });
    } catch (e) { }
  }
  async function repSnaps() {
    if (DEMO) {   // 데모용 예시 추이
      var cur = catCounts(liveAssets()), now = new Date(), out = [], pcs = pcStats();
      for (var j = now.getMonth(); j >= 0; j--) {
        var d = new Date(now.getFullYear(), now.getMonth() - j + 1, 0); if (j === 0) d = now; var c = {}, tot = 0;
        CGRP.forEach(function (g) { c[g] = Math.max(0, cur[g] - j * Math.max(1, Math.round(cur[g] / 140))); tot += c[g]; });
        out.push({ snap_date: ymd(d), total: tot, counts: c, pc: { total: pcs.total - j, today: Math.max(0, pcs.today - j), stale: pcs.stale + (j % 3), none: pcs.none + j, mismatch: pcs.mismatch + (j % 2) } });
      }
      return out;
    }
    var r = await sb.from('asset_snapshots').select('*').order('snap_date', { ascending: true }).limit(2000);
    if (r.error) throw new Error('보고서용 표를 읽지 못했습니다. db/update_v1.9.4.sql 을 SQL Editor에서 실행했는지 확인하세요.');
    return r.data;
  }
  function monthEnd(y, m) { return ymd(new Date(y, m, 0)); }
  function monthRows(snaps, year, co) {   // 달별 월말 수량 (스냅샷이 없는 달은 대장 등록일 기준 추정); co 지정 시 그 회사만 (v1.9.9)
    var now = new Date(), last = year === now.getFullYear() ? now.getMonth() + 1 : 12, rows = [];
    for (var m = 1; m <= last; m++) {
      var end = monthEnd(year, m), ms = snaps.filter(function (s0) { return s0.snap_date.slice(0, 7) === year + '-' + ('0' + m).slice(-2); }), hit = ms.length ? ms[ms.length - 1] : null, est = false, c = null, pc = null, noData = false;
      if (hit) {
        if (co) { if (hit.counts && hit.counts._co && hit.counts._co[co]) c = hit.counts._co[co]; else noData = true; }
        else { c = hit.counts; pc = hit.pc; }
      } else { est = true; c = catCounts(S.assets.filter(function (a) { return a.status !== '폐기' && (!a.created_at || ymd(a.created_at) <= end) && (!co || a.company === co); })); }
      var tot = null; if (c) { tot = 0; CGRP.forEach(function (g) { c[g] = c[g] || 0; tot += c[g]; }); }
      rows.push({ m: m, label: year + '-' + ('0' + m).slice(-2), c: c, total: tot, est: est, pc: pc, day: hit ? hit.snap_date : end, noData: noData });
    }
    return rows;
  }
  function repXlsx(fname, sheets, title) {
    var wb = XLSX.utils.book_new(), n = 0;
    sheets.forEach(function (s0) { var ws = XLSX.utils.json_to_sheet(s0.rows.length ? s0.rows : [{ '안내': '해당 내용이 없습니다' }]); XLSX.utils.book_append_sheet(wb, ws, s0.name.slice(0, 30)); n += s0.rows.length; });
    XLSX.writeFile(wb, fname + '_' + ymd(new Date()) + '.xlsx'); logExport('보고서 · ' + title, n, '보고서 내보내기');
  }
  function repHead(title, extra, sub) { return '<div class="row wrap"><a href="#/reports">‹ 보고서</a><h1>' + esc(title) + '</h1>' + (sub ? '<span class="note">' + sub + '</span>' : '') + '<div class="grow"></div>' + (extra || '') + '<button class="btn noprint" id="r_xl" type="button">엑셀 내려받기</button><button class="btn noprint" id="r_pdf" type="button">PDF</button></div>'; }
  function repBind(title, xlFn) {
    $('#r_xl').onclick = function () { try { xlFn(); } catch (e) { fail(e); } };
    $('#r_pdf').onclick = function () { logExport('보고서 · ' + title, 0, '보고서 PDF 인쇄'); window.print(); };
  }
  function kp(l, v, sub, c) { return '<div class="card kpi"><div class="note">' + l + '</div><div class="kv2" style="color:' + (c || '#1a1a1a') + '">' + v + '</div><div class="note">' + (sub || '') + '</div></div>'; }
  function dlt(n) { return '<span style="color:' + (n > 0 ? '#1e8e3e' : n < 0 ? '#c42b1c' : '#8a8a8a') + '">' + (n > 0 ? '+' : '') + n.toLocaleString() + '</span>'; }
  var REP_CO = '';   // v1.9.9: 보고서 회사 필터 ('' = 전체)
  function repCoFilter(list) { return !REP_CO ? list : list.filter(function (a) { return a.company === REP_CO; }); }
  var REPS = [
    ['자산 현황', [['monthly', '📅', '월별 자산 현황', '월말 기준 PC·노트북·모니터 등 분류별 수량과 전월 대비 증감, 월별 추이 그래프', '월별'], ['period', '🔄', '기간별 자산 변동', '기간을 정해 신규 등록·폐기·상태 변경·사용자 이동·위치 변경 건수와 내역', '기간별'], ['dept', '🏢', '부서별 자산 보유', '소속별 PC·노트북·모니터 보유 수량과 1인당 장비 수', '현재']]],
    ['점검·지원', [['warranty', '🛡️', '보증 만료 예정', '만료됨 / 1·3·6·12개월 안에 보증이 끝나는 장비 목록과 교체 예산용 수량', '기간별'], ['check', '🩺', '현황 점검 보고', 'PC 점검 수집률, 7일 이상 미확인, 사용자 불일치 현황과 월별 추이', '월별'], ['support', '🎧', '원격 지원 처리 현황', '월별 접수·완료 건수, 평균 처리 시간, 증상별·담당자별 통계', '월별']]],
    ['실사·감사', [['inv', '📋', '실사 결과 보고서', '회차별 확인율, 부서·분류별 진행, 미확인·이상 목록', '회차별'], ['audit', '🔎', '이력 관리 요약 (메인 관리자)', '기간별 로그인·변경·삭제·내보내기 건수와 작업자별 요약. 감사 제출용', '기간별', 'main']]]
  ];
  function pageReports(arg) {
    if (!isMain()) { denyPage(); return; }
    var k = (arg || '').split('/')[0];
    if (k === 'monthly') return repMonthly(); if (k === 'period') return repPeriod(); if (k === 'dept') return repDept(); if (k === 'warranty') return repWarranty();
    if (k === 'check') return repCheck(); if (k === 'support') return repSupport(); if (k === 'inv') return repInv(); if (k === 'audit') return repAudit();
    var CO_FLT = ['monthly', 'period', 'dept'];   // 회사 필터가 적용되는 보고서
    var html = '<div class="row wrap"><h1>보고서</h1><span class="note">조건을 고르면 바로 보고서가 만들어지고, 엑셀·PDF로 내려받습니다</span><div class="grow"></div><span class="note">회사</span><select id="r_co" class="noprint"><option value="">전체</option>' + CO.map(function (c) { return '<option' + (REP_CO === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select></div>' +
      (REP_CO ? '<div class="note" style="background:#fff3cd;color:#8a6d00;border-radius:6px;padding:6px 10px;margin-bottom:4px">회사를 "' + esc(REP_CO) + '"로 좁혀서 자산 현황 보고서를 다시 계산합니다 (월별 자산 현황은 이번 선택이 반영되는 달부터만 적용, 아래 참고)</div>' : '') +
      REPS.map(function (g) {
      return '<h3 style="margin:14px 0 6px">' + g[0] + '</h3><div class="rgrid">' + g[1].filter(function (r) { return !r[5] || isMain(); }).map(function (r) {
        return '<a class="rcard" href="#/reports/' + r[0] + '"><div class="rt"><span class="ri">' + r[1] + '</span><b>' + r[2] + '</b></div><div class="rd">' + r[3] + '</div><div class="rf"><span class="badge b-blue">' + r[4] + '</span>' + (REP_CO && CO_FLT.indexOf(r[0]) >= 0 ? '<span class="badge" style="background:#fff3cd;color:#8a6d00">' + esc(REP_CO) + '만</span>' : '') + '<span class="grow"></span><span class="ro">열기 ›</span></div></a>';
      }).join('') + '</div>';
    }).join('') + '<div class="note" style="margin-top:14px;line-height:1.8">· 엑셀·PDF로 내려받으면 이력 관리에 "보고서 내보내기"가 남습니다 · 조회 전용 계정도 열람할 수 있습니다<br>· 월별 자산 현황은 관리자가 접속하는 날 하루 1번 자동 저장되는 수량을 기준으로 합니다 (저장이 없던 달은 대장 등록일 기준 추정으로 표시)<br>· 실사 결과·이력 관리 요약 보고서는 이미 회사·기간 단위라 위 회사 선택과 무관합니다</div>';
    shell('reports', html);
    $('#r_co').onchange = function () { REP_CO = this.value; pageReports(arg); };
  }
  // ---- 월별 자산 현황
  var RV = { year: new Date().getFullYear() };
  async function repMonthly() {
    var snaps; try { snaps = await repSnaps(); } catch (e) { shell('reports', repHead('월별 자산 현황') + '<div class="note" style="color:#c42b1c;margin-top:8px">' + esc(e.message) + '</div>'); return; }
    var yrs = [new Date().getFullYear(), new Date().getFullYear() - 1], rowsAll = monthRows(snaps, RV.year, REP_CO), rows = rowsAll.filter(function (r) { return r.c; });
    var lastR = rows[rows.length - 1], prev = rows.length > 1 ? rows[rows.length - 2] : null, first = rows[0];
    var series = [['PC', '#0f6cbd'], ['노트북', '#1e8e3e'], ['모니터', '#e08a00']], W = 560, H = 230, all = [];
    series.forEach(function (s0) { rows.forEach(function (r) { all.push(r.c[s0[0]]); }); });
    if (!all.length) all = [0];
    var lo = Math.max(0, Math.min.apply(null, all) - 40), hi = Math.max.apply(null, all) + 40; if (hi === lo) hi = lo + 1;
    var X = function (i) { return 50 + i * (W - 70) / Math.max(1, rows.length - 1); }, Y = function (v) { return H - 30 - (v - lo) / (hi - lo) * (H - 60); };
    var svg = !rows.length ? '' : '<svg width="' + W + '" height="' + H + '" style="max-width:100%">' + [0, 1, 2, 3, 4].map(function (q) { var yy = H - 30 - q * (H - 60) / 4; return '<line x1="50" x2="' + (W - 20) + '" y1="' + yy + '" y2="' + yy + '" stroke="#eef0f3"/><text x="44" y="' + (yy + 4) + '" font-size="9" fill="#8a8a8a" text-anchor="end">' + Math.round(lo + (hi - lo) * q / 4) + '</text>'; }).join('') +
      rows.map(function (r, i) { return '<text x="' + X(i) + '" y="' + (H - 10) + '" font-size="9.5" fill="#6a6a6a" text-anchor="middle">' + r.m + '월</text>'; }).join('') +
      series.map(function (s0) { return '<polyline fill="none" stroke="' + s0[1] + '" stroke-width="2.2" points="' + rows.map(function (r, i) { return X(i).toFixed(0) + ',' + Y(r.c[s0[0]]).toFixed(0); }).join(' ') + '"/>' + rows.map(function (r, i) { return '<circle cx="' + X(i).toFixed(0) + '" cy="' + Y(r.c[s0[0]]).toFixed(0) + '" r="2.8" fill="' + s0[1] + '"/>'; }).join(''); }).join('') + '</svg>';
    var legend = series.map(function (s0) { return '<span style="margin-right:14px"><i style="display:inline-block;width:10px;height:3px;background:' + s0[1] + ';vertical-align:middle;margin-right:4px"></i>' + s0[0] + '</span>'; }).join('');
    var trs = rowsAll.slice().reverse().map(function (r) {
      var i = rowsAll.indexOf(r), p = i > 0 ? rowsAll[i - 1] : null;
      if (!r.c) return '<tr><td>' + r.label + '</td><td colspan="9" class="note">회사별 자산 현황이 저장되지 않은 달입니다 (이 회사 필터는 ' + ymd(new Date()) + ' 이후 저장분부터 적용됩니다)</td></tr>';
      return '<tr><td>' + r.label + (r.est ? ' <span class="note">추정</span>' : '') + '</td>' + CGRP.map(function (g) { return '<td>' + r.c[g].toLocaleString() + '</td><td>' + (p && p.c ? dlt(r.c[g] - p.c[g]) : '—') + '</td>'; }).join('') + '<td><b>' + r.total.toLocaleString() + '</b></td><td>' + (p && p.c ? dlt(r.total - p.total) : '—') + '</td></tr>';
    }).join('');
    shell('reports', repHead('월별 자산 현황', '<select id="r_y" class="noprint">' + yrs.map(function (y) { return '<option' + (y === RV.year ? ' selected' : '') + '>' + y + '</option>'; }).join('') + '</select>', '월말 기준 · 자산 대장 수량(폐기 제외)' + (REP_CO ? ' · 회사: ' + esc(REP_CO) : '')) +
      '<div class="kpis">' + series.map(function (s0) { var v = lastR ? lastR.c[s0[0]] : 0; return kp(s0[0], v.toLocaleString(), prev ? '전월 ' + (v - prev.c[s0[0]] >= 0 ? '+' : '') + (v - prev.c[s0[0]]) : '', s0[1]); }).join('') + kp('합계', (lastR ? lastR.total : 0).toLocaleString(), (prev ? '전월 ' + (lastR.total - prev.total >= 0 ? '+' : '') + (lastR.total - prev.total) : '') + (first && lastR ? ' · ' + RV.year + '년 초 대비 ' + (lastR.total - first.total >= 0 ? '+' : '') + (lastR.total - first.total) : '')) + '</div>' +
      '<div class="rcols"><div class="card"><div style="font-size:11.5px;margin-bottom:2px">' + legend + '</div>' + (svg || '<div class="note">표시할 달이 없습니다.</div>') + '</div><div class="rtb"><table class="tbl ctr"><thead><tr><th>월말 기준</th>' + CGRP.map(function (g) { return '<th>' + g + '</th><th>증감</th>'; }).join('') + '<th>합계</th><th>증감</th></tr></thead><tbody>' + trs + '</tbody></table></div></div>' +
      '<div class="note" style="margin-top:8px;line-height:1.8">· 월말(마지막 날) 기준 수량입니다. 그 달에 저장된 마지막 수량을 쓰고, 저장이 없던 달은 대장 등록일 기준 <b>추정</b>입니다.' + (REP_CO ? '<br>· 회사별 분해는 이번 업데이트부터 매일 저장에 함께 기록되므로, 이전 달은 회사별 수치가 없을 수 있습니다.' : '') + '</div>');
    $('#r_y').onchange = function () { RV.year = Number(this.value); repMonthly(); };
    repBind('월별 자산 현황', function () { repXlsx('월별자산현황_' + RV.year + (REP_CO ? '_' + REP_CO : ''), [{ name: RV.year + '년 월별', rows: rowsAll.map(function (r) { if (!r.c) return { '월말 기준': r.label, '구분': '회사별 미저장' }; var o = { '월말 기준': r.label, '구분': r.est ? '추정' : '저장값' }; CGRP.forEach(function (g) { o[g] = r.c[g]; }); o['합계'] = r.total; return o; }) }], '월별 자산 현황'); });
  }
  // ---- 기간별 자산 변동
  var RP = { from: '', to: '', cat: '', dept: '', q: 'month' };
  function periodSet(q) {
    var n = new Date(), y = n.getFullYear(), m = n.getMonth(), d = n.getDate(), f, t = ymd(n);
    if (q === 'today') f = t; else if (q === 'week') f = ymd(new Date(y, m, d - ((n.getDay() + 6) % 7))); else if (q === 'month') f = ymd(new Date(y, m, 1));
    else if (q === 'last') { f = ymd(new Date(y, m - 1, 1)); t = ymd(new Date(y, m, 0)); } else if (q === 'quarter') f = ymd(new Date(y, Math.floor(m / 3) * 3, 1)); else if (q === 'year') f = ymd(new Date(y, 0, 1));
    if (f) { RP.from = f; RP.to = t; } RP.q = q;
  }
  function changeTypes(r) {
    var out = [], ch = (r.detail && r.detail.changes) || [], ks = ch.map(function (c) { return c.k; });
    if (r.action === 'create') out.push('신규 등록');
    if (r.action === 'delete') out.push('삭제');
    if (r.action === 'update' || r.action === 'change') {
      ch.forEach(function (c) { if (c.k === '자산상태') out.push(/폐기/.test(c.to) ? '폐기' : '상태 변경'); });
      if (ks.indexOf('사용자명') >= 0 || ks.indexOf('사용자 ID') >= 0) out.push('사용자 이동'); if (ks.indexOf('위치') >= 0) out.push('위치 변경');
      if (!out.length && /폐기/.test(r.summary || '')) out.push('폐기');
    }
    return out;
  }
  async function repPeriod() {
    if (!RP.from) periodSet('month');
    var rows = [], err = '';
    try {
      if (DEMO) { rows = (S.audit = S.audit || demoAudit()).filter(function (r) { return /^자산/.test(r.target || '') && ymd(r.at) >= RP.from && ymd(r.at) <= RP.to; }); }
      else { var r = await sb.rpc('report_asset_changes', { p_from: RP.from, p_to: RP.to }); if (r.error) throw new Error('기간별 변동 조회에 실패했습니다. db/update_v1.9.4.sql 을 실행했는지 확인하세요. (' + r.error.message + ')'); rows = r.data; }
    } catch (e) { err = e.message; }
    var lines = [];
    rows.forEach(function (r) {
      var m = /^자산 (\S+)/.exec(r.target || ''), no = m ? m[1] : '', a = no ? S.assets.filter(function (x) { return x.asset_no === no; })[0] : null;
      if (RP.cat && (!a || a.category !== RP.cat)) return; if (RP.dept && (!a || a.dept !== RP.dept)) return; if (REP_CO && (!a || a.company !== REP_CO)) return;
      changeTypes(r).forEach(function (t) { lines.push({ at: r.at, no: no, type: t, text: r.summary || '', who: r.actor_name || '' }); });
    });
    var TYPES = [['신규 등록', '#0f6cbd'], ['폐기', '#c42b1c'], ['상태 변경', '#e08a00'], ['사용자 이동', '#6b3fb0'], ['위치 변경', '#1e8e3e'], ['삭제', '#8a8a8a']], cnt = {}; lines.forEach(function (l) { cnt[l.type] = (cnt[l.type] || 0) + 1; });
    var mx = Math.max.apply(null, [1].concat(TYPES.map(function (t) { return cnt[t[0]] || 0; })));
    var bars = TYPES.map(function (t) { var n = cnt[t[0]] || 0; return '<div class="prow"><span class="pn">' + t[0] + '</span><span class="pb"><i style="width:' + Math.round(n / mx * 100) + '%;background:' + t[1] + '"></i></span><span class="pv">' + n + '</span></div>'; }).join('');
    var cats = groupCount(S.assets, function (a) { return a.category; }).map(function (x) { return x[0]; }), depts = groupCount(S.assets, function (a) { return a.dept; }).map(function (x) { return x[0]; });
    var QL = [['today', '오늘'], ['week', '이번 주'], ['month', '이번 달'], ['last', '지난 달'], ['quarter', '분기'], ['year', '올해']];
    shell('reports', repHead('기간별 자산 변동', '', '이력 관리의 자산 변경 기록을 집계합니다' + (REP_CO ? ' · 회사: ' + esc(REP_CO) : '')) +
      '<div class="card noprint" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center"><span class="note">기간</span>' + QL.map(function (q) { return '<button type="button" class="achip' + (RP.q === q[0] ? ' on' : '') + '" data-q="' + q[0] + '">' + q[1] + '</button>'; }).join('') + '<input type="date" id="r_f" value="' + RP.from + '"> ~ <input type="date" id="r_t" value="' + RP.to + '">' +
      '<select id="r_c"><option value="">분류: 전체</option>' + cats.map(function (c) { return '<option' + (RP.cat === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select><select id="r_d"><option value="">부서: 전체</option>' + depts.map(function (c) { return '<option' + (RP.dept === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select><button class="btn pri" id="r_go" type="button">조회</button></div>' +
      (err ? '<div class="note" style="color:#c42b1c;margin:8px 0">' + esc(err) + '</div>' : '') +
      '<div class="rcols"><div class="card" style="min-width:300px"><b>변동 유형별 건수</b> <span class="note">' + RP.from + ' ~ ' + RP.to + ' · 총 ' + lines.length + '건</span>' + bars + '</div><div class="rtb"><div style="font-weight:600;margin-bottom:4px">변동 내역 (최근순 · 최대 200건 표시)</div><table class="tbl"><thead><tr><th>일시</th><th>관리번호</th><th>구분</th><th>내용</th><th>처리자</th></tr></thead><tbody>' +
      (lines.slice(0, 200).map(function (l) { return '<tr><td>' + esc(ymd(l.at).slice(5)) + ' ' + esc(hm(l.at)) + '</td><td class="mono">' + (l.no ? '<a href="#/asset/' + encodeURIComponent(l.no) + '">' + esc(l.no) + '</a>' : '') + '</td><td>' + esc(l.type) + '</td><td>' + esc(l.text) + '</td><td>' + esc(l.who) + '</td></tr>'; }).join('') || '<tr><td colspan="5" class="note" style="text-align:center;padding:16px">해당 기간에 변동이 없습니다.</td></tr>') + '</tbody></table></div></div>');
    $$('[data-q]').forEach(function (b) { b.onclick = function () { periodSet(b.dataset.q); repPeriod(); }; });
    $('#r_go').onclick = function () { RP.from = $('#r_f').value || RP.from; RP.to = $('#r_t').value || RP.to; RP.q = 'custom'; RP.cat = $('#r_c').value; RP.dept = $('#r_d').value; repPeriod(); };
    $('#r_c').onchange = $('#r_go').onclick; $('#r_d').onchange = $('#r_go').onclick;
    repBind('기간별 자산 변동', function () { repXlsx('기간별자산변동_' + RP.from + '_' + RP.to, [{ name: '요약', rows: TYPES.map(function (t) { return { '구분': t[0], '건수': cnt[t[0]] || 0 }; }) }, { name: '변동 내역', rows: lines.map(function (l) { return { '일시': ymd(l.at) + ' ' + hm(l.at), '관리번호': l.no, '구분': l.type, '내용': l.text, '처리자': l.who }; }) }], '기간별 자산 변동'); });
  }
  // ---- 부서별 자산 보유
  function repDept() {
    var g = {}; repCoFilter(liveAssets()).forEach(function (a) { var d = a.dept || '(소속 없음)', o = g[d] = g[d] || { dept: d, PC: 0, 노트북: 0, 모니터: 0, 기타: 0, users: {} }; o[catGroup(a.category)]++; if (a.user_name) o.users[a.user_name] = 1; });
    var list = Object.keys(g).map(function (k) { var o = g[k]; o.total = o.PC + o.노트북 + o.모니터 + o.기타; o.n = Object.keys(o.users).length; o.per = o.n ? o.total / o.n : 0; return o; }).sort(function (a, b) { return b.total - a.total; });
    var tot = { PC: 0, 노트북: 0, 모니터: 0, 기타: 0, total: 0 }; list.forEach(function (o) { CGRP.forEach(function (c) { tot[c] += o[c]; }); tot.total += o.total; });
    shell('reports', repHead('부서별 자산 보유', '', '현재 자산 대장 기준(폐기 제외)' + (REP_CO ? ' · 회사: ' + esc(REP_CO) : '')) + '<div class="kpis">' + [kp('부서 수', list.length, ''), kp('전체 장비', tot.total.toLocaleString(), 'PC ' + tot.PC.toLocaleString() + ' · 노트북 ' + tot['노트북'].toLocaleString() + ' · 모니터 ' + tot['모니터'].toLocaleString())].join('') + '</div>' +
      '<table class="tbl ctr" style="margin-top:8px"><thead><tr><th>소속</th><th>PC</th><th>노트북</th><th>모니터</th><th>기타</th><th>합계</th><th>사용 인원</th><th>1인당 장비</th></tr></thead><tbody>' +
      list.map(function (o) { return '<tr><td style="text-align:left">' + esc(o.dept) + '</td><td>' + o.PC + '</td><td>' + o['노트북'] + '</td><td>' + o['모니터'] + '</td><td>' + o['기타'] + '</td><td><b>' + o.total + '</b></td><td>' + o.n + '</td><td' + (o.per >= 3.5 ? ' style="color:#c42b1c;font-weight:600"' : o.per > 0 && o.per < 1 ? ' style="color:#a15c00;font-weight:600"' : '') + '>' + (o.n ? o.per.toFixed(1) : '—') + '</td></tr>'; }).join('') + '</tbody></table>' +
      '<div class="note" style="margin-top:8px">· 1인당 장비가 3.5대 이상이면 빨강(과다 의심), 1대 미만이면 주황(부족 의심)으로 표시합니다. 사용 인원은 사용자명이 있는 서로 다른 사람 수입니다.</div>');
    repBind('부서별 자산 보유', function () { repXlsx('부서별자산보유', [{ name: '부서별', rows: list.map(function (o) { return { '소속': o.dept, 'PC': o.PC, '노트북': o['노트북'], '모니터': o['모니터'], '기타': o['기타'], '합계': o.total, '사용 인원': o.n, '1인당 장비': o.n ? Number(o.per.toFixed(1)) : '' }; }) }], '부서별 자산 보유'); });
  }
  // ---- 보증 만료 예정
  var RW = { b: 'all', cat: '' };
  function repWarranty() {
    var now = new Date(), td = ymd(now), add = function (mo) { var d = new Date(now.getFullYear(), now.getMonth() + mo, now.getDate()); return ymd(d); };
    var lim = { m1: add(1), m3: add(3), m6: add(6), m12: add(12) }, items = liveAssets().filter(function (a) { return a.warr_end; });
    function bucket(a) { var d = a.warr_end; return d < td ? 'exp' : d <= lim.m1 ? 'm1' : d <= lim.m3 ? 'm3' : d <= lim.m6 ? 'm6' : d <= lim.m12 ? 'm12' : 'ok'; }
    var cnt = { exp: 0, m1: 0, m3: 0, m6: 0, m12: 0 }; items.forEach(function (a) { var b = bucket(a); if (cnt[b] != null) cnt[b]++; });
    var BL = { exp: ['이미 만료', 'b-bad'], m1: ['1개월 이내', 'b-warn'], m3: ['3개월 이내', 'b-warn'], m6: ['6개월 이내', 'b-blue'], m12: ['12개월 이내', 'b-gray'] };
    var list = items.filter(function (a) { var b = bucket(a); return b !== 'ok' && (RW.b === 'all' || b === RW.b) && (!RW.cat || a.category === RW.cat); }).sort(function (a, b) { return a.warr_end < b.warr_end ? -1 : 1; });
    var cats = groupCount(S.assets, function (a) { return a.category; }).map(function (x) { return x[0]; });
    shell('reports', repHead('보증 만료 예정', '', '보증 만료일(없으면 제조년월+5년) 기준') + '<div class="kpis">' + [kp('이미 만료', cnt.exp.toLocaleString(), '교체·연장 검토', '#c42b1c'), kp('1개월 이내', cnt.m1, ''), kp('3개월 이내', cnt.m3, ''), kp('6개월 이내', cnt.m6, ''), kp('12개월 이내', cnt.m12, '교체 예산 산정')].join('') + '</div>' +
      '<div class="row wrap noprint" style="margin:8px 0"><select id="r_b">' + [['all', '전체 (만료 포함 12개월 이내)'], ['exp', '이미 만료'], ['m1', '1개월 이내'], ['m3', '3개월 이내'], ['m6', '6개월 이내'], ['m12', '12개월 이내']].map(function (o) { return '<option value="' + o[0] + '"' + (RW.b === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select><select id="r_c"><option value="">분류: 전체</option>' + cats.map(function (c) { return '<option' + (RW.cat === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select><span class="note">' + list.length.toLocaleString() + '건</span></div>' +
      '<table class="tbl"><thead><tr><th>관리번호</th><th>분류</th><th>모델</th><th>사용자 · 부서</th><th>보증 만료</th><th>남은 기간</th></tr></thead><tbody>' + (list.slice(0, 300).map(function (a) { var b = bucket(a); return '<tr><td class="mono"><a href="#/asset/' + encodeURIComponent(a.asset_no) + '">' + esc(a.asset_no) + '</a></td><td>' + esc(a.category || '') + '</td><td>' + esc((a.manufacturer || '') + ' ' + (a.model || '')) + '</td><td>' + esc((a.user_name || '') + (a.dept ? ' · ' + a.dept : '')) + '</td><td>' + esc(a.warr_end) + (a.warr_calc ? ' <span class="note">계산</span>' : '') + '</td><td>' + badge(BL[b][0], BL[b][1].replace('b-', '')) + '</td></tr>'; }).join('') || '<tr><td colspan="6" class="note" style="text-align:center;padding:16px">해당하는 장비가 없습니다.</td></tr>') + '</tbody></table>' + (list.length > 300 ? '<div class="note">화면에는 300건까지 보이고, 엑셀에는 모두 들어갑니다.</div>' : ''));
    $('#r_b').onchange = function () { RW.b = this.value; repWarranty(); }; $('#r_c').onchange = function () { RW.cat = this.value; repWarranty(); };
    repBind('보증 만료 예정', function () { repXlsx('보증만료예정', [{ name: '요약', rows: Object.keys(BL).map(function (k) { return { '구분': BL[k][0], '건수': cnt[k] }; }) }, { name: '목록', rows: list.map(function (a) { return { '관리번호': a.asset_no, '분류': a.category, '제조사': a.manufacturer, '모델명': a.model, '사용자': a.user_name, '소속': a.dept, '보증 만료': a.warr_end, '구분': BL[bucket(a)][0] }; }) }], '보증 만료 예정'); });
  }
  // ---- 현황 점검 보고
  async function repCheck() {
    var snaps; try { snaps = await repSnaps(); } catch (e) { snaps = []; }
    var cur = pcStats(), rows = monthRows(snaps, new Date().getFullYear()).filter(function (r) { return r.pc; });
    shell('reports', repHead('현황 점검 보고', '', 'PC·노트북 프로그램 점검 현황') + '<div class="kpis">' + [kp('점검 대상 PC', cur.total.toLocaleString(), '폐기 제외'), kp('오늘 확인', cur.today.toLocaleString(), '수집률 ' + (cur.total ? Math.round(cur.today / cur.total * 100) : 0) + '%', '#1e8e3e'), kp('7일 이상 미확인', cur.stale.toLocaleString(), '휴가·퇴사·고장 확인', '#c42b1c'), kp('미수집 PC', cur.none.toLocaleString(), '프로그램 실행 이력 없음', '#a15c00'), kp('사용자 불일치', cur.mismatch.toLocaleString(), '대장 정리 필요')].join('') + '</div>' +
      '<h3 style="margin:12px 0 6px">월별 추이 <span class="note">월말 저장값 기준</span></h3><table class="tbl ctr"><thead><tr><th>월말 기준</th><th>대상 PC</th><th>오늘 확인</th><th>수집률</th><th>7일 이상 미확인</th><th>미수집</th><th>사용자 불일치</th></tr></thead><tbody>' +
      (rows.slice().reverse().map(function (r) { var p = r.pc; return '<tr><td>' + r.label + '</td><td>' + p.total + '</td><td>' + p.today + '</td><td>' + (p.total ? Math.round(p.today / p.total * 100) : 0) + '%</td><td>' + p.stale + '</td><td>' + p.none + '</td><td>' + p.mismatch + '</td></tr>'; }).join('') || '<tr><td colspan="7" class="note" style="text-align:center;padding:16px">아직 저장된 월별 값이 없습니다. 관리자가 접속하면 하루 1번 자동으로 저장됩니다.</td></tr>') + '</tbody></table>');
    repBind('현황 점검 보고', function () { repXlsx('현황점검보고', [{ name: '현재', rows: [{ '점검 대상 PC': cur.total, '오늘 확인': cur.today, '7일 이상 미확인': cur.stale, '미수집': cur.none, '사용자 불일치': cur.mismatch }] }, { name: '월별 추이', rows: rows.map(function (r) { return { '월말 기준': r.label, '대상 PC': r.pc.total, '오늘 확인': r.pc.today, '7일 이상 미확인': r.pc.stale, '미수집': r.pc.none, '사용자 불일치': r.pc.mismatch }; }) }], '현황 점검 보고'); });
  }
  // ---- 원격 지원 처리 현황
  function repSupport() {
    var L = S.support || [], now = new Date(), months = [];
    for (var i = 11; i >= 0; i--) { var d = new Date(now.getFullYear(), now.getMonth() - i, 1); months.push(d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2)); }
    var rows = months.map(function (mo) {
      var ms = L.filter(function (x) { return ymd(x.created_at).slice(0, 7) === mo; }), dn = ms.filter(function (x) { return x.status === 'done'; }), mins = dn.map(function (x) { return (new Date(x.updated_at) - new Date(x.created_at)) / 60000; }).filter(function (v) { return v >= 0; });
      return { mo: mo, rec: ms.length, done: dn.length, wk: ms.length - dn.length, avg: mins.length ? Math.round(mins.reduce(function (a, b) { return a + b; }, 0) / mins.length) : null };
    }).reverse();
    var cur = rows[0], sym = {}; L.filter(function (x) { return ymd(x.created_at).slice(0, 7) === months[11]; }).forEach(function (x) { var k = (x.symptom || '(증상 없음)').trim().slice(0, 20); sym[k] = (sym[k] || 0) + 1; });
    var top = Object.keys(sym).sort(function (a, b) { return sym[b] - sym[a]; }).slice(0, 5), hd = {}; L.forEach(function (x) { var k = x.handler || '(담당 미지정)'; hd[k] = hd[k] || { n: 0, d: 0 }; hd[k].n++; if (x.status === 'done') hd[k].d++; });
    var avgTxt = function (v) { return v == null ? '—' : v >= 60 ? Math.floor(v / 60) + '시간 ' + (v % 60) + '분' : v + '분'; };
    shell('reports', repHead('원격 지원 처리 현황', '', '최근 12개월 · 최근 300건 기준') + '<div class="kpis">' + [kp(cur.mo.slice(5) + '월 접수', cur.rec, ''), kp('완료', cur.done, '', '#1e8e3e'), kp('진행·대기', cur.wk, '', '#a15c00'), kp('평균 처리 시간', avgTxt(cur.avg), '접수 → 완료')].join('') + '</div>' +
      '<div class="rcols"><div class="rtb"><table class="tbl ctr"><thead><tr><th>월</th><th>접수</th><th>완료</th><th>진행·대기</th><th>평균 처리</th></tr></thead><tbody>' + rows.map(function (r) { return '<tr><td>' + r.mo + '</td><td>' + r.rec + '</td><td>' + r.done + '</td><td>' + r.wk + '</td><td>' + avgTxt(r.avg) + '</td></tr>'; }).join('') + '</tbody></table></div>' +
      '<div class="card" style="min-width:300px"><b>이번 달 상위 증상</b>' + (top.map(function (k) { return '<div class="prow"><span class="pn" style="width:150px">' + esc(k) + '</span><span class="pb"><i style="width:' + Math.round(sym[k] / sym[top[0]] * 100) + '%;background:#0f6cbd"></i></span><span class="pv">' + sym[k] + '</span></div>'; }).join('') || '<div class="note">접수가 없습니다.</div>') + '<b style="display:block;margin-top:12px">담당자별</b>' + Object.keys(hd).map(function (k) { return '<div class="note" style="line-height:1.8">' + esc(k) + ' · 접수 ' + hd[k].n + ' · 완료 ' + hd[k].d + '</div>'; }).join('') + '</div></div>');
    repBind('원격 지원 처리 현황', function () { repXlsx('원격지원처리현황', [{ name: '월별', rows: rows.map(function (r) { return { '월': r.mo, '접수': r.rec, '완료': r.done, '진행·대기': r.wk, '평균 처리(분)': r.avg == null ? '' : r.avg }; }) }, { name: '접수 내역', rows: L.map(function (x) { return { '접수번호': x.req_no, '접수 시각': ymd(x.created_at) + ' ' + hm(x.created_at), '컴퓨터 이름': x.computer_name, '자산': x.asset_no, '증상': x.symptom, '상태': { received: '접수', working: '진행중', done: '완료' }[x.status] || x.status, '담당': x.handler, '처리 메모': x.note }; }) }], '원격 지원 처리 현황'); });
  }
  // ---- 실사 결과 보고서
  var RI = { id: '' };
  async function repInv() {
    var invs; try { invs = await invList(); } catch (e) { shell('reports', repHead('실사 결과 보고서') + '<div class="note" style="color:#c42b1c">' + esc(e.message || e) + '</div>'); return; }
    if (!invs.length) { shell('reports', repHead('실사 결과 보고서') + '<div class="note" style="margin-top:10px">아직 만든 실사가 없습니다.</div>'); repBind('실사 결과 보고서', function () { }); return; }
    var inv = invs.filter(function (x) { return String(x.id) === String(RI.id); })[0] || invs[0]; RI.id = inv.id;
    var items = await invItems(inv.id), st = invStats(items);
    function grp(key) { var g = {}; items.forEach(function (i) { var k = i[key] || '(없음)', o = g[k] = g[k] || { k: k, n: 0, d: 0, p: 0, a: 0 }; o.n++; if (invDone(i)) o.d++; else if (i.result === 'abnormal') o.a++; else o.p++; }); return Object.keys(g).map(function (k) { return g[k]; }).sort(function (a, b) { return b.n - a.n; }); }
    var gd = grp('dept'), gc = grp('category'), gt = function (L) { return '<table class="tbl ctr"><thead><tr><th>구분</th><th>대상</th><th>확인</th><th>미확인</th><th>이상</th><th>진행률</th></tr></thead><tbody>' + L.slice(0, 15).map(function (o) { return '<tr><td style="text-align:left">' + esc(o.k) + '</td><td>' + o.n + '</td><td>' + o.d + '</td><td>' + o.p + '</td><td>' + o.a + '</td><td>' + Math.round(o.d / o.n * 100) + '%</td></tr>'; }).join('') + '</tbody></table>'; };
    var bad = items.filter(function (i) { return !invDone(i); });
    shell('reports', repHead('실사 결과 보고서', '<select id="r_i" class="noprint">' + invs.map(function (x) { return '<option value="' + x.id + '"' + (x.id === inv.id ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('') + '</select>', esc((inv.start_date || '') + ' ~ ' + (inv.end_date || '')) + ' · ' + (inv.status === 'open' ? '진행 중' : '마감')) +
      '<div class="kpis">' + [kp('대상', st.total.toLocaleString(), ''), kp('확인 완료', (st.auto + st.scan).toLocaleString(), st.pct + '% (자동 ' + st.auto + ' · 현장 ' + st.scan + ')', '#1e8e3e'), kp('미확인', st.pending.toLocaleString(), '', '#a15c00'), kp('이상', st.abnormal.toLocaleString(), '', '#c42b1c')].join('') + '</div>' +
      '<div class="rcols"><div class="rtb"><h3>부서별</h3>' + gt(gd) + '</div><div class="rtb"><h3>분류별</h3>' + gt(gc) + '</div></div>' +
      '<h3 style="margin:12px 0 6px">미확인·이상 목록 <span class="note">' + bad.length.toLocaleString() + '건 (화면에는 50건까지)</span></h3><table class="tbl"><thead><tr><th>관리번호</th><th>분류</th><th>사용자 · 부서</th><th>상태</th><th>처리</th></tr></thead><tbody>' + (bad.slice(0, 50).map(function (i) { return '<tr><td class="mono">' + esc(i.asset_no) + '</td><td>' + esc(i.category || '') + '</td><td>' + esc((i.user_name || '') + (i.dept ? ' · ' + i.dept : '')) + '</td><td>' + (i.result === 'abnormal' ? esc(i.abn_type || '이상') : '미확인') + '</td><td>' + esc(i.resolution ? (RES_L[i.resolution] || i.resolution) + (i.resolved_note ? ' · ' + i.resolved_note : '') : '') + '</td></tr>'; }).join('') || '<tr><td colspan="5" class="note" style="text-align:center;padding:14px">없습니다.</td></tr>') + '</tbody></table>');
    $('#r_i').onchange = function () { RI.id = this.value; repInv(); };
    repBind('실사 결과 보고서', function () { var RL = { auto: '자동 확인', ok: '현장 확인', pending: '미확인', abnormal: '이상' }; repXlsx('실사결과보고_' + inv.name.replace(/[\\/:*?"<>|\s]/g, ''), [{ name: '요약', rows: [{ '실사': inv.name, '대상': st.total, '확인': st.auto + st.scan, '미확인': st.pending, '이상': st.abnormal, '진행률(%)': st.pct }] }, { name: '부서별', rows: gd.map(function (o) { return { '부서': o.k, '대상': o.n, '확인': o.d, '미확인': o.p, '이상': o.a }; }) }, { name: '분류별', rows: gc.map(function (o) { return { '분류': o.k, '대상': o.n, '확인': o.d, '미확인': o.p, '이상': o.a }; }) }, { name: '미확인·이상', rows: bad.map(function (i) { return { '관리번호': i.asset_no, '분류': i.category, '부서': i.dept, '사용자': i.user_name, '결과': RL[i.result] || i.result, '이상 유형': i.abn_type || '', '처리': i.resolution ? RES_L[i.resolution] || i.resolution : '', '처리 사유': i.resolved_note || '' }; }) }], '실사 결과 보고서'); });
  }
  // ---- 이력 관리 요약 (메인 관리자)
  var RA = { from: '', to: '' };
  async function repAudit() {
    if (!isMain()) { shell('reports', '<h1>이력 관리 요약</h1><div class="note" style="margin-top:8px">메인 관리자만 볼 수 있습니다.</div>'); return; }
    if (!RA.from) { RA.from = ymd(new Date(new Date().getFullYear(), new Date().getMonth(), 1)); RA.to = ymd(new Date()); }
    var rows = [], err = '';
    try {
      if (DEMO) rows = (S.audit = S.audit || demoAudit()).filter(function (r) { return ymd(r.at) >= RA.from && ymd(r.at) <= RA.to; });
      else for (var from = 0; from < 20000; from += 1000) { var r = await sb.from('audit_log').select('action,actor_name,actor_sabun,at').gte('at', RA.from + 'T00:00:00+09:00').lte('at', RA.to + 'T23:59:59+09:00').order('at', { ascending: false }).range(from, from + 999); if (r.error) throw r.error; rows = rows.concat(r.data); if (r.data.length < 1000) break; }
    } catch (e) { err = e.message || String(e); }
    var byA = {}, byU = {}; rows.forEach(function (r) { byA[r.action] = (byA[r.action] || 0) + 1; var k = (r.actor_name || '알 수 없음') + ' ' + (r.actor_sabun || ''); var o = byU[k] = byU[k] || { k: k, n: 0 }; o.n++; o[r.action] = (o[r.action] || 0) + 1; });
    var acts = Object.keys(byA).sort(function (a, b) { return byA[b] - byA[a]; }), us = Object.keys(byU).map(function (k) { return byU[k]; }).sort(function (a, b) { return b.n - a.n; });
    shell('reports', repHead('이력 관리 요약', '<input type="date" id="r_f" value="' + RA.from + '" class="noprint"> ~ <input type="date" id="r_t" value="' + RA.to + '" class="noprint"><button class="btn noprint" id="r_go" type="button">조회</button>', '메인 관리자 전용 · 감사 제출용') + (err ? '<div class="note" style="color:#c42b1c">' + esc(err) + '</div>' : '') +
      '<div class="kpis">' + [kp('전체 기록', rows.length.toLocaleString(), RA.from + ' ~ ' + RA.to)].concat(['login', 'create', 'update', 'delete', 'export'].map(function (a) { return kp(ACT_L[a], (byA[a] || 0).toLocaleString(), '', a === 'delete' ? '#c42b1c' : ''); })).join('') + '</div>' +
      '<div class="rcols"><div class="rtb"><h3>작업 유형별</h3><table class="tbl ctr"><thead><tr><th>유형</th><th>건수</th></tr></thead><tbody>' + acts.map(function (a) { return '<tr><td>' + actBadge(a) + '</td><td>' + byA[a].toLocaleString() + '</td></tr>'; }).join('') + '</tbody></table></div><div class="rtb"><h3>작업자별 (상위 20명)</h3><table class="tbl ctr"><thead><tr><th>작업자</th><th>전체</th><th>로그인</th><th>변경·수정·생성</th><th>삭제</th><th>내보내기</th></tr></thead><tbody>' + us.slice(0, 20).map(function (o) { return '<tr><td style="text-align:left">' + esc(o.k) + '</td><td>' + o.n + '</td><td>' + (o.login || 0) + '</td><td>' + ((o.change || 0) + (o.update || 0) + (o.create || 0)) + '</td><td>' + (o['delete'] || 0) + '</td><td>' + (o['export'] || 0) + '</td></tr>'; }).join('') + '</tbody></table></div></div>');
    $('#r_go').onclick = function () { RA.from = $('#r_f').value || RA.from; RA.to = $('#r_t').value || RA.to; repAudit(); };
    repBind('이력 관리 요약', function () { repXlsx('이력관리요약_' + RA.from + '_' + RA.to, [{ name: '작업 유형별', rows: acts.map(function (a) { return { '유형': ACT_L[a] || a, '건수': byA[a] }; }) }, { name: '작업자별', rows: us.map(function (o) { return { '작업자': o.k, '전체': o.n, '로그인': o.login || 0, '변경·수정·생성': (o.change || 0) + (o.update || 0) + (o.create || 0), '삭제': o['delete'] || 0, '내보내기': o['export'] || 0 }; }) }], '이력 관리 요약'); });
  }

  function route() {

    scanStop(); $$('.scanov').forEach(function (m) { m.remove(); });
    $$('.mdl').forEach(function (m) { m.remove(); });   // 화면을 옮기면 열려 있던 창(QR 출력 등)을 닫음
    var h = (location.hash || '#/dashboard').replace(/^#\//, '').split('/'), p = h[0], arg = h.slice(1).join('/');
    try {
      if (p === 'assets') pageAssets();
      else if (p === 'company') pageCompany(arg);
      else if (p === 'asset-new') pageAssetNew();
      else if (p === 'asset') pageDetail(decodeURIComponent(arg));
      else if (p === 'check') pageCheck(arg);
      else if (p === 'support') pageSupport(arg);
      else if (p === 'employees') pageEmployees(arg);
      else if (p === 'admins') pageAdmins();
      else if (p === 'reports') pageReports(arg);
      else if (p === 'security') pageSecurity();
      else if (p === 'audit') pageAudit();
      else if (p === 'inventory') { var iv = arg.split('/')[0]; if (iv) pageInvDetail(iv); else pageInventory(); }
      else if (p === 'inv-scan') pageInvScan(arg);
      else if (p === 'scan') pageScan(arg);
      else if (p === 'data' || p === 'import') pageData();
      else pageDashboard();
    } catch (e) { fail(e); }
  }
  // ---------- 지원 요청 자동 확인 (v1.9.2: 1분마다, 새 요청이면 메뉴 숫자·알림) ----------
  var supSeen = {};
  function supBadge() {
    var n = S.support.filter(function (x) { return x.status === 'received'; }).length, a = $('.nav a[href="#/support"]');
    document.title = (n ? '(' + n + ') ' : '') + 'IT 자산관리시스템';
    if (!a) return; var c = $('.cnt', a); if (c) c.remove();
    if (n) { c = document.createElement('span'); c.className = 'cnt'; c.textContent = n; a.appendChild(c); }
  }
  function notice(html, href) {
    var d = document.createElement('div'); d.className = 'notice'; d.innerHTML = html; d.onclick = function () { d.remove(); if (href) location.hash = href; };
    document.body.appendChild(d); setTimeout(function () { d.remove(); }, 9000);
  }
  function startSupportPoll() {
    S.support.forEach(function (x) { supSeen[x.id] = 1; }); supBadge();
    setInterval(async function () {
      try {
        var r = await sb.from('support_requests').select('*').order('created_at', { ascending: false }).limit(300);
        if (r.error) return;
        var fresh = r.data.filter(function (x) { return !supSeen[x.id]; });
        S.support = r.data; r.data.forEach(function (x) { supSeen[x.id] = 1; }); supBadge();
        if (!fresh.length) return;
        var f = fresh[0], e = S.empBy && S.empBy[f.emp_no];
        notice('<b>새 지원 요청 ' + fresh.length + '건</b><br>' + esc((e ? e.name + ' / ' : '') + (f.computer_name || '')) + '<div class="nsub">' + esc(f.symptom || '증상 입력 없음') + '</div>', '#/support');
        var ed = document.activeElement && document.activeElement.tagName === 'TEXTAREA';
        if (!ed && (!location.hash || /^#\/(support|dashboard)(\/|$)/.test(location.hash))) route();
      } catch (er) { /* 다음 주기에 다시 */ }
    }, 60000);
  }
  async function start() {
    try {
      if (!DEMO) {
        var s = await sb.auth.getSession();
        if (!s.data.session) { pageLogin(); return; }
        S.user = s.data.session.user;
        var adm = await sb.from('admin_users').select('user_id,sabun,role,active,name,dept').eq('user_id', S.user.id).maybeSingle();
        if (adm.error) { adm = await sb.from('admin_users').select('user_id').eq('user_id', S.user.id).maybeSingle(); if (adm.data) { adm.data.role = 'main'; adm.data.active = true; } }   // v1.9.4 SQL 실행 전에도 기존 관리자는 동작
        S.me = adm.data || null;
        if (!adm.data) { await sb.auth.signOut(); pageLogin('관리자 권한이 없는 계정입니다. 메인 관리자에게 등록을 요청하세요.'); return; }
        if (adm.data.active === false) { await sb.auth.signOut(); pageLogin('사용이 중지된 계정입니다. 전산지원파트로 문의하세요.'); return; }
        if (!adm.data.role) adm.data.role = 'admin';
      }
      if (DEMO) S.me = { sabun: '99999012', role: params.get('role') || 'main', name: '배병욱', dept: '전산지원파트', title: '파트장' };
      $app.innerHTML = '<div style="padding:40px;text-align:center;color:#5c5c5c">불러오는 중…</div>';
      await loadAll();
      window.addEventListener('hashchange', route); route();
      if (!DEMO) { startSupportPoll(); startIdleTimer(); }
    } catch (e) { $app.innerHTML = '<div style="padding:40px"><h1>오류</h1><p class="err">' + esc(e.message || e) + '</p><p class="note">config.js 의 주소와 키, DB 구조(schema.sql) 실행 여부를 확인하세요.</p></div>'; console.error(e); }
  }
  // ---------- v1.9.11: 자동 로그아웃 (30분 미조작) ----------
  var IDLE_WARN_MS = 25 * 60 * 1000, IDLE_OUT_MS = 30 * 60 * 1000;
  var idleWarnT = null, idleOutT = null, idleToastEl = null, idleLast = 0;
  function idleClearToast() { if (idleToastEl) { idleToastEl.remove(); idleToastEl = null; } }
  function idleShowWarn() {
    idleToastEl = document.createElement('div'); idleToastEl.className = 'notice'; idleToastEl.style.background = '#2a2f38'; idleToastEl.style.color = '#fff';
    idleToastEl.innerHTML = '<b>5분 후 자동 로그아웃됩니다</b><div class="nsub" style="color:#d8dde3">화면을 움직이거나 아무 키나 누르면 계속 사용할 수 있습니다.</div>';
    idleToastEl.onclick = function () { idleResetTimer(); };
    document.body.appendChild(idleToastEl);
  }
  async function idleDoLogout() {
    idleClearToast(); clearTimeout(idleWarnT); clearTimeout(idleOutT);
    try { await sb.auth.signOut(); } catch (e) { /* 무시 */ }
    pageLogin('장시간 조작이 없어 자동 로그아웃되었습니다. 다시 로그인해 주세요.');
  }
  function idleResetTimer() {
    if (!S.me) return;
    idleClearToast(); clearTimeout(idleWarnT); clearTimeout(idleOutT);
    idleWarnT = setTimeout(idleShowWarn, IDLE_WARN_MS);
    idleOutT = setTimeout(idleDoLogout, IDLE_OUT_MS);
  }
  function idleOnActivity() {
    var now = Date.now(); if (now - idleLast < 5000) return; idleLast = now;   // 너무 자주 재설정하지 않도록 5초 간격으로만 처리
    idleResetTimer();
  }
  function startIdleTimer() {
    ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach(function (ev) { document.addEventListener(ev, idleOnActivity, { passive: true }); });
    idleResetTimer();
  }
  start();
  // v1.9.11: 다른 사이트에 갔다가 뒤로가기로 돌아오면(브라우저 캐시 복원) 세션이 남아 있어도 무조건 다시 로그인하도록 함
  window.addEventListener('pageshow', function (e) {
    if (e.persisted && !DEMO) { sb.auth.signOut().catch(function () { }).then(function () { location.reload(); }); }
  });
})();
