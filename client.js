window.__ModuleLoader__.load({
  id: "@sixzjd/dsh-workbuddy-connect",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;
    // The plugin page's own primitives, so a contributed action is the same
    // component, size and icon as the page's built-in Update button rather than
    // a lookalike that drifts when the page's design changes.
    const {
      Button,
      IconRefreshOutlineRegular,
    } = require("@deepseek-ai/dsh-client-ui-primitives");
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
    const UPDATE_PATH = `${BASE}/update`;
    const ACCOUNTS_PATH = `${BASE}/accounts`;
    const CHECKIN_PATH = `${BASE}/checkin`;

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
      search: "搜索模型 / ID",
      enableAll: "全部开启",
      disableAll: "全部关闭",
      freeTag: "免费",
      paidTag: "需积分",
      modelCount: "个模型",
      accounts: "当前账号",
      removeCurrent: "删除当前",
      clearAll: "清除全部",
      checkIn: "每日签到",
      checkInOn: "自动签到",
      checkInHint: "每天自动为每个账号领取 Buddy 加油站积分；无活动的版本自动跳过。",
      checkInTime: "签到时间（UTC+8）",
      checkInNow: "立即签到",
      checkInLogs: "签到日志",
      checkInClear: "清空日志",
      checkInEmpty: "还没有签到记录",
      checkInClaimed: (n) => `已领取 ${n} 积分`,
      checkInAlready: "今天已领取",
      checkInNoCampaign: "当前没有签到活动",
      checkInBefore: "活动窗口尚未开启",
      checkInError: "签到失败",
      removeAccount: "移除",
      accountExpired: "已过期",
      accountActive: "当前",
      accountsCurrent: "当前账号",
      addAccount: "添加账号",
      addAccountHint: "添加新账号，当前帐号会被保留",
      accountSwitched: "已切换账号",
      accountRemoved: "已移除账号",
      removeConfirm: "移除这个账号？它的登录信息会从本机删除。",
      cacheHit: "缓存命中",
      cacheLast: "最近一轮",
      cacheTurns: "轮",
      cacheIdle: "本次启动后还没有请求",
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
      updateTitle: "插件更新",
      updateHint: "git 版本可以在这里一键检查并更新到上游最新提交；DSH 自己只给官方插件显示「更新」。",
      accountRestricted: "上游已限制这个账号（不是凭据问题，重新登录或重新导入都无效）。只有申诉才能解除：在 WorkBuddy 里提交反馈。",
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
      search: "search models / id",
      enableAll: "Enable all",
      disableAll: "Disable all",
      freeTag: "free",
      paidTag: "uses credits",
      modelCount: "models",
      accounts: "Current account",
      removeCurrent: "Delete current",
      clearAll: "Clear all",
      checkIn: "Daily check-in",
      checkInOn: "Auto check-in",
      checkInHint: "Claim the Buddy 加油站 credits for every account each day; editions with no campaign are skipped.",
      checkInTime: "Check-in time (UTC+8)",
      checkInNow: "Check in now",
      checkInLogs: "Check-in log",
      checkInClear: "Clear log",
      checkInEmpty: "No check-ins recorded yet",
      checkInClaimed: (n) => `Claimed ${n} credits`,
      checkInAlready: "Already claimed today",
      checkInNoCampaign: "No active campaign",
      checkInBefore: "Window not open yet",
      checkInError: "Check-in failed",
      removeAccount: "Remove",
      accountExpired: "expired",
      accountActive: "active",
      accountsCurrent: "Active account",
      addAccount: "Add account",
      addAccountHint: "Add another account; the current one is kept.",
      accountSwitched: "Account switched",
      accountRemoved: "Account removed",
      removeConfirm: "Remove this account? Its sign-in will be deleted from this machine.",
      cacheHit: "cache hit",
      cacheLast: "latest",
      cacheTurns: "turns",
      cacheIdle: "no requests yet this session",
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
      updateTitle: "Plugin update",
      updateHint: "For a git install this checks upstream and updates to its latest commit in one click; DSH itself only shows Update for official plugins.",
      accountRestricted: "The upstream has restricted this account — this is not a credential problem, so signing in or importing again will not help. Only an appeal lifts it: submit feedback in WorkBuddy.",
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
      /* The account toolbar has to stay on ONE line: with flex-wrap the three
         actions slid onto a second line under the dropdown, so the row read as
         two unrelated groups. */
      .wb-row.wb-row-nowrap{flex-wrap:nowrap;min-width:0}
      .wb-row-nowrap .wb-account-label{flex:none}
      .wb-row-nowrap .wb-dd{flex:0 1 auto;min-width:120px;max-width:280px}
      .wb-row-nowrap .wb-row-actions{flex:none;white-space:nowrap}
      .wb-row-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-left:auto}
      .wb-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#74747c)}
      .wb-badge{font-size:11px;padding:2px 8px;border-radius:99px;border:.5px solid var(--dsw-alias-border-l2,#dedee3);color:var(--dsw-alias-label-secondary,#74747c);white-space:nowrap}
      .wb-badge.wb-good{color:var(--dsw-alias-state-business-primary,#4176e6);border-color:currentColor}
      .wb-badge.wb-free{color:var(--dsw-alias-state-success-primary,#2f9e44);border-color:currentColor}
      /* An upstream-declared label (limit-time free, night discount) is
         information, so it stays quiet rather than warning-coloured. */
      .wb-badge.wb-upstream{color:var(--dsw-alias-state-business-primary,#4176e6);border-color:currentColor}
      .wb-input,.wb-button{height:30px;padding:0 10px;color:var(--dsw-alias-label-primary,#25252a);background:var(--dsw-alias-bg-layer-1,#fff);border:.5px solid var(--dsw-alias-border-l4,#d4d6db);border-radius:var(--dsw-radius-md,8px);font:inherit;font-size:13px}
      .wb-input{flex:1;min-width:160px}
      .wb-update-action{display:inline-flex;align-items:center;gap:8px;min-width:0}
      .wb-update-note{color:var(--dsw-alias-label-tertiary,#9a9aa3);font-size:12.5px;line-height:18px;white-space:nowrap}
      .wb-update-note-info{color:var(--dsw-alias-state-business-primary,#4176e6)}
      @media (max-width:720px){.wb-update-note{display:none}}
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
      /* Settings-row shape, matching the DSH settings page (and the usage
         dashboard plugin): title + description on the left, one control right. */
      .wb-account-block{margin-top:2px}
      .wb-checkin{margin-top:6px;border-top:.5px solid var(--dsw-alias-border-l2,#dedee3);padding-top:4px}
      .wb-checkin-log{display:flex;align-items:center;gap:8px;padding:3px 0}
      .wb-checkin-logs{max-height:160px;overflow-y:auto}
      .wb-account-label{display:flex;align-items:center;gap:6px}
      .wb-config-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2,#dedee3)}
      .wb-config-label{display:flex;flex-direction:column;gap:2px;min-width:0}
      .wb-config-title{font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary,#25252a)}
      .wb-config-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#74747c)}
      .wb-config-control{display:flex;align-items:center;gap:8px;flex:none}
      .wb-config-value{font-size:13px;color:var(--dsw-alias-label-primary,#25252a);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      /* Same dropdown as the DSH usage dashboard: a settings-style trigger and a
         themed panel, rather than the OS-native menu a <select> produces. */
      .wb-dd{position:relative;min-width:0;max-width:100%}
      .wb-dd-trigger{box-sizing:border-box;display:flex;align-items:center;gap:8px;height:32px;padding:0 12px;border:none;border-radius:var(--dsw-radius-md,8px);background-color:var(--dsw-alias-bg-module-platform,#f5f6f7);color:var(--dsw-alias-label-primary,#25252a);font:inherit;font-size:13px;line-height:20px;cursor:pointer;max-width:100%;transition:background-color .15s ease}
      .wb-dd-trigger:hover{background-color:var(--dsw-alias-interactive-bg-hover,#f1f1f3)}
      .wb-dd-trigger:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:1px}
      .wb-dd-trigger[disabled]{color:var(--dsw-alias-label-tertiary,#9a9aa3);cursor:default}
      .wb-dd-value{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .wb-dd-caret{margin-left:auto;flex:none;color:var(--dsw-alias-label-secondary,#74747c);transition:transform .15s ease}
      .wb-dd-open .wb-dd-caret{transform:rotate(180deg)}
      .wb-dd-panel{position:absolute;z-index:40;top:calc(100% + 6px);left:0;min-width:100%;max-height:320px;overflow-y:auto;padding:6px;border-radius:var(--dsw-radius-panel,12px);background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 8px 24px rgba(0,0,0,.14);border:.5px solid var(--dsw-alias-border-l2,#dedee3)}
      .wb-dd-option{display:flex;align-items:center;gap:12px;padding:9px 12px;border-radius:var(--dsw-radius-sm,6px);color:var(--dsw-alias-label-primary,#25252a);font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap}
      .wb-dd-option-label{min-width:0;overflow:hidden;text-overflow:ellipsis}
      .wb-dd-active{background:var(--dsw-alias-interactive-bg-hover,#f1f1f3)}
      .wb-dd-selected{font-weight:500}
      .wb-dd-check{margin-left:auto;flex:none;color:var(--dsw-alias-label-primary,#25252a)}
      /* Danger actions share the ordinary button's shape (border, radius,
         background) and only change the colour, so the card reads as one set
         of controls rather than a mix of buttons and bare links. */
      .wb-button.wb-danger{color:var(--dsw-alias-state-danger-primary,#d94a4a);border-color:currentColor}
      .wb-button.wb-danger:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f1f3)}
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

    /**
     * Time choices for the check-in dropdown. Every half hour from 10:00 to
     * 23:30, plus 00:00–09:30 for people who prefer a late-night claim; the
     * upstream window opens at 10:00 UTC+8 so earlier slots simply re-attempt
     * the previous window, which is harmless (the endpoint is idempotent).
     */
    const checkInTimeOptions = () => {
      const out = []
      for (let minute = 0; minute < 1440; minute += 30) {
        out.push({
          value: String(minute),
          label: `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`,
        })
      }
      return out
    }
    /** One log row's short result label. */
    const checkInStatusText = (log) => {
      if (log.status === "claimed") return L.checkInClaimed(log.amount ?? 100)
      if (log.status === "already-claimed") return L.checkInAlready
      if (log.status === "no-campaign") return L.checkInNoCampaign
      if (log.status === "before-window") return L.checkInBefore
      return `${L.checkInError}: ${log.message ?? ""}`.slice(0, 60)
    }

    const isStatus = (value) => typeof value === "object" && value !== null && !Array.isArray(value) && value.status === "ok"

    /**
     * A dropdown shaped exactly like the DSH settings' own select and the usage
     * dashboard's picker: a trigger on the module-platform background, a panel
     * with a check on the selected row. The native <select> rendered the OS menu
     * shown in the screenshot, which does not belong to this theme; keeping the
     * same markup and --dsw-* tokens makes the account switcher read as part of
     * the settings page rather than an embedded widget.
     */
    function Dropdown({ label, value, options, onChange, disabled }) {
      const [open, setOpen] = React.useState(false)
      const [active, setActive] = React.useState(-1)
      const rootRef = React.useRef(null)
      const triggerRef = React.useRef(null)
      const listRef = React.useRef(null)
      const listId = React.useMemo(() => "wb-dd-" + Math.random().toString(36).slice(2, 9), [])
      const current = options.find((option) => option.value === value)
      const choose = (index) => {
        const option = options[index]
        if (option !== undefined) onChange(option.value)
        setOpen(false)
        setActive(-1)
        triggerRef.current?.focus?.()
      }
      const onKeyDown = (event) => {
        if (event.key === "Escape") { setOpen(false); return }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault()
          if (!open) { setOpen(true); setActive(Math.max(0, options.findIndex((o) => o.value === value))); return }
          const delta = event.key === "ArrowDown" ? 1 : -1
          setActive((i) => (i + delta + options.length) % options.length)
          return
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          if (open) choose(active);
          else setOpen(true)
        }
      }
      React.useEffect(() => {
        if (!open) return
        const onPointerDown = (event) => {
          if (!rootRef.current?.contains?.(event.target)) setOpen(false)
        }
        document.addEventListener("pointerdown", onPointerDown)
        return () => document.removeEventListener("pointerdown", onPointerDown)
      }, [open])
      React.useEffect(() => {
        if (!open || active < 0 || listRef.current === null) return
        listRef.current.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" })
      }, [open, active])

      return h("div", { className: "wb-dd", ref: rootRef },
        h("button", {
          type: "button",
          className: `wb-dd-trigger${open ? " wb-dd-open" : ""}`,
          ref: triggerRef,
          disabled: disabled === true,
          "aria-label": label,
          "aria-haspopup": "listbox",
          "aria-expanded": open,
          onClick: () => setOpen((v) => !v),
          onKeyDown,
        },
          h("span", { className: "wb-dd-value" }, current?.label ?? ""),
          h("svg", { className: "wb-dd-caret", width: 12, height: 12, viewBox: "0 0 12 12", fill: "none", "aria-hidden": "true", focusable: "false" },
            h("path", { d: "M3 4.5L6 7.5L9 4.5", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" }))),
        open ? h("div", { className: "wb-dd-panel", role: "listbox", ref: listRef, "aria-label": label, "aria-activedescendant": active >= 0 ? `${listId}-${active}` : undefined },
          options.map((option, index) => h("div", {
            key: option.value,
            "data-index": index,
            id: `${listId}-${index}`,
            role: "option",
            "aria-selected": option.value === value,
            className: `wb-dd-option${option.value === value ? " wb-dd-selected" : ""}${index === active ? " wb-dd-active" : ""}`,
            onPointerEnter: () => setActive(index),
            onClick: () => choose(index),
          },
            h("span", { className: "wb-dd-option-label" }, option.label),
            option.value === value
              ? h("svg", { className: "wb-dd-check", width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", focusable: "false" },
                  h("path", { d: "M3.5 8.5L6.5 11.5L12.5 4.5", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" }))
              : null))) : null);
    }

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
        // The upstream's own labels (限时免费 / 夜间折扣 / any future 订阅优先)
        // are rendered verbatim. That is the whole point: the plugin shows what
        // the upstream declares rather than guessing at a tier — the same rule
        // the reasoning levels follow.
        ...(Array.isArray(m.badges) ? m.badges.map((b) => h("span", { key: "b-" + b, className: "wb-badge wb-upstream" }, b)) : []),
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
      // Guarded: an older host does not send this field at all, and the card must
      // keep working against one. Declared before the handlers below, which read it.
      const accounts = Array.isArray(variant?.accounts) ? variant.accounts : []
      const checkIn = variant?.checkIn
      const setCheckIn = (patch) => post(CHECKIN_PATH, { action: "set", provider, ...patch }, status?.checkInKey)
      /** Make a stored account active. The server refreshes catalog and credits. */
      const switchAccount = (hash) => post(ACCOUNTS_PATH, { action: "activate", provider, hash }, status?.accountsKey)
      /** Forget one account. Removing the active one promotes another server-side. */
      const removeAccount = (hash) => post(ACCOUNTS_PATH, { action: "remove", provider, hash }, status?.accountsKey)
      /** Delete the active account; server promotes another if one is left. */
      const removeCurrent = () => {
        const current = accounts.find((a) => a.active) ?? accounts[0]
        return current ? removeAccount(current.hash) : Promise.resolve(false)
      }
      /** Clear every account of this edition (never the other realm). */
      const clearAccounts = () => post(ACCOUNTS_PATH, { action: "clear", provider }, status?.accountsKey)
      const credits = variant?.credits
      const creditAccounts = Array.isArray(credits?.accounts) ? credits.accounts : []
      const creditTotal = credits?.totalSize ?? creditAccounts.reduce((sum, a) => sum + (Number(a.size) || 0), 0)
      const cache = variant?.cache

      return h(React.Fragment, null,
        h("div", null,
          h("div", { className: "wb-row" },
            h("span", { className: "wb-label" }, auth?.state === "signed-in" ? L.signedIn : L.signedOut),
            auth?.state === "signed-in"
              ? h("span", { className: "wb-badge wb-good" }, auth.nickname ?? variant?.appName)
              : null,
            h("div", { className: "wb-row-actions" },
              auth?.state === "signed-in"
                ? h(React.Fragment, null,
                    h("button", { type: "button", className: "wb-button", disabled: busy, onClick: () => void post(AUTH_PATH, { action: "logout", provider }, status.authKey) }, L.logout),
                    // The desktop app can rotate its session behind the plugin's
                    // back, so this stays reachable while signed in.
                    variant?.desktopAvailable === true
                      ? h("button", { type: "button", className: "wb-button", disabled: busy, onClick: () => void importDesktop() }, L.importDesktop)
                      : null)
                : h(React.Fragment, null,
                    h("button", { type: "button", className: "wb-button wb-primary", disabled: busy, onClick: () => void beginLogin() }, L.signIn),
                    variant?.desktopAvailable === true
                      ? h("button", { type: "button", className: "wb-button", disabled: busy, onClick: () => void importDesktop() }, L.importDesktop)
                      : null))),
          auth?.state === "signed-in" ? h("div", { className: "wb-note", style: { marginTop: 4 } },
            [auth.domain ? `${L.domain}: ${auth.domain}` : null, auth.expiresAt ? ` · ${L.expires}: ${timeText(auth.expiresAt)}` : null].filter(Boolean).join("")) : null,
          // The account area.
          //
          // Shaped after the DSH settings rows the usage dashboard uses: a title,
          // a description, and one control — because that is where this card
          // lives and a row that does not match its neighbours reads as an
          // embedded widget rather than part of the page.
          //
          // The switcher is a select, not a list of buttons: with two accounts a
          // list is noisy, and with five it is unusable. "Add account" is always
          // available, including while signed in — that is the only way a second
          // account can ever get in here, and hiding it while signed in was the
          // reason there was no way to add one at all.
          // Account toolbar, in the same shape Qoder uses for its PATs: a
          // labelled dropdown naming the active account, then add / delete
          // current / clear all. The token is an account credential here rather
          // than a PAT, but the management operations are the same four.
          // Both editions render this identical block — only the realm's account
          // list behind it differs.
          h("div", { className: "wb-account-block" },
            h("div", { className: "wb-row wb-row-nowrap" },
              h("span", { className: "wb-label wb-account-label" },
                h("span", { className: "wb-dot wb-dot-on", "aria-hidden": "true" }),
                L.accounts),
              accounts.length > 0
                ? h(Dropdown, {
                    label: L.accounts,
                    value: (accounts.find((a) => a.active) ?? accounts[0]).hash,
                    disabled: busy,
                    options: accounts.map((account) => ({
                      value: account.hash,
                      label: `${account.nickname ?? account.uidShort}${account.expired ? ` · ${L.accountExpired}` : ""}`,
                    })),
                    onChange: (hash) => void switchAccount(hash),
                  })
                : h("span", { className: "wb-config-value" }, "—"),
              h("div", { className: "wb-row-actions" },
                h("button", {
                  type: "button",
                  className: "wb-button",
                  disabled: busy,
                  onClick: () => void beginLogin(),
                }, L.addAccount),
                accounts.length > 0
                  ? h("button", {
                      type: "button",
                      className: "wb-button",
                      disabled: busy,
                      onClick: () => void removeCurrent(),
                    }, L.removeCurrent)
                  : null,
                accounts.length > 0
                  ? h("button", {
                      type: "button",
                      className: "wb-button",
                      disabled: busy,
                      onClick: () => void clearAccounts(),
                    }, L.clearAll)
                  : null)),
            h("div", { className: "wb-note", style: { margin: "4px 0 0" } }, L.addAccountHint)),
          // Daily check-in, in the same settings-row shape Qoder uses. The
          // schedule is opt-in: no claim is made until the user enables it.
          auth?.state === "signed-in" ? h("div", { className: "wb-checkin" },
            h("div", { className: "wb-config-row" },
              h("div", { className: "wb-config-label" },
                h("div", { className: "wb-config-title" }, L.checkIn),
                h("div", { className: "wb-config-desc" }, L.checkInHint)),
              h("div", { className: "wb-config-control" },
                h("label", { className: "wb-check" },
                  h("input", {
                    type: "checkbox",
                    checked: checkIn?.enabled === true,
                    disabled: busy,
                    onChange: (e) => void setCheckIn({ enabled: e.target.checked }),
                  }),
                  h("span", null, L.checkInOn)))),
            h("div", { className: "wb-row", style: { marginTop: 4 } },
              h("label", { className: "wb-label" }, L.checkInTime),
              h(Dropdown, {
                label: L.checkInTime,
                value: String(checkIn?.minuteOfDay ?? 605),
                disabled: busy,
                options: checkInTimeOptions(),
                onChange: (value) => void setCheckIn({ minuteOfDay: Number(value) }),
              }),
              h("div", { className: "wb-row-actions" },
                h("button", {
                  type: "button",
                  className: "wb-button",
                  disabled: busy,
                  onClick: () => void post(CHECKIN_PATH, { action: "now", provider }, status?.checkInKey),
                }, L.checkInNow))),
            Array.isArray(checkIn?.record?.logs) && checkIn.record.logs.length > 0
              ? h(React.Fragment, null,
                  // The title row stays OUTSIDE the scroll container: its
                  // scrollbar steals ~12px and pushed this button left of the
                  // two above it. Only the log lines need to scroll.
                  h("div", { className: "wb-row", style: { marginTop: 6 } },
                    h("span", { className: "wb-label" }, L.checkInLogs),
                    h("div", { className: "wb-row-actions" },
                      h("button", {
                        type: "button",
                        className: "wb-button wb-danger",
                        disabled: busy,
                        onClick: () => void post(CHECKIN_PATH, { action: "clear-logs", provider }, status?.checkInKey),
                      }, L.checkInClear))),
                  h("div", { className: "wb-checkin-logs" },
                    checkIn.record.logs.slice(0, 5).map((log) => h("div", { key: log.id, className: "wb-checkin-log" },
                      h("span", { className: "wb-note" }, new Date(log.timestamp).toLocaleString("zh-CN", { hour12: false })),
                      h("span", { className: `wb-badge${log.status === "claimed" ? " wb-free" : ""}` }, checkInStatusText(log)),
                      h("span", { className: "wb-account-name" }, log.account?.nickname ?? log.account?.uidShort ?? "")))))
              : null)
          : null,
          auth?.accountRestricted ? h("div", { className: "wb-error", style: { marginTop: 4 } },
            L.accountRestricted,
            h("div", { className: "wb-note", style: { marginTop: 2 } }, String(auth.accountRestricted))) : null,
          auth?.sessionStale === true && !auth?.accountRestricted ? h("div", { className: "wb-error", style: { marginTop: 4 } }, L.sessionStale) : null,
          auth?.state !== "signed-in" ? h("div", { className: "wb-note", style: { marginTop: 4 } }, L.signedOutHint) : null,
          auth?.reason ? h("div", { className: "wb-error", style: { marginTop: 4 } }, auth.reason) : null,
          login ? h("div", { className: "wb-row", style: { marginTop: 8 } },
            h("span", { className: "wb-note" }, L.waiting),
            h("a", { className: "wb-link", href: login.url, target: "_blank", rel: "noreferrer" }, L.openLogin)) : null),
        variant?.auth?.state === "signed-in" ? h("div", null,
          h("div", { className: "wb-row" },
            h("span", { className: "wb-label" }, L.catalog),
            h("div", { className: "wb-row-actions" },
              // The source/timestamp badge is deliberately gone: it duplicated
              // information and took the whole row hostage. Only the action stays.
              h("button", { type: "button", className: "wb-button", disabled: busy || loading, onClick: () => void post(MODELS_PATH, { action: "refresh", provider }, status.modelsKey) }, loading ? L.refreshing : L.refresh))),
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
          // A count, not a badge on every row: nearly every model costs credits,
          // and a tag repeated 22 times carries no information. The free/free
          // distinction is the actionable one, so it is stated once.
          h("div", { className: "wb-note", style: { margin: "0 0 6px" } },
            `${shown.length} ${L.modelCount} · ${L.freeTag} ${shown.filter((m) => m.free).length} · ${L.paidTag} ${shown.filter((m) => m.paid).length}`),
          // The hit rate is what decides whether a long conversation is cheap or
          // expensive, and until now it could only be inferred from a bill. The
          // count of turns is part of the answer: 0 turns is "not measured yet",
          // which must never be rendered as "0%".
          h("div", { className: "wb-note", style: { margin: "0 0 6px" } },
            cache?.turns > 0
              ? `${L.cacheHit} ${(cache.rate * 100).toFixed(1)}% (${L.cacheLast} ${(cache.lastRate * 100).toFixed(1)}% · ${cache.turns} ${L.cacheTurns})`
              : `${L.cacheHit} — (${L.cacheIdle})`),
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

    /** The package name this card belongs to, as the plugin page reports it. */
    const PACKAGE_NAME = "@sixzjd/dsh-workbuddy-connect";
    /** Names an existing profile may still declare from before the rename. */
    const LEGACY_PACKAGE_NAMES = ["dsh-workbuddy-connect"];

    const inject = ["slots"]

    function apply(ctx) {
      try {
        ctx.slots.inject(SHARED_SECTION_SLOT, () => {
          try {
            /**
             * Register the shared block unless a sibling already owns it.
             *
             * The registrant OWNS the child declaration `plugin-settings.item`,
             * and a slot's entries and its declaration die together: disposing
             * the owner collapses the child slot and cascades every sibling's
             * card away with it. That is why disabling whichever connector
             * happened to register the block first used to remove the whole
             * 《插件设置》 entry, taking the still-enabled connectors' cards with
             * it.
             */
            const registerContainer = () => {
              if (ctx.slots.entries(SHARED_SECTION_SLOT).some((entry) => entry.options?.id === SHARED_SECTION_ID)) return undefined
              try {
                return ctx.slots.register({
                  name: SHARED_SECTION_SLOT,
                  id: SHARED_SECTION_ID,
                  order: SHARED_SECTION_ORDER,
                  label: () => SHARED_SECTION_LABEL,
                  children: { [SHARED_ITEM_SLOT]: { kind: "list", scope: "root" } },
                }, PluginSettingsSection)
              } catch (error) {
                // A sibling won the race between the check and the register.
                console.error("[dsh-workbuddy-connect] shared plugin-settings block lost the race; attaching to the winner:", error)
                note("container", error)
                return undefined
              }
            }
            // Depends on the ITEM slot, not the container: the item slot's
            // declaration epoch is what changes when an owner collapses, so
            // this re-fires and re-registers the card after a recovery.
            const disposeItem = ctx.slots.inject(SHARED_ITEM_SLOT, () => ctx.slots.register({
              name: SHARED_ITEM_SLOT,
              id: SHARED_ITEM_ID,
              order: 50,
            }, () => h(WorkBuddyCard)))
            let disposeContainer = registerContainer()
            // Recovery: `settings.section` stays declared by the host, so this
            // subscription outlives a sibling's collapse. Re-adopt the block so
            // the survivors' cards come back without a page reload.
            const unsubscribe = ctx.slots.subscribe(SHARED_SECTION_SLOT, () => {
              disposeContainer = registerContainer() ?? disposeContainer
            })
            return () => {
              unsubscribe()
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
