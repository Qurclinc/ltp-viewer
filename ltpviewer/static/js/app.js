/* LTP Viewer — single-page UI. No dependencies; works served by Flask or as a static export. */
(() => {
  "use strict";

  // ------------------------------------------------------------------ utils
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  const nf = new Intl.NumberFormat("en");
  const fmtN = (n) => nf.format(n ?? 0);
  const pct = (n, total) => (total ? (100 * n) / total : 0);
  const fmtPct = (n, total) => {
    const p = pct(n, total);
    return p === 0 ? "0%" : p < 0.1 ? "<0.1%" : p < 10 ? p.toFixed(1) + "%" : Math.round(p) + "%";
  };
  const debounce = (fn, ms) => {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };
  const icon = (id, cls = "") => `<svg class="${cls}"><use href="#i-${id}"/></svg>`;

  function fmtDur(s) {
    if (s == null || isNaN(s)) return "—";
    if (s < 1) return `${Math.round(s * 1000)} ms`;
    if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)} s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
    return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  }
  function fmtBytesKb(v) {
    const m = /^(\d+)\s*kB$/i.exec(String(v || ""));
    if (!m) return v;
    const gib = +m[1] / 1024 / 1024;
    return gib >= 1 ? `${gib.toFixed(1)} GiB` : `${(+m[1] / 1024).toFixed(0)} MiB`;
  }
  function toast(msg, isErr = false) {
    const el = document.createElement("div");
    el.className = "toast" + (isErr ? " err" : "");
    el.textContent = msg;
    $("#toasts").append(el);
    setTimeout(() => el.remove(), isErr ? 6000 : 2200);
  }
  async function copyText(text, what = "Copied") {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    toast(what);
  }
  function download(name, text, type = "text/plain") {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // -------------------------------------------------------------- constants
  const STATUSES = ["fail", "brok", "warn", "conf", "pass"];
  const STATUS_META = {
    fail: { label: "Failed", tag: "FAIL", desc: "TFAIL: the test detected a failure" },
    brok: { label: "Broken", tag: "BROK", desc: "TBROK: the test could not run properly (setup error, timeout, missing resource…)" },
    warn: { label: "Warning", tag: "WARN", desc: "TWARN: finished with warnings (often cleanup problems)" },
    conf: { label: "Skipped", tag: "CONF", desc: "TCONF: not applicable to this system or configuration" },
    pass: { label: "Passed", tag: "PASS", desc: "TPASS: all checks passed" },
    gone: { label: "Missing", tag: "GONE", desc: "Present only in the baseline report" },
  };
  const statusMeta = (s) => STATUS_META[s] || { label: s, tag: String(s).toUpperCase().slice(0, 4), desc: "Unknown status" };
  const statusRank = (s) => { const i = STATUSES.indexOf(s); return i < 0 ? (s === "gone" ? 6 : 5) : i; };
  const stCls = (s) => "st-" + (STATUS_META[s] ? s : "unknown");
  const PROBLEMS = ["fail", "brok", "warn"];
  const isProblem = (s) => PROBLEMS.includes(s);
  const STATUS_ALIASES = {
    fail: ["fail"], failed: ["fail"], tfail: ["fail"], brok: ["brok"], broken: ["brok"], tbrok: ["brok"],
    warn: ["warn"], warning: ["warn"], warnings: ["warn"], twarn: ["warn"], conf: ["conf"], tconf: ["conf"],
    skip: ["conf"], skipped: ["conf"], pass: ["pass"], passed: ["pass"], tpass: ["pass"], ok: ["pass"],
    gone: ["gone"], missing: ["gone"], problem: PROBLEMS, problems: PROBLEMS, bad: PROBLEMS,
  };

  const CHANGES = ["regressed", "fixed", "changed", "new", "missing", "same"];
  const CHANGE_META = {
    regressed: { label: "Regressed", sym: "↓", desc: "Was fine in the baseline, now failed / broken / warning" },
    fixed: { label: "Fixed", sym: "↑", desc: "Was a problem in the baseline, now isn't" },
    changed: { label: "Changed", sym: "~", desc: "Status changed in another way (e.g. pass → skipped)" },
    new: { label: "New", sym: "+", desc: "Not present in the baseline" },
    missing: { label: "Missing", sym: "−", desc: "Present in the baseline only" },
    same: { label: "Same", sym: "=", desc: "Same status as in the baseline" },
  };

  // LTP exit code bitmask (include/tst_res_flags.h)
  const EXIT_BITS = [[1, "TFAIL"], [2, "TBROK"], [4, "TWARN"], [16, "TINFO"], [32, "TCONF"]];
  function decodeExit(code) {
    if (code == null) return "unknown";
    if (code === 0) return "success";
    if (code > 63 || code < 0) return "non-LTP exit code";
    const names = EXIT_BITS.filter(([b]) => code & b).map(([, n]) => n);
    return names.length ? names.join(" | ") : "non-LTP exit code";
  }

  const DUR_BUCKETS = [
    ["< 0.1 s", 0, 0.1], ["0.1–1 s", 0.1, 1], ["1–10 s", 1, 10],
    ["10–60 s", 10, 60], ["1–5 min", 60, 300], ["≥ 5 min", 300, Infinity],
  ];
  const durBucket = (d) => (d == null ? "n/a" : (DUR_BUCKETS.find(([, lo, hi]) => d >= lo && d < hi) || DUR_BUCKETS[5])[0]);
  const DUR_ORDER = [...DUR_BUCKETS.map((b) => b[0]), "n/a"];

  const LEVELS = ["TFAIL", "TBROK", "TWARN", "TCONF", "TPASS", "TINFO", "other"];
  const LEVEL_STATUS = { TFAIL: "fail", TBROK: "brok", TWARN: "warn", TCONF: "conf", TPASS: "pass" };

  // Kernel command line knowledge: shown as tooltips on the environment card.
  const CMDLINE_DOCS = {
    mitigations: "CPU vulnerability mitigations (auto, auto,nosmt, off)",
    nosmt: "Disable simultaneous multithreading (SMT / Hyper-Threading)",
    "page_alloc.shuffle": "Randomize the page allocator free lists",
    slab_nomerge: "Never merge slab caches of similar size (hardens against heap exploitation)",
    slub_nomerge: "Never merge slab caches of similar size",
    init_on_free: "Zero memory when it is freed",
    init_on_alloc: "Zero memory when it is allocated",
    hardened_usercopy: "Bounds-check copies between kernel and user space",
    "kfence.sample_interval": "KFENCE memory-safety error detector sample interval (ms)",
    lockdown: "Kernel lockdown LSM: integrity or confidentiality",
    "module.sig_enforce": "Only load modules with a valid signature",
    efi: "EFI options; disable_early_pci_dma blocks bus-master DMA before the IOMMU is up",
    iommu: "IOMMU mode; force = always use the IOMMU",
    amd_iommu: "AMD IOMMU options",
    intel_iommu: "Intel IOMMU options",
    "iommu.strict": "Invalidate the IOTLB synchronously on unmap (no lazy DMA window)",
    "iommu.passthrough": "Bypass DMA translation (1 weakens DMA protection)",
    debugfs: "debugfs availability (off = not registered at all)",
    "proc_mem.force_override": "Whether /proc/PID/mem may override page protections (never = hardened)",
    randomize_kstack_offset: "Randomize the kernel stack offset on each syscall",
    vsyscall: "Legacy vsyscall page (none = disabled)",
    pti: "Page Table Isolation (Meltdown mitigation)",
    nopti: "Disables Page Table Isolation",
    spectre_v2: "Spectre v2 mitigation mode",
    spectre_bhi: "Branch History Injection mitigation",
    spec_store_bypass_disable: "Speculative Store Bypass (Spectre v4) mitigation",
    l1tf: "L1 Terminal Fault mitigation",
    mds: "Microarchitectural Data Sampling mitigation",
    tsx: "Intel TSX control",
    tsx_async_abort: "TSX Async Abort mitigation",
    retbleed: "Retbleed mitigation",
    "kvm.nx_huge_pages": "iTLB multihit mitigation for KVM",
    oops: "oops=panic: panic on kernel oops",
    panic: "Seconds before reboot after a panic",
    lsm: "Ordered list of enabled Linux Security Modules",
    security: "Primary LSM",
    apparmor: "Enable/disable AppArmor",
    selinux: "Enable/disable SELinux",
    ia32_emulation: "32-bit syscall emulation (0 reduces attack surface)",
    "loadpin.enforce": "Only load kernel files from the first filesystem used",
    page_poison: "Poison freed pages",
    slub_debug: "SLUB allocator debugging / poisoning",
    rodata: "Read-only kernel data (off weakens)",
    nokaslr: "Disables kernel address space layout randomization",
    kaslr: "Kernel address space layout randomization",
    nosmep: "Disables SMEP", nosmap: "Disables SMAP",
    sysrq_always_enabled: "Enables all SysRq functions",
    norandmaps: "Disables address space randomization",
    "vdso32": "32-bit vDSO", "random.trust_cpu": "Trust the CPU RNG to seed the pool",
    "random.trust_bootloader": "Trust the bootloader-provided seed",
    hash_pointers: "Hash kernel pointers printed with %p",
    "bdev_allow_write_mounted": "Allow writes to mounted block devices (0 = hardened)",
    quiet: "Less verbose boot log", ro: "Mount root read-only initially", rw: "Mount root read-write",
    root: "Root filesystem", BOOT_IMAGE: "Kernel image loaded by the bootloader",
  };
  const WEAK_KEYS = new Set(["nokaslr", "nosmep", "nosmap", "nopti", "nospectre_v1", "nospectre_v2", "sysrq_always_enabled", "norandmaps"]);
  const NEUTRAL_KEYS = new Set(["quiet", "ro", "rw", "root", "BOOT_IMAGE", "panic", "console", "init", "splash", "loglevel", "random.trust_cpu", "random.trust_bootloader", "vdso32", "tsx", "kaslr"]);
  function paramKind(k, v) {
    if (WEAK_KEYS.has(k)) return "weak";
    if (!(k in CMDLINE_DOCS) || NEUTRAL_KEYS.has(k)) return "";
    const val = String(v ?? "").toLowerCase();
    if (k === "mitigations") return val.startsWith("off") ? "weak" : "hard";
    if (k === "debugfs") return val === "on" ? "weak" : "hard";
    if (k === "iommu") return ["off", "pt"].includes(val) ? "weak" : "hard";
    if (k === "iommu.passthrough" || k === "bdev_allow_write_mounted") return ["1", "y", "on", "true"].includes(val) ? "weak" : "hard";
    if (k === "vsyscall") return val === "none" ? "hard" : "";
    if (k === "ia32_emulation") return ["0", "n", "no", "off", "false"].includes(val) ? "hard" : "";
    if (k === "proc_mem.force_override") return val === "always" ? "weak" : "hard";
    if (["off", "0", "n", "no", "none", "false"].includes(val)) return "weak";
    return "hard";
  }

  // ------------------------------------------------------------- columns
  const subtestPills = (r) => {
    const parts = [["passed", "pass", "P"], ["failed", "fail", "F"], ["broken", "brok", "B"], ["skipped", "conf", "S"], ["warnings", "warn", "W"]]
      .filter(([k]) => r[k] > 0)
      .map(([k, s, l]) => `<span class="pill ${stCls(s)}" data-tip="${r[k]} ${k}">${l}<b>${r[k]}</b></span>`);
    return parts.length ? `<span class="pills">${parts.join("")}</span>` : `<span class="none">—</span>`;
  };
  const badge = (s, sm = false) => {
    const m = statusMeta(s);
    return `<span class="badge ${sm ? "sm " : ""}${stCls(s)}" data-tip="${esc(m.desc)}"><span class="dot"></span>${esc(m.tag)}</span>`;
  };
  const changePill = (c) => {
    if (!c) return `<span class="none">—</span>`;
    const m = CHANGE_META[c];
    return `<span class="chg chg-${c}" data-tip="${esc(m.desc)}"><i>${m.sym}</i>${m.label}</span>`;
  };
  const none = `<span class="none">—</span>`;
  const numCol = (id, label, title) => ({
    id, label, title, num: true, sort: (r) => r[id], text: (r) => r[id] ?? "",
    cell: (r) => (r[id] ? fmtN(r[id]) : `<span class="none">0</span>`),
  });

  const COLUMNS = [
    { id: "idx", label: "#", title: "Execution order", num: true, sort: (r) => (r.ghost ? Infinity : r.idx), text: (r) => (r.ghost ? "" : r.idx + 1), cell: (r) => (r.ghost ? none : `<span class="none">${r.idx + 1}</span>`) },
    { id: "status", label: "Status", sort: (r) => statusRank(r.status), text: (r) => statusMeta(r.status).label, cell: (r) => badge(r.status) },
    { id: "change", label: "Change", compare: true, sort: (r) => CHANGES.indexOf(r.change), text: (r) => r.change || "", cell: (r) => changePill(r.change) },
    { id: "baseline", label: "Baseline", compare: true, title: "Status in the baseline report", sort: (r) => (r.base ? statusRank(r.base.status) : 99), text: (r) => (r.base ? statusMeta(r.base.status).label : ""), cell: (r) => (r.base ? badge(r.base.status, true) : none) },
    {
      id: "name", label: "Test", sort: (r) => r.name, text: (r) => r.name,
      cell: (r) => `<span class="name">${esc(r.name)}</span>${r.occurrence ? `<span class="occ" data-tip="Run #${r.occurrence + 1} of this test in the report (e.g. listed in several runtest files)">#${r.occurrence + 1}</span>` : ""}${r.args.length ? `<span class="args" data-tip="${esc(r.cmdline)}">${esc(r.args.join(" "))}</span>` : ""}`,
    },
    { id: "command", label: "Command", sort: (r) => r.cmdline, text: (r) => r.cmdline, cell: (r) => `<span class="mono" data-tip="${esc(r.cmdline)}">${esc(r.cmdline)}</span>` },
    { id: "family", label: "Family", title: "Test name without the trailing number", sort: (r) => r.family, text: (r) => r.family, cell: (r) => `<span class="mono">${esc(r.family)}</span>` },
    { id: "subsystem", label: "Subsystem", title: "First token of the family (heuristic)", sort: (r) => r.subsystem, text: (r) => r.subsystem, cell: (r) => `<span class="mono">${esc(r.subsystem)}</span>` },
    {
      id: "reason", label: "Reason", title: "First relevant TFAIL / TBROK / TWARN / TCONF message", sort: (r) => r.reason_key || "￿", text: (r) => r.reason || "",
      cell: (r) => (r.reason ? `<span class="reason" data-tip="${esc(r.reason)}">${r.reason_level ? `<span class="lvl">${r.reason_level}</span>` : ""}${esc(r.reason)}</span>` : none),
    },
    { id: "errno", label: "Errno", sort: (r) => r.errno || "￿", text: (r) => r.errno || "", cell: (r) => (r.errno ? `<span class="errno">${esc(r.errno)}</span>` : none) },
    { id: "kconfig", label: "Kernel config", title: "Unsatisfied kernel config constraints", sort: (r) => r.kconfig.join(",") || "￿", text: (r) => r.kconfig.join(" "), cell: (r) => (r.kconfig.length ? `<span class="mono" data-tip="${esc(r.kconfig.join("\n"))}">${esc(r.kconfig.join(", "))}</span>` : none) },
    { id: "retval", label: "Exit", title: "Process exit code (LTP bitmask)", num: true, sort: (r) => r.retval, text: (r) => r.retval ?? "", cell: (r) => (r.retval == null ? none : `<span data-tip="${esc(decodeExit(r.retval))}">${r.retval}</span>`) },
    { id: "subtests", label: "Subtests", title: "Subtest results reported by the test (TPASS / TFAIL / TBROK / TCONF / TWARN)", sort: (r) => -(r.failed * 1e9 + r.broken * 1e6 + r.warnings * 1e3 + r.skipped), text: (r) => `P${r.passed} F${r.failed} B${r.broken} S${r.skipped} W${r.warnings}`, cell: subtestPills },
    numCol("passed", "Passed", "TPASS count"),
    numCol("failed", "Failed", "TFAIL count"),
    numCol("broken", "Broken", "TBROK count"),
    numCol("skipped", "Skipped", "TCONF count"),
    numCol("warnings", "Warn", "TWARN count"),
    {
      id: "duration", label: "Duration", num: true, sort: (r) => r.duration, text: (r) => (r.duration == null ? "" : r.duration.toFixed(3)),
      cell: (r) => {
        if (r.duration == null) return none;
        const w = state.maxDurLog ? Math.max(2, (48 * Math.log10(1 + r.duration)) / state.maxDurLog) : 0;
        return `<span class="durcell" data-tip="${r.duration.toFixed(3)} s"><span>${fmtDur(r.duration)}</span><span class="dbar" style="width:${w.toFixed(1)}px"></span></span>`;
      },
    },
    {
      id: "ddur", label: "Δ Time", compare: true, title: "Duration difference vs baseline", num: true,
      sort: (r) => (r.base && r.duration != null && r.base.duration != null ? r.duration - r.base.duration : null),
      text: (r) => (r.base && r.duration != null && r.base.duration != null ? (r.duration - r.base.duration).toFixed(3) : ""),
      cell: (r) => {
        if (!r.base || r.duration == null || r.base.duration == null) return none;
        const d = r.duration - r.base.duration;
        if (Math.abs(d) < 0.005) return `<span class="none">±0</span>`;
        return `<span data-tip="baseline ${fmtDur(r.base.duration)}">${d > 0 ? "+" : "−"}${fmtDur(Math.abs(d))}</span>`;
      },
    },
    { id: "log_lines", label: "Log", title: "Log length in lines", num: true, sort: (r) => r.log_lines, text: (r) => r.log_lines ?? "", cell: (r) => fmtN(r.log_lines) },
  ];
  const COL = Object.fromEntries(COLUMNS.map((c) => [c.id, c]));
  const DEFAULT_COLS = ["status", "change", "baseline", "name", "reason", "errno", "retval", "subtests", "duration"];

  // ------------------------------------------------------- facets & groups
  const FACETS = [
    { id: "change", label: "Change vs baseline", compare: true, get: (r) => r.change, order: CHANGES, fmt: (v) => CHANGE_META[v]?.label || v },
    { id: "subsystem", label: "Subsystem", get: (r) => r.subsystem, mono: true, searchable: true },
    { id: "errno", label: "Errno", get: (r) => r.errno || "", mono: true, fmt: (v) => v || "(none)" },
    { id: "kconfig", label: "Missing kernel config", multi: (r) => r.kconfig, mono: true, hideEmpty: true },
    { id: "retval", label: "Exit code", get: (r) => (r.retval == null ? "" : String(r.retval)), mono: true, fmt: (v) => (v === "" ? "(none)" : `${v}  ${decodeExit(+v)}`), sortNum: true },
    { id: "duration", label: "Duration", get: (r) => durBucket(r.duration), order: DUR_ORDER },
    { id: "family", label: "Test family", get: (r) => r.family, mono: true, searchable: true, closed: true },
    { id: "reason", label: "Reason", get: (r) => r.reason_key || "", hidden: true, fmt: (v) => v || "(no message)" },
  ];
  const FACET = Object.fromEntries(FACETS.map((f) => [f.id, f]));

  const GROUPS = [
    { id: "none", label: "None" },
    { id: "status", label: "Status", key: (r) => r.status, title: (k) => statusMeta(k).label, sortKey: (k) => statusRank(k), facet: "status" },
    { id: "change", label: "Change", compare: true, key: (r) => r.change, title: (k) => CHANGE_META[k]?.label || k, sortKey: (k) => CHANGES.indexOf(k), facet: "change" },
    { id: "subsystem", label: "Subsystem", key: (r) => r.subsystem, mono: true, facet: "subsystem" },
    { id: "family", label: "Family", key: (r) => r.family, mono: true, facet: "family" },
    { id: "reason", label: "Reason", key: (r) => r.reason_key || "", title: (k) => k || "(no message)", facet: "reason" },
    { id: "errno", label: "Errno", key: (r) => r.errno || "", title: (k) => k || "(no errno)", mono: true, facet: "errno" },
    { id: "retval", label: "Exit code", key: (r) => (r.retval == null ? "" : String(r.retval)), title: (k) => (k === "" ? "(none)" : `${k} · ${decodeExit(+k)}`), sortKey: (k) => +k, facet: "retval" },
    { id: "duration", label: "Duration", key: (r) => durBucket(r.duration), sortKey: (k) => DUR_ORDER.indexOf(k), facet: "duration" },
  ];
  const GROUP = Object.fromEntries(GROUPS.map((g) => [g.id, g]));

  // ------------------------------------------------------------------- api
  const STATIC = window.__LTP_STATIC__ || null;
  async function getJSON(url, opts) {
    const res = await fetch(url, opts);
    let body = null;
    try { body = await res.json(); } catch { /* not json */ }
    if (!res.ok) throw new Error((body && body.error) || `${res.status} ${res.statusText}`);
    return body;
  }
  const enc = encodeURIComponent;
  const api = STATIC
    ? {
        async list() {
          return { reports: STATIC.reports, allow_upload: false, errors: [] };
        },
        async report(id) {
          const r = STATIC.reports.find((x) => x.id === id);
          if (!r) throw new Error(`unknown report ${id}`);
          return r;
        },
        async log(id, idx) {
          return (await this.report(id)).logs[idx] ?? "";
        },
        async search(id, q, regex) {
          const rx = new RegExp(regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
          const r = await this.report(id);
          return r.logs.reduce((acc, l, i) => (rx.test(l) ? (acc.push(i), acc) : acc), []);
        },
      }
    : {
        list: () => getJSON("api/reports"),
        report: (id) => getJSON(`api/reports/${enc(id)}`),
        log: async (id, idx) => (await getJSON(`api/reports/${enc(id)}/tests/${idx}/log`)).log,
        search: async (id, q, regex) => (await getJSON(`api/reports/${enc(id)}/search?q=${enc(q)}&regex=${regex ? 1 : 0}`)).hits,
        async upload(files) {
          const fd = new FormData();
          [...files].forEach((f) => fd.append("file", f, f.name));
          return getJSON("api/reports", { method: "POST", body: fd });
        },
        remove: (id) => getJSON(`api/reports/${enc(id)}`, { method: "DELETE" }),
      };

  const reportCache = new Map();
  const logCache = new Map();
  function loadReport(id) {
    if (!reportCache.has(id)) {
      reportCache.set(id, api.report(id).then(prepareReport).catch((e) => { reportCache.delete(id); throw e; }));
    }
    return reportCache.get(id);
  }
  async function getLog(reportId, idx) {
    const k = reportId + ":" + idx;
    if (!logCache.has(k)) logCache.set(k, api.log(reportId, idx));
    return logCache.get(k);
  }
  function prepareReport(rep) {
    for (const t of rep.tests) {
      t.kconfig = t.kconfig || [];
      t.args = t.args || [];
      t.hay = [t.name, t.cmdline, t.family, t.reason || ""].join("\u0001").toLowerCase();
    }
    rep.byKey = new Map(rep.tests.map((t) => [t.key, t]));
    return rep;
  }

  // ----------------------------------------------------------------- state
  const PREFS_KEY = "ltpv.prefs";
  const prefs = Object.assign(
    { cols: DEFAULT_COLS, density: "normal", sidebar: true, overview: true, wrap: false, hiddenLevels: [], drawerW: null, closedFacets: {}, topTab: "problems" },
    (() => { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; } })()
  );
  const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ } };

  const state = {
    reports: [], allowUpload: false,
    reportId: null, baselineId: null, report: null, baseline: null,
    rows: [], view: [], flat: [], items: [],
    q: "", regex: false, statuses: new Set(),
    facets: Object.fromEntries(FACETS.map((f) => [f.id, new Set()])),
    facetSearch: {}, facetExpanded: {},
    group: "none", sort: { key: "status", dir: 1 },
    collapsed: new Set(),
    selKey: null, openKey: null, drawerTab: "log",
    limit: 600, maxDurLog: 0,
    logSearch: new Map(), queryInfo: null,
  };

  // ---------------------------------------------------------- url <-> state
  let lastHash = "";
  function stateToHash() {
    const p = new URLSearchParams();
    if (state.reportId) p.set("r", state.reportId);
    if (state.baselineId) p.set("b", state.baselineId);
    if (state.q) p.set("q", state.q);
    if (state.regex) p.set("re", "1");
    if (state.statuses.size) p.set("st", [...state.statuses].join(","));
    for (const [id, set] of Object.entries(state.facets)) for (const v of set) p.append("f_" + id, v);
    if (state.group !== "none") p.set("g", state.group);
    if (!(state.sort.key === "status" && state.sort.dir === 1)) p.set("s", `${state.sort.key}${state.sort.dir < 0 ? ":desc" : ""}`);
    if (state.openKey) p.set("t", state.openKey);
    return p.toString();
  }
  function syncHash() {
    const h = stateToHash();
    if (h !== lastHash) {
      lastHash = h;
      history.replaceState(null, "", h ? "#" + h : location.pathname + location.search);
    }
  }
  function hashToState() {
    const p = new URLSearchParams(location.hash.slice(1));
    lastHash = location.hash.slice(1);
    state.reportId = p.get("r") || state.reportId;
    state.baselineId = p.get("b") || null;
    state.q = p.get("q") || "";
    state.regex = p.get("re") === "1";
    state.statuses = new Set((p.get("st") || "").split(",").filter(Boolean));
    for (const f of FACETS) state.facets[f.id] = new Set(p.getAll("f_" + f.id));
    state.group = GROUP[p.get("g")] ? p.get("g") : "none";
    const s = (p.get("s") || "status").split(":");
    state.sort = { key: COL[s[0]] ? s[0] : "status", dir: s[1] === "desc" ? -1 : 1 };
    state.openKey = p.get("t") || null;
    state.collapsed.clear();
  }

  // ------------------------------------------------------------- rows/diff
  function buildRows() {
    const rep = state.report;
    const base = state.baseline;
    if (!rep) { state.rows = []; return; }
    const rows = rep.tests.map((t) => ({ ...t, ghost: false, base: null, change: null }));
    if (base) {
      for (const r of rows) {
        const b = base.byKey.get(r.key);
        r.base = b || null;
        if (!b) r.change = "new";
        else if (b.status === r.status) r.change = "same";
        else if (isProblem(r.status) && !isProblem(b.status)) r.change = "regressed";
        else if (!isProblem(r.status) && isProblem(b.status)) r.change = "fixed";
        else r.change = "changed";
      }
      for (const b of base.tests) {
        if (!rep.byKey.has(b.key)) {
          rows.push({ ...b, idx: -1, ghost: true, status: "gone", base: b, change: "missing" });
        }
      }
    }
    state.rows = rows;
    const maxDur = Math.max(0, ...rows.map((r) => r.duration || 0));
    state.maxDurLog = Math.log10(1 + maxDur);
  }

  // ----------------------------------------------------------------- query
  const FIELD_ALIASES = {
    name: "name", n: "name", test: "name", status: "status", is: "status", st: "status",
    family: "family", fam: "family", sub: "subsystem", subsystem: "subsystem",
    reason: "reason", msg: "reason", message: "reason", errno: "errno", err: "errno",
    cmd: "cmd", command: "cmd", args: "cmd", kconfig: "kconfig", config: "kconfig",
    exit: "exit", ret: "exit", retval: "exit", rc: "exit", dur: "dur", duration: "dur", time: "dur",
    passed: "passed", failed: "failed", broken: "broken", skipped: "skipped", warnings: "warnings", warns: "warnings",
    change: "change", diff: "change", log: "log",
  };
  const TOKEN_RE = /(-?)(?:([A-Za-z_]+)(:|>=|<=|>|<|=))?(?:"([^"]*)"?|(\S+))/g;
  const cmpNum = (op, a, b) => {
    if (a == null || isNaN(a)) return false;
    switch (op) {
      case ">": return a > b;
      case ">=": return a >= b;
      case "<": return a < b;
      case "<=": return a <= b;
      default: return a === b;
    }
  };

  function compileQuery(q, regex) {
    const preds = [], logTerms = [], errors = [];
    const text = (s) => String(s ?? "").toLowerCase();
    const matcher = (val) => {
      if (regex) {
        try { const rx = new RegExp(val, "i"); return (s) => rx.test(s ?? ""); }
        catch (e) { errors.push(e.message); return () => true; }
      }
      const v = val.toLowerCase();
      return (s) => text(s).includes(v);
    };
    let m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(q))) {
      const neg = m[1] === "-";
      let key = m[2] ? FIELD_ALIASES[m[2].toLowerCase()] : null;
      let op = m[3];
      let val = m[4] ?? m[5] ?? "";
      if (m[2] && !key) { val = m[0].slice(neg ? 1 : 0).replace(/^"|"$/g, ""); op = null; }
      if (!val && key !== "log") continue;
      let p;
      switch (key) {
        case "name": { const f = matcher(val); p = (r) => f(r.name); break; }
        case "family": { const f = matcher(val); p = (r) => f(r.family); break; }
        case "subsystem": { const f = matcher(val); p = (r) => f(r.subsystem); break; }
        case "reason": { const f = matcher(val); p = (r) => f(r.reason); break; }
        case "cmd": { const f = matcher(val); p = (r) => f(r.cmdline); break; }
        case "kconfig": { const f = matcher(val); p = (r) => r.kconfig.some(f); break; }
        case "errno": { const vs = val.toUpperCase().split(","); p = (r) => vs.includes(r.errno || "") || (vs.includes("NONE") && !r.errno); break; }
        case "status": {
          const sts = new Set(val.toLowerCase().split(",").flatMap((v) => STATUS_ALIASES[v] || [v]));
          p = (r) => sts.has(r.status);
          break;
        }
        case "change": { const cs = val.toLowerCase().split(","); p = (r) => cs.includes(r.change); break; }
        case "exit": case "dur": case "passed": case "failed": case "broken": case "skipped": case "warnings": {
          const num = parseFloat(val);
          if (isNaN(num)) { errors.push(`${m[2]}: expected a number`); continue; }
          const realOp = op === ":" ? (key === "dur" ? ">=" : "=") : op;
          const field = key === "exit" ? "retval" : key === "dur" ? "duration" : key;
          p = (r) => cmpNum(realOp, r[field], num);
          break;
        }
        case "log": {
          if (!val) continue;
          const k = `${state.reportId}|${regex ? 1 : 0}|${val}`;
          logTerms.push({ k, val, neg });
          p = (r) => {
            const e = state.logSearch.get(k);
            if (!e || e.status !== "done") return !neg; // pending / error: don't hide anything
            return !r.ghost && e.hits.has(r.idx);
          };
          break;
        }
        default: {
          if (regex) {
            try { const rx = new RegExp(val, "i"); p = (r) => rx.test(r.hay); }
            catch (e) { errors.push(e.message); continue; }
          } else {
            const v = val.toLowerCase();
            p = (r) => r.hay.includes(v);
          }
        }
      }
      preds.push(neg ? (r) => !p(r) : p);
    }
    return { match: (r) => preds.every((p) => p(r)), logTerms, errors, empty: !preds.length };
  }

  function ensureLogSearches(terms) {
    for (const t of terms) {
      if (state.logSearch.has(t.k)) continue;
      const entry = { status: "pending", hits: new Set() };
      state.logSearch.set(t.k, entry);
      const reportId = state.reportId;
      api.search(reportId, t.val, state.regex)
        .then((hits) => { entry.status = "done"; entry.hits = new Set(hits); })
        .catch((e) => { entry.status = "error"; entry.error = e.message; })
        .finally(() => { if (reportId === state.reportId) update(); });
    }
  }

  // ---------------------------------------------------------------- filter
  function facetValues(f, r) {
    return f.multi ? f.multi(r) : [f.get(r)];
  }
  function activeFilters() {
    const fs = [];
    if (state.statuses.size) fs.push({ id: "status", test: (r) => state.statuses.has(r.status) });
    for (const f of FACETS) {
      const set = state.facets[f.id];
      if (!set.size || (f.compare && !state.baseline)) continue;
      fs.push({ id: f.id, test: (r) => facetValues(f, r).some((v) => set.has(v)) });
    }
    return fs;
  }

  function computeView() {
    const qi = compileQuery(state.q, state.regex);
    state.queryInfo = qi;
    ensureLogSearches(qi.logTerms);
    const base = qi.empty ? state.rows : state.rows.filter(qi.match);
    const fs = activeFilters();
    const view = base.filter((r) => fs.every((f) => f.test(r)));

    // counts for facets / chips: everything except the facet's own filter
    const counts = {};
    const countFor = (id, valuesOf) => {
      const c = new Map();
      const others = fs.filter((f) => f.id !== id);
      for (const r of base) {
        if (!others.every((f) => f.test(r))) continue;
        for (const v of valuesOf(r)) c.set(v, (c.get(v) || 0) + 1);
      }
      return c;
    };
    counts.status = countFor("status", (r) => [r.status]);
    for (const f of FACETS) if (!f.hidden && !(f.compare && !state.baseline)) counts[f.id] = countFor(f.id, (r) => facetValues(f, r));
    state.counts = counts;

    // sort
    const col = COL[state.sort.key] || COL.status;
    const dir = state.sort.dir;
    const keyed = view.map((r) => [col.sort(r), r]);
    keyed.sort((a, b) => {
      const [x, y] = [a[0], b[0]];
      const xn = x == null || (typeof x === "number" && isNaN(x));
      const yn = y == null || (typeof y === "number" && isNaN(y));
      if (xn || yn) return xn && yn ? 0 : xn ? 1 : -1;
      const c = typeof x === "number" && typeof y === "number" ? x - y : collator.compare(String(x), String(y));
      if (c) return c * dir;
      return collator.compare(a[1].name, b[1].name) || a[1].idx - b[1].idx;
    });
    state.view = keyed.map((k) => k[1]);

    // group
    const g = GROUP[state.group];
    const items = [];
    const flat = [];
    if (!g || g.id === "none" || (g.compare && !state.baseline)) {
      for (const r of state.view) { items.push({ row: r }); flat.push(r); }
    } else {
      const groups = new Map();
      for (const r of state.view) {
        const k = g.key(r);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      }
      const problemsOf = (rows) => rows.filter((r) => isProblem(r.status)).length;
      const ordered = [...groups.entries()].sort((a, b) => {
        if (g.sortKey) return g.sortKey(a[0]) - g.sortKey(b[0]);
        return problemsOf(b[1]) - problemsOf(a[1]) || b[1].length - a[1].length || collator.compare(a[0], b[0]);
      });
      for (const [k, rows] of ordered) {
        const collapsed = state.collapsed.has(k);
        items.push({ group: k, rows, collapsed });
        if (!collapsed) for (const r of rows) { items.push({ row: r }); flat.push(r); }
      }
    }
    state.items = items;
    state.flat = flat;
  }

  // ----------------------------------------------------------- rendering
  const visibleCols = () => COLUMNS.filter((c) => prefs.cols.includes(c.id) && (!c.compare || state.baseline));

  function renderPickers() {
    const opts = state.reports.map((r) => {
      const prob = (r.counts.fail || 0) + (r.counts.brok || 0);
      return `<option value="${esc(r.id)}">${esc(r.name)} · ${fmtN(r.total)} tests${prob ? ` · ${prob} problems` : ""}</option>`;
    });
    const rs = $("#report-select");
    rs.innerHTML = opts.join("");
    rs.value = state.reportId || "";
    const bs = $("#baseline-select");
    bs.innerHTML = `<option value="">— none —</option>` + state.reports.filter((r) => r.id !== state.reportId).map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("");
    bs.value = state.baselineId || "";
    bs.disabled = state.reports.length < 2;
    bs.closest(".picker").title = state.reports.length < 2 ? "Load a second report to compare (e.g. stock kernel vs hardened)" : "Compare against a baseline report";
    $(".report-pickers").hidden = !state.reports.length;
    $("#btn-upload").hidden = !state.allowUpload;
    $("#btn-remove").hidden = !state.allowUpload || !state.reportId;
    $$(".upload-only").forEach((e) => (e.hidden = !state.allowUpload));
  }

  function tile({ label, value, foot, cls = "", status, change, active, tip }) {
    const attrs = status ? `data-solo-status="${status}"` : change ? `data-solo-change="${change}"` : "";
    return `<button class="tile ${cls} ${active ? "active" : ""} ${!attrs ? "static" : ""}" ${attrs} ${tip ? `data-tip="${esc(tip)}"` : ""}>
      <div class="t-label">${status ? `<span class="dot ${stCls(status)}" style="background:var(--c)"></span>` : ""}${esc(label)}</div>
      <div class="t-value">${value}</div>
      <div class="t-foot">${foot || "&nbsp;"}</div></button>`;
  }

  function renderOverview() {
    const rep = state.report;
    const el = $("#overview");
    if (!rep) { el.hidden = true; return; }
    el.hidden = false;
    el.classList.toggle("collapsed", !prefs.overview);
    const env = rep.environment || {};
    const stats = rep.stats || {};
    const total = rep.tests.length;
    const counts = rep.counts || {};
    const base = state.baseline;
    const bc = base ? base.counts : null;

    const delta = (s) => {
      if (!bc) return "";
      const d = (counts[s] || 0) - (bc[s] || 0);
      if (!d) return `<span class="delta">±0 vs baseline</span>`;
      const good = s === "pass" ? d > 0 : isProblem(s) ? d < 0 : null;
      return `<span class="delta ${good == null ? "" : good ? "good" : "bad"}">${d > 0 ? "+" : "−"}${Math.abs(d)} vs baseline</span>`;
    };
    const tiles = [
      tile({ label: "Tests", value: fmtN(total), foot: stats.runtime ? `runtime ${fmtDur(stats.runtime)}` : "", tip: "Test executions in this report" }),
      ...["fail", "brok", "warn", "conf", "pass"].map((s) =>
        tile({
          label: statusMeta(s).label, status: s, value: fmtN(counts[s] || 0),
          foot: `${fmtPct(counts[s] || 0, total)} ${delta(s)}`,
          active: state.statuses.size === 1 && state.statuses.has(s), tip: statusMeta(s).desc + "\nClick to show only these",
        })
      ),
    ];

    let compareTiles = "";
    if (base) {
      const cc = {};
      for (const r of state.rows) cc[r.change] = (cc[r.change] || 0) + 1;
      compareTiles = `<div class="tiles">${CHANGES.filter((c) => c !== "same").map((c) =>
        tile({ label: CHANGE_META[c].label, change: c, value: fmtN(cc[c] || 0), foot: `vs ${esc(base.name)}`, tip: CHANGE_META[c].desc,
          active: state.facets.change.size === 1 && state.facets.change.has(c) })).join("")}</div>`;
    }

    const segs = STATUSES.filter((s) => counts[s]).map((s) =>
      `<span class="seg ${stCls(s)}" style="flex:${counts[s]}" data-solo-status="${s}" data-tip="${statusMeta(s).label}: ${fmtN(counts[s])} (${fmtPct(counts[s], total)})"></span>`).join("");
    const legend = STATUSES.filter((s) => counts[s]).map((s) =>
      `<span><i class="dot ${stCls(s)}" style="background:var(--c)"></i>${statusMeta(s).label} <b>${fmtN(counts[s])}</b></span>`).join("");
    const subtests = [["passed", "TPASS"], ["failed", "TFAIL"], ["broken", "TBROK"], ["skipped", "TCONF"], ["warnings", "TWARN"]]
      .filter(([k]) => stats[k] != null).map(([k, l]) => `<span><b>${fmtN(stats[k])}</b> ${l}</span>`).join("");

    // environment
    const envRows = [
      ["Distribution", [env.distribution, env.distribution_version].filter(Boolean).join(" ")],
      ["Kernel", env.kernel], ["Arch", env.arch], ["CPU", env.cpu && env.cpu !== "unknown" ? env.cpu : null],
      ["RAM", fmtBytesKb(env.RAM)], ["Swap", fmtBytesKb(env.swap)], ["LTP", rep.ltp_version],
    ];
    const known = new Set(["distribution", "distribution_version", "kernel", "arch", "cpu", "RAM", "swap", "cmdline"]);
    for (const [k, v] of Object.entries(env)) if (!known.has(k) && v != null && typeof v !== "object") envRows.push([k, String(v)]);
    const cmd = (env.cmdline || "").trim();
    const params = cmd ? cmd.split(/\s+/).map((p) => {
      const i = p.indexOf("=");
      const k = i < 0 ? p : p.slice(0, i);
      const v = i < 0 ? null : p.slice(i + 1);
      const kind = paramKind(k, v);
      const doc = CMDLINE_DOCS[k];
      return `<span class="param ${kind}" data-tip="${esc(p + (doc ? "\n" + doc : ""))}"><span class="k">${esc(k)}</span>${v != null ? `<span class="v">=${esc(v)}</span>` : ""}</span>`;
    }).join("") : "";

    // top reasons
    const reasonCounts = (filter) => {
      const m = new Map();
      for (const r of state.rows) {
        if (!filter(r) || !r.reason_key) continue;
        if (!m.has(r.reason_key)) m.set(r.reason_key, { n: 0, st: r.status });
        m.get(r.reason_key).n++;
      }
      return [...m.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 7);
    };
    const tab = prefs.topTab;
    let topItems;
    if (tab === "errno") {
      const m = new Map();
      for (const r of state.rows) if (isProblem(r.status) || r.status === "conf") if (r.errno) m.set(r.errno, (m.get(r.errno) || 0) + 1);
      topItems = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7)
        .map(([e, n]) => `<li data-facet="errno" data-value="${esc(e)}"><span class="n">${n}</span><span class="txt mono">${esc(e)}</span></li>`);
    } else {
      topItems = reasonCounts(tab === "skips" ? (r) => r.status === "conf" : (r) => isProblem(r.status))
        .map(([k, v]) => `<li data-facet="reason" data-value="${esc(k)}" data-tip="${esc(k)}"><span class="n">${v.n}</span><span class="txt"><i class="dot ${stCls(v.st)}" style="background:var(--c)"></i>${esc(k)}</span></li>`);
    }
    if (!topItems.length) topItems = [`<li class="empty-li">Nothing here 🎉</li>`];
    const slowest = [...state.rows].filter((r) => !r.ghost).sort((a, b) => (b.duration || 0) - (a.duration || 0)).slice(0, 7)
      .map((r) => `<li data-open="${esc(r.key)}"><span class="n">${fmtDur(r.duration)}</span><span class="txt"><i class="dot ${stCls(r.status)}" style="background:var(--c)"></i><span class="mono">${esc(r.name)}</span></span></li>`);

    const kernelShort = (env.kernel || "").replace(/^Linux\s+/, "").split(" ")[0];
    el.innerHTML = `
      <div class="ov-head">
        <h1 class="ov-title">${esc(rep.name)}</h1>
        <div class="ov-sub">
          ${kernelShort ? `<span>kernel <b>${esc(kernelShort)}</b></span>` : ""}
          ${rep.ltp_version ? `<span>LTP <b>${esc(rep.ltp_version)}</b></span>` : ""}
          ${base ? `<span>baseline <b>${esc(base.name)}</b></span>` : ""}
          ${rep.source ? `<span class="mono" title="${esc(rep.source)}">${esc(rep.source.length > 70 ? "…" + rep.source.slice(-68) : rep.source)}</span>` : ""}
        </div>
        <button class="btn ov-toggle" id="btn-overview">${prefs.overview ? "Hide overview" : "Show overview"} <kbd>o</kbd></button>
      </div>
      <div class="ov-body">
        <div class="tiles">${tiles.join("")}</div>
        ${compareTiles}
        <div class="card">
          <h3>Status distribution <span class="dim">${fmtN(total)} tests</span></h3>
          <div class="statusbar">${segs}</div>
          <div class="legend">${legend}</div>
          ${subtests ? `<div class="subtests-line"><span>Subtest results:</span>${subtests}</div>` : ""}
        </div>
        <div class="ov-grid">
          <div class="card">
            <h3>Environment</h3>
            <dl class="kv">${envRows.filter(([, v]) => v).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
            ${params ? `<div class="cmdline">${params}</div>
              <div class="cmd-legend"><span><span class="param hard"><span class="k">param</span></span> hardening</span><span><span class="param weak"><span class="k">param</span></span> weakening</span><span>hover for details</span></div>` : ""}
          </div>
          <div class="card">
            <h3>Top reasons
              <span class="mini-tabs" id="top-tabs">
                <button data-tab="problems" class="${tab === "problems" ? "on" : ""}">Problems</button>
                <button data-tab="skips" class="${tab === "skips" ? "on" : ""}">Skips</button>
                <button data-tab="errno" class="${tab === "errno" ? "on" : ""}">Errno</button>
              </span>
            </h3>
            <ul class="toplist">${topItems.join("")}</ul>
          </div>
          <div class="card">
            <h3>Slowest tests</h3>
            <ul class="toplist wide-n">${slowest.join("")}</ul>
          </div>
        </div>
      </div>`;
  }

  function renderChips() {
    const c = state.counts.status;
    const chips = STATUSES.concat(state.baseline ? ["gone"] : []).map((s) => {
      const n = c.get(s) || 0;
      const on = state.statuses.has(s);
      return `<button class="chip ${stCls(s)} ${on ? "on" : ""} ${n ? "" : "zero"}" data-status="${s}" data-tip="${esc(statusMeta(s).desc)}\nClick: toggle · Double-click: only this">
        <span class="dot" style="background:var(--c)"></span>${statusMeta(s).label}<span class="n">${fmtN(n)}</span></button>`;
    });
    const probOnly = state.statuses.size === 3 && PROBLEMS.every((s) => state.statuses.has(s));
    chips.push(`<button class="chip preset ${probOnly ? "on" : ""}" data-preset="problems" style="--c:var(--s-fail)" data-tip="Failed + Broken + Warning (p)">Problems only</button>`);
    $("#status-chips").innerHTML = chips.join("");
  }

  function facetEntries(f) {
    const counts = state.counts[f.id] || new Map();
    const sel = state.facets[f.id];
    const values = new Set([...counts.keys(), ...sel]);
    let list = [...values].map((v) => [v, counts.get(v) || 0]);
    if (f.order) list.sort((a, b) => f.order.indexOf(a[0]) - f.order.indexOf(b[0]));
    else if (f.sortNum) list.sort((a, b) => b[1] - a[1] || +a[0] - +b[0]);
    else list.sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0]));
    return list;
  }
  function facetBodyHtml(f) {
    const sel = state.facets[f.id];
    let list = facetEntries(f);
    const q = (state.facetSearch[f.id] || "").toLowerCase();
    const searchable = f.searchable && list.length > 10;
    if (q) list = list.filter(([v]) => String(v).toLowerCase().includes(q));
    const max = Math.max(1, ...list.map((e) => e[1]));
    const limit = state.facetExpanded[f.id] || q ? Infinity : 8;
    const shown = list.slice(0, limit);
    const rows = shown.map(([v, n]) => {
      const label = f.fmt ? f.fmt(v) : v;
      return `<button class="fv ${sel.has(v) ? "on" : ""} ${n ? "" : "zero"}" data-facet="${f.id}" data-value="${esc(v)}" data-tip="${esc(label)}\nClick: toggle · Double-click: only this">
        <span class="box"></span><span class="lbl ${f.mono ? "mono" : ""}">${esc(label)}</span><span class="cnt">${fmtN(n)}</span>
        <span class="bar"><i style="width:${((100 * n) / max).toFixed(1)}%"></i></span></button>`;
    });
    const more = list.length > shown.length
      ? `<button class="link-btn facet-more" data-more="${f.id}">Show ${list.length - shown.length} more</button>`
      : state.facetExpanded[f.id] && list.length > 8 ? `<button class="link-btn facet-more" data-more="${f.id}">Show less</button>` : "";
    return `${searchable ? `<input type="search" class="facet-filter" data-facet-search="${f.id}" placeholder="Filter ${esc(f.label.toLowerCase())}…" value="${esc(state.facetSearch[f.id] || "")}">` : ""}
      ${rows.join("") || `<div class="dim" style="padding:2px 6px">No values</div>`}${more}`;
  }
  function renderSidebar() {
    document.body.classList.toggle("no-sidebar", !prefs.sidebar);
    $("#btn-sidebar").classList.toggle("active", prefs.sidebar);
    if (!prefs.sidebar) return;
    const focused = document.activeElement?.dataset?.facetSearch;
    const html = FACETS.filter((f) => !f.hidden && !(f.compare && !state.baseline)).map((f) => {
      if (f.hideEmpty && !(state.counts[f.id]?.size) && !state.facets[f.id].size) return "";
      const closed = prefs.closedFacets[f.id] ?? !!f.closed;
      const n = state.facets[f.id].size;
      return `<div class="facet ${closed ? "closed" : ""}" data-facet-box="${f.id}">
        <div class="facet-head" data-toggle-facet="${f.id}">${icon("chev")}${esc(f.label)}${n ? `<button class="link-btn clear" data-clear-facet="${f.id}">clear ${n}</button>` : ""}</div>
        <div class="facet-body" id="facet-body-${f.id}">${closed ? "" : facetBodyHtml(f)}</div></div>`;
    }).join("");
    $("#sidebar").innerHTML = html;
    if (focused) {
      const inp = $(`[data-facet-search="${focused}"]`);
      if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    }
  }

  function renderFilterbar() {
    const tags = [];
    const tag = (label, value, data) => tags.push(`<span class="ftag"><span><em>${esc(label)}:</em> ${esc(value)}</span><button ${data} title="Remove">${icon("x")}</button></span>`);
    if (state.q) tag("search", state.q, `data-rm="q"`);
    for (const s of state.statuses) tag("status", statusMeta(s).label, `data-rm="status" data-value="${esc(s)}"`);
    for (const f of FACETS) {
      if (f.compare && !state.baseline) continue;
      for (const v of state.facets[f.id]) tag(f.label.toLowerCase(), f.fmt ? f.fmt(v) : v, `data-rm="facet" data-facet="${f.id}" data-value="${esc(v)}"`);
    }
    const total = state.rows.length;
    const shown = state.view.length;
    const hasFilters = tags.length > 0;
    $("#filterbar").innerHTML = `<span class="count"><b>${fmtN(shown)}</b> of ${fmtN(total)} tests</span>
      ${tags.join("")}${hasFilters ? `<button class="link-btn" data-rm="all">Clear all</button>` : ""}`;

    const st = $("#search-state");
    const qi = state.queryInfo;
    const pending = qi.logTerms.some((t) => state.logSearch.get(t.k)?.status === "pending");
    const err = qi.errors[0] || qi.logTerms.map((t) => state.logSearch.get(t.k)).find((e) => e?.status === "error")?.error;
    st.className = "search-state" + (err ? " err" : pending ? " busy" : "");
    st.textContent = err ? "invalid query" : pending ? "logs…" : "";
    st.title = err || "";
    $("#search").classList.toggle("error", !!err);
    $("#btn-regex").classList.toggle("on", state.regex);
  }

  function renderHead() {
    const cols = visibleCols();
    $("#grid").querySelectorAll("colgroup").forEach((c) => c.remove());
    const cg = document.createElement("colgroup");
    cg.innerHTML = cols.map((c) => `<col class="c-${c.id}">`).join("");
    $("#grid").prepend(cg);
    $("#grid-head").innerHTML = `<tr>${cols.map((c) => {
      const sorted = state.sort.key === c.id;
      const arrow = sorted ? (state.sort.dir > 0 ? "▲" : "▼") : "";
      return `<th class="${c.num ? "num" : ""} ${sorted ? "sorted" : ""}" data-sort="${c.id}" ${c.title ? `data-tip="${esc(c.title)}"` : ""}>${esc(c.label)}<span class="arrow">${arrow}</span></th>`;
    }).join("")}</tr>`;
  }

  function rowHtml(r, cols) {
    const cls = `row${r.ghost ? " ghost" : ""}${r.key === state.selKey ? " sel" : ""}${r.key === state.openKey ? " open" : ""}`;
    return `<tr class="${cls}" data-key="${esc(r.key)}">${cols.map((c) => `<td class="${c.num ? "num" : ""}">${c.cell(r)}</td>`).join("")}</tr>`;
  }
  function groupHtml(item, cols) {
    const g = GROUP[state.group];
    const rows = item.rows;
    const sc = {};
    for (const r of rows) sc[r.status] = (sc[r.status] || 0) + 1;
    const order = STATUSES.concat(["gone"]);
    const bar = order.filter((s) => sc[s]).map((s) => `<i class="${stCls(s)}" style="flex:${sc[s]}"></i>`).join("");
    const stats = order.filter((s) => sc[s]).map((s) => `<span><i class="dot ${stCls(s)}" style="background:var(--c)"></i>${sc[s]} ${statusMeta(s).tag.toLowerCase()}</span>`).join("");
    const title = g.title ? g.title(item.group) : item.group || "(none)";
    const canFilter = g.facet && !(g.facet === "status" ? state.statuses.size === 1 && state.statuses.has(item.group) : state.facets[g.facet]?.size === 1 && state.facets[g.facet].has(item.group));
    return `<tr class="group ${item.collapsed ? "collapsed" : ""}" data-group="${esc(item.group)}"><td colspan="${cols.length}">
      <div class="ghead">${icon("chev", "chev")}<span class="gtitle ${g.mono ? "mono" : ""}" data-tip="${esc(title)}">${esc(title)}</span>
      <span class="gcount">${fmtN(rows.length)}</span>
      ${canFilter ? `<button class="link-btn" data-only-group="${esc(item.group)}" title="Filter to this group only">only</button>` : ""}
      <span class="gstats">${stats}</span><span class="gbar">${bar}</span></div></td></tr>`;
  }

  let moreObserver = null;
  function renderBody() {
    const cols = visibleCols();
    const items = state.items.slice(0, state.limit);
    const html = items.map((it) => (it.row ? rowHtml(it.row, cols) : groupHtml(it, cols)));
    const rest = state.items.length - items.length;
    if (rest > 0) html.push(`<tr class="more"><td colspan="${cols.length}"><button class="btn" id="btn-more">Show ${fmtN(Math.min(rest, 600))} more</button> <button class="link-btn" id="btn-all">show all ${fmtN(state.items.length)}</button></td></tr>`);
    $("#grid-body").innerHTML = html.join("");
    $("#no-rows").hidden = state.view.length > 0;
    $("#grid").hidden = state.view.length === 0;
    $("#group-tools").hidden = state.group === "none";
    if (moreObserver) moreObserver.disconnect();
    const more = $("#btn-more");
    if (more && "IntersectionObserver" in window) {
      moreObserver = new IntersectionObserver((ents) => { if (ents.some((e) => e.isIntersecting)) { state.limit += 600; renderBody(); } }, { rootMargin: "400px" });
      moreObserver.observe(more);
    }
  }

  function renderGroupSelect() {
    const gs = $("#group-select");
    gs.innerHTML = GROUPS.filter((g) => !g.compare || state.baseline).map((g) => `<option value="${g.id}">${g.label}</option>`).join("");
    if (GROUP[state.group]?.compare && !state.baseline) state.group = "none";
    gs.value = state.group;
  }

  function renderColumnsMenu() {
    const items = COLUMNS.filter((c) => !c.compare || state.baseline).map((c) =>
      `<button class="mi check ${prefs.cols.includes(c.id) ? "on" : ""}" data-col="${c.id}"><span class="box"></span>${esc(c.label === "#" ? "# (order)" : c.label)}${c.compare ? `<span class="hint">compare</span>` : ""}</button>`);
    const dens = [["compact", "Compact"], ["normal", "Comfortable"], ["cozy", "Cozy"]].map(([k, l]) =>
      `<button class="mi check ${prefs.density === k ? "on" : ""}" data-density="${k}"><span class="box"></span>${l}</button>`);
    $("#columns-menu").innerHTML = `<div class="menu-title">Columns <button class="link-btn" data-cols-reset>reset</button></div>${items.join("")}<hr><div class="menu-title">Row density</div>${dens.join("")}`;
  }
  function renderExportMenu() {
    $("#export-menu").innerHTML = `<div class="menu-title">Export ${fmtN(state.view.length)} visible tests</div>
      <button class="mi" data-export="csv">${icon("download")}CSV <span class="hint">visible columns</span></button>
      <button class="mi" data-export="json">${icon("download")}JSON</button>
      <button class="mi" data-export="md">${icon("copy")}Copy as Markdown table</button>
      <button class="mi" data-export="names">${icon("copy")}Copy test names <span class="hint">one per line</span></button>
      ${STATIC ? "" : `<hr><a class="mi" href="export/${enc(state.reportId || "")}.html${state.baselineId ? "?b=" + enc(state.baselineId) : ""}">${icon("download")}Self-contained HTML <span class="hint">offline</span></a>`}`;
  }

  function update({ keepLimit = false } = {}) {
    if (!state.report) return;
    if (!keepLimit) state.limit = 600;
    computeView();
    renderChips();
    renderSidebar();
    renderFilterbar();
    renderHead();
    renderBody();
    updateOverviewActive();
    syncHash();
  }
  function updateOverviewActive() {
    $$("#overview .tile[data-solo-status]").forEach((t) => t.classList.toggle("active", state.statuses.size === 1 && state.statuses.has(t.dataset.soloStatus)));
    $$("#overview .tile[data-solo-change]").forEach((t) => t.classList.toggle("active", state.facets.change.size === 1 && state.facets.change.has(t.dataset.soloChange)));
  }

  // ---------------------------------------------------------------- drawer
  let drawerToken = 0;
  const logView = { q: "", marks: [], cur: -1 };
  const LOG_LINE_RE = /^(?:([\w.+-]+:\d+):(\s+))?(.*?)\b(TPASS|TFAIL|TBROK|TCONF|TWARN|TINFO|TDEBUG)\b(\s*:\s*)(.*)$/;

  function findRow(key) {
    return state.rows.find((r) => r.key === key) || null;
  }
  function openDrawer(key, { scroll = true } = {}) {
    const r = findRow(key);
    if (!r) return;
    state.openKey = key;
    state.selKey = key;
    if (r.ghost) state.drawerTab = "base";
    else if (state.drawerTab === "base" && !r.base) state.drawerTab = "log";
    $$("#grid-body tr.row.open").forEach((tr) => tr.classList.remove("open"));
    markSelected(scroll);
    $(`#grid-body tr.row[data-key="${CSS.escape(key)}"]`)?.classList.add("open");
    $("#drawer").hidden = false;
    renderDrawer(r);
    syncHash();
  }
  function closeDrawer() {
    state.openKey = null;
    $("#drawer").hidden = true;
    $$("#grid-body tr.row.open").forEach((tr) => tr.classList.remove("open"));
    syncHash();
  }
  function markSelected(scroll = true) {
    $$("#grid-body tr.row.sel").forEach((tr) => tr.classList.remove("sel"));
    if (!state.selKey) return;
    let tr = $(`#grid-body tr.row[data-key="${CSS.escape(state.selKey)}"]`);
    if (!tr) {
      // selection may sit beyond the render limit
      const i = state.items.findIndex((it) => it.row && it.row.key === state.selKey);
      if (i >= state.limit) { state.limit = i + 100; renderBody(); tr = $(`#grid-body tr.row[data-key="${CSS.escape(state.selKey)}"]`); }
    }
    if (tr) { tr.classList.add("sel"); if (scroll) tr.scrollIntoView({ block: "nearest" }); }
  }
  function moveSel(delta) {
    const flat = state.flat;
    if (!flat.length) return;
    let i = flat.findIndex((r) => r.key === state.selKey);
    i = i < 0 ? (delta > 0 ? 0 : flat.length - 1) : Math.min(flat.length - 1, Math.max(0, i + delta));
    state.selKey = flat[i].key;
    if (state.openKey) openDrawer(state.selKey);
    else markSelected();
  }

  function fact(k, v) { return `<div class="fact"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`; }

  function renderDrawer(r) {
    const token = ++drawerToken;
    const flat = state.flat;
    const pos = flat.findIndex((x) => x.key === r.key);
    const tabs = [];
    if (!r.ghost) tabs.push(["log", state.report.name]);
    if (r.base && state.baseline) tabs.push(["base", "Baseline · " + state.baseline.name]);
    const reasonColor = r.reason_level ? LEVEL_STATUS[r.reason_level] || r.status : r.status;
    const filterLink = (facet, v, label) => `<button class="link-btn" data-drawer-filter="${facet}" data-value="${esc(v)}" title="Filter by this">${esc(label ?? v)}</button>`;

    let compare = "";
    if (state.baseline) {
      if (r.ghost) compare = `<div class="d-compare">${changePill("missing")} Only in baseline <b>${esc(state.baseline.name)}</b> as ${badge(r.base.status, true)}</div>`;
      else if (!r.base) compare = `<div class="d-compare">${changePill("new")} Not present in baseline <b>${esc(state.baseline.name)}</b></div>`;
      else {
        const d = r.duration != null && r.base.duration != null ? r.duration - r.base.duration : null;
        compare = `<div class="d-compare">${changePill(r.change)}<span>baseline ${badge(r.base.status, true)}</span>
          ${r.base.reason && r.base.reason !== r.reason ? `<span class="dim" title="${esc(r.base.reason)}">“${esc(r.base.reason.slice(0, 80))}${r.base.reason.length > 80 ? "…" : ""}”</span>` : ""}
          ${d != null ? `<span class="dim">Δ time ${d >= 0 ? "+" : "−"}${fmtDur(Math.abs(d))}</span>` : ""}</div>`;
      }
    }
    const src = r.ghost ? r.base : r;
    $("#drawer-inner").innerHTML = `
      <div class="d-head">
        ${badge(r.status)}
        <div class="d-title" title="${esc(r.name)}">${esc(r.name)}${r.occurrence ? `<span class="occ dim"> #${r.occurrence + 1}</span>` : ""}</div>
        <div class="d-nav">
          <span class="pos">${pos >= 0 ? `${pos + 1} / ${flat.length}` : ""}</span>
          <button class="icon-btn" data-nav="-1" title="Previous (k)">${icon("up")}</button>
          <button class="icon-btn" data-nav="1" title="Next (j)">${icon("down")}</button>
          <button class="icon-btn" data-copy-link title="Copy link to this test">${icon("link")}</button>
          <button class="icon-btn" data-close-drawer title="Close (Esc)">${icon("x")}</button>
        </div>
      </div>
      <div class="d-body">
        <div class="d-meta">
          <div class="d-cmd"><code>${esc(src.cmdline)}</code><button class="icon-btn" data-copy="${esc(src.cmdline)}" title="Copy command">${icon("copy")}</button></div>
          ${r.reason ? `<div class="d-reason ${stCls(reasonColor)}"><span class="loc">${esc(r.reason_level || "")}${r.reason_loc ? " · " + esc(r.reason_loc) : ""}${r.reason_line && !r.ghost ? ` · <button class="link-btn" data-jump="${r.reason_line}">line ${r.reason_line}</button>` : ""}</span>${esc(r.reason)}</div>` : ""}
          ${compare}
          <div class="d-facts">
            ${fact("Exit code", r.retval == null ? "—" : `${r.retval} <span class="dim">${esc(decodeExit(r.retval))}</span>`)}
            ${fact("Duration", fmtDur(r.duration))}
            ${fact("Subtests", subtestPills(r))}
            ${fact("Family", filterLink("family", r.family))}
            ${fact("Subsystem", filterLink("subsystem", r.subsystem))}
            ${fact("Errno", r.errno ? filterLink("errno", r.errno) : "—")}
            ${r.kconfig.length ? fact("Kernel config", r.kconfig.map((k) => filterLink("kconfig", k)).join("<br>")) : ""}
            ${fact("Log", `${fmtN(r.log_lines)} lines`)}
          </div>
        </div>
        <div class="tabs">${tabs.map(([id, l]) => `<button data-tab="${id}" class="${state.drawerTab === id ? "on" : ""}">${esc(l)}</button>`).join("")}</div>
        <div class="log-tools" id="log-tools"></div>
        <pre class="log ${prefs.wrap ? "wrap" : ""}" id="log"><div class="log-empty">Loading log…</div></pre>
      </div>`;
    if (prefs.drawerW) $("#drawer").style.setProperty("--drawer-w", prefs.drawerW + "px");

    const reportId = state.drawerTab === "base" ? state.baselineId : state.reportId;
    const idx = state.drawerTab === "base" ? r.base.idx : r.idx;
    getLog(reportId, idx).then((log) => {
      if (token !== drawerToken) return;
      renderLog(log, r, state.drawerTab === "base" ? r.base : r);
    }).catch((e) => {
      if (token === drawerToken) $("#log").innerHTML = `<div class="log-empty">Could not load log: ${esc(e.message)}</div>`;
    });
  }

  function renderLog(log, r, src) {
    const lines = log.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    const levelOf = [];
    const cnt = {};
    let inSummary = false;
    const parsed = lines.map((line) => {
      if (/^Summary:\s*$/.test(line)) inSummary = true;
      const m = LOG_LINE_RE.exec(line);
      const lvl = m ? m[4] : "other";
      const key = LEVELS.includes(lvl) ? lvl : lvl === "TDEBUG" ? "TINFO" : "other";
      cnt[key] = (cnt[key] || 0) + 1;
      levelOf.push(key);
      return { line, m, key, summary: inSummary };
    });
    const hidden = new Set(prefs.hiddenLevels);
    const q = logView.q;
    let rx = null;
    if (q) { try { rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"); } catch { rx = null; } }
    const hl = (s) => {
      if (!rx || !s) return esc(s);
      let out = "", last = 0;
      s.replace(rx, (m0, off) => { out += esc(s.slice(last, off)) + `<mark>${esc(m0)}</mark>`; last = off + m0.length; return m0; });
      return out + esc(s.slice(last));
    };
    const html = parsed.map((p, i) => {
      if (hidden.has(p.key)) return "";
      let tx;
      if (p.m) {
        const [, loc, sp, pre, lvl, sep, msg] = p.m;
        tx = `${loc ? `<span class="loc">${hl(loc)}:</span>${sp}` : ""}${hl(pre)}<span class="lv lv-${lvl}">${lvl}</span>${esc(sep)}${hl(msg)}`;
      } else tx = hl(p.line);
      return `<div class="ln l-${p.key}${p.summary ? " summary" : ""}" data-ln="${i + 1}"><span class="no">${i + 1}</span><span class="tx">${tx || " "}</span></div>`;
    }).join("");
    const logEl = $("#log");
    logEl.innerHTML = html || `<div class="log-empty">${lines.length ? "All lines hidden by the level filter." : "Empty log."}</div>`;

    const lvlBtns = LEVELS.filter((l) => cnt[l]).map((l) =>
      `<button class="lvl-toggle ${hidden.has(l) ? "" : "on"} ${stCls(LEVEL_STATUS[l] || "unknown")}" data-level="${l}" title="Show / hide ${l} lines">${l === "other" ? "other" : l}<span class="n">${cnt[l]}</span></button>`).join("");
    const firstProblem = parsed.findIndex((p) => ["TFAIL", "TBROK", "TWARN"].includes(p.key));
    $("#log-tools").innerHTML = `${lvlBtns}<span class="spacer"></span>
      <input type="search" id="log-search" placeholder="Find in log…" value="${esc(q)}" spellcheck="false"><span class="hits" id="log-hits"></span>
      ${firstProblem >= 0 ? `<button class="icon-btn" data-jump="${firstProblem + 1}" title="Jump to first TFAIL / TBROK / TWARN">${icon("target")}</button>` : ""}
      <button class="icon-btn ${prefs.wrap ? "active" : ""}" data-wrap title="Wrap long lines">${icon("wrap")}</button>
      <button class="icon-btn" data-copy-log title="Copy log">${icon("copy")}</button>
      <button class="icon-btn" data-download-log title="Download log">${icon("download")}</button>`;
    logView.marks = $$("mark", logEl);
    logView.cur = -1;
    $("#log-hits").textContent = q ? `${logView.marks.length} hits` : "";
    logView.text = log;
    logView.name = src.name;
    if (q && logView.marks.length) stepLogHit(1);
  }
  function stepLogHit(d) {
    const marks = logView.marks;
    if (!marks.length) return;
    marks[logView.cur]?.classList.remove("cur");
    logView.cur = (logView.cur + d + marks.length) % marks.length;
    marks[logView.cur].classList.add("cur");
    marks[logView.cur].scrollIntoView({ block: "center" });
    $("#log-hits").textContent = `${logView.cur + 1}/${marks.length}`;
  }
  function jumpToLine(n) {
    let el = $(`#log .ln[data-ln="${n}"]`);
    if (!el) {
      // line hidden by level filter: show everything
      prefs.hiddenLevels = [];
      savePrefs();
      const r = findRow(state.openKey);
      if (r) renderLog(logView.text, r, state.drawerTab === "base" ? r.base : r);
      el = $(`#log .ln[data-ln="${n}"]`);
    }
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
  }

  // -------------------------------------------------------------- actions
  function setStatuses(arr) { state.statuses = new Set(arr); update(); }
  function toggleStatus(s) {
    state.statuses.has(s) ? state.statuses.delete(s) : state.statuses.add(s);
    update();
  }
  function soloStatus(s) {
    setStatuses(state.statuses.size === 1 && state.statuses.has(s) ? [] : [s]);
  }
  function toggleFacet(id, v, solo = false) {
    const set = state.facets[id];
    if (solo) {
      const only = set.size === 1 && set.has(v);
      set.clear();
      if (!only) set.add(v);
    } else set.has(v) ? set.delete(v) : set.add(v);
    update();
  }
  function clearAll() {
    state.q = "";
    $("#search").value = "";
    state.statuses.clear();
    for (const s of Object.values(state.facets)) s.clear();
    update();
  }
  function setGroup(g) {
    state.group = g;
    state.collapsed.clear();
    $("#group-select").value = g;
    update();
  }

  function exportRows(kind) {
    const rows = state.view;
    const cols = visibleCols();
    const base = (state.report?.name || "ltp") + (state.view.length !== state.rows.length ? "-filtered" : "");
    if (kind === "csv") {
      const q = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const lines = [cols.map((c) => q(c.label === "#" ? "order" : c.label)).join(",")].concat(rows.map((r) => cols.map((c) => q(c.text(r))).join(",")));
      download(base + ".csv", lines.join("\n") + "\n", "text/csv");
    } else if (kind === "json") {
      const out = rows.map(({ hay, base: b, ghost, ...r }) => ({ ...r, ...(state.baseline ? { baseline_status: b ? b.status : null } : {}) }));
      download(base + ".json", JSON.stringify(out, null, 2), "application/json");
    } else if (kind === "md") {
      const mdCols = cols.filter((c) => c.id !== "subtests");
      const cell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
      const md = [`| ${mdCols.map((c) => c.label).join(" | ")} |`, `| ${mdCols.map((c) => (c.num ? "---:" : "---")).join(" | ")} |`]
        .concat(rows.map((r) => `| ${mdCols.map((c) => cell(c.id === "name" ? "`" + r.name + "`" : c.text(r))).join(" | ")} |`));
      copyText(md.join("\n"), `Copied ${rows.length} rows as Markdown`);
    } else if (kind === "names") {
      copyText([...new Set(rows.map((r) => r.name))].join("\n"), `Copied ${rows.length} test names`);
    }
  }

  async function uploadFiles(files) {
    if (!state.allowUpload || !files.length) return;
    try {
      const res = await api.upload(files);
      (res.errors || []).forEach((e) => toast(e, true));
      await refreshReports();
      const first = res.reports[0];
      if (first) {
        if (state.reportId && state.reportId !== first.id && !state.baselineId) {
          toast(`Loaded ${first.name}. Tip: pick a baseline in “Compare with”.`);
        }
        await selectReport(first.id);
      }
    } catch (e) {
      toast(e.message, true);
    }
  }
  async function refreshReports() {
    const res = await api.list();
    state.reports = res.reports || [];
    state.allowUpload = !!res.allow_upload;
    (res.errors || []).forEach((e) => toast(e, true));
  }

  async function selectReport(id, { keepFilters = true } = {}) {
    if (!state.reports.length) { showEmpty(); return; }
    if (!state.reports.some((r) => r.id === id)) id = state.reports[0].id;
    if (id !== state.reportId) { state.logSearch.clear(); state.selKey = null; if (!keepFilters) clearAll(); }
    state.reportId = id;
    if (state.baselineId === id || (state.baselineId && !state.reports.some((r) => r.id === state.baselineId))) state.baselineId = null;
    try {
      const [rep, base] = await Promise.all([loadReport(id), state.baselineId ? loadReport(state.baselineId) : null]);
      if (state.reportId !== id) return;
      state.report = rep;
      state.baseline = base;
    } catch (e) {
      toast(`Could not load report: ${e.message}`, true);
      return;
    }
    $("#empty").hidden = true;
    $("#workspace").hidden = false;
    buildRows();
    renderPickers();
    renderGroupSelect();
    renderColumnsMenu();
    renderOverview();
    update();
    if (state.openKey && findRow(state.openKey)) openDrawer(state.openKey);
    else closeDrawer();
  }
  function showEmpty() {
    state.report = null;
    state.reportId = null;
    renderPickers();
    $("#empty").hidden = false;
    $("#overview").hidden = true;
    $("#workspace").hidden = true;
    closeDrawer();
  }

  function toggleTheme() {
    const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem("ltpv.theme", t); } catch { /* ignore */ }
  }
  function applyDensity() {
    document.body.classList.remove("density-compact", "density-cozy");
    if (prefs.density !== "normal") document.body.classList.add("density-" + prefs.density);
  }
  function closeMenus(except) {
    $$(".menu").forEach((m) => { if (m !== except) m.hidden = true; });
  }

  // ---------------------------------------------------------------- events
  function bind() {
    $("#report-select").addEventListener("change", (e) => { state.openKey = null; selectReport(e.target.value); });
    $("#baseline-select").addEventListener("change", (e) => {
      state.baselineId = e.target.value || null;
      if (!state.baselineId) state.facets.change.clear();
      selectReport(state.reportId);
    });
    $("#btn-theme").addEventListener("click", toggleTheme);
    $("#btn-help").addEventListener("click", () => $("#help").showModal());
    $("#help").addEventListener("click", (e) => { if (e.target.closest("[data-close]") || e.target === $("#help")) $("#help").close(); });
    $("#btn-link").addEventListener("click", () => { syncHash(); copyText(location.href, "Link to this view copied"); });
    $("#brand").addEventListener("click", (e) => { e.preventDefault(); clearAll(); setGroup("none"); closeDrawer(); window.scrollTo({ top: 0 }); });
    $("#btn-upload").addEventListener("click", () => $("#file-input").click());
    $("#empty-upload").addEventListener("click", () => $("#file-input").click());
    $("#file-input").addEventListener("change", (e) => { uploadFiles(e.target.files); e.target.value = ""; });
    $("#btn-remove").addEventListener("click", async () => {
      const r = state.reports.find((x) => x.id === state.reportId);
      if (!r || !confirm(`Unload report “${r.name}” from the viewer? (The file on disk is not touched.)`)) return;
      try {
        await api.remove(r.id);
        reportCache.delete(r.id);
        await refreshReports();
        state.openKey = null;
        if (state.reports.length) selectReport(state.reports[0].id); else showEmpty();
      } catch (e) { toast(e.message, true); }
    });

    const onSearch = debounce(() => { state.q = $("#search").value.trim(); update(); }, 140);
    $("#search").addEventListener("input", onSearch);
    $("#search").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { state.q = e.target.value.trim(); update(); }
      if (e.key === "ArrowDown") { e.preventDefault(); e.target.blur(); moveSel(1); }
    });
    $("#btn-regex").addEventListener("click", () => { state.regex = !state.regex; update(); });
    $("#group-select").addEventListener("change", (e) => setGroup(e.target.value));
    $("#btn-sidebar").addEventListener("click", () => { prefs.sidebar = !prefs.sidebar; savePrefs(); renderSidebar(); });
    $("#btn-expand").addEventListener("click", () => { state.collapsed.clear(); update({ keepLimit: true }); });
    $("#btn-collapse").addEventListener("click", () => {
      state.items.filter((i) => !i.row).forEach((i) => state.collapsed.add(i.group));
      update();
    });
    $("#btn-clear-all").addEventListener("click", clearAll);

    // menus
    for (const [btn, menu, render] of [["#btn-columns", "#columns-menu", renderColumnsMenu], ["#btn-export", "#export-menu", renderExportMenu]]) {
      $(btn).addEventListener("click", (e) => {
        e.stopPropagation();
        const m = $(menu);
        closeMenus(m);
        if (m.hidden) render();
        m.hidden = !m.hidden;
      });
    }
    $("#columns-menu").addEventListener("click", (e) => {
      e.stopPropagation();
      const b = e.target.closest("[data-col],[data-density],[data-cols-reset]");
      if (!b) return;
      if (b.dataset.col) {
        const id = b.dataset.col;
        prefs.cols = prefs.cols.includes(id) ? prefs.cols.filter((c) => c !== id) : [...prefs.cols, id];
      } else if (b.dataset.density) {
        prefs.density = b.dataset.density;
        applyDensity();
      } else prefs.cols = [...DEFAULT_COLS];
      savePrefs();
      renderColumnsMenu();
      renderHead();
      renderBody();
    });
    $("#export-menu").addEventListener("click", (e) => {
      const b = e.target.closest("[data-export]");
      if (b) { exportRows(b.dataset.export); closeMenus(); }
    });
    document.addEventListener("click", (e) => { if (!e.target.closest(".menu-wrap")) closeMenus(); });

    // status chips
    let chipTimer = null;
    $("#status-chips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-status],[data-preset]");
      if (!b) return;
      if (b.dataset.preset) {
        const on = state.statuses.size === 3 && PROBLEMS.every((s) => state.statuses.has(s));
        setStatuses(on ? [] : PROBLEMS);
        return;
      }
      clearTimeout(chipTimer);
      chipTimer = setTimeout(() => toggleStatus(b.dataset.status), 200);
    });
    $("#status-chips").addEventListener("dblclick", (e) => {
      const b = e.target.closest("[data-status]");
      if (!b) return;
      clearTimeout(chipTimer);
      setStatuses([b.dataset.status]);
    });

    // overview
    $("#overview").addEventListener("click", (e) => {
      const t = e.target;
      if (t.closest("#btn-overview")) { prefs.overview = !prefs.overview; savePrefs(); renderOverview(); return; }
      const tab = t.closest("#top-tabs [data-tab]");
      if (tab) { prefs.topTab = tab.dataset.tab; savePrefs(); renderOverview(); return; }
      const solo = t.closest("[data-solo-status]");
      if (solo) { soloStatus(solo.dataset.soloStatus); return; }
      const ch = t.closest("[data-solo-change]");
      if (ch) { toggleFacet("change", ch.dataset.soloChange, true); return; }
      const li = t.closest("li[data-facet]");
      if (li) {
        toggleFacet(li.dataset.facet, li.dataset.value, true);
        $("#workspace").scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      const op = t.closest("li[data-open]");
      if (op) openDrawer(op.dataset.open);
    });

    // sidebar
    let fvTimer = null;
    $("#sidebar").addEventListener("click", (e) => {
      const t = e.target;
      const clr = t.closest("[data-clear-facet]");
      if (clr) { e.stopPropagation(); state.facets[clr.dataset.clearFacet].clear(); update(); return; }
      const head = t.closest("[data-toggle-facet]");
      if (head) {
        const id = head.dataset.toggleFacet;
        prefs.closedFacets[id] = !(prefs.closedFacets[id] ?? !!FACET[id].closed);
        savePrefs();
        renderSidebar();
        return;
      }
      const more = t.closest("[data-more]");
      if (more) { state.facetExpanded[more.dataset.more] = !state.facetExpanded[more.dataset.more]; renderSidebar(); return; }
      const fv = t.closest(".fv");
      if (fv) {
        clearTimeout(fvTimer);
        fvTimer = setTimeout(() => toggleFacet(fv.dataset.facet, fv.dataset.value), 200);
      }
    });
    $("#sidebar").addEventListener("dblclick", (e) => {
      const fv = e.target.closest(".fv");
      if (!fv) return;
      clearTimeout(fvTimer);
      toggleFacet(fv.dataset.facet, fv.dataset.value, true);
    });
    $("#sidebar").addEventListener("input", (e) => {
      const id = e.target.dataset.facetSearch;
      if (!id) return;
      state.facetSearch[id] = e.target.value;
      $(`#facet-body-${id}`).innerHTML = facetBodyHtml(FACET[id]);
      const inp = $(`[data-facet-search="${id}"]`);
      inp.focus();
      inp.setSelectionRange(inp.value.length, inp.value.length);
    });

    // filter bar
    $("#filterbar").addEventListener("click", (e) => {
      const b = e.target.closest("[data-rm]");
      if (!b) return;
      const kind = b.dataset.rm;
      if (kind === "all") return clearAll();
      if (kind === "q") { state.q = ""; $("#search").value = ""; }
      if (kind === "status") state.statuses.delete(b.dataset.value);
      if (kind === "facet") state.facets[b.dataset.facet].delete(b.dataset.value);
      update();
    });

    // table
    $("#grid-head").addEventListener("click", (e) => {
      const th = e.target.closest("[data-sort]");
      if (!th) return;
      const k = th.dataset.sort;
      state.sort = state.sort.key === k ? { key: k, dir: -state.sort.dir } : { key: k, dir: ["duration", "subtests", "log_lines", "ddur", "passed", "failed", "broken", "skipped", "warnings"].includes(k) ? -1 : 1 };
      update({ keepLimit: true });
    });
    $("#grid-body").addEventListener("click", (e) => {
      const only = e.target.closest("[data-only-group]");
      if (only) {
        e.stopPropagation();
        const g = GROUP[state.group];
        if (g.facet === "status") setStatuses([only.dataset.onlyGroup]);
        else toggleFacet(g.facet, only.dataset.onlyGroup, true);
        return;
      }
      const grp = e.target.closest("tr.group");
      if (grp) {
        const k = grp.dataset.group;
        state.collapsed.has(k) ? state.collapsed.delete(k) : state.collapsed.add(k);
        computeView();
        renderBody();
        return;
      }
      if (e.target.closest("#btn-more")) { state.limit += 600; renderBody(); return; }
      if (e.target.closest("#btn-all")) { state.limit = Infinity; renderBody(); return; }
      const tr = e.target.closest("tr.row");
      if (tr) {
        if (state.openKey === tr.dataset.key) closeDrawer();
        else openDrawer(tr.dataset.key, { scroll: false });
      }
    });

    // drawer
    $("#drawer").addEventListener("click", (e) => {
      const t = e.target;
      if (t.closest("[data-close-drawer]")) return closeDrawer();
      const nav = t.closest("[data-nav]");
      if (nav) return moveSel(+nav.dataset.nav);
      const cp = t.closest("[data-copy]");
      if (cp) return copyText(cp.dataset.copy, "Command copied");
      if (t.closest("[data-copy-link]")) { syncHash(); return copyText(location.href, "Link to this test copied"); }
      if (t.closest("[data-copy-log]")) return copyText(logView.text || "", "Log copied");
      if (t.closest("[data-download-log]")) return download(`${logView.name || "test"}.log`, logView.text || "");
      if (t.closest("[data-wrap]")) {
        prefs.wrap = !prefs.wrap;
        savePrefs();
        $("#log").classList.toggle("wrap", prefs.wrap);
        t.closest("[data-wrap]").classList.toggle("active", prefs.wrap);
        return;
      }
      const jump = t.closest("[data-jump]");
      if (jump) return jumpToLine(+jump.dataset.jump);
      const tab = t.closest(".tabs [data-tab]");
      if (tab) { state.drawerTab = tab.dataset.tab; const r = findRow(state.openKey); if (r) renderDrawer(r); return; }
      const lvl = t.closest("[data-level]");
      if (lvl) {
        const l = lvl.dataset.level;
        const h = new Set(prefs.hiddenLevels);
        h.has(l) ? h.delete(l) : h.add(l);
        prefs.hiddenLevels = [...h];
        savePrefs();
        const r = findRow(state.openKey);
        if (r) renderLog(logView.text, r, state.drawerTab === "base" ? r.base : r);
        return;
      }
      const df = t.closest("[data-drawer-filter]");
      if (df) toggleFacet(df.dataset.drawerFilter, df.dataset.value, true);
    });
    const onLogSearch = debounce((v) => {
      logView.q = v;
      const r = findRow(state.openKey);
      if (r) {
        renderLog(logView.text, r, state.drawerTab === "base" ? r.base : r);
        const inp = $("#log-search");
        inp.focus();
        inp.setSelectionRange(inp.value.length, inp.value.length);
      }
    }, 180);
    $("#drawer").addEventListener("input", (e) => { if (e.target.id === "log-search") onLogSearch(e.target.value); });
    $("#drawer").addEventListener("keydown", (e) => {
      if (e.target.id === "log-search" && e.key === "Enter") { e.preventDefault(); stepLogHit(e.shiftKey ? -1 : 1); }
    });

    // drawer resize
    const handle = $("#drawer-resize");
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      handle.classList.add("drag");
      const move = (ev) => {
        const w = Math.min(window.innerWidth - 80, Math.max(380, window.innerWidth - ev.clientX));
        $("#drawer").style.setProperty("--drawer-w", w + "px");
        prefs.drawerW = w;
      };
      const up = () => { handle.classList.remove("drag"); savePrefs(); window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });

    // tooltips
    const tip = $("#tooltip");
    let tipEl = null;
    document.addEventListener("mouseover", (e) => {
      const el = e.target.closest("[data-tip]");
      if (el === tipEl) return;
      tipEl = el;
      if (!el) { tip.hidden = true; return; }
      tip.textContent = el.dataset.tip;
      tip.hidden = false;
    });
    document.addEventListener("mousemove", (e) => {
      if (tip.hidden) return;
      const pad = 14;
      const { offsetWidth: w, offsetHeight: h } = tip;
      let x = e.clientX + pad, y = e.clientY + pad;
      if (x + w > window.innerWidth - 8) x = e.clientX - w - pad;
      if (y + h > window.innerHeight - 8) y = e.clientY - h - pad;
      tip.style.left = x + "px";
      tip.style.top = y + "px";
    });
    document.addEventListener("scroll", () => { tip.hidden = true; tipEl = null; }, true);

    // drag & drop
    let dragDepth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
    window.addEventListener("dragenter", (e) => { if (!state.allowUpload || !hasFiles(e)) return; dragDepth++; $("#dropzone").hidden = false; });
    window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#dropzone").hidden = true; } });
    window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      $("#dropzone").hidden = true;
      uploadFiles(e.dataTransfer.files);
    });

    // keyboard
    const GROUP_CYCLE = () => GROUPS.filter((g) => !g.compare || state.baseline).map((g) => g.id);
    document.addEventListener("keydown", (e) => {
      if ($("#help").open) return;
      const inField = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
      if (e.key === "Escape") {
        if (inField) { document.activeElement.blur(); return; }
        if (!$$(".menu").every((m) => m.hidden)) return closeMenus();
        if (state.openKey) return closeDrawer();
        state.selKey = null;
        return markSelected();
      }
      if (inField || e.ctrlKey || e.metaKey || e.altKey || !state.report) {
        if (!state.report && e.key === "t" && !inField) toggleTheme();
        return;
      }
      const k = e.key;
      if (k === "/") { e.preventDefault(); $("#search").focus(); $("#search").select(); }
      else if (k === "j" || k === "ArrowDown") { e.preventDefault(); moveSel(1); }
      else if (k === "k" || k === "ArrowUp") { e.preventDefault(); moveSel(-1); }
      else if (k === "Enter" && state.selKey) openDrawer(state.selKey);
      else if (k === "t") toggleTheme();
      else if (k === "?") $("#help").showModal();
      else if (k === "s") { prefs.sidebar = !prefs.sidebar; savePrefs(); renderSidebar(); }
      else if (k === "o") { prefs.overview = !prefs.overview; savePrefs(); renderOverview(); }
      else if (k === "p") { const on = state.statuses.size === 3 && PROBLEMS.every((s) => state.statuses.has(s)); setStatuses(on ? [] : PROBLEMS); }
      else if (k === "0") clearAll();
      else if (k === "g") { const c = GROUP_CYCLE(); setGroup(c[(c.indexOf(state.group) + 1) % c.length]); }
      else if (/^[1-5]$/.test(k)) toggleStatus(STATUSES[+k - 1]);
    });

    window.addEventListener("hashchange", () => {
      if (location.hash.slice(1) === lastHash) return;
      const prevReport = state.reportId;
      const prevBase = state.baselineId;
      hashToState();
      $("#search").value = state.q;
      if (state.reportId !== prevReport || state.baselineId !== prevBase) selectReport(state.reportId);
      else {
        renderGroupSelect();
        update();
        if (state.openKey) openDrawer(state.openKey); else closeDrawer();
      }
    });

    // keep sticky offsets in sync with the (wrapping) toolbar height
    const toolbar = $(".toolbar");
    const setSticky = () => document.documentElement.style.setProperty("--sticky-top", 52 + toolbar.offsetHeight + "px");
    new ResizeObserver(setSticky).observe(toolbar);
    setSticky();
  }

  // ------------------------------------------------------------------ init
  async function init() {
    applyDensity();
    bind();
    hashToState();
    if (STATIC && STATIC.baseline && !location.hash) state.baselineId = STATIC.baseline;
    $("#search").value = state.q;
    try {
      await refreshReports();
    } catch (e) {
      toast(`Could not reach the server: ${e.message}`, true);
    }
    renderPickers();
    if (!state.reports.length) return showEmpty();
    await selectReport(state.reportId || state.reports[0].id);
  }

  init();
})();
