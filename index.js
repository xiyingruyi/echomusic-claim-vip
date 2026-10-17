// claim-vip —— 恢复 EchoMusic「领取会员」功能
//
// 原版（最后一个内置该功能的版本 2.2.8-beta.5）在个人中心提供两个按钮：
//   「领取畅听会员」  ->  GET /youth/day/vip?receive_day=<today>   (youth_day_vip.js)
//   「升级概念会员」  ->  GET /youth/day/vip/upgrade                (youth_day_vip_upgrade.js)
// 以及登录后自动领取。当前版本把 UI 去掉了，但 API 仍保留在 ctx.kugou.user 下。
//
// 本插件通过 ctx.kugou.user.* 恢复这些能力，鉴权、签名、风控验证全部由宿主完成，
// 插件只传业务参数。UI 入口：标题栏「礼物」按钮打开面板；插件设置页也有同一面板。

const STORAGE_KEY = "settings";
const DEFAULT_SETTINGS = { autoClaim: false };

const PLUGIN_TAG = "[claim-vip]";

// ---------- 模块级状态 ----------
let state = null; // { settings } 响应式
let claimState = null; // { busy, lastMessage, lastOk, musicDone, conceptDone }
let dialogOpen = null; // 面板弹层开关

// 本次会话内已成功领取的乐观标记：服务器月记录/VIP 详情有同步延迟，
// 若不保留该标记，刚领取成功后立刻刷新状态会把「已领取」翻回「未领取」。
const optimistic = { day: "", music: false, concept: false };

// 把乐观标记对齐到指定日期（跨天后自动作废）
const syncOptimisticDay = (today) => {
  if (optimistic.day !== today) {
    optimistic.day = today;
    optimistic.music = false;
    optimistic.concept = false;
  }
};

let cssDispose = null;
let teleportDispose = null;
let titlebarDispose = null;
let settingsDispose = null;
let loginUnwatch = null;
let autoClaimTimer = null; // 登录后自动领取的延迟任务句柄

// ---------- 工具 ----------
const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);

const normalizeSettings = (value) => {
  const source = isObject(value) ? value : {};
  return {
    ...DEFAULT_SETTINGS,
    ...source,
    autoClaim: source.autoClaim === true,
  };
};

// 解析请求错误：业务失败时宿主会抛 Error('API Error: 502')，响应体挂在 .response.body
const extractError = (error) => {
  const body = isObject(error?.response?.body)
    ? error.response.body
    : isObject(error?.response)
      ? error.response
      : {};
  const code = Number(body?.error_code ?? body?.errcode ?? body?.code ?? 0);
  const msg = String(body?.msg || body?.error_msg || body?.message || "").trim();
  return { code, msg };
};

// 服务器今日（UTC+8），失败回退本地时间。与原生 getServerToday 逻辑一致。
const getToday = async (ctx) => {
  try {
    const res = await ctx.kugou.user.getServerNow();
    const data = isObject(res?.data) ? res.data : isObject(res) ? res : {};
    const candidates = [data.now, data.time, data.timestamp, data.server_time, data.serverTime];
    for (const raw of candidates) {
      const value = Number(raw);
      if (Number.isFinite(value) && value > 0) {
        const ms = value > 1e12 ? value : value * 1e3;
        return new Date(ms + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
      }
    }
  } catch (error) {
    console.warn(PLUGIN_TAG, "获取服务器时间失败，回退本地时间", error);
  }
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
};

// 领取畅听会员
const claimMusicVip = async (ctx) => {
  const today = await getToday(ctx);
  return ctx.kugou.user.claimDayVip(today);
};

// 升级概念会员
const claimConceptVip = async (ctx) => {
  return ctx.kugou.user.upgradeDayVip();
};

// 从月领取记录判断今日是否已领畅听；从 VIP 详情判断概念会员是否已开。
// 服务器有一定同步延迟，因此只允许「未领取 -> 已领取」的单向翻转：
// 已判定为已领时，后续刷新不会把它翻回未领，避免刚领完就显示未领。
const refreshStatus = async (ctx) => {
  // 记下本次激活周期的状态对象：插件停用后 claimState 会被置空，
  // 此时在途的 await 续体若继续写入会抛错或污染下一次激活的状态。
  const target = claimState;
  if (!ctx || !target) return;
  const alive = () => claimState === target;
  let today = "";
  try {
    today = await getToday(ctx);
    syncOptimisticDay(today);
    const record = await ctx.kugou.user.getVipMonthRecord();
    const data = isObject(record?.data) ? record.data : isObject(record) ? record : {};
    const list = Array.isArray(data.list) ? data.list : Array.isArray(record?.list) ? record.list : [];
    const claimed = list.some((item) => String(item?.day) === today);
    if (!alive()) return;
    target.musicDone = claimed || optimistic.music;
  } catch (error) {
    console.warn(PLUGIN_TAG, "获取领取记录失败", error);
  }

  try {
    const detail = await ctx.kugou.user.getUserVipDetail();
    const data = isObject(detail?.data) ? detail.data : isObject(detail) ? detail : {};
    const busiVip = Array.isArray(data.busi_vip)
      ? data.busi_vip
      : Array.isArray(detail?.data?.busi_vip)
        ? detail.data.busi_vip
        : [];
    const upgraded = busiVip.some(
      (item) => item?.product_type === "svip" && Number(item?.is_vip) === 1,
    );
    if (!alive()) return;
    target.conceptDone = upgraded || optimistic.concept;
  } catch (error) {
    console.warn(PLUGIN_TAG, "获取 VIP 详情失败", error);
  }

  // 服务器已确认的部分同样记入乐观标记，保证跨天判定一致。
  if (target.musicDone) optimistic.music = true;
  if (target.conceptDone) optimistic.concept = true;
};

// 登录后自动领取（与原生 autoReceiveVipIfNeeded 一致：逐个尝试、忽略单步失败）
// 返回实际结果，避免在「今日已领过」时误报成功。
const autoReceive = async (ctx) => {
  const today = await getToday(ctx);
  syncOptimisticDay(today);
  let musicOk = false;
  let conceptOk = false;

  try {
    await ctx.kugou.user.claimDayVip(today);
    musicOk = true;
    optimistic.music = true;
  } catch (error) {
    const { code } = extractError(error);
    // 今日已领过时接口同样会报错，此时按「已完成」处理更符合用户预期。
    if (code === 0) console.warn(PLUGIN_TAG, "自动领取畅听会员失败", error);
    else console.warn(PLUGIN_TAG, `自动领取畅听会员未执行（错误码 ${code}）`);
  }

  try {
    await ctx.kugou.user.upgradeDayVip();
    conceptOk = true;
    optimistic.concept = true;
  } catch (error) {
    const { code } = extractError(error);
    if (code === 297002) {
      optimistic.concept = true;
      console.warn(PLUGIN_TAG, "自动升级概念会员：今日已升级");
    } else {
      console.warn(PLUGIN_TAG, "自动升级概念会员失败", error);
    }
  }

  if (musicOk || conceptOk) {
    const parts = [];
    if (musicOk) parts.push("畅听会员");
    if (conceptOk) parts.push("概念会员");
    ctx.toast.success(`已自动领取${parts.join("、")}`);
  }
  // 全部未执行（例如今日已领过）时不打扰用户，状态以服务器记录为准。
};

// ---------- UI ----------
const CSS = `
.claim-vip-mask {
  position: fixed;
  inset: 0;
  /* 宿主层级：抽屉 1400 / 弹窗 1600+ / Toast 5000 / 气泡 9999 / Tooltip 10030。
     取 4500 可盖住页面与宿主导航，又低于 Toast，保证领取结果提示不被遮住。 */
  z-index: 4500;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.42);
}
.claim-vip-dialog {
  width: min(400px, calc(100vw - 32px));
  border-radius: 14px;
  background: var(--surface-elevated-base, #1a1d24);
  border: 1px solid color-mix(in srgb, var(--color-text-main, #e6e8ee) 14%, transparent);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.35);
  padding: 18px;
  color: var(--color-text-main, #e6e8ee);
}
.claim-vip-dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.claim-vip-dialog-head h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 760;
}
.claim-vip-close {
  border: 0;
  background: transparent;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.9));
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 4px;
  border-radius: 6px;
}
.claim-vip-close:hover {
  background: var(--control-hover-bg, rgba(255, 255, 255, 0.08));
}
.claim-vip-panel {
  display: grid;
  gap: 12px;
}
.claim-vip-status {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 10px;
  align-items: center;
  padding: 10px 12px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--color-text-main, #e6e8ee) 6%, transparent);
  font-size: 13px;
}
.claim-vip-status .status-label {
  font-weight: 650;
}
.claim-vip-status .status-value {
  text-align: right;
  font-weight: 650;
}
.claim-vip-status .is-done {
  color: #31cfa1;
}
.claim-vip-status .is-pending {
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.9));
}
.claim-vip-actions {
  display: grid;
  gap: 10px;
}
.claim-vip-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--color-text-main, #e6e8ee) 12%, transparent);
}
.claim-vip-row .row-label {
  display: grid;
  gap: 2px;
}
.claim-vip-row .row-label span {
  font-size: 13px;
  font-weight: 650;
}
.claim-vip-row .row-label small {
  font-size: 11px;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.9));
}
.claim-vip-message {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  padding: 8px 10px;
  border-radius: 8px;
}
.claim-vip-message.is-ok {
  color: #31cfa1;
  background: color-mix(in srgb, #31cfa1 12%, transparent);
}
.claim-vip-message.is-err {
  color: #ff8a65;
  background: color-mix(in srgb, #ff8a65 12%, transparent);
}
/* 宿主 Button / Switch 缺失时的降级控件 */
.claim-vip-fallback-button {
  width: 100%;
  padding: 9px 14px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--color-text-main, #e6e8ee) 16%, transparent);
  background: color-mix(in srgb, var(--color-primary, #0071e3) 88%, transparent);
  color: #fff;
  font-size: 13px;
  font-weight: 650;
  cursor: pointer;
}
.claim-vip-fallback-button[disabled] {
  opacity: 0.6;
  cursor: not-allowed;
}
.claim-vip-actions > .claim-vip-fallback-button + .claim-vip-fallback-button {
  background: transparent;
  color: var(--color-text-main, #e6e8ee);
}
.claim-vip-fallback-switch {
  width: 18px;
  height: 18px;
  cursor: pointer;
  accent-color: var(--color-primary, #0071e3);
}
`;

// 宿主组件缺失时的降级实现：保持与宿主 Button / Switch 相同的 props 契约，
// 这样即使某个版本没有暴露这些组件，面板依然可用（只是样式朴素一些）。
const makeFallbackButton = (h, defineComponent) =>
  defineComponent({
    name: "ClaimVipFallbackButton",
    props: {
      disabled: { type: Boolean, default: false },
      loading: { type: Boolean, default: false },
    },
    setup(props, { slots }) {
      return () =>
        h(
          "button",
          {
            type: "button",
            class: "claim-vip-fallback-button",
            disabled: Boolean(props.disabled || props.loading),
          },
          [props.loading ? "…" : null, slots.default ? slots.default() : null],
        );
    },
  });

const makeFallbackSwitch = (h, defineComponent) =>
  defineComponent({
    name: "ClaimVipFallbackSwitch",
    props: {
      modelValue: { type: Boolean, default: false },
      disabled: { type: Boolean, default: false },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
      return () =>
        h("input", {
          type: "checkbox",
          class: "claim-vip-fallback-switch",
          checked: Boolean(props.modelValue),
          disabled: Boolean(props.disabled),
          onChange: (event) => emit("update:modelValue", Boolean(event.target.checked)),
        });
    },
  });

const buildPanel = (ctx) => {
  const { h, defineComponent, defineAsyncComponent } = ctx.vue;
  // 宿主组件按能力探测；缺失时退化为内置实现，保证任何版本都能正常显示。
  const hostComponents = ctx.ui?.components ?? {};
  const Button = hostComponents.Button
    ? defineAsyncComponent(hostComponents.Button)
    : makeFallbackButton(h, defineComponent);
  const Switch = hostComponents.Switch
    ? defineAsyncComponent(hostComponents.Switch)
    : makeFallbackSwitch(h, defineComponent);

  // 全流程共用一份交互状态：停用后 claimState 置空，在途的 await 续体不再写入。
  const setMessage = (text, ok) => {
    if (!claimState) return;
    claimState.lastMessage = text;
    claimState.lastOk = ok;
  };

  const doClaimMusic = async () => {
    if (!claimState || claimState.busy) return;
    const target = claimState;
    target.busy = "music";
    try {
      await claimMusicVip(ctx);
      if (claimState !== target) return;
      optimistic.music = true;
      target.musicDone = true;
      setMessage("畅听会员领取成功", true);
      ctx.toast.success("畅听会员领取成功");
    } catch (error) {
      if (claimState !== target) return;
      const { code, msg } = extractError(error);
      const text = msg || (code ? `领取失败（错误码 ${code}）` : "领取失败，可能今日已领取");
      setMessage(text, false);
      ctx.toast.warning(text);
    } finally {
      if (claimState === target) target.busy = null;
    }
    // 以服务器月领取记录为准同步真实状态（服务器有同步延迟，故乐观标记优先）
    void refreshStatus(ctx);
  };

  const doClaimConcept = async () => {
    if (!claimState || claimState.busy) return;
    const target = claimState;
    target.busy = "concept";
    try {
      await claimConceptVip(ctx);
      if (claimState !== target) return;
      optimistic.concept = true;
      target.conceptDone = true;
      setMessage("概念会员升级成功", true);
      ctx.toast.success("概念会员升级成功");
    } catch (error) {
      if (claimState !== target) return;
      const { code, msg } = extractError(error);
      // 297002 = 已升级过（原生 Upgrade 逻辑同样把该码视为成功终态）
      if (code === 297002) {
        optimistic.concept = true;
        target.conceptDone = true;
        setMessage("概念会员已升级", true);
        ctx.toast.info("概念会员已升级");
      } else {
        const text = msg || (code ? `升级失败（错误码 ${code}）` : "升级失败，请稍后重试");
        setMessage(text, false);
        ctx.toast.warning(text);
      }
    } finally {
      if (claimState === target) target.busy = null;
    }
    void refreshStatus(ctx);
  };

  return defineComponent({
    name: "ClaimVipPanel",
    setup() {
      const patchAutoClaim = (value) => {
        if (!state) return;
        state.settings = normalizeSettings({ ...state.settings, autoClaim: Boolean(value) });
        void ctx.storage.set(STORAGE_KEY, state.settings);
      };

      return () => {
        // 插件停用后状态对象已置空，此时不再渲染（宿主卸载组件前的最后几帧）。
        if (!state || !claimState) return null;

        return h("div", { class: "claim-vip-panel" }, [
          h("div", { class: "claim-vip-status" }, [
            h("span", { class: "status-label" }, "畅听会员"),
            h("span"),
            h(
              "span",
              { class: ["status-value", claimState.musicDone ? "is-done" : "is-pending"] },
              claimState.musicDone ? "已领取" : "未领取",
            ),
            h("span", { class: "status-label" }, "概念会员"),
            h("span"),
            h(
              "span",
              { class: ["status-value", claimState.conceptDone ? "is-done" : "is-pending"] },
              claimState.conceptDone ? "已升级" : "未升级",
            ),
          ]),
          h("div", { class: "claim-vip-actions" }, [
            h(
              Button,
              {
                variant: "primary",
                size: "md",
                loading: claimState.busy === "music",
                // 已领取后按钮置灰（与原生一致）：重复请求只会被服务器拒绝
                disabled: claimState.musicDone || claimState.busy !== null,
                onClick: doClaimMusic,
              },
              { default: () => (claimState.musicDone ? "畅听会员已领取" : "领取畅听会员") },
            ),
            h(
              Button,
              {
                variant: "outline",
                size: "md",
                loading: claimState.busy === "concept",
                disabled: claimState.conceptDone || claimState.busy !== null,
                onClick: doClaimConcept,
              },
              { default: () => (claimState.conceptDone ? "概念会员已升级" : "升级概念会员") },
            ),
          ]),
          h("div", { class: "claim-vip-row" }, [
            h("div", { class: "row-label" }, [
              h("span", "登录后自动领取"),
              h("small", "每次登录 EchoMusic 时自动领取并升级"),
            ]),
            h(Switch, {
              modelValue: Boolean(state.settings.autoClaim),
              "onUpdate:modelValue": patchAutoClaim,
            }),
          ]),
          claimState.lastMessage
            ? h(
                "p",
                { class: ["claim-vip-message", claimState.lastOk ? "is-ok" : "is-err"] },
                claimState.lastMessage,
              )
            : null,
        ]);
      };
    },
  });
};

const buildDialog = (ctx, Panel) => {
  const { h, defineComponent } = ctx.vue;
  return defineComponent({
    name: "ClaimVipDialog",
    setup() {
      return () => {
        if (!dialogOpen || !dialogOpen.value) return null;
        return h(
          "div",
          {
            class: "claim-vip-mask",
            onClick: (event) => {
              if (!dialogOpen) return;
              if (event.target === event.currentTarget) dialogOpen.value = false;
            },
          },
          [
            h("div", { class: "claim-vip-dialog" }, [
              h("div", { class: "claim-vip-dialog-head" }, [
                h("h3", "领取会员"),
                h(
                  "button",
                  {
                    class: "claim-vip-close",
                    type: "button",
                    onClick: () => {
                      if (dialogOpen) dialogOpen.value = false;
                    },
                  },
                  "✕",
                ),
              ]),
              h(Panel),
            ]),
          ],
        );
      };
    },
  });
};

// ---------- 生命周期 ----------
export async function activate(ctx) {
  const { ref, reactive, watch } = ctx.vue;

  const saved = await ctx.storage.get(STORAGE_KEY);
  state = reactive({ settings: normalizeSettings(saved) });
  claimState = reactive({
    busy: null,
    lastMessage: "",
    lastOk: true,
    musicDone: false,
    conceptDone: false,
  });
  dialogOpen = ref(false);

  const Panel = buildPanel(ctx);
  const Dialog = buildDialog(ctx, Panel);
  const ui = ctx.ui ?? {};

  // 以下每一步都做能力探测并各自兜底：任何一项不可用都不应该让整块面板失效，
  // 只要设置页入口注册成功，用户就始终有办法领到会员。
  try {
    cssDispose = ctx.css.inject(CSS, { id: "claim-vip-style" });
  } catch (error) {
    console.warn(PLUGIN_TAG, "注入样式失败", error);
  }

  try {
    teleportDispose = ui.teleport?.(Dialog, { id: "claim-vip-dialog" }) ?? null;
  } catch (error) {
    console.warn(PLUGIN_TAG, "挂载弹层失败", error);
  }

  // 标题栏入口（较新版本才有，做能力探测）
  if (typeof ui.titlebar?.register === "function") {
    try {
      titlebarDispose = ui.titlebar.register({
        id: "claim-vip",
        title: "领取会员",
        icon: ctx.icons?.iconGift ?? "tabler:gift",
        tooltip: "领取会员",
        defaultPlacement: "toolbar",
        order: 100,
        onClick: () => {
          void refreshStatus(ctx);
          if (dialogOpen) dialogOpen.value = true;
        },
      });
    } catch (error) {
      console.warn(PLUGIN_TAG, "注册标题栏入口失败", error);
    }
  }

  // 设置页入口（所有版本都有）
  if (typeof ui.settings?.define === "function") {
    settingsDispose = ui.settings.define({
      title: "领取会员",
      description: "一键领取每日畅听会员并升级概念会员，可开启登录后自动领取。",
      component: Panel,
    });
  } else {
    console.warn(PLUGIN_TAG, "宿主未提供设置页 API，插件入口不可用");
  }

  // 登录后自动领取：观察登录 token。token 出现即视为完成一次登录。
  // 延迟 2s 执行，等 pinia 的设备信息就绪，保证鉴权头完整（与官方 auto-team-vip 一致）。
  let autoClaimBusy = false;
  const scheduleAutoReceive = () => {
    // 短时间内多次登录事件只保留最后一次，避免重复请求触发风控
    if (autoClaimTimer !== null) {
      clearTimeout(autoClaimTimer);
      autoClaimTimer = null;
    }
    autoClaimTimer = setTimeout(async () => {
      autoClaimTimer = null;
      if (!state || !state.settings.autoClaim || autoClaimBusy || claimState?.busy) return;
      autoClaimBusy = true;
      // 复用 busy 状态，避免自动领取进行中用户又点一次手动领取
      if (claimState) claimState.busy = "auto";
      try {
        await autoReceive(ctx);
        await refreshStatus(ctx);
      } catch (error) {
        console.warn(PLUGIN_TAG, "自动领取异常", error);
      } finally {
        autoClaimBusy = false;
        if (claimState) claimState.busy = null;
      }
    }, 2000);
  };

  loginUnwatch = watch(
    () => ctx.pinia?.state?.value?.user?.info?.token,
    (token) => {
      if (!token) return;
      scheduleAutoReceive();
    },
  );

  // 启动时若已处于登录态且开启自动领取，也自动领取一次（覆盖重启后无需重新登录的场景）。
  if (state.settings.autoClaim && ctx.pinia?.state?.value?.user?.info?.token) {
    scheduleAutoReceive();
  }

  // 后台刷新一次状态（不自动领取）
  void refreshStatus(ctx);

  ctx.dispose?.(() => {
    if (autoClaimTimer !== null) {
      clearTimeout(autoClaimTimer);
      autoClaimTimer = null;
    }
  });
}

export async function deactivate(ctx) {
  if (autoClaimTimer !== null) {
    clearTimeout(autoClaimTimer);
    autoClaimTimer = null;
  }

  try {
    loginUnwatch?.();
  } catch (error) {
    /* ignore */
  }
  loginUnwatch = null;

  try {
    titlebarDispose?.();
  } catch (error) {
    /* ignore */
  }
  titlebarDispose = null;

  try {
    settingsDispose?.();
  } catch (error) {
    /* ignore */
  }
  settingsDispose = null;

  try {
    teleportDispose?.();
  } catch (error) {
    /* ignore */
  }
  teleportDispose = null;

  try {
    cssDispose?.();
  } catch (error) {
    /* ignore */
  }
  cssDispose = null;

  optimistic.day = "";
  optimistic.music = false;
  optimistic.concept = false;

  state = null;
  claimState = null;
  dialogOpen = null;
}
