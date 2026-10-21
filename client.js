window.__ModuleLoader__.load({
  id: "dsh-workbuddy-connect",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;
    window.__WB_ERR__ = window.__WB_ERR__ || [];
    const note = (where, error) => {
      try {
        window.__WB_ERR__.push(where + ": " + String((error && error.stack) || error));
      } catch {}
    };

    /** Host routes (literal here and in the host half: the two bundles build independently). */
    const BASE = "/plugins/dsh-workbuddy-connect";
    const STATUS_PATH = `${BASE}/status`;
    const LOGIN_PATH = `${BASE}/login`;
    const MODELS_PATH = `${BASE}/models`;
    const AUTH_PATH = `${BASE}/auth`;

    const zh = {
      title: "WorkBuddy",
      subtitle: "接入 WorkBuddy 模型（国际版 / 国内版）。",
      signIn: "登录 WorkBuddy",
      importDesktop: "从桌面 App 导入",
      signInHint: "点击后在新标签页打开 WorkBuddy 授权页，完成登录后回到这里。",
      waiting: "等待授权中…",
      openLogin: "打开授权页面",
      signedIn: "已登录",
      signedOut: "未登录",
      logout: "退出登录",
      nickname: "账号",
      expires: "凭据有效期",
      domain: "域",
      catalog: "模型目录",
      catalogLive: "实时列表",
      catalogSaved: "上次保存的列表",
      catalogFallback: "内置列表",
      catalogUpdated: "更新于",
      catalogError: "最近刷新失败：",
      refresh: "刷新目录",
      refreshing: "刷新中…",
      models: "模型开关",
      modelsHint: "关闭的模型从 DSH 模型选择器中隐藏。",
      search: "搜索模型 / ID",
      enableAll: "全部开启",
      disableAll: "全部关闭",
      freeTag: "免费",
      rateTag: "倍率",
      ctxTag: "上下文",
      imgTag: "图片",
      effortTag: "推理",
      maxWindow: "使用上游声明的最大上下文窗口",
      maxWindowHint: "关闭时按上游的默认窗口发送请求（如 300K），开启时按最大窗口（如 1M）。",
      credits: "额度",
      creditsNone: "暂无额度信息",
      creditsRemain: "剩余",
      creditsTotal: "总量",
      creditsUnlimited: "不限",
      creditsEnd: "到期",
      creditsError: "额度读取失败：",
      identity: "客户端身份",
      errorLoad: "无法读取连接器状态",
      retry: "重试",
      failed: "操作失败",
      signedOutHint: "登录后才会出现模型分组。",
      sessionStale: "上游拒绝了这份凭据：桌面 App 换过会话了。点「从桌面 App 导入」重新接入，或重新登录。",
      tabGlobal: "国际版",
      tabCN: "国内版",
    };
    const en = {
      title: "WorkBuddy",
      subtitle: "WorkBuddy models (Global / CN) in DSH.",
      signIn: "Sign in to WorkBuddy",
      importDesktop: "Import from the desktop app",
      signInHint: "Opens the WorkBuddy authorization page in a new tab; come back here when it is done.",
      waiting: "waiting for authorization…",
      openLogin: "Open the authorization page",
      signedIn: "Signed in",
      signedOut: "Signed out",
      logout: "Sign out",
      nickname: "Account",
      expires: "Credential expires",
      domain: "Domain",
      catalog: "Model catalog",
      catalogLive: "live list",
      catalogSaved: "saved list",
      catalogFallback: "built-in list",
      catalogUpdated: "updated",
      catalogError: "last refresh failed: ",
      refresh: "Refresh catalog",
      refreshing: "Refreshing…",
      models: "Model toggles",
      modelsHint: "Disabled models are hidden from DSH's model picker.",
      search: "search models / id",
      enableAll: "Enable all",
      disableAll: "Disable all",
      freeTag: "free",
      rateTag: "rate",
      ctxTag: "ctx",
      imgTag: "image",
      effortTag: "reasoning",
      maxWindow: "Use the upstream's maximum context window",
      maxWindowHint: "Off sends the upstream's default window (e.g. 300K); on sends the largest one (e.g. 1M).",
      credits: "Quota",
      creditsNone: "No quota information yet",
      creditsRemain: "remaining",
      creditsTotal: "total",
      creditsUnlimited: "unlimited",
      creditsEnd: "expires",
      creditsError: "Could not read the quota: ",
      identity: "client identity",
      errorLoad: "Cannot read connector status",
      retry: "Retry",
      failed: "Action failed",
      signedOutHint: "The model group appears after you sign in.",
      sessionStale: "The upstream refused this credential — the desktop app rotated its session. Press “Import from the desktop app” again, or sign in once more.",
      tabGlobal: "Global",
      tabCN: "China",
    };
    const L = typeof navigator !== "undefined" && /^zh/i.test(navigator.language || "") ? zh : en;

    const css = `
      .wb-card{border:.5px solid var(--dsw-alias-border-l2,#dedee3);border-radius:var(--dsw-radius-panel,12px);background:var(--dsw-alias-bg-layer-1,#fff);overflow:hidden}
      .wb-head{display:flex;align-items:center;gap:10px;width:100%;padding:14px 16px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
      .wb-head:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f1f3)}
      .wb-title{font-size:14px;font-weight:600}
      .wb-sub{color:var(--dsw-alias-label-secondary,#74747c);font-size:12px;margin-top:2px}
      .wb-chev{margin-left:auto;color:var(--dsw-alias-label-tertiary,#9a9aa3);transition:transform .15s}
      .wb-chev.wb-open{transform:rotate(90deg)}
      .wb-tabs{display:flex;gap:4px;padding:3px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2,#f1f1f3);width:fit-content}
      .wb-tab{display:flex;align-items:center;gap:6px;height:28px;padding:0 12px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#74747c);font:inherit;font-size:13px;cursor:pointer}
      .wb-tab:hover{color:var(--dsw-alias-label-primary,#25252a)}
      .wb-tab[aria-selected="true"]{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#25252a);box-shadow:0 .5px 2px rgba(0,0,0,.08)}
      .wb-dot{width:7px;height:7px;border-radius:99px;background:var(--dsw-alias-label-tertiary,#9a9aa3);flex:none}
      .wb-dot.wb-dot-on{background:var(--dsw-alias-state-success-primary,#2f9e44)}
      .wb-dot.wb-dot-load{background:var(--dsw-alias-state-warning-primary,#d98416)}
      .wb-body{padding:2px 16px 16px;display:flex;flex-direction:column;gap:14px}
      .wb-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .wb-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#74747c)}
      .wb-badge{font-size:11px;padding:2px 8px;border-radius:99px;border:.5px solid var(--dsw-alias-border-l2,#dedee3);color:var(--dsw-alias-label-secondary,#74747c);white-space:nowrap}
      .wb-badge.wb-good{color:var(--dsw-alias-state-business-primary,#4176e6);border-color:currentColor}
      .wb-badge.wb-free{color:var(--dsw-alias-state-success-primary,#2f9e44);border-color:currentColor}
      .wb-input,.wb-button{height:30px;padding:0 10px;color:var(--dsw-alias-label-primary,#25252a);background:var(--dsw-alias-bg-layer-1,#fff);border:.5px solid var(--dsw-alias-border-l4,#d4d6db);border-radius:var(--dsw-radius-md,8px);font:inherit;font-size:13px}
      .wb-input{flex:1;min-width:160px}
      .wb-button{cursor:pointer;white-space:nowrap}
      .wb-button:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f1f3)}
      .wb-button:disabled{opacity:.5;cursor:default}
      .wb-button.wb-primary{background:var(--dsw-alias-state-business-primary,#4176e6);border-color:transparent;color:#fff}
      .wb-button.wb-primary:hover{filter:brightness(1.05)}
      .wb-note{font-size:11px;color:var(--dsw-alias-label-tertiary,#9a9aa3);line-height:1.5}
      .wb-error{font-size:12px;color:var(--dsw-alias-state-error-primary,#bd4747)}
      .wb-models{display:flex;flex-direction:column;gap:2px;max-height:280px;overflow:auto;border:.5px solid var(--dsw-alias-border-l2,#dedee3);border-radius:var(--dsw-radius-md,8px);padding:6px}
      .wb-model{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;font-size:13px;flex-wrap:nowrap;min-width:0}
      .wb-model:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f1f3)}
      .wb-model input{accent-color:var(--dsw-alias-state-business-primary,#4176e6);flex:none}
      .wb-model-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .wb-model-id{flex:0 1 auto;min-width:0;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#9a9aa3);font-size:11px}
      .wb-model .wb-badge{flex:none}
      .wb-quota{display:flex;flex-direction:column;gap:6px}
      .wb-quota-row{display:flex;align-items:center;gap:8px;font-size:12px}
      .wb-bar{flex:1;height:6px;border-radius:99px;background:var(--dsw-alias-border-l2,#dedee3);overflow:hidden}
      .wb-bar span{display:block;height:100%;background:var(--dsw-alias-state-business-primary,#4176e6)}
      .wb-check{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary,#74747c);cursor:pointer}
      .wb-check input{accent-color:var(--dsw-alias-state-business-primary,#4176e6)}
      .wb-link{color:var(--dsw-alias-state-business-primary,#4176e6);text-decoration:none;cursor:pointer}
      @media(prefers-reduced-motion:reduce){.wb-chev{transition:none}}
    `;

    const timeText = (ms) => {
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return ""
      const d = new Date(ms)
      return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    }

    /** 200,000 tokens reads as 200K, 1,048,576 as 1M — never 195K or 1024K. */
    const ctxText = (n) => {
      if (!Number.isFinite(n) || n <= 0) return ""
      if (n >= 1e6) return `${Math.round(n / 1e5) / 10}M`
      return `${Math.round(n / 1e3)}K`
    }

    const isStatus = (value) => typeof value === "object" && value !== null && !Array.isArray(value) && value.status === "ok"

    /** One row of the model list: the toggle, the name, the id, and its badges. */
    function modelRow(m, rowOptions) {
      const { busy, setModelEnabled } = rowOptions
      return h("label", { key: m.id, className: "wb-model" },
        h("input", {
          type: "checkbox",
          checked: m.enabled !== false,
          disabled: busy,
          onChange: (e) => {
            // The toggle names ONE model and its new state; it never sends a
            // list derived from a snapshot of the page. A snapshot is stale
            // the moment the catalog refreshes, and a complement computed from
            // a stale one can disable every model but the one clicked.
            void setModelEnabled(m.id, e.target.checked)
          },
        }),
        h("span", { className: "wb-model-name", title: m.name }, m.name),
        h("span", { className: "wb-model-id", title: m.id }, m.id),
        m.free ? h("span", { className: "wb-badge wb-free" }, L.freeTag) : null,
        m.rate ? h("span", { className: "wb-badge" }, `${L.rateTag} ${m.rate}`) : null,
        m.rateUnknown ? h("span", { className: "wb-badge" }, "—") : null,
        m.contextWindow ? h("span", { className: "wb-badge" }, `${L.ctxTag} ${ctxText(m.contextWindow)}`) : null)
    }

    /**
     * One variant's section: sign-in, catalog, model toggles, quota.
     *
     * The status document carries both variants and belongs to the card
     * shell, so switching tabs never refetches and never loses the other
     * variant's data.
     */
    function VariantSection(props) {
      const { provider, status, load, loading } = props
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [query, setQuery] = React.useState("")
      const [login, setLogin] = React.useState(null)
      const mounted = React.useRef(true)
      React.useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false }
      }, [])

      const variant = status?.variants?.[provider]

      const post = React.useCallback(async (path, body, key) => {
        setBusy(true)
        setNotice(null)
        try {
          const res = await fetch(path, {
            method: "POST",
            headers: { "content-type": "application/json", "x-dsh-workbuddy-connect-key": key ?? "" },
            body: JSON.stringify(body),
          })
          if (!res.ok) throw new Error(String(res.status))
          await load()
          return true
        } catch {
          setNotice(L.failed)
          return false
        } finally {
          setBusy(false)
        }
      }, [load])

      /** Begin the device-authorization flow and start polling for its outcome. */
      const beginLogin = React.useCallback(async () => {
        setBusy(true)
        setNotice(null)
        try {
          const res = await fetch(LOGIN_PATH, {
            method: "POST",
            headers: { "content-type": "application/json", "x-dsh-workbuddy-connect-key": status?.loginKey ?? "" },
            body: JSON.stringify({ action: "begin", provider }),
          })
          if (!res.ok) throw new Error(String(res.status))
          const doc = await res.json()
          if (!mounted.current) return
          if (doc?.status === "pending" && doc.authUrl) setLogin({ url: doc.authUrl, state: doc.state })
          else setNotice(doc?.error ?? L.failed)
        } catch {
          if (mounted.current) setNotice(L.failed)
        } finally {
          if (mounted.current) setBusy(false)
        }
      }, [provider, status])

      /** Adopt the session the WorkBuddy desktop app is already signed in to. */
      const importDesktop = React.useCallback(async () => {
        setBusy(true)
        setNotice(null)
        try {
          const res = await fetch(AUTH_PATH, {
            method: "POST",
            headers: { "content-type": "application/json", "x-dsh-workbuddy-connect-key": status?.authKey ?? "" },
            body: JSON.stringify({ action: "import-desktop", provider }),
          })
          if (!res.ok) throw new Error(String(res.status))
          const doc = await res.json()
          if (!mounted.current) return
          if (doc?.ok === true) await load()
          else setNotice(doc?.error ?? L.failed)
        } catch {
          if (mounted.current) setNotice(L.failed)
        } finally {
          if (mounted.current) setBusy(false)
        }
      }, [provider, status, load])

      /** Poll the pending attempt until the human finishes in the browser. */
      React.useEffect(() => {
        if (!login) return undefined
        let cancelled = false
        const timer = setInterval(async () => {
          try {
            const res = await fetch(LOGIN_PATH, {
              method: "POST",
              headers: { "content-type": "application/json", "x-dsh-workbuddy-connect-key": status?.loginKey ?? "" },
              body: JSON.stringify({ action: "poll", provider, state: login.state }),
            })
            if (!res.ok) throw new Error(String(res.status))
            const doc = await res.json()
            if (cancelled || !mounted.current) return
            if (doc?.status === "complete") {
              setLogin(null)
              await load()
            } else if (doc?.status === "error") {
              setLogin(null)
              setNotice(doc.error ?? L.failed)
            }
          } catch {
            // A transient poll failure is not a failed login: keep polling.
          }
        }, 2500)
        return () => { cancelled = true; clearInterval(timer) }
      }, [login, provider, status, load])

      const auth = variant?.auth
      const catalog = variant?.catalog
      const models = Array.isArray(catalog?.models) ? catalog.models : []
      const shown = query.trim() === "" ? models : models.filter((m) => `${m.name} ${m.id}`.toLowerCase().includes(query.trim().toLowerCase()))
      // Both mutations name what they change, never a list derived from the
      // page: the server owns the catalog and computes the rest.
      const setModelEnabled = (model, enabled) => post(MODELS_PATH, { action: "set-model", provider, model, enabled }, status?.modelsKey)
      const setAllEnabled = (enabled) => post(MODELS_PATH, { action: "set-all", provider, enabled }, status?.modelsKey)
      const credits = variant?.credits
      const creditAccounts = Array.isArray(credits?.accounts) ? credits.accounts : []
      const creditTotal = credits?.totalSize ?? creditAccounts.reduce((sum, a) => sum + (Number(a.size) || 0), 0)

      return h(React.Fragment, null,
        h("div", null,
          h("div", { className: "wb-row" },
            h("span", { className: "wb-label" }, auth?.state === "signed-in" ? L.signedIn : L.signedOut),
            h("span", { className: `wb-badge${auth?.state === "signed-in" ? " wb-good" : ""}` },
              auth?.state === "signed-in" ? (auth.nickname ?? variant?.appName) : L.signedOut),
            auth?.state === "signed-in"
              ? h(React.Fragment, null,
                  h("button", { type: "button", className: "wb-button", disabled: busy, onClick: () => void post(AUTH_PATH, { action: "logout", provider }, status.authKey) }, L.logout),
                  // The desktop app re-signs in behind the plugin's back and
                  // rotates its own session, so adopting that session again has
                  // to stay reachable while signed in — otherwise a rotated
                  // credential can only be replaced by signing out first.
                  variant?.desktopAvailable === true
                    ? h("button", { type: "button", className: "wb-button", disabled: busy, onClick: () => void importDesktop() }, L.importDesktop)
                    : null)
              : h(React.Fragment, null,
                  h("button", { type: "button", className: "wb-button wb-primary", disabled: busy, onClick: () => void beginLogin() }, L.signIn),
                  variant?.desktopAvailable === true
                    ? h("button", { type: "button", className: "wb-button", disabled: busy, onClick: () => void importDesktop() }, L.importDesktop)
                    : null)),
          auth?.state === "signed-in" ? h("div", { className: "wb-note", style: { marginTop: 4 } },
            [auth.domain ? `${L.domain}: ${auth.domain}` : null, auth.expiresAt ? ` · ${L.expires}: ${timeText(auth.expiresAt)}` : null].filter(Boolean).join("")) : null,
          auth?.sessionStale === true ? h("div", { className: "wb-error", style: { marginTop: 4 } }, L.sessionStale) : null,
          auth?.state !== "signed-in" ? h("div", { className: "wb-note", style: { marginTop: 4 } }, L.signedOutHint) : null,
          auth?.reason ? h("div", { className: "wb-error", style: { marginTop: 4 } }, auth.reason) : null,
          login ? h("div", { className: "wb-row", style: { marginTop: 8 } },
            h("span", { className: "wb-note" }, L.waiting),
            h("a", { className: "wb-link", href: login.url, target: "_blank", rel: "noreferrer" }, L.openLogin)) : null),
        variant?.auth?.state === "signed-in" ? h("div", null,
          h("div", { className: "wb-row" },
            h("span", { className: "wb-label" }, L.catalog),
            h("span", { className: `wb-badge${catalog.source === "live" ? " wb-good" : ""}` },
              catalog.source === "live" ? L.catalogLive : catalog.source === "saved" ? L.catalogSaved : L.catalogFallback,
              catalog.fetchedAt ? ` · ${L.catalogUpdated} ${timeText(catalog.fetchedAt)}` : ""),
            h("button", { type: "button", className: "wb-button", disabled: busy || loading, onClick: () => void post(MODELS_PATH, { action: "refresh", provider }, status.modelsKey) }, loading ? L.refreshing : L.refresh)),
          catalog.error ? h("div", { className: "wb-error", style: { marginTop: 4 } }, L.catalogError + catalog.error) : null,
          h("div", { className: "wb-row", style: { marginTop: 6 } },
            h("label", { className: "wb-check" },
              h("input", {
                type: "checkbox",
                checked: variant?.useMaximumContextWindow === true,
                disabled: busy,
                onChange: (e) => void post(MODELS_PATH, { action: "set-max-window", provider, enabled: e.target.checked }, status.modelsKey),
              }),
              h("span", null, L.maxWindow)),
            h("span", { className: "wb-note" }, L.maxWindowHint)),
          h("div", { className: "wb-row", style: { marginTop: 10 } },
            h("span", { className: "wb-label" }, L.models),
            h("input", { className: "wb-input", style: { maxWidth: 180, marginLeft: "auto" }, placeholder: L.search, value: query, onChange: (e) => setQuery(e.target.value) })),
          h("div", { className: "wb-note", style: { margin: "4px 0 6px" } }, L.modelsHint),
          h("div", { className: "wb-models" },
            shown.length === 0
              ? h("div", { className: "wb-note" }, "—")
              : shown.map((m) => modelRow(m, { busy, setModelEnabled }))),
          h("div", { className: "wb-row", style: { marginTop: 6 } },
            h("button", { type: "button", className: "wb-button", disabled: busy, onClick: () => void setAllEnabled(true) }, L.enableAll),
            h("button", { type: "button", className: "wb-button", disabled: busy, onClick: () => void setAllEnabled(false) }, L.disableAll))) : null,
        variant?.auth?.state === "signed-in" ? h("div", null,
          h("div", { className: "wb-row" },
            h("span", { className: "wb-label" }, L.credits),
            variant?.creditsError ? h("span", { className: "wb-badge" }, L.creditsError + variant.creditsError) : null),
          credits && creditAccounts.length > 0 ? h("div", { className: "wb-quota", style: { marginTop: 6 } },
            creditAccounts.map((a, i) => {
              const size = Number(a.size) || 0
              const remain = Number(a.remain) || 0
              const pct = size > 0 ? Math.max(0, Math.min(100, Math.round((remain / size) * 100))) : 0
              return h("div", { key: `${a.packageName}-${i}`, className: "wb-quota-row" },
                h("span", { style: { minWidth: 96, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: a.packageName }, a.packageName),
                h("span", { className: "wb-bar" }, h("span", { style: { width: `${pct}%` } })),
                h("span", { style: { whiteSpace: "nowrap" } }, `${remain} / ${size}`),
                a.packageEndTime ? h("span", { className: "wb-note" }, `${L.creditsEnd} ${a.packageEndTime}`) : null)
            }),
            creditTotal > 0 ? h("div", { className: "wb-note" }, `${L.creditsTotal}: ${creditTotal}`) : null)
            : credits ? h("div", { className: "wb-note" }, L.creditsNone) : null) : null,
        notice ? h("div", { className: "wb-error" }, notice) : null)
    }

    /**
     * The one card for both WorkBuddy editions.
     *
     * One panel with a variant tab, the way the Qoder connector does it: the
     * two editions share a card, a header and a status poll, and only the
     * section under the active tab differs.
     */
    function WorkBuddyCard() {
      const [open, setOpen] = React.useState(false)
      const [active, setActive] = React.useState("workbuddy-global")
      const [status, setStatus] = React.useState(null)
      const [loadError, setLoadError] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const mounted = React.useRef(true)
      React.useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false }
      }, [])

      const load = React.useCallback(async () => {
        setLoading(true)
        try {
          const res = await fetch(STATUS_PATH, { headers: { accept: "application/json" } })
          if (!res.ok) throw new Error(String(res.status))
          const doc = await res.json()
          if (!mounted.current) return
          if (isStatus(doc)) { setStatus(doc); setLoadError(null) }
          else setLoadError(L.errorLoad)
        } catch {
          if (mounted.current) setLoadError(L.errorLoad)
        } finally {
          if (mounted.current) setLoading(false)
        }
      }, [])

      // The status is cheap (it reads the cached catalog and the stored
      // credential — never the upstream), and the collapsed header shows the
      // sign-in state, so it is loaded whether the card is open or not.
      React.useEffect(() => {
        void load()
        const timer = setInterval(() => void load(), 60_000)
        return () => clearInterval(timer)
      }, [load])

      const variant = status?.variants?.[active]
      /** A tab's dot: green when that edition is signed in, amber while loading. */
      const dotClass = v => (v?.auth?.state === "signed-in" ? "wb-dot wb-dot-on" : status === null ? "wb-dot wb-dot-load" : "wb-dot")

      return h("div", { className: "wb-card" },
        h("style", null, css),
        h("button", { type: "button", className: "wb-head", onClick: () => setOpen((v) => !v), "aria-expanded": open },
          h("span", null,
            h("span", { className: "wb-title" }, L.title),
            h("div", { className: "wb-sub" }, L.subtitle)),
          variant?.auth?.state === "signed-in"
            ? h("span", { className: "wb-badge wb-good" }, variant.auth.nickname ?? variant.displayName)
            : status
              ? h("span", { className: "wb-badge" }, L.signedOut)
              : null,
          h("span", { className: `wb-chev${open ? " wb-open" : ""}`, "aria-hidden": "true" }, "›")),
        open ? h("div", { className: "wb-body" },
          h("div", { className: "wb-tabs", role: "tablist", "aria-label": L.title },
            h("button", { type: "button", role: "tab", className: "wb-tab", "aria-selected": active === "workbuddy-global", onClick: () => setActive("workbuddy-global") },
              h("span", { className: dotClass(status?.variants?.["workbuddy-global"]), "aria-hidden": "true" }),
              h("span", null, L.tabGlobal)),
            h("button", { type: "button", role: "tab", className: "wb-tab", "aria-selected": active === "workbuddy", onClick: () => setActive("workbuddy") },
              h("span", { className: dotClass(status?.variants?.["workbuddy"]), "aria-hidden": "true" }),
              h("span", null, L.tabCN))),
          loadError && !status ? h("div", { className: "wb-error" }, loadError, " ", h("button", { type: "button", className: "wb-button", onClick: () => void load() }, L.retry)) : null,
          status ? h(VariantSection, { provider: active, status, load, loading }) : h("div", { className: "wb-note" }, loading ? "…" : "—")) : null)
    }

    /**
     * Join the shared 《插件设置》 block with the same rendezvous protocol the
     * sibling connect plugins use: wait for the host's `settings.section`,
     * attach to the existing container when one is registered, otherwise
     * register it (falling back to attaching when a sibling wins the race).
     */
    const SHARED_SECTION_SLOT = "settings.section"
    const SHARED_SECTION_ID = "plugin-settings"
    const SHARED_SECTION_ORDER = 900
    const SHARED_ITEM_SLOT = "plugin-settings.item"
    const SHARED_ITEM_ID = "dsh-workbuddy-connect"
    const SHARED_SECTION_LABEL = "插件设置"

    function PluginSettingsSection(props) {
      return h("ul", {
        style: { display: "flex", flexDirection: "column", gap: 6, padding: 0, listStyle: "none" },
      }, props.renderSlot(SHARED_ITEM_SLOT, {}))
    }

    const inject = ["slots"]

    function apply(ctx) {
      try {
        ctx.slots.inject(SHARED_SECTION_SLOT, () => {
          try {
            let disposeContainer
            if (!ctx.slots.entries(SHARED_SECTION_SLOT).some((entry) => entry.options?.id === SHARED_SECTION_ID)) {
              try {
                disposeContainer = ctx.slots.register({
                  name: SHARED_SECTION_SLOT,
                  id: SHARED_SECTION_ID,
                  order: SHARED_SECTION_ORDER,
                  label: () => SHARED_SECTION_LABEL,
                  children: { [SHARED_ITEM_SLOT]: { kind: "list", scope: "root" } },
                }, PluginSettingsSection)
              } catch (error) {
                console.error("[dsh-workbuddy-connect] shared plugin-settings block lost the race; attaching to the winner:", error)
                note("container", error)
              }
            }
            const disposeItem = ctx.slots.inject(SHARED_ITEM_SLOT, () => ctx.slots.register({
              name: SHARED_ITEM_SLOT,
              id: SHARED_ITEM_ID,
              order: 50,
            }, () => h(WorkBuddyCard)))
            return () => {
              disposeItem()
              disposeContainer?.()
            }
          } catch (error) {
            console.error("[dsh-workbuddy-connect] could not register the settings item:", error)
            note("section-inject", error)
          }
        })
      } catch (error) {
        console.error("[dsh-workbuddy-connect] could not register the settings card:", error)
        note("apply", error)
      }
    }

    return { inject, apply }
  },
})
