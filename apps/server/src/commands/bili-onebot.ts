import { randomUUID } from "node:crypto";
import { ensureFollowed } from "@bilibili-notify/api";
import {
	type CachedProfile,
	type CommandAliases,
	type CommandConfig,
	DEFAULT_COMMAND_ALIASES,
	DEFAULT_COMMAND_OWNER_QQ,
	DEFAULT_COMMAND_PREFIX,
	FEATURE_KEYS,
	type GlobalConfig,
	makeEmptySubscription,
	type PushTarget,
	type Subscription,
} from "@bilibili-notify/internal";
import type { OnebotInboundEventHandler } from "../platforms/onebot.js";
import type { AppRuntime } from "../runtime/bootstrap.js";
import { handleBiliVideoParse } from "./bili-video-parser.js";

type SenderRole = "owner" | "admin" | "member" | "unknown";
type BiliCommandKind = Exclude<BiliCommand["kind"], "unknown">;

const COMMAND_KINDS: readonly BiliCommandKind[] = [
	"help",
	"add",
	"del",
	"list",
	"listall",
	"delall",
	"delallall",
	"member",
];
const LIST_FORWARD_PAGE_SIZE = 10;
const USER_SEARCH_PAGE_SIZE = 5;
const USER_SEARCH_KEYWORD_MAX_LENGTH = 50;
const MENU_TRIGGER = "菜单";
const COMMAND_SUBSCRIPTION_DEFAULT_FEATURES = {
	liveGuardBuy: true,
	superchat: true,
} as const;

interface ResolvedCommandConfig {
	enabled: boolean;
	prefix: string;
	ownerQq: string;
	aliases: CommandAliases;
}

const DEFAULT_COMMAND_CONFIG: ResolvedCommandConfig = {
	enabled: true,
	prefix: DEFAULT_COMMAND_PREFIX,
	ownerQq: DEFAULT_COMMAND_OWNER_QQ,
	aliases: { ...DEFAULT_COMMAND_ALIASES },
};
const LEGACY_COMMAND_ALIASES: CommandAliases = {
	help: "help",
	add: "add",
	del: "del",
	list: "list",
	listall: "listall",
	delall: "delall",
	delallall: "delallall",
	member: "member",
};

export function commandHelpHintFromGlobals(globals: GlobalConfig): string | undefined {
	const config = resolveCommandConfigFromGlobals(globals);
	if (!config.enabled) return undefined;
	return `发送 ${commandUsage(config, "help")} 获取菜单`;
}

export type BiliCommand =
	| { kind: "help" }
	| { kind: "add"; query: string }
	| { kind: "del"; uid: string }
	| { kind: "list" }
	| { kind: "listall" }
	| { kind: "delall" }
	| { kind: "delallall" }
	| { kind: "member"; action: MemberPermissionAction }
	| { kind: "unknown"; reason: string };

type MemberPermissionAction = "on" | "off" | "status";

interface GroupMessageEvent {
	groupId: string;
	userId: string;
	role: SenderRole;
	text: string;
}

interface UpProfile {
	uid: string;
	name: string;
	avatar: string;
	sign: string;
	fans: number;
}

interface UpSearchCandidate {
	uid: string;
	name: string;
	fans?: number;
}

type OnebotGroupTarget = Extract<PushTarget, { platform: "onebot" }> & { scope: "group" };

interface GroupSubscriptionListResult {
	text: string;
	forwardNodes: string[];
}

export function parseBiliCommand(
	input: string,
	config: ResolvedCommandConfig = DEFAULT_COMMAND_CONFIG,
): BiliCommand | null {
	if (!config.enabled) return null;
	const text = input.trim();
	if (!text) return null;
	const parsed = parseAfterPrefix(text, config.prefix);
	if (!parsed) return null;
	const action = parseCommandAction(parsed.afterPrefix, config.aliases);
	if (!action)
		return parsed.separated
			? { kind: "unknown", reason: `未知命令：${firstToken(parsed.afterPrefix) ?? ""}` }
			: null;
	const { matched, argsText } = action;
	const tokens = argsText ? argsText.split(/\s+/) : [];

	if (matched === "help") {
		return tokens.length === 0 ? { kind: "help" } : badUsage(commandUsage(config, "help"));
	}
	if (matched === "list") {
		return tokens.length === 0 ? { kind: "list" } : badUsage(commandUsage(config, "list"));
	}
	if (matched === "listall") {
		return tokens.length === 0 ? { kind: "listall" } : badUsage(commandUsage(config, "listall"));
	}
	if (matched === "delall") {
		return tokens.length === 0 ? { kind: "delall" } : badUsage(commandUsage(config, "delall"));
	}
	if (matched === "delallall") {
		return tokens.length === 0
			? { kind: "delallall" }
			: badUsage(commandUsage(config, "delallall"));
	}
	if (matched === "member") {
		const action = parseMemberPermissionAction(tokens[0]);
		if (tokens.length !== 1 || !action) {
			return badUsage(commandUsage(config, "member", "开启|关闭|状态"));
		}
		return { kind: "member", action };
	}

	if (matched === "add") {
		if (!argsText) return badUsage(commandUsage(config, "add", "<uid>|<名字>"));
		return { kind: "add", query: argsText };
	}

	if (matched === "del") {
		const uid = tokens[0];
		if (tokens.length !== 1 || !uid || !/^\d+$/.test(uid)) {
			return badUsage(commandUsage(config, "del", "<uid>"));
		}
		return { kind: "del", uid };
	}

	return { kind: "unknown", reason: `未知命令：${firstToken(parsed.afterPrefix) ?? ""}` };
}

export function extractOnebotMessageText(message: unknown, rawMessage: unknown): string {
	if (Array.isArray(message)) {
		return message
			.map((seg) => {
				if (!seg || typeof seg !== "object") return "";
				const item = seg as { type?: unknown; data?: { text?: unknown } };
				return item.type === "text" && typeof item.data?.text === "string" ? item.data.text : " ";
			})
			.join("")
			.trim();
	}
	if (typeof message === "string") return stripCqCodes(message).trim();
	if (typeof rawMessage === "string") return stripCqCodes(rawMessage).trim();
	return "";
}

export function parseOnebotGroupMessage(frame: unknown): GroupMessageEvent | null {
	if (!frame || typeof frame !== "object") return null;
	const f = frame as {
		post_type?: unknown;
		message_type?: unknown;
		group_id?: unknown;
		user_id?: unknown;
		sender?: { role?: unknown };
		message?: unknown;
		raw_message?: unknown;
	};
	if (f.post_type !== "message" || f.message_type !== "group") return null;
	const groupId = normalizeNumericId(f.group_id);
	const userId = normalizeNumericId(f.user_id);
	if (!groupId || !userId) return null;
	const role = normalizeRole(f.sender?.role);
	const text = extractOnebotMessageText(f.message, f.raw_message);
	return { groupId, userId, role, text };
}

export function isOnebotMenuRequest(frame: unknown): boolean {
	if (!frame || typeof frame !== "object") return false;
	const f = frame as {
		post_type?: unknown;
		message_type?: unknown;
		self_id?: unknown;
		message?: unknown;
		raw_message?: unknown;
	};
	if (f.post_type !== "message" || f.message_type !== "group") return false;
	const selfId = normalizeNumericId(f.self_id);

	if (Array.isArray(f.message)) {
		return isMenuSegmentMessage(f.message, selfId);
	}

	return isRawMenuMessage(f.message, f.raw_message, selfId);
}

export function createBiliOnebotCommandHandler(runtime: AppRuntime): OnebotInboundEventHandler {
	const log = runtime.serviceCtx.logger;

	return async ({
		adapterId,
		frame,
		getGroupName,
		sendGroupText,
		sendGroupMessage,
		sendGroupForwardText,
	}) => {
		const event = parseOnebotGroupMessage(frame);
		if (!event) return;
		const reply = async (text: string): Promise<void> => {
			const result = await sendGroupText(event.groupId, text);
			if (!result.ok) {
				log.warn(`[bili-command] 回复群 ${event.groupId} 失败: ${result.err ?? "unknown"}`);
			}
		};
		const commandConfig = resolveCommandConfig(runtime);

		if (isOnebotMenuRequest(frame)) {
			await reply(menuText(commandConfig));
			return;
		}

		const command = parseBiliCommand(event.text, commandConfig);
		if (!command) {
			await handleBiliVideoParse(runtime, { frame, sendGroupMessage });
			return;
		}

		const groupTarget = findGroupTarget(runtime, adapterId, event.groupId);
		const isOwner = event.userId === commandConfig.ownerQq;
		const isGroupAdminOrAbove = isOwner || event.role === "owner" || event.role === "admin";
		const allowMemberManage = groupTarget?.session.allowMemberManage === true;
		const canManageGroup = isGroupAdminOrAbove || allowMemberManage;

		if (requiresOwner(command) && !isOwner) {
			await reply("只有主人可以执行这个命令。");
			return;
		}
		if (requiresMemberPermissionAdmin(command) && !isGroupAdminOrAbove) {
			await reply("只有群主、管理员或主人可以修改普通成员管理权限。");
			return;
		}
		if (requiresGroupAdmin(command) && !canManageGroup) {
			await reply(formatMemberManageStatus(false, commandConfig));
			return;
		}

		try {
			if (command.kind === "help") {
				const text = helpText(isOwner, commandConfig);
				const result = await sendGroupForwardText(event.groupId, [text]);
				if (result.ok) return;
				log.warn(
					`[bili-command] 转发群 ${event.groupId} 帮助失败: ${
						result.err ?? "unknown"
					}，回退普通文本`,
				);
				await reply(text);
				return;
			}

			if (command.kind === "list") {
				const list = buildGroupSubscriptionList(runtime, adapterId, event.groupId, commandConfig);
				if (list.forwardNodes.length > 0) {
					const result = await sendGroupForwardText(event.groupId, list.forwardNodes);
					if (result.ok) return;
					log.warn(
						`[bili-command] 转发群 ${event.groupId} 订阅列表失败: ${
							result.err ?? "unknown"
						}，回退普通文本`,
					);
				}
				await reply(list.text);
				return;
			}

			const groupName =
				command.kind === "add" || command.kind === "del" ? await getGroupName(event.groupId) : null;
			const message = await handleBiliCommand(runtime, adapterId, event, command, {
				isOwner,
				config: commandConfig,
				groupName,
			});
			if (message) await reply(message);
		} catch (err) {
			log.warn(`[bili-command] ${event.groupId}/${event.userId} failed: ${String(err)}`);
			await reply(`B 站订阅命令执行失败：${err instanceof Error ? err.message : String(err)}`);
		}
	};
}

async function handleBiliCommand(
	runtime: AppRuntime,
	adapterId: string,
	event: GroupMessageEvent,
	command: BiliCommand,
	perm: { isOwner: boolean; config: ResolvedCommandConfig; groupName?: string | null },
): Promise<string | null> {
	switch (command.kind) {
		case "help":
			return helpText(perm.isOwner, perm.config);
		case "unknown":
			return `${command.reason}\n\n发送 ${commandUsage(perm.config, "help")} 查看可用命令。`;
		case "add":
			return addSubscription(
				runtime,
				adapterId,
				event.groupId,
				command.query,
				perm.groupName,
				perm.config,
			);
		case "del":
			return deleteGroupSubscription(
				runtime,
				adapterId,
				event.groupId,
				command.uid,
				perm.groupName,
			);
		case "list":
			return listGroupSubscriptions(runtime, adapterId, event.groupId, perm.config);
		case "listall":
			return listAllSubscriptions(runtime);
		case "delall":
			return deleteAllGroupSubscriptions(runtime, adapterId, event.groupId);
		case "delallall":
			return deleteAllSubscriptions(runtime);
		case "member":
			return setMemberManagePermission(
				runtime,
				adapterId,
				event.groupId,
				command.action,
				perm.config,
			);
	}
}

async function addSubscription(
	runtime: AppRuntime,
	adapterId: string,
	groupId: string,
	query: string,
	groupName?: string | null,
	config?: ResolvedCommandConfig,
): Promise<string> {
	const engines = runtime.engines;
	if (!engines) return "B 站 API 尚未就绪，稍后再试。";

	const existingTarget = await syncGroupTargetName(
		runtime,
		findGroupTarget(runtime, adapterId, groupId),
		groupName,
	);
	if (existingTarget && !existingTarget.enabled) {
		return `订阅失败：当前群推送目标「${existingTarget.name}」已禁用，请先在 Dashboard 启用。`;
	}

	const profileResult = await resolveAddProfile(runtime, query, config ?? DEFAULT_COMMAND_CONFIG);
	if (!profileResult.ok) return profileResult.message;
	const { profile } = profileResult;
	const uid = profile.uid;

	const follow = await ensureFollowed(engines.api, uid);
	if (!follow.ok) {
		const existing = runtime.configStore.getSubscriptions().find((s) => s.uid === uid);
		if (existing) {
			await runtime.subRuntimeStore.patch(existing.id, {
				followed: false,
				followError: follow.message || `code=${follow.code}`,
			});
		}
		return `订阅失败：无法关注 ${profile.name}（UID ${uid}）。原因：${
			follow.message || `code=${follow.code}`
		}`;
	}

	const target =
		existingTarget ?? (await ensureGroupTarget(runtime, adapterId, groupId, groupName));
	const existing = runtime.configStore.getSubscriptions().find((s) => s.uid === uid);
	const base = existing ?? makeEmptySubscription({ id: randomUUID(), uid });
	const alreadyInGroup = existing ? isTargetRouted(existing, target.id) : false;
	const next = applyCommandSubscriptionDefaults(attachTargetToSubscription(base, target.id), {
		targetId: target.id,
		isNewSubscription: !existing,
		isNewGroupRoute: !alreadyInGroup,
	});
	next.enabled = true;
	next.name = profile.name || next.name;

	await runtime.configStore.upsertSubscription(next);
	await runtime.subRuntimeStore.patch(next.id, {
		cachedProfile: toCachedProfile(profile),
		followed: true,
		followError: undefined,
	});

	return formatSubscriptionAddResult(profile.name, uid, alreadyInGroup);
}

function formatSubscriptionAddResult(name: string, uid: string, alreadyInGroup: boolean): string {
	return [`✅ ${alreadyInGroup ? "已订阅" : "订阅成功"}!`, `📺 ${name}`, `🔗 UID: ${uid}`].join(
		"\n",
	);
}

async function deleteGroupSubscription(
	runtime: AppRuntime,
	adapterId: string,
	groupId: string,
	uid: string,
	groupName?: string | null,
): Promise<string> {
	const target = await syncGroupTargetName(
		runtime,
		findGroupTarget(runtime, adapterId, groupId),
		groupName,
	);
	if (!target) return "本群还没有绑定过 B 站推送目标。";

	const sub = runtime.configStore.getSubscriptions().find((s) => s.uid === uid);
	if (!sub || !isTargetRouted(sub, target.id)) return `本群未订阅 UID ${uid}。`;

	const detached = detachTargetFromSubscription(sub, target.id);
	if (hasAnyRouting(detached)) await runtime.configStore.upsertSubscription(detached);
	else await runtime.configStore.deleteSubscription(detached.id);

	return `已取消本群订阅：${displaySub(runtime, sub)}`;
}

async function deleteAllGroupSubscriptions(
	runtime: AppRuntime,
	adapterId: string,
	groupId: string,
): Promise<string> {
	const target = findGroupTarget(runtime, adapterId, groupId);
	if (!target) return "本群还没有绑定过 B 站推送目标。";

	const subs = runtime.configStore.getSubscriptions().filter((s) => isTargetRouted(s, target.id));
	if (subs.length === 0) return "本群暂无 B 站订阅。";

	for (const sub of subs) {
		const detached = detachTargetFromSubscription(sub, target.id);
		if (hasAnyRouting(detached)) await runtime.configStore.upsertSubscription(detached);
		else await runtime.configStore.deleteSubscription(detached.id);
	}
	return `已清空本群 B 站订阅，共 ${subs.length} 个。`;
}

async function deleteAllSubscriptions(runtime: AppRuntime): Promise<string> {
	const subs = runtime.configStore.getSubscriptions();
	if (subs.length === 0) return "当前没有任何 B 站订阅。";
	for (const sub of subs) await runtime.configStore.deleteSubscription(sub.id);
	return `已删除全部 B 站订阅，共 ${subs.length} 个。`;
}

async function setMemberManagePermission(
	runtime: AppRuntime,
	adapterId: string,
	groupId: string,
	action: MemberPermissionAction,
	config: ResolvedCommandConfig,
): Promise<string> {
	if (action === "status") {
		const target = findGroupTarget(runtime, adapterId, groupId);
		return formatMemberManageStatus(target?.session.allowMemberManage === true, config);
	}

	const enabled = action === "on";
	const target = await ensureGroupTarget(runtime, adapterId, groupId);
	const session = { ...target.session };
	if (enabled) session.allowMemberManage = true;
	else delete session.allowMemberManage;
	const next: OnebotGroupTarget = {
		...target,
		session,
	};
	await runtime.configStore.upsertTarget(next);
	return formatMemberManageUpdate(enabled, config);
}

function listGroupSubscriptions(
	runtime: AppRuntime,
	adapterId: string,
	groupId: string,
	config: ResolvedCommandConfig,
): string {
	return buildGroupSubscriptionList(runtime, adapterId, groupId, config).text;
}

function buildGroupSubscriptionList(
	runtime: AppRuntime,
	adapterId: string,
	groupId: string,
	config: ResolvedCommandConfig,
): GroupSubscriptionListResult {
	const target = findGroupTarget(runtime, adapterId, groupId);
	if (!target) return { text: "本群暂无 B 站订阅。", forwardNodes: [] };

	const subs = runtime.configStore.getSubscriptions().filter((s) => isTargetRouted(s, target.id));
	if (subs.length === 0) return { text: "本群暂无 B 站订阅。", forwardNodes: [] };

	const itemLines = subs.map(
		(s, index) => `${index + 1}. ${displaySub(runtime, s)}${s.enabled ? "" : "（已停用）"}`,
	);
	const header = `📺 本群 B 站订阅（${subs.length} 个）`;
	const text = [header, "", ...itemLines.map((line) => `• ${line}`)].join("\n");
	const pageCount = Math.ceil(itemLines.length / LIST_FORWARD_PAGE_SIZE);
	const forwardNodes = Array.from({ length: pageCount }, (_, pageIndex) => {
		const start = pageIndex * LIST_FORWARD_PAGE_SIZE;
		const items = itemLines.slice(start, start + LIST_FORWARD_PAGE_SIZE);
		return [header, `第 ${pageIndex + 1}/${pageCount} 页`, "", ...items].join("\n");
	});
	forwardNodes.push(listAdminHelpText(config));

	return { text, forwardNodes };
}

function listAdminHelpText(config: ResolvedCommandConfig): string {
	return [
		"🧩 管理员可用",
		`• ${commandUsage(config, "add", "<uid>|<名字>")}：订阅 UP`,
		`• ${commandUsage(config, "del", "<uid>")}：取消订阅`,
	].join("\n");
}

function listAllSubscriptions(runtime: AppRuntime): string {
	const subs = runtime.configStore.getSubscriptions();
	if (subs.length === 0) return "当前没有任何 B 站订阅。";
	const targets = runtime.configStore.getTargets();
	const targetById = new Map(targets.map((t) => [t.id, t]));

	return [
		`📺 全部 B 站订阅（${subs.length} 个）`,
		"",
		...subs.map((s) => {
			const ids = routedTargetIds(s);
			const targetLabel =
				ids.length === 0
					? "未配置推送目标"
					: ids
							.map((id) => targetById.get(id)?.name ?? "已删除目标")
							.slice(0, 3)
							.join("、") + (ids.length > 3 ? ` 等 ${ids.length} 个目标` : "");
			return `• ${displaySub(runtime, s)} → ${targetLabel}${s.enabled ? "" : "（已停用）"}`;
		}),
	].join("\n");
}

function helpText(_isOwner: boolean, config: ResolvedCommandConfig): string {
	return [
		"B站订阅up主 推送动态和直播",
		"",
		"🧩 管理员可用",
		`• ${commandUsage(config, "add", "<uid>|<名字>")}：订阅 UP`,
		`• ${commandUsage(config, "del", "<uid>")}：取消订阅`,
		`• ${commandUsage(config, "member", "开启|关闭")}：设置普通成员管理权限`,
		`• ${commandUsage(config, "member", "状态")}：查看普通成员管理权限`,
		"",
		"🔎 普通成员可用",
		`• ${commandUsage(config, "list")}：查看本群订阅`,
		`• ${commandUsage(config, "help")}：显示本说明`,
	].join("\n");
}

function menuText(config: ResolvedCommandConfig): string {
	return [
		"==== 功能菜单 ====",
		"",
		"🐾 pet",
		"   表情包命令。",
		"",
		`📺 ${commandUsage(config, "help")}`,
		"   B站订阅功能。",
	].join("\n");
}

function formatMemberManageUpdate(enabled: boolean, config: ResolvedCommandConfig): string {
	return [
		`✅ 普通成员管理权限已${enabled ? "开启" : "关闭"}`,
		enabled
			? `普通成员现在可以执行 ${commandUsage(config, "add", "<uid>|<名字>")} / ${commandUsage(config, "del", "<uid>")} 管理本群订阅。`
			: "普通成员现在只能查看本群订阅，不能新增或取消订阅。",
	].join("\n");
}

function formatMemberManageStatus(enabled: boolean, config: ResolvedCommandConfig): string {
	return [
		"👥 普通成员管理权限",
		`状态：${enabled ? "已开启" : "已关闭"}`,
		enabled
			? `普通成员可执行 ${commandUsage(config, "add", "<uid>|<名字>")} / ${commandUsage(config, "del", "<uid>")}。`
			: "普通成员只能查看本群订阅。",
	].join("\n");
}

async function resolveAddProfile(
	runtime: AppRuntime,
	query: string,
	config: ResolvedCommandConfig,
): Promise<{ ok: true; profile: UpProfile } | { ok: false; message: string }> {
	const normalized = normalizeAddQuery(query);
	if (!normalized) return { ok: false, message: "订阅失败：请输入 UID 或 UP 主名字。" };
	if (/^\d+$/.test(normalized)) return lookupUpProfile(runtime, normalized);
	if (normalized.length > USER_SEARCH_KEYWORD_MAX_LENGTH) {
		return {
			ok: false,
			message: "订阅失败：UP 主名字太长，请换更精确的关键词，或直接使用 UID。",
		};
	}
	return lookupUpProfileByName(runtime, normalized, config);
}

async function lookupUpProfileByName(
	runtime: AppRuntime,
	keyword: string,
	config: ResolvedCommandConfig,
): Promise<{ ok: true; profile: UpProfile } | { ok: false; message: string }> {
	const engines = runtime.engines;
	if (!engines) return { ok: false, message: "B 站 API 尚未就绪，稍后再试。" };
	try {
		const res = await engines.api.searchByType("bili_user", keyword, {
			page: 1,
			pageSize: USER_SEARCH_PAGE_SIZE,
		});
		const code = readNumberField(res, "code");
		if (code !== null && code !== 0) {
			const message = readStringField(res, "message") ?? readStringField(res, "msg");
			return {
				ok: false,
				message: `订阅失败：搜索 UP「${keyword}」失败。${message ? `原因：${message}` : ""}`,
			};
		}

		const candidates = extractUserSearchCandidates(res);
		if (candidates.length === 0) {
			return {
				ok: false,
				message: `订阅失败：未找到名为「${keyword}」的 UP。请换更准确的名字，或使用 UID。`,
			};
		}

		const exactMatches = candidates.filter(
			(candidate) => normalizeNameForCompare(candidate.name) === normalizeNameForCompare(keyword),
		);
		const candidate =
			exactMatches.length === 1 ? exactMatches[0] : candidates.length === 1 ? candidates[0] : null;
		if (!candidate)
			return { ok: false, message: formatUserSearchCandidates(keyword, candidates, config) };
		return lookupUpProfile(runtime, candidate.uid);
	} catch (err) {
		return {
			ok: false,
			message: `订阅失败：搜索 UP「${keyword}」时出错。${
				err instanceof Error ? err.message : String(err)
			}`,
		};
	}
}

async function lookupUpProfile(
	runtime: AppRuntime,
	uid: string,
): Promise<{ ok: true; profile: UpProfile } | { ok: false; message: string }> {
	const engines = runtime.engines;
	if (!engines) return { ok: false, message: "B 站 API 尚未就绪，稍后再试。" };
	try {
		const res = await engines.api.getUserCardInfo(uid);
		const card = res.data?.card;
		if (res.code !== 0 || !card) {
			const message = (res as { message?: string }).message;
			return {
				ok: false,
				message: `订阅失败：未找到 UID ${uid}。${message ? `原因：${message}` : ""}`,
			};
		}
		return {
			ok: true,
			profile: {
				uid: String(card.mid ?? uid),
				name: typeof card.name === "string" && card.name ? card.name : `UID ${uid}`,
				avatar: typeof card.face === "string" ? card.face : "",
				sign: typeof card.sign === "string" ? card.sign : "",
				fans: typeof card.fans === "number" && card.fans >= 0 ? card.fans : 0,
			},
		};
	} catch (err) {
		return {
			ok: false,
			message: `订阅失败：查询 UID ${uid} 时出错。${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

function normalizeAddQuery(query: string): string {
	return query.trim().replace(/\s+/g, " ");
}

function extractUserSearchCandidates(res: unknown): UpSearchCandidate[] {
	const root = asRecord(res);
	const data = asRecord(root?.data);
	const result = data?.result;
	if (!Array.isArray(result)) return [];

	const seen = new Set<string>();
	const candidates: UpSearchCandidate[] = [];
	for (const item of result) {
		const candidate = parseUserSearchCandidate(item);
		if (!candidate || seen.has(candidate.uid)) continue;
		seen.add(candidate.uid);
		candidates.push(candidate);
		if (candidates.length >= USER_SEARCH_PAGE_SIZE) break;
	}
	return candidates;
}

function parseUserSearchCandidate(item: unknown): UpSearchCandidate | null {
	const obj = asRecord(item);
	if (!obj) return null;
	const uid = normalizeNumericId(obj.mid ?? obj.uid);
	const rawName = readStringField(obj, "uname") ?? readStringField(obj, "name");
	const name = rawName ? stripSearchHighlight(rawName).trim() : "";
	if (!uid || !name) return null;
	const fans = readNumberField(obj, "fans");
	return fans !== null ? { uid, name, fans } : { uid, name };
}

function formatUserSearchCandidates(
	keyword: string,
	candidates: UpSearchCandidate[],
	config: ResolvedCommandConfig,
): string {
	return [
		`🔎 找到多个可能的 UP「${keyword}」，请使用 UID 添加：`,
		"",
		...candidates.map((candidate, index) => {
			const fans = candidate.fans === undefined ? "" : ` · ${formatFans(candidate.fans)}`;
			return `${index + 1}. ${candidate.name}${fans}\n   UID: ${candidate.uid}`;
		}),
		"",
		`仅显示前 ${USER_SEARCH_PAGE_SIZE} 个结果，请发送：${commandUsage(config, "add", "<uid>")}`,
	].join("\n");
}

function formatFans(fans: number): string {
	if (fans >= 10000) return `${trimDecimal(fans / 10000)}万粉丝`;
	return `${fans} 粉丝`;
}

function trimDecimal(value: number): string {
	return value.toFixed(1).replace(/\.0$/, "");
}

function normalizeNameForCompare(name: string): string {
	return normalizeAddQuery(stripSearchHighlight(name)).toLowerCase();
}

function stripSearchHighlight(value: string): string {
	return decodeHtmlEntities(value.replace(/<[^>]*>/g, ""));
}

function decodeHtmlEntities(value: string): string {
	return value
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readStringField(value: unknown, key: string): string | null {
	const record = asRecord(value);
	const field = record?.[key];
	return typeof field === "string" ? field : null;
}

function readNumberField(value: unknown, key: string): number | null {
	const record = asRecord(value);
	const field = record?.[key];
	if (typeof field === "number" && Number.isFinite(field)) return field;
	if (typeof field === "string" && /^-?\d+(?:\.\d+)?$/.test(field.trim())) {
		return Number(field);
	}
	return null;
}

function normalizeGroupName(groupName?: string | null): string | null {
	const trimmed = groupName?.trim();
	return trimmed ? trimmed : null;
}

function groupTargetNameForCreate(groupId: string, groupName?: string | null): string {
	return normalizeGroupName(groupName) ?? `QQ群 ${groupId}`;
}

async function syncGroupTargetName(
	runtime: AppRuntime,
	target: OnebotGroupTarget | null,
	groupName?: string | null,
): Promise<OnebotGroupTarget | null> {
	const name = normalizeGroupName(groupName);
	if (!target || !name || target.name === name) return target;
	const next: OnebotGroupTarget = { ...target, name };
	await runtime.configStore.upsertTarget(next);
	return next;
}

async function ensureGroupTarget(
	runtime: AppRuntime,
	adapterId: string,
	groupId: string,
	groupName?: string | null,
): Promise<OnebotGroupTarget> {
	const existing = findGroupTarget(runtime, adapterId, groupId);
	if (existing) return existing;

	const adapter = runtime.configStore
		.getAdapters()
		.find((a) => a.platform === "onebot" && a.id === adapterId);
	if (!adapter) throw new Error("当前 OneBot 连接没有对应的推送适配器配置");

	const target: OnebotGroupTarget = {
		id: randomUUID(),
		name: groupTargetNameForCreate(groupId, groupName),
		adapterId: adapter.id,
		platform: "onebot",
		scope: "group",
		enabled: true,
		session: { groupId },
	};
	await runtime.configStore.upsertTarget(target);
	return target;
}

function findGroupTarget(
	runtime: AppRuntime,
	adapterId: string,
	groupId: string,
): OnebotGroupTarget | null {
	const targets = runtime.configStore
		.getTargets()
		.filter(isOnebotGroupTarget)
		.filter((t) => t.session.groupId === groupId);
	return targets.find((t) => t.adapterId === adapterId) ?? targets[0] ?? null;
}

function isOnebotGroupTarget(target: PushTarget): target is OnebotGroupTarget {
	return target.platform === "onebot" && target.scope === "group";
}

function attachTargetToSubscription(sub: Subscription, targetId: string): Subscription {
	const routing = { ...sub.routing };
	for (const key of FEATURE_KEYS) {
		const current = routing[key];
		if (!current.includes(targetId)) routing[key] = [...current, targetId];
	}
	return { ...sub, routing };
}

function applyCommandSubscriptionDefaults(
	sub: Subscription,
	opts: { targetId: string; isNewSubscription: boolean; isNewGroupRoute: boolean },
): Subscription {
	const current = sub.overrides.features ?? {};
	const atAll = {
		dynamic: { ...sub.atAll.dynamic },
		live: { ...sub.atAll.live },
	};
	if (!opts.isNewSubscription && opts.isNewGroupRoute && atAll.live[opts.targetId] === undefined) {
		atAll.live[opts.targetId] = false;
	}
	return {
		...sub,
		atAllDefaults: {
			...sub.atAllDefaults,
			live: opts.isNewSubscription ? false : sub.atAllDefaults.live,
		},
		atAll,
		overrides: {
			...sub.overrides,
			features: {
				...current,
				liveGuardBuy: current.liveGuardBuy ?? COMMAND_SUBSCRIPTION_DEFAULT_FEATURES.liveGuardBuy,
				superchat: current.superchat ?? COMMAND_SUBSCRIPTION_DEFAULT_FEATURES.superchat,
			},
		},
	};
}

function detachTargetFromSubscription(sub: Subscription, targetId: string): Subscription {
	const routing = { ...sub.routing };
	for (const key of FEATURE_KEYS) routing[key] = routing[key].filter((id) => id !== targetId);
	const atAll = {
		dynamic: { ...sub.atAll.dynamic },
		live: { ...sub.atAll.live },
	};
	delete atAll.dynamic[targetId];
	delete atAll.live[targetId];
	return { ...sub, routing, atAll };
}

function hasAnyRouting(sub: Subscription): boolean {
	return FEATURE_KEYS.some((key) => sub.routing[key].length > 0);
}

function isTargetRouted(sub: Subscription, targetId: string): boolean {
	return FEATURE_KEYS.some((key) => sub.routing[key].includes(targetId));
}

function routedTargetIds(sub: Subscription): string[] {
	const ids = new Set<string>();
	for (const key of FEATURE_KEYS) for (const id of sub.routing[key]) ids.add(id);
	return [...ids];
}

function displaySub(runtime: AppRuntime, sub: Subscription): string {
	const profile = runtime.subRuntimeStore.get(sub.id)?.cachedProfile;
	return `${profile?.name?.trim() || sub.name?.trim() || `UID ${sub.uid}`}（UID ${sub.uid}）`;
}

function toCachedProfile(profile: UpProfile): CachedProfile {
	return {
		name: profile.name,
		avatar: profile.avatar,
		sign: profile.sign,
		fans: profile.fans,
		lastRefreshedAt: new Date().toISOString(),
	};
}

function requiresOwner(command: BiliCommand): boolean {
	return command.kind === "listall" || command.kind === "delall" || command.kind === "delallall";
}

function requiresMemberPermissionAdmin(command: BiliCommand): boolean {
	return command.kind === "member";
}

function requiresGroupAdmin(command: BiliCommand): boolean {
	return command.kind === "add" || command.kind === "del";
}

function resolveCommandConfig(runtime: AppRuntime): ResolvedCommandConfig {
	return resolveCommandConfigFromGlobals(runtime.configStore.getGlobals());
}

function resolveCommandConfigFromGlobals(globals: GlobalConfig): ResolvedCommandConfig {
	const commandConfig = globals.commands as CommandConfig | undefined;
	const aliases = isLegacyDefaultAliases(commandConfig?.aliases)
		? undefined
		: commandConfig?.aliases;
	const ownerQq =
		commandConfig?.ownerQq?.trim() || globals.master.ownerQq?.trim() || DEFAULT_COMMAND_OWNER_QQ;
	return {
		enabled: commandConfig?.enabled ?? true,
		prefix: normalizeToken(commandConfig?.prefix, DEFAULT_COMMAND_PREFIX),
		ownerQq: /^\d+$/.test(ownerQq) ? ownerQq : DEFAULT_COMMAND_OWNER_QQ,
		aliases: normalizeAliases(aliases),
	};
}

function isLegacyDefaultAliases(aliases: Partial<CommandAliases> | undefined): boolean {
	if (!aliases) return false;
	return COMMAND_KINDS.every((kind) => aliases[kind] === LEGACY_COMMAND_ALIASES[kind]);
}

function normalizeAliases(aliases: Partial<CommandAliases> | undefined): CommandAliases {
	return {
		help: normalizeToken(aliases?.help, DEFAULT_COMMAND_ALIASES.help),
		add: normalizeToken(aliases?.add, DEFAULT_COMMAND_ALIASES.add),
		del: normalizeToken(aliases?.del, DEFAULT_COMMAND_ALIASES.del),
		list: normalizeToken(aliases?.list, DEFAULT_COMMAND_ALIASES.list),
		listall: normalizeToken(aliases?.listall, DEFAULT_COMMAND_ALIASES.listall),
		delall: normalizeToken(aliases?.delall, DEFAULT_COMMAND_ALIASES.delall),
		delallall: normalizeToken(aliases?.delallall, DEFAULT_COMMAND_ALIASES.delallall),
		member: normalizeToken(aliases?.member, DEFAULT_COMMAND_ALIASES.member),
	};
}

function normalizeToken(value: string | undefined, fallback: string): string {
	const token = value?.trim();
	return token && !/\s/.test(token) ? token : fallback;
}

function parseCommandAction(
	text: string,
	aliases: CommandAliases,
): { matched: BiliCommandKind; argsText: string } | null {
	if (!text) return { matched: "help", argsText: "" };

	const candidates = COMMAND_KINDS.flatMap((kind) => [
		{ kind, alias: aliases[kind], priority: 0 },
		{ kind, alias: LEGACY_COMMAND_ALIASES[kind], priority: 1 },
	]).sort((a, b) => b.alias.length - a.alias.length || a.priority - b.priority);
	const normalized = text.toLowerCase();
	for (const { kind, alias } of candidates) {
		const normalizedAlias = alias.toLowerCase();
		if (normalized === normalizedAlias) return { matched: kind, argsText: "" };
		if (!normalized.startsWith(normalizedAlias)) continue;

		const rest = text.slice(alias.length);
		if (!rest) return { matched: kind, argsText: "" };
		return { matched: kind, argsText: rest.trim() };
	}
	return null;
}

function parseAfterPrefix(
	text: string,
	prefix: string,
): { afterPrefix: string; separated: boolean } | null {
	if (text === prefix) return { afterPrefix: "", separated: true };
	if (!text.startsWith(prefix)) return null;
	const next = text[prefix.length];
	if (!next) return { afterPrefix: "", separated: true };
	if (/\s/.test(next))
		return { afterPrefix: text.slice(prefix.length).trimStart(), separated: true };
	return { afterPrefix: text.slice(prefix.length).trim(), separated: false };
}

function firstToken(text: string): string | null {
	return text.match(/^\S+/)?.[0] ?? null;
}

function commandUsage(config: ResolvedCommandConfig, kind: BiliCommandKind, arg?: string): string {
	return `${config.prefix}${config.aliases[kind]}${arg ?? ""}`;
}

function badUsage(usage: string): BiliCommand {
	return { kind: "unknown", reason: `用法错误，应为：${usage}` };
}

function parseMemberPermissionAction(value: string | undefined): MemberPermissionAction | null {
	const action = value?.trim().toLowerCase();
	if (!action) return null;
	if (action === "on" || action === "enable" || action === "开启" || action === "开") return "on";
	if (action === "off" || action === "disable" || action === "关闭" || action === "关") {
		return "off";
	}
	if (action === "status" || action === "状态") return "status";
	return null;
}

function isMenuSegmentMessage(message: unknown[], selfId: string | null): boolean {
	let text = "";
	for (const seg of message) {
		if (!seg || typeof seg !== "object") return false;
		const item = seg as { type?: unknown; data?: Record<string, unknown> };
		if (item.type === "text") {
			if (typeof item.data?.text !== "string") return false;
			text += item.data.text;
			continue;
		}
		if (item.type === "at") {
			const qq = normalizeNumericId(item.data?.qq);
			if (!selfId || !qq || qq !== selfId) return false;
			continue;
		}
		return false;
	}
	return text.trim() === MENU_TRIGGER;
}

function isRawMenuMessage(message: unknown, rawMessage: unknown, selfId: string | null): boolean {
	const raw =
		typeof rawMessage === "string" ? rawMessage : typeof message === "string" ? message : "";
	if (!raw) return false;
	const mentions = [...raw.matchAll(/\[CQ:at,qq=([^\],]+)(?:,[^\]]*)?\]/g)].map((m) =>
		normalizeNumericId(m[1]),
	);
	if (mentions.length > 0 && (!selfId || mentions.some((qq) => !qq || qq !== selfId))) {
		return false;
	}
	return stripCqCodes(raw).trim() === MENU_TRIGGER;
}

function normalizeNumericId(value: unknown): string | null {
	if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
	if (typeof value === "string" && /^\d+$/.test(value)) return value;
	return null;
}

function normalizeRole(value: unknown): SenderRole {
	return value === "owner" || value === "admin" || value === "member" ? value : "unknown";
}

function stripCqCodes(text: string): string {
	return text.replace(/\[CQ:[^\]]+\]/g, " ");
}
