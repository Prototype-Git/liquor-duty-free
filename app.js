// 주류 면세 체크 — 계산 로직과 화면 렌더링

const CURRENCIES = ['KRW', 'USD', 'JPY', 'EUR', 'CNY', 'TWD', 'HKD', 'VND', 'THB', 'SGD', 'AUD', 'GBP', 'IDR', 'PHP'];
// 네트워크와 캐시가 모두 없을 때만 쓰는 근사치 (USD 기준, 2026-10-27)
const FALLBACK_RATES = { USD: 1, KRW: 1325.19, JPY: 157.44, EUR: 0.894, CNY: 6.684, TWD: 32.59, HKD: 7.845, VND: 25831.5, THB: 33.79, SGD: 1.281, AUD: 1.425, GBP: 0.749, IDR: 18148.8, PHP: 63.96 };
const STORE_KEY = 'liquor-duty-free:v1';
const RATE_KEY = 'liquor-duty-free:rates';
const SELF_DECLARE_CAP = 200000;

const state = {
  mode: 'out',            // out: 한국→해외, in: 해외→한국
  dest: 'JP',
  travelers: [{ name: '나', age: 30 }],
  items: [],
};
let rates = { values: FALLBACK_RATES, source: 'fallback', updatedAt: null };

/* ---------- 저장 ---------- */
function safeGet(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function safeSet(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* 저장 불가 환경 */ } }

/* ---------- 환율 ---------- */
async function loadRates() {
  const cached = safeGet(RATE_KEY);
  if (cached && cached.values) rates = { ...cached, source: 'cache' };
  renderRateStatus('loading');
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD', { cache: 'no-store' });
    const j = await r.json();
    if (j.result !== 'success') throw new Error('rate api');
    rates = { values: j.rates, source: 'ExchangeRate-API', updatedAt: j.time_last_update_unix * 1000 };
  } catch {
    try {
      const r = await fetch('https://api.frankfurter.dev/v1/latest?base=USD', { cache: 'no-store' });
      const j = await r.json();
      rates = { values: { USD: 1, ...FALLBACK_RATES, ...j.rates }, source: 'Frankfurter(ECB)', updatedAt: Date.parse(j.date) };
    } catch {
      renderRateStatus('offline');
      recompute();
      return;
    }
  }
  safeSet(RATE_KEY, rates);
  renderRateStatus('ok');
  recompute();
}

function krwPerUsd() {
  return rates.values.KRW;
}
function toUsd(amount, cur) {
  if (cur === 'KRW') return amount / krwPerUsd();
  const r = rates.values[cur] || FALLBACK_RATES[cur];
  return amount / r;
}
function fromUsd(usd, cur) {
  if (cur === 'KRW') return usd * krwPerUsd();
  return usd * (rates.values[cur] || FALLBACK_RATES[cur]);
}

/* ---------- 규칙 평가 ---------- */
function unitAmount(b, unit) {
  return unit === 'ml' ? b.ml : unit === 'usd' ? b.usd : 1;
}

// 한 사람이 가진 병들(bottles)이 면세 한도 안인지와 사용률
function evalRule(rule, bottles) {
  let best = null;
  for (const option of rule.options) {
    const pools = option.map(pool => {
      let frac = 0;
      const used = pool.components.map(() => 0);
      for (const b of bottles) {
        const i = pool.components.findIndex(c => c.match(b));
        if (i >= 0) used[i] += unitAmount(b, pool.components[i].unit);
      }
      pool.components.forEach((c, i) => { frac += used[i] / c.limit; });
      return { label: pool.label, frac, used, components: pool.components };
    });
    const maxFrac = Math.max(0, ...pools.map(p => p.frac));
    if (!best || maxFrac < best.maxFrac) best = { pools, maxFrac };
  }
  best.ok = best.maxFrac <= 1 + 1e-9 && !bottles.some(b => rule.perBottleMaxMl && b.ml > rule.perBottleMaxMl);
  return best;
}

function airlineLimitedMl(bottles) {
  return bottles.reduce((s, b) => s + (b.abv > AIRLINE.limitedAbvOver && b.abv <= AIRLINE.bannedAbvOver ? b.ml : 0), 0);
}

/* ---------- 한국 세금 ---------- */
function krTax(b) {
  const t = LIQUOR_TYPES[b.type].kr;
  const v = b.usd * krwPerUsd();
  const duty = v * t.d;
  const liq = t.lPerL ? (b.ml / 1000) * t.lPerL : (v + duty) * t.l;
  const edu = liq * t.e;
  const vat = (v + duty + liq + edu) * 0.1;
  return { duty, total: duty + liq + edu + vat, estimate: !!t.estimate };
}

function jpTax(rule, b) {
  const perL = rule.jpTaxPerL[b.type] ?? rule.jpTaxDefault;
  return (b.ml / 1000) * perL;
}

/* ---------- 배분 ---------- */
// 병을 성인들에게 나눠 면세 효과를 최대화. 항공 한도(24~70% 5L/인)는 넘기지 않는다.
function allocate(bottles, adultCount, rule, valueOf) {
  const orders = [
    [...bottles].sort((a, b) => valueOf(b) - valueOf(a)),
    [...bottles].sort((a, b) => b.ml - a.ml),
    [...bottles].sort((a, b) => b.usd - a.usd),
    [...bottles].sort((a, b) => valueOf(b) / b.ml - valueOf(a) / a.ml),
  ];
  const tries = bottles.length <= 60 ? 150 : 20;
  for (let i = 0; i < tries; i++) orders.push(shuffle([...bottles]));

  let best = null;
  for (const order of orders) {
    const people = Array.from({ length: adultCount }, () => ({ exempt: [], over: [] }));
    const over = [];
    for (const b of order) {
      let pick = null, pickUse = Infinity;
      for (const p of people) {
        const carried = [...p.exempt, ...p.over, b];
        if (airlineLimitedMl(carried) > AIRLINE.limitedMlPerPerson) continue;
        const ev = evalRule(rule, [...p.exempt, b]);
        if (!ev.ok) continue;
        const use = ev.maxFrac + p.exempt.length * 1e-6;
        if (use < pickUse) { pick = p; pickUse = use; }
      }
      if (pick) pick.exempt.push(b); else over.push(b);
    }
    let airlineFail = 0;
    for (const b of over) {
      let pick = null, load = Infinity;
      for (const p of people) {
        const carried = [...p.exempt, ...p.over, b];
        const ok = airlineLimitedMl(carried) <= AIRLINE.limitedMlPerPerson;
        const l = carried.reduce((s, x) => s + x.ml, 0) + (ok ? 0 : 1e9);
        if (l < load) { pick = p; load = l; }
      }
      if (!pick) continue;
      if (load >= 1e9) airlineFail++;
      pick.over.push(b);
    }
    const saved = people.reduce((s, p) => s + p.exempt.reduce((t, b) => t + valueOf(b), 0), 0);
    const spread = people.reduce((s, p) => s + Math.pow(evalRule(rule, p.exempt).maxFrac, 2), 0);
    const score = [airlineFail, -saved, over.length, spread];
    if (!best || lexLess(score, best.score)) best = { people, over, airlineFail, score };
  }
  return best;
}

function lexLess(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > 1e-9) return a[i] < b[i];
  }
  return false;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/* ---------- 전체 계산 ---------- */
function compute() {
  const destKey = state.mode === 'in' ? 'KR' : state.dest;
  const rule = DESTINATIONS[destKey];
  const bottles = [];
  const banned = [];
  const issues = [];
  state.travelers.forEach((t, i) => {
    if (t.age === '' || t.age == null || isNaN(+t.age)) issues.push(`${esc(t.name || `여행객 ${i + 1}`)}: 나이가 비어 있어 면세 대상에서 뺐어요.`);
  });
  state.items.forEach((it, idx) => {
    const qty = Math.max(0, Math.floor(+it.qty || 0));
    const ml = Math.max(0, +it.ml || 0), abv = Math.min(100, Math.max(0, +it.abv || 0)), price = Math.max(0, +it.price || 0);
    const name = it.name || LIQUOR_TYPES[it.type].label;
    if (!qty) return;
    if (!ml) { issues.push(`${esc(name)}: 용량이 비어 있어 계산에서 뺐어요.`); return; }
    if (!(+it.price > 0)) issues.push(`${esc(name)}: 가격이 비어 있어 0원으로 계산했어요. 금액 기준 판정이 틀릴 수 있어요.`);
    if (!(+it.abv > 0)) issues.push(`${esc(name)}: 도수가 비어 있어요.`);
    const usd = toUsd(price, it.currency);
    for (let i = 0; i < qty; i++) {
      const b = { id: `${idx}-${i}`, item: idx, c: it.c, label: name, type: it.type, ml, abv, usd, price, currency: it.currency };
      (abv > AIRLINE.bannedAbvOver ? banned : bottles).push(b);
    }
  });

  const travelers = state.travelers.map((t, i) => ({ ...t, idx: i, age: +t.age || 0 }));
  const adults = travelers.filter(t => t.age >= rule.minAge);
  const valueOf = destKey === 'KR' ? (b => krTax(b).total) : (b => b.ml + b.usd * 1e-3);
  // 신고할 병을 고를 때 줄이려는 값: 한국·일본은 예상 세금, 그 외는 신고 용량
  const costOf = destKey === 'KR' ? (b => krTax(b).total) : destKey === 'JP' ? (b => jpTax(rule, b)) : (b => b.ml);
  const alloc = allocate(bottles, adults.length, rule, valueOf);

  const people = adults.map((t, i) => {
    const p = alloc.people[i];
    const choice = chooseDeclared(rule, [...p.exempt, ...p.over], costOf);
    if (choice.best) { p.exempt = choice.best.keep; p.over = choice.best.declare; }
    const res = {
      traveler: t, exempt: p.exempt, over: p.over, options: choice.options,
      ev: evalRule(rule, p.exempt), carried: [...p.exempt, ...p.over],
      airlineMl: airlineLimitedMl([...p.exempt, ...p.over]),
    };
    if (destKey === 'KR' && p.over.length) res.tax = krPersonTax(p.over);
    if (destKey === 'JP' && p.over.length) res.jpYen = p.over.reduce((s, b) => s + jpTax(rule, b), 0);
    return res;
  });
  if (adults.length) alloc.over = people.flatMap(p => p.over);

  // 전부 면세가 되려면 성인이 몇 명 필요한지
  let needAdults = null;
  if (alloc.over.length && bottles.length) {
    for (let k = Math.max(1, adults.length + 1); k <= adults.length + 15; k++) {
      const a = allocateQuick(bottles, k, rule, valueOf);
      if (!a.over.length) { needAdults = k; break; }
    }
  }

  return { destKey, rule, bottles, banned, travelers, adults, minors: travelers.filter(t => t.age < rule.minAge && t.age > 0), people, alloc, needAdults, issues };
}

function krPersonTax(over) {
  const taxes = over.map(krTax);
  const total = taxes.reduce((s, t) => s + t.total, 0);
  const duty = taxes.reduce((s, t) => s + t.duty, 0);
  const relief = Math.min(duty * 0.3, SELF_DECLARE_CAP);
  return { total, declared: total - relief, caught: total * 1.4, estimate: taxes.some(t => t.estimate) };
}

// 한 사람이 든 병 중 어떤 걸 신고할지: 나머지가 면세 한도 안에 들어가는 조합 중 비용이 낮은 순
function chooseDeclared(rule, carried, costOf) {
  const n = carried.length;
  if (!n || n > 14 || evalRule(rule, carried).ok) return { best: null, options: [] };
  const seen = new Map();
  for (let mask = 1; mask < (1 << n); mask++) {
    const declare = [], keep = [];
    carried.forEach((b, i) => ((mask >> i) & 1 ? declare : keep).push(b));
    // 같은 술 조합은 한 번만 본다
    const sig = declare.map(b => b.item).sort((a, b) => a - b).join(',');
    if (seen.has(sig)) continue;
    if (!evalRule(rule, keep).ok) { seen.set(sig, null); continue; }
    seen.set(sig, { declare, keep, cost: declare.reduce((s, b) => s + costOf(b), 0) });
  }
  const options = [...seen.values()].filter(Boolean)
    // 더 적게 신고하는 조합에 포함되는(불필요하게 많이 신고하는) 조합은 뺀다
    .sort((a, b) => a.cost - b.cost || a.declare.length - b.declare.length);
  const minimal = options.filter(o => !options.some(x => x !== o && x.declare.length < o.declare.length && isSubBag(x.declare, o.declare)));
  return { best: minimal[0] || null, options: minimal.slice(0, 4) };
}

function isSubBag(small, big) {
  const cnt = new Map();
  big.forEach(b => cnt.set(b.item, (cnt.get(b.item) || 0) + 1));
  return small.every(b => { const c = cnt.get(b.item) || 0; cnt.set(b.item, c - 1); return c > 0; });
}

function allocateQuick(bottles, k, rule, valueOf) {
  const people = Array.from({ length: k }, () => []);
  const over = [];
  for (const b of [...bottles].sort((a, c) => c.ml - a.ml)) {
    const p = people.find(p => evalRule(rule, [...p, b]).ok && airlineLimitedMl([...p, b]) <= AIRLINE.limitedMlPerPerson);
    if (p) p.push(b); else over.push(b);
  }
  return { over };
}

/* ---------- 렌더링 ---------- */
const $ = s => document.querySelector(s);
const fmt = (n, d = 0) => n.toLocaleString('ko-KR', { maximumFractionDigits: d, minimumFractionDigits: d });
const won = n => `₩${fmt(n < 1000 ? Math.round(n) : Math.round(n / 10) * 10)}`;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderRateStatus(status) {
  const el = $('#rate-status');
  const krw = krwPerUsd();
  const when = rates.updatedAt ? new Date(rates.updatedAt).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }) : '';
  const msg = {
    loading: `환율 불러오는 중… (현재 1 USD = ${fmt(krw, 2)}원)`,
    ok: `1 USD = ${fmt(krw, 2)}원 · ${rates.source} · ${when} 기준`,
    offline: rates.source === 'cache'
      ? `오프라인 — 저장된 환율 사용 (1 USD = ${fmt(krw, 2)}원, ${when})`
      : `오프라인 — 근사 환율 사용 (1 USD = ${fmt(krw, 2)}원)`,
  }[status];
  el.textContent = msg;
  el.dataset.status = status;
}

function renderMeta() {
  const days = Math.floor((Date.now() - Date.parse(RULES_META.verifiedAt)) / 86400000);
  const stale = days > RULES_META.staleAfterDays;
  $('#rules-meta').innerHTML = `면세 기준 확인일 <b>${RULES_META.verifiedAt}</b>` +
    (stale ? ` · <span class="warn-text">${days}일 지남 — 출발 전 기준 업데이트를 권장해요</span>` : ` · ${days}일 전`);
}

function renderInputs() {
  document.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)));
  $('#dest-row').hidden = state.mode !== 'out';
  $('#dest').value = state.dest;

  $('#travelers').innerHTML = state.travelers.map((t, i) => `
    <div class="row traveler">
      <input aria-label="이름" data-t="${i}" data-f="name" value="${esc(t.name)}" placeholder="이름">
      <label class="inline">만 <input aria-label="나이" type="number" inputmode="numeric" min="0" max="120" data-t="${i}" data-f="age" value="${esc(t.age)}"> 세</label>
      <button class="icon" data-del-t="${i}" aria-label="삭제" ${state.travelers.length <= 1 ? 'disabled' : ''}>✕</button>
    </div>`).join('');

  const typeOpts = Object.entries(LIQUOR_TYPES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  const curOpts = CURRENCIES.map(c => `<option>${c}</option>`).join('');
  $('#items').innerHTML = state.items.map((it, i) => `
    <div class="item card">
      <div class="item-head">
        ${swatch(it.c)}
        <input class="grow" aria-label="술 이름" data-i="${i}" data-f="name" value="${esc(it.name)}" placeholder="이름 (예: 발베니 12년)">
        <button class="icon" data-del-i="${i}" aria-label="삭제">✕</button>
      </div>
      <div class="grid">
        <label>종류<select data-i="${i}" data-f="type">${typeOpts}</select></label>
        <label>용량(ml)<input type="number" inputmode="numeric" min="0" step="50" data-i="${i}" data-f="ml" value="${esc(it.ml)}"></label>
        <label>도수(%)<input type="number" inputmode="decimal" step="0.1" data-i="${i}" data-f="abv" value="${esc(it.abv)}"></label>
        <label>수량(병)<input type="number" inputmode="numeric" min="0" step="1" data-i="${i}" data-f="qty" value="${esc(it.qty)}"></label>
        <label class="span2">1병 가격<span class="price"><input type="number" inputmode="decimal" min="0" step="any" data-i="${i}" data-f="price" value="${esc(it.price)}"><select data-i="${i}" data-f="currency">${curOpts}</select></span></label>
      </div>
      <div class="conv" id="conv-${i}"></div>
    </div>`).join('');
  state.items.forEach((it, i) => {
    document.querySelector(`select[data-i="${i}"][data-f="type"]`).value = it.type;
    document.querySelector(`select[data-i="${i}"][data-f="currency"]`).value = it.currency;
  });
}

const swatch = c => `<i class="sw" style="--c:var(--s${c >= 1 && c <= 8 ? c : 0})"></i>`;

// 같은 술끼리 묶기 (입력 순서 유지)
function groupBottles(bs) {
  const g = new Map();
  for (const b of [...bs].sort((a, c) => a.item - c.item)) {
    if (!g.has(b.item)) g.set(b.item, { b, n: 0 });
    g.get(b.item).n++;
  }
  return [...g.values()];
}

function bottleList(bs) {
  return groupBottles(bs).map(({ b, n }) => `${esc(b.label)} ${n}병`).join(', ');
}

function priceText(b) {
  return b.currency === 'KRW' ? won(b.price) : `${fmt(b.price, b.price % 1 ? 2 : 0)} ${b.currency}`;
}

function amountText(unit, v) {
  return unit === 'usd' ? `$${fmt(v, v < 100 && v % 1 ? 1 : 0)}` : unit === 'bottles' ? `${v}병` : `${fmt(v / 1000, 2)}L`;
}

// 병마다 한 칸씩 쌓은 게이지. 신고분은 빗금, 한도선은 세로선.
function stackedGauge(segments, label, valueText) {
  const total = segments.reduce((s, x) => s + x.frac, 0);
  const scale = Math.max(1, total);
  const cls = total > 1 + 1e-9 ? 'over' : total > 0.85 ? 'near' : '';
  return `
    <div class="gauge-row">
      <span class="g-label">${label}</span>
      <span class="gauge" role="img" aria-label="${esc(label)} ${esc(valueText)}">
        ${segments.map(s => `<span class="part${s.declared ? ' declared' : ''}" style="--c:var(--s${s.c >= 1 && s.c <= 8 ? s.c : 0});width:calc(${(s.frac / scale) * 100}% - 2px)" title="${esc(s.title)}"></span>`).join('')}
        ${scale > 1 ? `<span class="limit" style="left:${100 / scale}%" title="면세 한도"></span>` : ''}
      </span>
      <span class="g-value ${cls}">${valueText}</span>
    </div>`;
}

function poolGauges(rule, p) {
  const out = [];
  const option = p.ev.pools;
  for (const pool of option) {
    if (!pool.components.some(c => c.limit >= 1)) continue;
    const segs = [];
    const usedExempt = pool.components.map(() => 0), usedOver = pool.components.map(() => 0);
    const order = [...p.exempt.map(b => [b, false]), ...p.over.map(b => [b, true])];
    for (const [b, declared] of order) {
      const i = pool.components.findIndex(c => c.match(b));
      if (i < 0) continue;
      const c = pool.components[i];
      const amt = unitAmount(b, c.unit);
      (declared ? usedOver : usedExempt)[i] += amt;
      segs.push({ c: b.c, frac: amt / c.limit, declared, title: `${b.label} · ${amountText(c.unit, amt)}${declared ? ' · 신고' : ''}` });
    }
    if (!segs.length && pool.components.length > 1) continue;
    const text = pool.components.map((c, i) => c.limit < 1 ? null :
      `${amountText(c.unit, usedExempt[i])} / ${amountText(c.unit, c.limit)}` + (usedOver[i] ? ` <em>+${amountText(c.unit, usedOver[i])} ${rule.overflow === 'destroy' ? '폐기' : '신고'}</em>` : ''))
      .filter(Boolean).join(' · ');
    out.push(stackedGauge(segs, pool.label, text));
  }
  if (p.airlineMl) {
    const segs = p.carried.filter(b => b.abv > AIRLINE.limitedAbvOver).map(b => ({ c: b.c, frac: b.ml / AIRLINE.limitedMlPerPerson, title: `${b.label} · ${amountText('ml', b.ml)}` }));
    out.push(stackedGauge(segs, '항공 5L', `${amountText('ml', p.airlineMl)} / 5L <small>(24~70%)</small>`));
  }
  return out.join('');
}

function costText(destKey, rule, declare) {
  if (destKey === 'KR') return `자진신고 시 <b>${won(krPersonTax(declare).declared)}</b>`;
  if (destKey === 'JP') return `세금 약 <b>¥${fmt(declare.reduce((s, b) => s + jpTax(rule, b), 0))}</b>`;
  return `신고 <b>${amountText('ml', declare.reduce((s, b) => s + b.ml, 0))}</b>`;
}

function personCard(r, p) {
  const { rule, destKey } = r;
  const name = esc(p.traveler.name || `여행객 ${p.traveler.idx + 1}`);
  const destroy = rule.overflow === 'destroy';
  const status = !p.carried.length ? '<span class="status idle">들고 탈 술 없음</span>'
    : p.over.length ? `<span class="status warn">${destroy ? '✕' : '!'} ${p.over.length}병 ${destroy ? '폐기 대상' : '신고'}</span>`
    : '<span class="status ok">✓ 전부 면세</span>';

  const rows = [
    ...groupBottles(p.exempt).map(g => ({ ...g, declared: false })),
    ...groupBottles(p.over).map(g => ({ ...g, declared: true })),
  ].map(({ b, n, declared }) => {
    const perTax = declared && destKey === 'KR' ? `<small class="row-tax">병당 세금 약 ${won(krTax(b).total)}</small>`
      : declared && destKey === 'JP' ? `<small class="row-tax">병당 세금 약 ¥${fmt(jpTax(rule, b))}</small>` : '';
    return `
      <li class="${declared ? 'declared' : ''}">
        ${swatch(b.c)}
        <span class="b-name">${esc(b.label)}<small>${fmt(b.ml)}ml · ${fmt(b.abv, 1)}% · ${priceText(b)}</small>${perTax}</span>
        <span class="b-qty">${n}병</span>
        <span class="tag ${declared ? 'warn' : 'ok'}">${declared ? (destroy ? '폐기' : '신고') : '면세'}</span>
      </li>`;
  }).join('');

  let advice = '';
  if (p.over.length && p.options.length) {
    const head = destKey === 'KR' || destKey === 'JP' ? '어떤 병을 신고할까요? — 세금이 적은 순' : '어떤 병을 신고할까요? — 신고 용량이 적은 순';
    advice = `
      <div class="advice">
        <p class="advice-head">${destroy ? '어떤 병을 빼야 할까요?' : head}</p>
        <ol>${p.options.map((o, i) => `
          <li class="${i === 0 ? 'best' : ''}">
            <span>${groupBottles(o.declare).map(({ b, n }) => `<span class="opt-item">${swatch(b.c)} ${esc(b.label)} ${n}병</span>`).join(' + ')}</span>
            <span class="cost">${destroy ? '' : costText(destKey, rule, o.declare)}${i === 0 ? '<span class="tag ok">추천</span>' : ''}</span>
          </li>`).join('')}
        </ol>
        ${p.options.length === 1 ? '<p class="muted">면세 한도 안에 맞추는 방법이 이것뿐이에요.</p>' : ''}
      </div>`;
  }

  const tax = p.tax ? `<p class="tax-line">예상 세금 <b>${won(p.tax.declared)}</b> <span class="muted">자진신고 기준 · 미신고 적발 시 ${won(p.tax.caught)}${p.tax.estimate ? ' · 맥주는 추정치' : ''}</span></p>`
    : p.jpYen ? `<p class="tax-line">예상 세금 <b>¥${fmt(p.jpYen)}</b> <span class="muted">간이세율 기준 · ≈ ${won(toUsd(p.jpYen, 'JPY') * krwPerUsd())}</span></p>` : '';

  return `
    <div class="card person">
      <div class="person-head"><div><b>${name}</b> <span class="muted">만 ${p.traveler.age}세</span></div>${status}</div>
      ${p.carried.length ? `<ul class="bottles">${rows}</ul><div class="gauges">${poolGauges(rule, p)}</div>` : ''}
      ${tax}${advice}
    </div>`;
}

function renderResult(r) {
  const { rule, destKey } = r;
  const overCount = r.alloc.over.length;
  const totalBottles = r.bottles.length + r.banned.length;
  const airlineFail = r.alloc.airlineFail > 0;
  const destroy = rule.overflow === 'destroy' && overCount > 0;

  let level, title, sub;
  if (!totalBottles) {
    level = 'idle';
    title = r.issues.length ? '입력을 확인하세요' : '주류를 입력하세요';
    sub = r.issues.length ? '빨간 칸을 채우면 바로 판정합니다.' : '용량·도수·가격·수량을 넣으면 바로 판정합니다.';
  } else if (!r.adults.length) {
    level = 'bad'; title = '면세 받을 수 있는 성인이 없어요';
    sub = `${rule.name} 주류 면세는 만 ${rule.minAge}세 이상만 해당됩니다.`;
  } else if (r.banned.length || airlineFail || destroy) {
    level = 'bad'; title = r.banned.length || airlineFail ? '항공기에 실을 수 없는 술이 있어요' : '초과분은 압수·폐기됩니다';
    sub = r.banned.length ? `도수 70% 초과 술 ${r.banned.length}병은 기내·위탁 모두 불가합니다.`
      : airlineFail ? '도수 24~70% 술은 1인당 5L까지만 실을 수 있어요. 인원을 늘리거나 수량을 줄이세요.'
      : `${rule.name}은(는) 한도 초과분을 세금 내고 찾을 수 없어요. ${overCount}병을 빼세요.`;
  } else if (overCount) {
    level = 'warn'; title = `${overCount}병은 신고가 필요해요`;
    const tax = r.people.reduce((s, p) => s + (p.tax ? p.tax.declared : 0), 0);
    const yen = r.people.reduce((s, p) => s + (p.jpYen || 0), 0);
    sub = destKey === 'KR' ? `세금이 가장 적게 나오도록 나눴을 때 자진신고 예상 세금 <b>${won(tax)}</b>`
      : destKey === 'JP' ? `초과분 예상 세금 <b>¥${fmt(yen)}</b> (≈ ${won(toUsd(yen, 'JPY') * krwPerUsd())})`
      : '입국할 때 세관에 신고하고 세금을 내야 해요.';
  } else {
    level = 'ok'; title = '문제없어요 — 전부 면세';
    sub = `아래처럼 나눠 들면 ${esc(rule.name)} 면세 기준과 항공 규정을 모두 지켜요.`;
  }
  if (r.needAdults && (level !== 'bad' || !r.adults.length)) sub += `<br>만 ${rule.minAge}세 이상 ${r.needAdults}명이 나눠 들면 전부 면세 가능`;

  const all = [...r.bottles, ...r.banned];
  const sumMl = all.reduce((s, b) => s + b.ml, 0), sumUsd = all.reduce((s, b) => s + b.usd, 0);
  const stats = totalBottles ? `<div class="stats"><span><b>${totalBottles}</b>병</span><span><b>${fmt(sumMl / 1000, 2)}</b>L</span><span><b>$${fmt(sumUsd, 0)}</b> ≈ ${won(sumUsd * krwPerUsd())}</span><span>면세 대상 성인 <b>${r.adults.length}</b>명</span></div>` : '';

  const alerts = [...r.issues];
  if (r.minors.length) alerts.push(`만 ${rule.minAge}세 미만 ${r.minors.length}명(${r.minors.map(t => esc(t.name || '이름 없음')).join(', ')})은 주류 면세 대상이 아니라 배분에서 뺐어요.`);
  if (r.banned.length) alerts.push(`도수 70% 초과 술(${bottleList(r.banned)})은 항공기에 실을 수 없어요.`);

  const conf = { official: ['공식 출처 확인', 'ok'], secondary: ['2차 출처 기준', 'warn'], conflict: ['출처 불일치 · 보수적 적용', 'warn'] }[rule.confidence];

  let html = `
    <div class="verdict ${level}" role="status">
      <div class="verdict-icon">${{ ok: '✓', warn: '!', bad: '✕', idle: '·' }[level]}</div>
      <div><h2>${title}</h2><p>${sub}</p>${stats}</div>
    </div>
    ${alerts.length ? `<ul class="alerts">${alerts.map(a => `<li>${a}</li>`).join('')}</ul>` : ''}
    <div class="card rule-card">
      <div class="rule-head"><span>적용 기준 · <b>${esc(rule.name)}</b></span><span class="chip ${conf[1]}">${conf[0]}</span></div>
      <p>${esc(rule.summary)} · 만 ${rule.minAge}세 이상</p>
    </div>`;

  if (r.people.length && r.bottles.length) {
    html += `<h3>여행객별로 이렇게 들고 타세요</h3>`;
    html += `<p class="legend-hint"><span class="seg-demo"></span> 면세 <span class="seg-demo declared"></span> 신고 <span class="limit-demo"></span> 면세 한도</p>`;
    html += r.people.map(p => personCard(r, p)).join('');
  }

  const notes = [];
  if (state.mode === 'out') notes.push('한국에서 출국할 때 술을 가지고 나가는 수량 제한은 없어요. 도착 국가 기준과 항공 규정만 지키면 됩니다.');
  notes.push('기내에 들고 탈 수 있는 술은 보안검색 후 면세점에서 산 봉인 봉투(STEB) 제품뿐이에요. 시내·인터넷 면세점이나 일반 매장에서 산 술은 위탁 수하물로 보내세요. 환승이 있으면 환승 공항 보안검색에서 압수될 수 있으니 봉인 봉투를 뜯지 말거나 위탁으로 보내세요.');
  if (destKey === 'KR') notes.push('세관은 매주 고시하는 과세환율을 써요. 실제 세액은 이 계산과 조금 다를 수 있어요.');
  notes.push('면세 한도는 각자 실제로 들고 들어오는 양으로 판정되지만, 면세점 구매기록은 구매자 여권에 연결돼요. 가능하면 각자 자기 몫을 결제하세요.');
  rule.notes.forEach(n => notes.push(esc(n)));

  html += `
    <details class="card notes-box">
      <summary>참고 사항 ${notes.length}개</summary>
      <ul class="notes">${notes.map(w => `<li>${w}</li>`).join('')}</ul>
    </details>
    <p class="sources">출처: ${rule.sources.map(s => `<a href="${s.url}" target="_blank" rel="noopener">${esc(s.label)}</a>`).join(' · ')}</p>`;

  $('#result').innerHTML = html;

  state.items.forEach((it, i) => {
    const el = document.getElementById(`conv-${i}`);
    if (!el) return;
    const usd = toUsd(+it.price || 0, it.currency);
    el.textContent = `1병 ≈ $${fmt(usd, 2)} · ${won(usd * krwPerUsd())}` + ((+it.abv) > 70 ? ' · 도수 70% 초과 → 항공 반입 불가' : '');
  });
}

function recompute() {
  safeSet(STORE_KEY, state);
  renderResult(compute());
  markInvalid();
}

// 비었거나 잘못된 입력칸을 빨간 테두리로 표시
function markInvalid() {
  const bad = (sel, cond) => { const el = document.querySelector(sel); if (el) el.classList.toggle('invalid', cond); };
  state.items.forEach((it, i) => {
    const counted = Math.floor(+it.qty || 0) > 0;
    bad(`input[data-i="${i}"][data-f="ml"]`, counted && !(+it.ml > 0));
    bad(`input[data-i="${i}"][data-f="price"]`, counted && !(+it.price > 0));
    bad(`input[data-i="${i}"][data-f="abv"]`, counted && !(+it.abv > 0 && +it.abv <= 100));
    bad(`input[data-i="${i}"][data-f="qty"]`, +it.qty < 0);
  });
  state.travelers.forEach((t, i) => bad(`input[data-t="${i}"][data-f="age"]`, t.age === '' || isNaN(+t.age) || +t.age < 0));
}

/* ---------- 이벤트 ---------- */
function bind() {
  document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
    state.mode = b.dataset.mode;
    renderInputs(); recompute();
  }));
  $('#dest').addEventListener('change', e => { state.dest = e.target.value; recompute(); });
  $('#add-traveler').addEventListener('click', () => {
    state.travelers.push({ name: `동행 ${state.travelers.length}`, age: 30 });
    renderInputs(); recompute();
  });
  $('#add-item').addEventListener('click', () => {
    const last = state.items[state.items.length - 1];
    state.items.push({ name: '', type: 'wine', ml: 750, abv: LIQUOR_TYPES.wine.abv, price: 0, currency: last ? last.currency : 'USD', qty: 1, c: nextColor() });
    renderInputs(); recompute();
  });

  document.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.t !== undefined) {
      state.travelers[+t.dataset.t][t.dataset.f] = t.value;
      recompute();
    } else if (t.dataset.i !== undefined) {
      const it = state.items[+t.dataset.i];
      it[t.dataset.f] = t.value;
      if (t.dataset.f === 'type') {
        it.abv = LIQUOR_TYPES[t.value].abv;
        document.querySelector(`input[data-i="${t.dataset.i}"][data-f="abv"]`).value = it.abv;
      }
      recompute();
    }
  });
  document.addEventListener('click', e => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.delT !== undefined) { state.travelers.splice(+t.dataset.delT, 1); renderInputs(); recompute(); }
    if (t.dataset.delI !== undefined) { state.items.splice(+t.dataset.delI, 1); renderInputs(); recompute(); }
  });
}

// 술마다 고정 색 슬롯(1~8). 삭제돼도 남은 술의 색은 바뀌지 않는다. 8개를 넘으면 회색(0).
function nextColor() {
  const used = new Set(state.items.map(it => it.c));
  for (let c = 1; c <= 8; c++) if (!used.has(c)) return c;
  return 0;
}

function init() {
  const saved = safeGet(STORE_KEY);
  if (saved && Array.isArray(saved.items) && Array.isArray(saved.travelers)) {
    const { transfer, krwOverride, ...rest } = saved;
    Object.assign(state, rest);
  }
  if (!DESTINATIONS[state.dest] || state.dest === 'KR') state.dest = 'JP';
  state.items.forEach(it => { if (!it.c) it.c = nextColor(); });

  $('#dest').innerHTML = Object.entries(DESTINATIONS).filter(([k]) => k !== 'KR')
    .map(([k, v]) => `<option value="${k}">${v.name}</option>`).join('');
  renderMeta();
  renderInputs();
  bind();
  renderRateStatus('loading');
  recompute();
  loadRates();
}

init();
