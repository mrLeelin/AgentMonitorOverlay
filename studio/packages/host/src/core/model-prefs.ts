import type { ModelOption, ModelPrefs, ModelProfile, ProfileChoices, SessionOptions } from "@amo-studio/protocol";
import type { Store } from "../store/store.js";
import { HostError } from "./shared.js";

// 设置 → 模型 → 型号顺序和默认 (stage 12, S12-J): per profile, the order of its models in every picker and the model,
// reasoning effort, permissions and Codex Fast a new session gets when none is chosen. Kept in the Host's kv table.

const KEY = "settings:model-prefs";

export function readModelPrefs(store: Store): Record<string, ModelPrefs> {
  try {
    const raw = JSON.parse(store.getKv(KEY)?.value ?? "{}") as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, ModelPrefs>) : {};
  } catch {
    return {};
  }
}

const text = (v: unknown, name: string) => {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || v.length > 200) throw new HostError("bad_request", `${name} must be a short string`);
  return v;
};

/** Replaces the prefs of the profiles given (null or {} clears a profile's). */
export function writeModelPrefs(store: Store, profiles: readonly Pick<ModelProfile, "id" | "runtime">[], input: unknown): Record<string, ModelPrefs> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HostError("bad_request", "modelPrefs must map profile ids to prefs");
  const next = readModelPrefs(store);
  for (const [profileId, raw] of Object.entries(input as Record<string, unknown>)) {
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) throw new HostError("bad_request", `unknown profile ${profileId}`);
    if (raw === null) {
      delete next[profileId];
      continue;
    }
    if (typeof raw !== "object" || Array.isArray(raw)) throw new HostError("bad_request", `modelPrefs.${profileId} must be an object`);
    const o = raw as Record<string, unknown>;
    if (o.order !== undefined && (!Array.isArray(o.order) || o.order.length > 200 || o.order.some((x) => typeof x !== "string"))) throw new HostError("bad_request", "order must list model ids");
    if (o.hidden !== undefined && (!Array.isArray(o.hidden) || o.hidden.length > 1000 || o.hidden.some((id) => typeof id !== "string" || !id))) throw new HostError("bad_request", "hidden must list model ids");
    if (o.fast !== undefined && typeof o.fast !== "boolean") throw new HostError("bad_request", "fast must be true or false");
    if (o.fast !== undefined && profile.runtime !== "codex") throw new HostError("bad_request", "默认开启 Fast 只适用于 Codex 渠道。");
    const prefs: ModelPrefs = {
      ...(Array.isArray(o.order) && o.order.length ? { order: [...new Set(o.order as string[])] } : {}),
      ...(Array.isArray(o.hidden) && o.hidden.length ? { hidden: [...new Set(o.hidden as string[])] } : {}),
      ...(text(o.model, "model") ? { model: text(o.model, "model")! } : {}),
      ...(text(o.effort, "effort") ? { effort: text(o.effort, "effort")! } : {}),
      ...(text(o.permission, "permission") ? { permission: text(o.permission, "permission")! } : {}),
      ...(o.fast === true ? { fast: true } : {}),
    };
    if (Object.keys(prefs).length) next[profileId] = prefs;
    else delete next[profileId];
  }
  store.setKv(KEY, JSON.stringify(next));
  return next;
}

/**
 * The CLI's choices with the person's prefs on top: models in their order (new ones after, as the CLI lists them),
 * their visible and hidden models, default model, effort (on the models that take it) and permissions. Prefs naming something the CLI no longer
 * offers are skipped.
 */
export function applyModelPrefs(choices: ProfileChoices, prefs: ModelPrefs | undefined): ProfileChoices {
  if (!prefs) return choices;
  const rank = new Map((prefs.order ?? []).map((id, i) => [id, i]));
  const ordered = choices.models
    .map((m, i) => ({ m, i }))
    .sort((a, b) => (rank.get(a.m.id) ?? rank.size + a.i) - (rank.get(b.m.id) ?? rank.size + b.i))
    .map(({ m }) => m);
  const hidden = new Set(prefs.hidden);
  const visible = ordered.filter((m) => !hidden.has(m.id));
  // Discovery can temporarily return a smaller catalog. Always leave a model to start a session with.
  const retained = visible.length ? undefined : ordered.find((m) => m.isDefault) ?? ordered[0];
  if (retained) visible.push(retained);
  const hiddenModels = ordered.filter((m) => hidden.has(m.id) && m !== retained);
  const defaultId = visible.find((m) => m.id === prefs.model)?.id ?? visible.find((m) => m.isDefault)?.id ?? (hiddenModels.length ? visible[0]?.id : undefined);
  const withEffort = (m: ModelOption) => {
    const effort = prefs.effort && m.efforts.includes(prefs.effort) ? prefs.effort : m.defaultEffort;
    return { ...m, ...(effort ? { defaultEffort: effort } : {}) };
  };
  return {
    ...choices,
    models: visible.map((m) => {
      const { isDefault: _was, ...rest } = m;
      return { ...withEffort(rest), ...(m.id === defaultId ? { isDefault: true } : {}) };
    }),
    ...(hiddenModels.length ? { hiddenModels: hiddenModels.map(withEffort) } : {}),
    defaultPermission: prefs.permission && choices.permissions.some((p) => p.id === prefs.permission && !p.unavailable) ? prefs.permission : choices.defaultPermission,
    ...(prefs.fast === true ? { defaultFast: true } : {}),
  };
}

/**
 * A new session's options with the defaults filled in where nothing was chosen: the default model, its default effort,
 * the default permissions and Codex Fast, all as the choices (prefs applied) say. With hidden models we pin the visible default
 * so the CLI cannot independently choose a hidden one.
 */
export function fillDefaults(options: SessionOptions, choices: ProfileChoices, prefs: ModelPrefs | undefined): SessionOptions {
  if (!prefs) return options;
  const fallback = choices.models.find((m) => m.isDefault);
  const preferred = choices.models.find((m) => m.id === prefs.model);
  const model = options.model ?? preferred?.id ?? (choices.hiddenModels?.length ? fallback?.id : undefined);
  const selected = model ? choices.models.find((m) => m.id === model) ?? choices.hiddenModels?.find((m) => m.id === model) : fallback;
  const runs = selected ?? fallback;
  const effort = options.effort ?? (prefs.effort && runs?.efforts.includes(prefs.effort) ? prefs.effort : undefined);
  const permission = options.permission ?? (prefs.permission && choices.permissions.some((p) => p.id === prefs.permission && !p.unavailable) ? prefs.permission : undefined);
  const fast = options.fast ?? (prefs.fast === true && selected?.fast ? true : undefined);
  return { ...options, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(permission ? { permission } : {}), ...(fast !== undefined ? { fast } : {}) };
}
