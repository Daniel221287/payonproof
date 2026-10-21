/* PayOnProof UI. Plain JavaScript, loaded as an external file (strict CSP, no inline scripts).
   All data from documents is rendered with textContent / DOM nodes, never as HTML. */
(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const NONCE = document.querySelector('meta[name="csp-nonce"]')?.content ?? '';
  const NARROW = window.matchMedia('(max-width: 680px)');

  const state = {
    config: null,
    samples: [],
    sampleId: null,
    mode: 'samples',
    caseView: null,
    approval: null,
    messageDirty: false,
    selectedLineId: null,
    docId: null,
    grid: null,
    busy: null,
    pollTimer: null,
    pollCount: 0,
  };

  /* ---------- small helpers ---------- */

  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    check: ['M2 6.5l2.5 2.5L10 3'],
    half: ['M6 1.5a4.5 4.5 0 1 0 0 9a4.5 4.5 0 1 0 0-9z', 'M6 1.5v9'],
    down: ['M6 1.8v8', 'M2.8 6.8L6 10l3.2-3.2'],
    noteq: ['M2 4.6h8', 'M2 7.6h8', 'M8.2 2L3.8 10'],
    cap: ['M2 2.4h8', 'M6 10.2V4.8', 'M3.4 7.2L6 4.6l2.6 2.6'],
    pen: ['M2 10l.8-2.8L8.4 1.6l2 2-5.6 5.6z'],
    empty: ['M6 1.5a4.5 4.5 0 1 0 0 9a4.5 4.5 0 1 0 0-9z', 'M2.6 9.4l6.8-6.8'],
    copy: ['M4.2 4.2h5.8V10H4.2z', 'M2 7.8V2h5.8'],
    swap: ['M1.8 4h7.6', 'M7.6 2l2 2-2 2', 'M10.2 8H2.6', 'M4.4 6l-2 2 2 2'],
  };
  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 12 12');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (const d of ICONS[name]) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }

  const VERDICTS = {
    PROVEN: { label: 'Proven', tone: 'ok', icon: 'check' },
    PARTIAL: { label: 'Partial', tone: 'warn', icon: 'half' },
    ROLE_MISMATCH: { label: 'Trade differs', tone: 'warn', icon: 'swap' },
    RATE_ABOVE_CONTRACT: { label: 'Rate capped', tone: 'warn', icon: 'down' },
    MATH_ERROR: { label: 'Math error', tone: 'warn', icon: 'noteq' },
    OVER_CAP: { label: 'Over cap', tone: 'warn', icon: 'cap' },
    UNSIGNED: { label: 'Unsigned', tone: 'bad', icon: 'pen' },
    UNPROVEN: { label: 'Unproven', tone: 'bad', icon: 'empty' },
    DUPLICATE: { label: 'Duplicate', tone: 'bad', icon: 'copy' },
  };

  function verdictBadge(code) {
    const meta = VERDICTS[code] ?? { label: code, tone: 'warn', icon: 'empty' };
    return h('span', { class: 'verdict', 'data-tone': meta.tone, title: code }, icon(meta.icon), meta.label);
  }

  function currency() {
    return state.caseView?.verification?.currency ?? state.caseView?.contract?.currency ?? 'EUR';
  }
  function money(cents, code = currency()) {
    if (cents === null || cents === undefined) return '';
    const sign = cents < 0 ? '-' : '';
    return sign + new Intl.NumberFormat('en-GB', { style: 'currency', currency: code }).format(Math.abs(cents) / 100);
  }
  function qty(milli) {
    return new Intl.NumberFormat('en-GB', { maximumFractionDigits: 3 }).format(milli / 1000);
  }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function shortDate(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    return `${d} ${MONTHS[m - 1]}`;
  }
  function longDate(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    return `${d} ${MONTHS[m - 1]} ${y}`;
  }
  /** Email address with a line-break opportunity after "@" (never breaks inside a word). */
  function emailNode(email) {
    const text = String(email ?? '');
    const at = text.indexOf('@');
    if (at < 0) return document.createTextNode(text);
    const fragment = document.createDocumentFragment();
    fragment.append(text.slice(0, at + 1), document.createElement('wbr'), text.slice(at + 1));
    return fragment;
  }
  function clock(isoString) {
    return new Date(isoString).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  async function api(path, { method = 'GET', body } = {}) {
    const response = await fetch(path, {
      method,
      headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      const error = new Error(data?.error?.message ?? `The server answered ${response.status}.`);
      error.code = data?.error?.code;
      error.detail = data?.error?.detail;
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  let toastTimer = null;
  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.setAttribute('data-show', '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.removeAttribute('data-show'), 3200);
  }

  function showError(id, error) {
    const el = $(id);
    if (!error) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.textContent = error.message ?? String(error);
  }

  function setBusy(button, busy, busyText) {
    if (busy) {
      button.dataset.label = button.dataset.label ?? button.textContent.trim();
      button.setAttribute('aria-busy', 'true');
      button.disabled = true;
      if (busyText) setButtonText(button, busyText);
    } else {
      button.removeAttribute('aria-busy');
      if (button.dataset.label) setButtonText(button, button.dataset.label);
    }
  }
  function setButtonText(button, text) {
    const svg = button.querySelector('svg');
    button.replaceChildren(...(svg ? [svg, ' '] : []), text);
  }

  async function copyText(text, message) {
    try {
      await navigator.clipboard.writeText(text);
      toast(message);
    } catch {
      toast('Copying is not available here. Select the text and copy it manually.');
    }
  }

  /* ---------- theme ---------- */

  const THEMES = ['system', 'light', 'dark'];
  function currentTheme() {
    return document.documentElement.dataset.theme ?? 'system';
  }
  function applyTheme(theme) {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try {
      if (theme === 'system') localStorage.removeItem('payonproof-theme');
      else localStorage.setItem('payonproof-theme', theme);
    } catch {
      // Storage is optional.
    }
    const label = { system: 'System', light: 'Light', dark: 'Dark' }[theme];
    $('#theme-label').textContent = label;
    $('#theme-toggle').setAttribute('aria-label', `Colour theme: ${label.toLowerCase()}. Change theme`);
  }

  /* ---------- header and intake ---------- */

  function renderHeader() {
    const { config } = state;
    const env = $('#env-badge');
    if (config.paypal.environment === 'live') {
      env.textContent = 'LIVE PayPal: real money';
      env.setAttribute('data-live', '');
    } else {
      env.textContent = 'Sandbox: no real money';
    }
    const badge = $('#paypal-badge');
    badge.hidden = false;
    badge.removeAttribute('data-mock');
    if (config.paypal.mode === 'mock') {
      badge.textContent = 'MOCK PayPal';
      badge.setAttribute('data-mock', '');
      badge.title = 'An in-process fake of the PayPal sandbox API answers. No network calls.';
    } else if (config.paypal.mode === 'unconfigured') {
      badge.textContent = 'PayPal not configured';
    } else {
      badge.textContent = `PayPal ${config.paypal.environment}`;
    }
    const reader = $('#reader-line');
    reader.replaceChildren('Documents are read by ', h('strong', { text: config.ai.label }), '.');
    $('#paste-note').textContent = config.ai.isAI
      ? `Paste or load plain text. ${config.ai.label} reads each document separately; the rules engine does the checking.`
      : 'Offline mode reads only the fixed layout of the sample documents. Start from a sample and change numbers to see the verdicts move. Configure Nebius Token Factory, Gemini or an OpenAI-compatible model to read any text.';
    $('#passcode-row').hidden = !config.approval.passcodeRequired;
    $('#passcode-note').hidden = config.approval.passcodeRequired;
    $('#footer-agents').replaceChildren('Agents can use it over MCP at ', h('code', { text: '/mcp' }), config.approval.passcodeRequired
      ? '. They can verify, propose and pay a payment a person approved; approving needs the approver passcode, which no MCP tool accepts.'
      : '. They can verify and propose; no MCP tool can approve. This server has no approver passcode, so any program that can send HTTP to it could approve: keep it on 127.0.0.1.');
    setButtonText($('#pay-btn'), config.paypal.environment === 'live' ? 'Pay with PayPal (LIVE)' : 'Pay with PayPal (sandbox)');
  }

  function renderCasePicker() {
    const picker = $('#case-picker');
    picker.replaceChildren(h('legend', { class: 'visually-hidden', text: 'Sample case' }));
    for (const sample of state.samples) {
      const input = h('input', { type: 'radio', name: 'sample', value: sample.id, id: `sample-${sample.id}` });
      input.checked = sample.id === state.sampleId;
      input.addEventListener('change', () => {
        state.sampleId = sample.id;
      });
      picker.append(h('label', { class: 'case-option', for: `sample-${sample.id}` },
        input,
        h('span', { class: 'case-title', text: sample.title }),
        h('span', { class: 'case-summary', text: sample.summary }),
        h('span', { class: 'case-meta', text: `${sample.documents.length} documents` })));
    }
    const select = $('#paste-sample');
    select.replaceChildren(...state.samples.map((sample) => h('option', { value: sample.id, text: sample.title })));
  }

  function selectTab(mode, focus = false) {
    state.mode = mode;
    for (const [tabId, panelId, tabMode] of [['#tab-samples', '#panel-samples', 'samples'], ['#tab-paste', '#panel-paste', 'paste']]) {
      const selected = tabMode === mode;
      const tab = $(tabId);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      $(panelId).hidden = !selected;
      if (selected && focus) tab.focus();
    }
  }

  function fillFromSample(sampleId) {
    const sample = state.samples.find((candidate) => candidate.id === sampleId);
    if (!sample) return;
    const fields = { contract: '#paste-contract', invoice: '#paste-invoice', timesheet: '#paste-timesheet', delivery_notes: '#paste-delivery' };
    for (const [type, selector] of Object.entries(fields)) {
      $(selector).value = sample.documents.filter((doc) => doc.type === type).map((doc) => doc.text).join('\n----\n');
    }
    toast(`Copied the "${sample.title}" documents into the fields.`);
  }

  function pastedDocuments() {
    const docs = [];
    for (const textarea of document.querySelectorAll('#panel-paste textarea')) {
      const text = textarea.value.trim();
      if (text) docs.push({ type: textarea.dataset.type, name: textarea.labels[0]?.firstChild?.textContent.trim(), text });
    }
    return docs;
  }

  async function analyze() {
    const button = $('#analyze-btn');
    showError('#analyze-error', null);
    let body;
    if (state.mode === 'samples') {
      if (!state.sampleId) {
        showError('#analyze-error', new Error('Pick a sample case first.'));
        return;
      }
      body = { sampleId: state.sampleId };
    } else {
      const documents = pastedDocuments();
      if (!documents.some((doc) => doc.type === 'contract') || !documents.some((doc) => doc.type === 'invoice')) {
        showError('#analyze-error', new Error('Add at least the contract and the invoice.'));
        return;
      }
      body = { documents };
    }
    setBusy(button, true, 'Verifying…');
    try {
      const { case: caseView } = await api('/api/analyze', { method: 'POST', body });
      state.approval = null;
      state.selectedLineId = null;
      state.docId = null;
      setCase(caseView, { fresh: true });
      $('#proof').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      $('#proof-title').setAttribute('tabindex', '-1');
      $('#proof-title').focus({ preventScroll: true });
    } catch (error) {
      showError('#analyze-error', error);
    } finally {
      setBusy(button, false);
      button.disabled = false;
    }
  }

  /* ---------- case rendering ---------- */

  function setCase(caseView, { fresh = false } = {}) {
    const previous = state.caseView;
    state.caseView = caseView;
    if (fresh || !previous || previous.id !== caseView.id || previous.message?.text !== caseView.message?.text) {
      state.messageDirty = false;
      $('#message-text').value = caseView.message?.text ?? '';
    }
    if (state.approval && (state.approval.caseId !== caseView.id || state.approval.previewHash !== caseView.proposal?.previewHash)) {
      state.approval = { ...state.approval, withdrawn: true };
    }
    renderDocuments();
    renderProof();
    renderApprove();
    renderPay();
    renderProgress();
    schedulePoll();
  }

  function renderDocuments() {
    const c = state.caseView;
    const viewer = $('#doc-viewer');
    viewer.hidden = false;
    viewer.querySelector('summary').textContent = `Show the ${c.documents.length} documents that were read`;
    if (!state.docId || !c.documents.some((doc) => doc.id === state.docId)) state.docId = c.documents[0]?.id ?? null;
    const tabs = $('#doc-tabs');
    tabs.replaceChildren(...c.documents.map((doc) => {
      const selected = doc.id === state.docId;
      const ok = doc.status === 'ok';
      return h('button', {
        type: 'button', role: 'tab', 'aria-selected': String(selected), 'aria-controls': 'doc-text',
        onclick: () => {
          state.docId = doc.id;
          renderDocuments();
        },
      }, doc.name, h('span', { class: 'doc-status', 'data-ok': String(ok), text: ok ? (doc.warnings.length ? 'read, with notes' : 'read') : 'rejected' }));
    }));
    const doc = c.documents.find((candidate) => candidate.id === state.docId);
    $('#doc-text').textContent = doc?.text ?? '';
    viewer.querySelector('.doc-issues')?.remove();
    const issues = [...(doc?.errors ?? []).map((e) => `Error at ${e.path}: ${e.message}`), ...(doc?.warnings ?? []).map((w) => `Note at ${w.path}: ${w.message}`)];
    if (issues.length) viewer.append(h('ul', { class: 'doc-issues' }, issues.map((text) => h('li', { text }))));
  }

  function renderProof() {
    const c = state.caseView;
    const section = $('#proof');
    section.hidden = false;
    const v = c.verification;
    const titleBlock = $('#title-block');
    const cell = (label, value, small) => h('div', {}, h('dt', { text: label }), h('dd', {}, value ?? 'Not found', small ? h('small', { text: small }) : null));
    titleBlock.replaceChildren(
      cell('Invoice', c.invoice?.invoiceNumber, c.invoice?.issueDate ? `issued ${longDate(c.invoice.issueDate)}` : null),
      cell('Subcontractor', c.contract?.subcontractor),
      cell('Contract', c.contract?.contractId, c.contract?.paymentCapCents != null ? `cap ${money(c.contract.paymentCapCents)} per invoice` : null),
      cell('Payee (PayPal)', c.contract ? emailNode(c.contract.payeeEmail) : null, 'taken from the contract, never from the invoice'),
      cell('Message language', c.contract?.languageName ?? null),
      cell('Read by', c.extraction.label, `${c.extraction.durationMs} ms${c.extraction.cached ? ', cached result' : ''}, input SHA-256 ${c.extraction.inputSha256.slice(0, 12)}…`),
    );

    const findings = $('#case-findings');
    findings.replaceChildren(...(v?.caseFindings ?? c.blockers ?? []).map((finding) => h('li', { 'data-severity': finding.severity },
      h('span', { class: 'finding-label', text: finding.severity === 'blocker' ? 'Blocked' : 'Warning' }),
      h('span', { text: finding.reason }))));

    const ledger = $('#ledger');
    const gridWrap = section.querySelector('.grid-wrap');
    if (!v) {
      ledger.hidden = true;
      gridWrap.hidden = true;
      $('#inspector').replaceChildren();
      return;
    }
    ledger.hidden = false;
    gridWrap.hidden = false;
    const t = v.totals;
    const paidLines = v.lines.filter((line) => line.payableCents > 0).length;
    const heldLines = v.lines.filter((line) => line.disputedCents > 0).length;
    $('#sum-claimed').textContent = money(t.claimedCents);
    $('#sum-claimed-note').textContent = `${t.lineCount} invoice lines`;
    $('#sum-payable').textContent = money(t.payableCents);
    $('#sum-payable-note').textContent = `${paidLines} of ${t.lineCount} lines paid, ${t.provenLineCount} in full`;
    $('#sum-disputed').textContent = money(t.disputedCents);
    $('#sum-disputed-note').textContent = heldLines ? `${heldLines} line${heldLines === 1 ? '' : 's'} held back` : 'Nothing held back';
    const share = t.claimedCents > 0 ? Math.min(1, t.payableCents / t.claimedCents) : 0;
    $('#proof-bar-paid').style.width = `${(share * 100).toFixed(2)}%`;
    $('#proof-bar-cut').style.width = `${((1 - share) * 100).toFixed(2)}%`;
    $('#proof-bar').setAttribute('aria-label', `${money(t.payableCents)} of ${money(t.claimedCents)} claimed is proven (${Math.round(share * 100)} percent).`);

    renderGrid(v.lines);
    if (!state.selectedLineId || !v.lines.some((line) => line.id === state.selectedLineId)) {
      state.selectedLineId = (v.lines.find((line) => line.verdict !== 'PROVEN') ?? v.lines[0])?.id ?? null;
    }
    renderInspector();
  }

  /* ---------- AG Grid ---------- */

  /** Role as invoiced, plus the trade on the signed timesheet when it differs. */
  function roleText(line) {
    return line.timesheetRole ? `${line.role} (timesheet: ${line.timesheetRole})` : line.role;
  }

  function subjectRenderer(params) {
    const line = params.data;
    const secondary = NARROW.matches
      ? `${money(line.payableCents)} of ${money(line.claimedCents)}`
      : line.kind === 'labour' ? roleText(line) : (line.itemCode ? `Article ${line.itemCode}` : 'Material');
    return h('div', { class: 'cell-subject', title: `${line.subject}, ${secondary}` }, h('strong', { text: line.subject }), h('span', { text: secondary }));
  }
  function qtyRenderer(params) {
    const line = params.data;
    if (line.provenQtyMilli === line.claimedQtyMilli) return h('span', { text: `${qty(line.claimedQtyMilli)} ${line.unit}` });
    return h('div', { class: 'cell-stack' },
      h('span', { class: 'cell-short', text: `${qty(line.provenQtyMilli)} ${line.unit}` }),
      h('small', { text: `of ${qty(line.claimedQtyMilli)} claimed` }));
  }
  function rateRenderer(params) {
    const line = params.data;
    if (line.payRateCents === line.unitPriceCents) return h('span', { text: money(line.unitPriceCents) });
    return h('div', { class: 'cell-stack' },
      h('span', { class: 'cell-short', text: money(line.payRateCents) }),
      h('small', { text: `invoiced ${money(line.unitPriceCents)}` }));
  }

  function ensureGrid() {
    if (state.grid) return state.grid;
    if (!window.agGrid) throw new Error('The grid library did not load.');
    const theme = window.agGrid.themeQuartz.withParams({
      fontFamily: 'inherit',
      fontSize: 14,
      headerFontSize: 13,
      headerFontWeight: 700,
      backgroundColor: 'var(--sheet)',
      foregroundColor: 'var(--ink)',
      textColor: 'var(--ink)',
      headerTextColor: 'var(--ink-2)',
      headerBackgroundColor: 'var(--sheet-2)',
      chromeBackgroundColor: 'var(--sheet-2)',
      borderColor: 'var(--rule)',
      accentColor: 'var(--signature)',
      rowHoverColor: 'color-mix(in srgb, var(--signature) 7%, transparent)',
      selectedRowBackgroundColor: 'color-mix(in srgb, var(--signature) 13%, transparent)',
      oddRowBackgroundColor: 'transparent',
      wrapperBorderRadius: 4,
      spacing: 6,
      cellHorizontalPadding: 12,
      browserColorScheme: 'inherit',
    });
    const columnDefs = [
      { headerName: 'Line', field: 'id', colId: 'id', width: 64, minWidth: 46, comparator: (a, b) => a.localeCompare(b, 'en', { numeric: true }) },
      { headerName: 'Work or material', field: 'subject', colId: 'subject', flex: 1.3, minWidth: 150, cellRenderer: subjectRenderer },
      { headerName: 'Date', field: 'date', colId: 'date', width: 84, valueFormatter: (p) => shortDate(p.value) },
      { headerName: 'Quantity', colId: 'qty', type: 'rightAligned', width: 120, valueGetter: (p) => p.data.provenQtyMilli, cellRenderer: qtyRenderer },
      { headerName: 'Rate', colId: 'rate', type: 'rightAligned', width: 112, valueGetter: (p) => p.data.payRateCents, cellRenderer: rateRenderer },
      { headerName: 'Claimed', field: 'claimedCents', colId: 'claimed', type: 'rightAligned', width: 108, valueFormatter: (p) => money(p.value) },
      { headerName: 'Payable', field: 'payableCents', colId: 'payable', type: 'rightAligned', width: 108, valueFormatter: (p) => money(p.value), cellClass: 'cell-strong' },
      { headerName: 'Verdict', field: 'verdict', colId: 'verdict', width: 146, minWidth: 128, cellRenderer: (p) => verdictBadge(p.value) },
      { headerName: 'Why', field: 'reason', colId: 'why', flex: 2, minWidth: 220, wrapText: true, autoHeight: true, sortable: false, cellClass: 'cell-reason' },
    ];
    const gridOptions = {
      theme,
      styleNonce: NONCE,
      columnDefs,
      rowData: [],
      defaultColDef: { sortable: true, resizable: true, suppressMovable: true, suppressHeaderMenuButton: true },
      domLayout: 'autoHeight',
      rowHeight: 54,
      headerHeight: 42,
      ensureDomOrder: true,
      animateRows: false,
      getRowId: (p) => p.data.id,
      rowSelection: { mode: 'singleRow', checkboxes: false, enableClickSelection: true },
      onSelectionChanged: (event) => {
        const [node] = event.api.getSelectedNodes();
        if (node && node.data.id !== state.selectedLineId) {
          state.selectedLineId = node.data.id;
          renderInspector();
        }
      },
      onCellFocused: (event) => {
        if (event.rowIndex === null || event.rowIndex === undefined) return;
        const node = event.api.getDisplayedRowAtIndex(event.rowIndex);
        if (node && !node.isSelected()) node.setSelected(true, true);
      },
      overlayNoRowsTemplate: '<span>No invoice lines.</span>',
    };
    state.grid = window.agGrid.createGrid($('#lines-grid'), gridOptions);
    applyResponsiveColumns();
    NARROW.addEventListener('change', applyResponsiveColumns);
    return state.grid;
  }

  function applyResponsiveColumns() {
    const grid = state.grid;
    if (!grid) return;
    grid.setColumnsVisible(['date', 'qty', 'rate', 'claimed', 'payable', 'why'], !NARROW.matches);
    grid.setColumnWidths([{ key: 'id', newWidth: NARROW.matches ? 48 : 64 }, { key: 'verdict', newWidth: NARROW.matches ? 128 : 146 }]);
    grid.refreshCells({ force: true, columns: ['subject'] });
    $('#grid-hint').textContent = NARROW.matches ? 'Tap a line to see its proof. Swipe the table sideways if needed.' : 'Select a line to see its proof chain below.';
  }

  function renderGrid(lines) {
    const grid = ensureGrid();
    grid.setGridOption('rowData', lines);
    const node = state.selectedLineId ? grid.getRowNode(state.selectedLineId) : null;
    node?.setSelected(true, true);
  }

  function renderInspector() {
    const c = state.caseView;
    const box = $('#inspector');
    const line = c.verification?.lines.find((candidate) => candidate.id === state.selectedLineId);
    if (!line) {
      box.replaceChildren();
      return;
    }
    const node = state.grid?.getRowNode(line.id);
    if (node && !node.isSelected()) node.setSelected(true, true);
    const what = line.kind === 'labour' ? roleText(line) : (line.itemCode ? `Article ${line.itemCode}` : 'Material');
    const invoiced = `${qty(line.claimedQtyMilli)} ${line.unit} × ${money(line.unitPriceCents)} printed as ${money(line.claimedCents)}`;
    const payable = line.payableCents === 0
      ? `${money(0)}`
      : `${qty(line.provenQtyMilli)} ${line.unit} × ${money(line.payRateCents)} gives ${money(line.payableCents)}`;
    box.replaceChildren(
      h('div', { class: 'inspector-head' }, h('h3', { text: `Line ${line.id}: ${line.subject}` }), verdictBadge(line.verdict)),
      h('p', { class: 'cell-muted', text: `${what}, ${longDate(line.date)}` }),
      h('dl', { class: 'calc' },
        h('dt', { text: 'Invoiced' }),
        h('dd', { text: line.correctCents !== line.claimedCents && line.findings.some((f) => f.code === 'MATH_ERROR') ? `${invoiced} (the product is ${money(line.correctCents)})` : invoiced }),
        h('dt', { text: 'Evidence used' }),
        h('dd', {}, line.evidence.length
          ? h('ul', {}, line.evidence.map((item) => h('li', {}, h('span', { class: 'mono', text: item.id }), `: ${item.detail}`)))
          : 'None that proves this line'),
        h('dt', { text: 'Contract rate' }),
        h('dd', { text: line.contractRateCents === null
          ? 'No agreed rate in the contract'
          : `${money(line.contractRateCents)} per ${line.unit} (${line.contractRateName})${line.timesheetRateCents !== null && line.timesheetRateCents !== undefined
            ? `; the signed timesheet says ${line.timesheetRole}: ${money(line.timesheetRateCents)} per ${line.unit}` : ''}` }),
        h('dt', { text: 'Payable' }),
        h('dd', {}, h('strong', { text: payable })),
        h('dt', { text: 'Why' }),
        h('dd', {}, line.findings.length
          ? h('ul', {}, line.findings.map((finding) => h('li', { text: finding.reason })))
          : 'Every unit is proven at the agreed rate.'),
      ),
    );
  }

  /* ---------- approve ---------- */

  function approvalIsLive() {
    const a = state.approval;
    const c = state.caseView;
    return Boolean(a && !a.withdrawn && !a.used && c && a.caseId === c.id && a.previewHash === c.proposal?.previewHash && Date.parse(a.expiresAt) > Date.now());
  }

  function renderApprove() {
    const c = state.caseView;
    const section = $('#approve');
    section.hidden = !c.proposal;
    if (!c.proposal) return;
    const { proposal, message } = c;
    const core = proposal.core;
    $('#message-meta').textContent = `Written in ${message.languageName}. ${message.label}.`;
    const note = $('#message-note');
    note.hidden = !message.note;
    note.textContent = message.note ?? '';
    $('#save-message').disabled = !state.messageDirty;

    const sentence = $('#approval-sentence');
    sentence.replaceChildren('Pay ', h('strong', { text: money(core.payableCents, core.currency) }), ' to ',
      h('strong', {}, emailNode(core.payee.email)), ' for invoice ', h('strong', { text: core.invoiceNumber }),
      `: ${core.paidLines.length} of ${c.verification.lines.length} lines.`);
    const override = $('#override-note');
    override.hidden = !core.payee.sandboxOverride;
    override.textContent = core.payee.sandboxOverride
      ? `Sandbox testing: PAYEE_EMAIL_OVERRIDE sends this payout to ${core.payee.email} instead of the contract payee ${core.payee.contractEmail}.`
      : '';
    $('#proposal-blockers').replaceChildren(...proposal.blockers.map((reason) => h('li', { 'data-severity': 'blocker' },
      h('span', { class: 'finding-label', text: 'Blocked' }), h('span', { text: reason }))));
    $('#preview-hash').textContent = proposal.previewHash;
    $('#preview-json').textContent = JSON.stringify(core, null, 2);

    const sent = c.payout && !['NOT_SENT', 'REJECTED'].includes(c.payout.state);
    const live = approvalIsLive();
    const approveButton = $('#approve-btn');
    approveButton.disabled = proposal.status === 'BLOCKED' || sent || live || state.messageDirty || state.busy === 'approve';
    $('#confirm-check').disabled = proposal.status === 'BLOCKED' || sent || live;
    renderApprovalState();
  }

  function renderApprovalState() {
    const box = $('#approval-state');
    const c = state.caseView;
    const a = state.approval;
    box.removeAttribute('data-state');
    if (state.messageDirty) {
      box.setAttribute('data-state', 'withdrawn');
      box.replaceChildren(h('span', { text: 'You changed the message. Save it to get the new preview hash, then approve.' }));
      return;
    }
    if (c.payout && !['NOT_SENT', 'REJECTED'].includes(c.payout.state)) {
      box.replaceChildren(h('p', {}, h('strong', { text: 'Approved and used.' }), ` The payout went to PayPal as sender_batch_id ${c.payout.senderBatchId.slice(0, 16)}…, derived from this preview hash.`));
      return;
    }
    if (!a) {
      box.replaceChildren();
      return;
    }
    if (a.withdrawn) {
      box.setAttribute('data-state', 'withdrawn');
      box.replaceChildren(h('strong', { text: 'Approval withdrawn.' }), h('span', { text: ' The payment changed after it was approved. Review it and approve again.' }));
      return;
    }
    const remaining = Date.parse(a.expiresAt) - Date.now();
    if (remaining <= 0) {
      box.setAttribute('data-state', 'withdrawn');
      box.replaceChildren(h('strong', { text: 'Approval expired.' }), h('span', { text: ' Approvals are valid for 10 minutes. Approve again to pay.' }));
      return;
    }
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000).toString().padStart(2, '0');
    box.replaceChildren(
      h('p', {}, h('strong', { text: `Approved at ${clock(a.issuedAt)}.` }), ` Valid for ${minutes}:${seconds}, for one payment of exactly this preview.`),
      h('div', { class: 'token-row' },
        h('code', { text: `${a.token.slice(0, 10)}…` }),
        h('button', { type: 'button', class: 'button-quiet', onclick: () => copyText(a.token, 'Approval token copied. It works once, for this preview hash only.') }, 'Copy token for an MCP agent')),
    );
  }

  async function saveMessage() {
    const button = $('#save-message');
    showError('#message-error', null);
    setBusy(button, true, 'Saving…');
    try {
      const { case: caseView } = await api('/api/message', { method: 'POST', body: { caseId: state.caseView.id, text: $('#message-text').value } });
      state.messageDirty = false;
      setCase(caseView);
      toast('Message saved. The preview hash changed, so approve again.');
    } catch (error) {
      showError('#message-error', error);
    } finally {
      setBusy(button, false);
      button.disabled = !state.messageDirty;
    }
  }

  async function approve() {
    const c = state.caseView;
    const button = $('#approve-btn');
    showError('#approve-error', null);
    if (!$('#confirm-check').checked) {
      showError('#approve-error', new Error('Tick the box to confirm you checked the payee, the amount and the paid lines.'));
      $('#confirm-check').focus();
      return;
    }
    state.busy = 'approve';
    setBusy(button, true, 'Approving…');
    try {
      const result = await api('/api/approve', {
        method: 'POST',
        body: { caseId: c.id, previewHash: c.proposal.previewHash, confirm: true, passcode: $('#passcode').value || undefined },
      });
      state.approval = { ...result.approval };
      $('#confirm-check').checked = false;
      $('#passcode').value = '';
      state.busy = null;
      setCase(result.case);
      toast('Approved. You can pay now.');
      $('#pay-btn').focus({ preventScroll: true });
      $('#pay').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
    } catch (error) {
      state.busy = null;
      showError('#approve-error', error);
      if (error.code === 'PREVIEW_CHANGED') refreshCase();
    } finally {
      setBusy(button, false);
      renderApprove();
    }
  }

  /* ---------- pay and receipt ---------- */

  const STAMPS = {
    PAID_VERIFIED: { text: 'Paid & verified', tone: 'ok', explain: 'PayPal reports the batch and the item as SUCCESS, and the readback matches the approval.' },
    SENT: { text: 'Pending at PayPal', tone: 'warn', explain: 'PayPal accepted the payout and is still processing it. The status refreshes automatically for a short while.' },
    UNCLAIMED: { text: 'Sent, unclaimed', tone: 'warn', explain: 'PayPal sent the payout, but the receiver has not claimed it yet (no PayPal account for this address). Unclaimed payouts return after 30 days.' },
    FAILED: { text: 'Payout failed', tone: 'bad', explain: 'PayPal reports that the payout did not go through.' },
    MISMATCH: { text: 'Readback mismatch', tone: 'bad', explain: 'PayPal reports a different amount, currency or receiver than you approved. Investigate before anything else.' },
    UNKNOWN_AFTER_SEND: { text: 'Outcome unknown', tone: 'warn', explain: 'The request may have reached PayPal, but no answer came back. Nothing is resent automatically. Reconciling presents the same sender_batch_id again, which PayPal processes at most once, and reads the batch back.' },
    NOT_SENT: { text: 'Not sent', tone: 'bad', explain: 'PayPal could not be reached, so nothing was sent. Approve again to retry.' },
    REJECTED: { text: 'Rejected by PayPal', tone: 'bad', explain: 'PayPal refused the payout; nothing was paid. Fix the cause, approve again and retry.' },
    SENDING: { text: 'Sending', tone: 'warn', explain: 'The payout is being sent.' },
  };

  function renderPay() {
    const c = state.caseView;
    const section = $('#pay');
    section.hidden = !c.proposal;
    if (!c.proposal) return;
    const button = $('#pay-btn');
    const sent = c.payout && !['NOT_SENT', 'REJECTED'].includes(c.payout.state);
    const configured = state.config.paypal.mode !== 'unconfigured';
    const live = approvalIsLive();
    button.disabled = !live || sent || !configured || state.busy === 'pay' || state.messageDirty;
    let hint;
    if (!configured) hint = 'PayPal is not configured on this server (set sandbox credentials or PAYPAL_MOCK=1).';
    else if (state.messageDirty && !sent) hint = 'Save or undo your change to the message first.';
    else if (sent) hint = 'This approved payment was sent. The receipt below is what PayPal reports.';
    else if (live) hint = `Ready: ${money(c.proposal.core.payableCents, c.proposal.core.currency)} to ${c.proposal.core.payee.email}.`;
    else if (c.proposal.status === 'BLOCKED') hint = 'This payment is blocked. See the reasons above.';
    else hint = 'Approve the payment first. The button unlocks for exactly the approved preview.';
    if (state.config.paypal.mode === 'mock' && !sent) hint += ' MOCK PayPal answers: an in-process fake of the sandbox API, no network.';
    $('#pay-hint').textContent = hint;
    renderReceipt();
  }

  function renderReceipt() {
    const c = state.caseView;
    const box = $('#receipt');
    const payout = c.payout;
    if (!payout) {
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    box.hidden = false;
    const stamp = STAMPS[payout.state] ?? STAMPS.SENT;
    const receipt = payout.receipt;
    const environment = payout.environment === 'mock' ? 'MOCK PayPal' : `PayPal ${payout.environment}`;
    const fields = h('dl', { class: 'receipt-fields' });
    const add = (label, value, mono = false) => {
      if (value === null || value === undefined || value === '') return;
      fields.append(h('dt', { text: label }), h('dd', { class: mono ? 'mono' : null }, value));
    };
    if (receipt) {
      add('Payout batch', `${receipt.payoutBatchId} (${receipt.batchStatus ?? 'no status'})`, true);
      add('Payout item', receipt.payoutItemId ? `${receipt.payoutItemId} (${receipt.itemStatus ?? 'no status'})` : null, true);
      add('Transaction', receipt.transactionId, true);
      add('Amount', receipt.amount ? h('span', {}, `${receipt.amount.value} ${receipt.amount.currency} to `, emailNode(receipt.receiver)) : null);
      add('PayPal fee', receipt.fee ? `${receipt.fee.value} ${receipt.fee.currency}` : null);
      add('Item error', receipt.itemError ? `${receipt.itemError.name ?? ''} ${receipt.itemError.message ?? ''}`.trim() : null);
      add('Read back', `${clock(receipt.readbackAt)}, ${receipt.readbackAttempts} read${receipt.readbackAttempts === 1 ? '' : 's'} of ${environment}`);
      const labels = { amount: 'amount', currency: 'currency', receiver: 'receiver', senderBatchId: 'batch id', senderItemId: 'item id' };
      add('Matches approval', h('ul', { class: 'checks' }, Object.entries(receipt.checks).map(([key, ok]) => h('li', { 'data-ok': String(ok) },
        `${labels[key]} ${ok === true ? 'matches' : ok === false ? 'differs' : 'not reported yet'}`))));
    }
    add('sender_batch_id', payout.senderBatchId, true);
    if (payout.error) add('PayPal said', `${payout.error.code}: ${payout.error.message}`);
    if (payout.readbackError) add('Readback problem', payout.readbackError);
    if (payout.receiptSha256) add('Receipt SHA-256', payout.receiptSha256, true);

    const actions = h('div', { class: 'receipt-actions' });
    if (payout.batchId) actions.append(h('button', { type: 'button', class: 'button-quiet', id: 'refresh-btn', onclick: refreshPayout }, 'Check status again'));
    if (payout.state === 'UNKNOWN_AFTER_SEND') actions.append(h('button', { type: 'button', class: 'button-primary', id: 'reconcile-btn', onclick: reconcile }, 'Reconcile with PayPal'));
    if (receipt) actions.append(h('button', { type: 'button', class: 'button-quiet', onclick: downloadReceipt }, 'Download receipt (JSON)'));

    box.replaceChildren(...[
      h('div', { class: 'receipt-head' },
        h('div', {}, h('h3', { id: 'receipt-title', tabindex: '-1', text: 'PayPal receipt' }), h('p', { class: 'receipt-sub', text: environment })),
        h('span', { class: 'stamp', 'data-tone': stamp.tone, text: stamp.text })),
      h('p', { class: 'receipt-explain', text: stamp.explain }),
      payout.duplicateDetected ? h('p', { class: 'note', text: 'PayPal recognised this sender_batch_id and pointed to the existing batch. No second payout was created.' }) : null,
      fields,
      actions,
    ].filter(Boolean));
  }

  async function pay() {
    const c = state.caseView;
    const button = $('#pay-btn');
    showError('#pay-error', null);
    if (!approvalIsLive()) {
      showError('#pay-error', new Error('Approve the payment first.'));
      return;
    }
    state.busy = 'pay';
    setBusy(button, true, 'Paying and reading back…');
    try {
      const { case: caseView } = await api('/api/pay', { method: 'POST', body: { caseId: c.id, approvalToken: state.approval.token, previewHash: c.proposal.previewHash } });
      state.approval = { ...state.approval, used: true };
      state.busy = null;
      setCase(caseView);
      $('#receipt-title')?.focus({ preventScroll: true });
      $('#receipt').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
      toast(caseView.payout?.state === 'PAID_VERIFIED' ? 'Paid and verified by PayPal readback.' : 'Sent to PayPal. See the receipt.');
    } catch (error) {
      state.busy = null;
      if (error.code === 'HUMAN_APPROVAL_REQUIRED') state.approval = null;
      if (error.data?.error?.case) setCase(error.data.error.case);
      showError('#pay-error', error);
    } finally {
      setBusy(button, false);
      renderPay();
      renderApprove();
      renderProgress();
    }
  }

  async function refreshPayout() {
    const button = $('#refresh-btn');
    if (button) setBusy(button, true, 'Checking…');
    try {
      const { case: caseView } = await api(`/api/payout/${encodeURIComponent(state.caseView.id)}`);
      setCase(caseView);
    } catch (error) {
      showError('#pay-error', error);
      if (button) setBusy(button, false);
    }
  }

  async function reconcile() {
    const button = $('#reconcile-btn');
    if (button) setBusy(button, true, 'Reconciling…');
    try {
      const { case: caseView } = await api(`/api/payout/${encodeURIComponent(state.caseView.id)}/reconcile`, { method: 'POST', body: {} });
      setCase(caseView);
    } catch (error) {
      showError('#pay-error', error);
      if (button) setBusy(button, false);
    }
  }

  function downloadReceipt() {
    const payout = state.caseView.payout;
    const blob = new Blob([JSON.stringify({ receipt: payout.receipt, sha256: payout.receiptSha256 }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: `payonproof-receipt-${state.caseView.id}.json` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function schedulePoll() {
    clearTimeout(state.pollTimer);
    const payout = state.caseView?.payout;
    if (payout?.state === 'SENT' && payout.batchId && state.pollCount < 6) {
      state.pollTimer = setTimeout(async () => {
        state.pollCount += 1;
        await refreshPayout();
      }, 3000);
    } else if (payout?.state !== 'SENT') {
      state.pollCount = 0;
    }
  }

  async function refreshCase() {
    try {
      const { case: caseView } = await api(`/api/cases/${encodeURIComponent(state.caseView.id)}`);
      setCase(caseView);
    } catch {
      // The visible error already explains what happened.
    }
  }

  /* ---------- progress ---------- */

  function renderProgress() {
    const c = state.caseView;
    const sent = Boolean(c?.payout && !['NOT_SENT', 'REJECTED'].includes(c.payout.state));
    const paid = c?.payout?.state === 'PAID_VERIFIED';
    const steps = {
      documents: c ? 'done' : 'current',
      proof: c ? 'done' : 'todo',
      approve: c ? (approvalIsLive() || sent ? 'done' : 'current') : 'todo',
      pay: paid ? 'done' : (approvalIsLive() || sent ? 'current' : 'todo'),
    };
    for (const li of document.querySelectorAll('.progress li')) {
      const value = steps[li.dataset.step];
      li.dataset.state = value;
      if (value === 'current') li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    }
  }

  /* ---------- wiring ---------- */

  function wire() {
    $('#theme-toggle').addEventListener('click', () => {
      const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
      applyTheme(next);
    });
    $('#tab-samples').addEventListener('click', () => selectTab('samples'));
    $('#tab-paste').addEventListener('click', () => selectTab('paste'));
    for (const tab of document.querySelectorAll('.tabs [role="tab"]')) {
      tab.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault();
          selectTab(state.mode === 'samples' ? 'paste' : 'samples', true);
        }
      });
    }
    $('#paste-fill').addEventListener('click', () => fillFromSample($('#paste-sample').value));
    for (const input of document.querySelectorAll('.file-pick input')) {
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        if (file.size > 60_000) {
          toast('That file is larger than 60 KB. Paste the relevant part instead.');
          return;
        }
        document.getElementById(input.dataset.target).value = await file.text();
        input.value = '';
      });
    }
    $('#analyze-btn').addEventListener('click', analyze);
    $('#message-text').addEventListener('input', () => {
      const dirty = $('#message-text').value !== (state.caseView?.message?.text ?? '');
      if (dirty !== state.messageDirty) {
        state.messageDirty = dirty;
        renderApprove();
        renderPay();
      }
    });
    $('#save-message').addEventListener('click', saveMessage);
    $('#copy-message').addEventListener('click', () => copyText($('#message-text').value, 'Message copied.'));
    $('#approve-btn').addEventListener('click', approve);
    $('#pay-btn').addEventListener('click', pay);
    setInterval(() => {
      if (!state.caseView || !state.approval) return;
      renderApprovalState();
      const button = $('#pay-btn');
      if (!button.disabled && !approvalIsLive()) {
        renderApprove();
        renderPay();
        renderProgress();
      }
    }, 1000);
  }

  async function init() {
    applyTheme(currentTheme());
    wire();
    renderProgress();
    try {
      const [config, cases] = await Promise.all([api('/api/config'), api('/api/cases')]);
      state.config = config;
      state.samples = cases.samples;
      state.sampleId = cases.samples[0]?.id ?? null;
      renderHeader();
      renderCasePicker();
    } catch (error) {
      showError('#analyze-error', new Error(`The server could not be reached: ${error.message}`));
      return;
    }
    const caseId = new URLSearchParams(window.location.search).get('case');
    if (caseId) {
      try {
        const { case: caseView } = await api(`/api/cases/${encodeURIComponent(caseId)}`);
        setCase(caseView, { fresh: true });
        if (window.location.hash === '#approve') $('#approve').scrollIntoView({ block: 'start' });
      } catch (error) {
        showError('#analyze-error', error);
      }
    }
  }

  init();
})();
