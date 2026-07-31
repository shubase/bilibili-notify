// biome-ignore-all lint/suspicious/noExplicitAny: command handler tests use a narrow fake runtime.
import {
	FEATURE_KEYS,
	makeDefaultGlobalConfig,
	makeEmptySubscription,
	type PushTarget,
	type Subscription,
} from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const H = vi.hoisted(() => ({
	ensureFollowed: vi.fn(),
}));

vi.mock("@bilibili-notify/api", () => ({
	ensureFollowed: H.ensureFollowed,
}));

import {
	createBiliOnebotCommandHandler,
	extractOnebotMessageText,
	isOnebotMenuRequest,
	parseBiliCommand,
	parseOnebotGroupMessage,
} from "../bili-onebot.js";
import { clearBiliVideoParseCacheForTest, parseBiliVideoTarget } from "../bili-video-parser.js";

beforeEach(() => {
	H.ensureFollowed.mockReset();
	clearBiliVideoParseCacheForTest();
});

describe("bili OneBot group command parser", () => {
	it("只接收无斜杠的 bili 前缀", () => {
		expect(parseBiliCommand("bili帮助")).toEqual({ kind: "help" });
		expect(parseBiliCommand("bili help")).toEqual({ kind: "help" });
		expect(parseBiliCommand("/bili帮助")).toBeNull();
		expect(parseBiliCommand(" 菜单 ")).toBeNull();
	});

	it("解析中文无空格订阅管理命令", () => {
		expect(parseBiliCommand("bili订阅123456")).toEqual({ kind: "add", query: "123456" });
		expect(parseBiliCommand("bili订阅火播君")).toEqual({
			kind: "add",
			query: "火播君",
		});
		expect(parseBiliCommand("bili取消123456")).toEqual({ kind: "del", uid: "123456" });
		expect(parseBiliCommand("bili列表")).toEqual({ kind: "list" });
		expect(parseBiliCommand("bili全部列表")).toEqual({ kind: "listall" });
		expect(parseBiliCommand("bili清空")).toEqual({ kind: "delall" });
		expect(parseBiliCommand("bili清空全部")).toEqual({ kind: "delallall" });
		expect(parseBiliCommand("bili权限开启")).toEqual({ kind: "member", action: "on" });
		expect(parseBiliCommand("bili权限关闭")).toEqual({ kind: "member", action: "off" });
		expect(parseBiliCommand("bili权限状态")).toEqual({ kind: "member", action: "status" });
	});

	it("兼容旧英文命令", () => {
		expect(parseBiliCommand("bili add 123456")).toEqual({ kind: "add", query: "123456" });
		expect(parseBiliCommand("bili del 123456")).toEqual({ kind: "del", uid: "123456" });
		expect(parseBiliCommand("bili list")).toEqual({ kind: "list" });
		expect(parseBiliCommand("bili member status")).toEqual({ kind: "member", action: "status" });
	});

	it("解析 Bilibili 视频 BV 与 av 标识", async () => {
		await expect(
			parseBiliVideoTarget("https://www.bilibili.com/video/BV1QY4y1p7Jd"),
		).resolves.toEqual({
			bvid: "BV1QY4y1p7Jd",
			cacheKey: "BV1QY4y1p7Jd",
		});
		await expect(parseBiliVideoTarget("av170001")).resolves.toEqual({
			aid: 170001,
			cacheKey: "av170001",
		});
	});

	it("支持配置命令前缀和关键字", () => {
		const config = {
			enabled: true,
			prefix: "bn",
			ownerQq: "10000",
			aliases: {
				help: "help",
				add: "添加",
				del: "删除",
				list: "列表",
				listall: "全部列表",
				delall: "清空本群",
				delallall: "清空全部",
				member: "权限",
			},
		};
		expect(parseBiliCommand("bn添加123456", config)).toEqual({ kind: "add", query: "123456" });
		expect(parseBiliCommand("bn 权限 开", config)).toEqual({ kind: "member", action: "on" });
		expect(parseBiliCommand("bn权限开", config)).toEqual({ kind: "member", action: "on" });
		expect(parseBiliCommand("bili add 123456", config)).toBeNull();
		expect(parseBiliCommand("bn 删除 abc", config)).toEqual({
			kind: "unknown",
			reason: "用法错误，应为：bn删除<uid>",
		});
	});

	it("add 支持名字，del 仍然要求 UID 是纯数字", () => {
		expect(parseBiliCommand("bili订阅abc")).toEqual({ kind: "add", query: "abc" });
		expect(parseBiliCommand("bili取消")).toEqual({
			kind: "unknown",
			reason: "用法错误，应为：bili取消<uid>",
		});
	});

	it("从 OneBot 消息段中提取文字并忽略 at 段", () => {
		const text = extractOnebotMessageText(
			[
				{ type: "at", data: { qq: "10000" } },
				{ type: "text", data: { text: " bili列表 " } },
			],
			"",
		);
		expect(text).toBe("bili列表");
	});

	it("从 CQ 字符串中去掉 CQ 码", () => {
		expect(extractOnebotMessageText("[CQ:at,qq=10000] bili列表", "")).toBe("bili列表");
	});

	it("只解析群聊 message 事件", () => {
		expect(
			parseOnebotGroupMessage({
				post_type: "message",
				message_type: "group",
				group_id: 987,
				user_id: 123,
				sender: { role: "admin" },
				message: [{ type: "text", data: { text: "bili列表" } }],
			}),
		).toMatchObject({ groupId: "987", userId: "123", role: "admin", text: "bili列表" });

		expect(
			parseOnebotGroupMessage({
				post_type: "message",
				message_type: "private",
				user_id: 123,
				message: "bili列表",
			}),
		).toBeNull();
	});

	it("识别纯菜单文本和 @ 机器人菜单文本", () => {
		expect(
			isOnebotMenuRequest({
				post_type: "message",
				message_type: "group",
				self_id: 10000,
				message: [{ type: "text", data: { text: " 菜单 " } }],
			}),
		).toBe(true);
		expect(
			isOnebotMenuRequest({
				post_type: "message",
				message_type: "group",
				self_id: 10000,
				message: [
					{ type: "at", data: { qq: "10000" } },
					{ type: "text", data: { text: " 菜单 " } },
				],
			}),
		).toBe(true);
	});

	it("菜单触发必须精确，并且不能 @ 其他人", () => {
		expect(
			isOnebotMenuRequest({
				post_type: "message",
				message_type: "group",
				self_id: 10000,
				message: [{ type: "text", data: { text: "菜单一下" } }],
			}),
		).toBe(false);
		expect(
			isOnebotMenuRequest({
				post_type: "message",
				message_type: "group",
				self_id: 10000,
				message: [
					{ type: "at", data: { qq: "10001" } },
					{ type: "text", data: { text: " 菜单" } },
				],
			}),
		).toBe(false);
	});
});

describe("bili OneBot group command handler", () => {
	it("bili订阅 关注失败时返回失败，并且不创建订阅和群目标", async () => {
		const h = makeRuntime();
		H.ensureFollowed.mockResolvedValueOnce({
			ok: false,
			code: -403,
			message: "已被对方拉黑，无法关注",
		});

		await sendCommand(h.runtime, "bili订阅123456", { groupName: "女仆值班室" });

		expect(h.replies[0]).toContain("订阅失败：无法关注 测试UP");
		expect(h.subscriptions).toHaveLength(0);
		expect(h.targets).toHaveLength(0);
		expect(h.patches).toHaveLength(0);
	});

	it("bili订阅 成功时自动创建本群推送目标并写入订阅路由", async () => {
		const h = makeRuntime();
		H.ensureFollowed.mockResolvedValueOnce({ ok: true, code: 0 });

		await sendCommand(h.runtime, "bili订阅123456", { groupName: "女仆值班室" });

		expect(h.replies[0]).toBe("✅ 订阅成功!\n📺 测试UP\n🔗 UID: 123456");
		expect(h.targets).toHaveLength(1);
		expect(h.targets[0]).toMatchObject({
			name: "女仆值班室",
			adapterId: "onebot-main",
			platform: "onebot",
			scope: "group",
			session: { groupId: "987" },
		});
		expect(h.subscriptions).toHaveLength(1);
		const targetId = h.targets[0]?.id;
		expect(targetId).toBeTruthy();
		expect(Object.values(h.subscriptions[0]?.routing ?? {})).toEqual(
			expect.arrayContaining([expect.arrayContaining([targetId])]),
		);
		expect(h.subscriptions[0]?.routing.live).toContain(targetId);
		expect(h.subscriptions[0]?.atAllDefaults.live).toBe(false);
		expect(h.subscriptions[0]?.overrides.features).toMatchObject({
			liveGuardBuy: true,
			superchat: true,
		});
		expect(h.patches[0]).toMatchObject({
			id: h.subscriptions[0]?.id,
			partial: { followed: true, followError: undefined },
		});
	});

	it("bili订阅 支持通过 UP 名字精确命中后订阅", async () => {
		const h = makeRuntime();
		H.ensureFollowed.mockResolvedValueOnce({ ok: true, code: 0 });
		h.runtime.engines.api.searchByType.mockResolvedValueOnce({
			code: 0,
			data: {
				result: [
					{
						mid: "268536810",
						uname: '<em class="keyword">火</em>播君',
						fans: 672345,
					},
				],
			},
		});
		h.runtime.engines.api.getUserCardInfo.mockResolvedValueOnce({
			code: 0,
			data: {
				card: {
					mid: "268536810",
					name: "火播君",
					face: "https://example.invalid/huobojun.png",
					sign: "",
					fans: 672345,
				},
			},
		});

		await sendCommand(h.runtime, "bili订阅火播君", { groupName: "女仆值班室" });

		expect(h.runtime.engines.api.searchByType).toHaveBeenCalledWith("bili_user", "火播君", {
			page: 1,
			pageSize: 5,
		});
		expect(H.ensureFollowed).toHaveBeenCalledWith(h.runtime.engines.api, "268536810");
		expect(h.replies[0]).toBe("✅ 订阅成功!\n📺 火播君\n🔗 UID: 268536810");
		expect(h.subscriptions[0]?.uid).toBe("268536810");
	});

	it("bili订阅 名字命中多个候选时只返回前 5 个 UID，不自动订阅", async () => {
		const h = makeRuntime();
		h.runtime.engines.api.searchByType.mockResolvedValueOnce({
			code: 0,
			data: {
				result: [
					{ mid: "10001", uname: "火播君", fans: 672345 },
					{ mid: "10002", uname: "火播姬", fans: 12345 },
					{ mid: "10003", uname: "火播频道", fans: 2345 },
					{ mid: "10004", uname: "火播直播间", fans: 345 },
					{ mid: "10005", uname: "火播Official", fans: 45 },
					{ mid: "10006", uname: "不应显示", fans: 1 },
				],
			},
		});

		await sendCommand(h.runtime, "bili订阅火播");

		expect(H.ensureFollowed).not.toHaveBeenCalled();
		expect(h.subscriptions).toHaveLength(0);
		expect(h.replies[0]).toContain("🔎 找到多个可能的 UP「火播」，请使用 UID 添加：");
		expect(h.replies[0]).toContain("1. 火播君 · 67.2万粉丝\n   UID: 10001");
		expect(h.replies[0]).toContain("5. 火播Official · 45 粉丝\n   UID: 10005");
		expect(h.replies[0]).toContain("请发送：bili订阅<uid>");
		expect(h.replies[0]).not.toContain("10006");
	});

	it("bili订阅 名字无搜索结果时返回未找到", async () => {
		const h = makeRuntime();
		h.runtime.engines.api.searchByType.mockResolvedValueOnce({
			code: 0,
			data: { result: [] },
		});

		await sendCommand(h.runtime, "bili订阅不存在的UP");

		expect(H.ensureFollowed).not.toHaveBeenCalled();
		expect(h.replies[0]).toBe(
			"订阅失败：未找到名为「不存在的UP」的 UP。请换更准确的名字，或使用 UID。",
		);
	});

	it("bili取消 时同步已有本群推送目标名称", async () => {
		const h = makeRuntime();
		h.targets.push({
			id: "target-987",
			name: "QQ群 987",
			adapterId: "onebot-main",
			platform: "onebot",
			scope: "group",
			enabled: true,
			session: { groupId: "987" },
		});
		h.subscriptions.push(makeRoutedSubscription("123456", "测试UP", "target-987"));

		await sendCommand(h.runtime, "bili取消123456", { groupName: "新的群名" });

		expect(h.targets[0]?.name).toBe("新的群名");
	});

	it("bili订阅 为已有 UP 新增本群订阅时保持开播开启，但关闭本群开播 @全体", async () => {
		const h = makeRuntime();
		H.ensureFollowed.mockResolvedValueOnce({ ok: true, code: 0 });
		h.targets.push({
			id: "target-987",
			name: "测试群",
			adapterId: "onebot-main",
			platform: "onebot",
			scope: "group",
			enabled: true,
			session: { groupId: "987" },
		});
		const sub = makeRoutedSubscription("123456", "测试UP", "other-target");
		sub.atAllDefaults.live = true;
		h.subscriptions.push(sub);

		await sendCommand(h.runtime, "bili订阅123456");

		expect(h.subscriptions[0]?.routing.live).toContain("target-987");
		expect(h.subscriptions[0]?.atAllDefaults.live).toBe(true);
		expect(h.subscriptions[0]?.atAll.live).toMatchObject({ "target-987": false });
	});

	it("普通成员未开启管理权限时，使用管理员命令会回复权限状态", async () => {
		const h = makeRuntime();

		await sendCommand(h.runtime, "bili订阅123456", { userId: "20000", role: "member" });

		expect(h.replies[0]).toBe(
			["👥 普通成员管理权限", "状态：已关闭", "普通成员只能查看本群订阅。"].join("\n"),
		);
		expect(h.subscriptions).toHaveLength(0);
	});

	it("群目标开启普通成员管理后，普通成员可以管理本群订阅", async () => {
		const h = makeRuntime();
		h.targets.push({
			id: "target-987",
			name: "测试群",
			adapterId: "onebot-main",
			platform: "onebot",
			scope: "group",
			enabled: true,
			session: { groupId: "987", allowMemberManage: true },
		});

		await sendCommand(h.runtime, "bili取消123456", { userId: "20000", role: "member" });

		expect(h.replies[0]).toBe("本群未订阅 UID 123456。");
	});

	it("收到菜单时回复功能菜单", async () => {
		const h = makeRuntime();

		await sendCommand(h.runtime, "菜单");

		expect(h.replies[0]).toBe(
			[
				"==== 功能菜单 ====",
				"",
				"🐾 pet",
				"   表情包命令。",
				"",
				"📺 bili帮助",
				"   B站订阅功能。",
			].join("\n"),
		);
	});

	it("旧英文默认 aliases 会自动迁移为中文展示", async () => {
		const h = makeRuntime();
		h.globals.commands.aliases = {
			help: "help",
			add: "add",
			del: "del",
			list: "list",
			listall: "listall",
			delall: "delall",
			delallall: "delallall",
			member: "member",
		};

		await sendCommand(h.runtime, "菜单");

		expect(h.replies[0]).toContain("📺 bili帮助");
	});

	it("@机器人说菜单时回复功能菜单，@其他人不触发", async () => {
		const h = makeRuntime();

		await sendCommand(h.runtime, "", {
			message: [
				{ type: "at", data: { qq: "10000" } },
				{ type: "text", data: { text: " 菜单 " } },
			],
		});
		await sendCommand(h.runtime, "", {
			message: [
				{ type: "at", data: { qq: "10001" } },
				{ type: "text", data: { text: " 菜单" } },
			],
		});

		expect(h.replies).toHaveLength(1);
		expect(h.replies[0]).toContain("==== 功能菜单 ====");
	});

	it("bili list 有订阅时使用合并转发发送列表", async () => {
		const h = makeRuntime();
		h.targets.push({
			id: "target-987",
			name: "测试群",
			adapterId: "onebot-main",
			platform: "onebot",
			scope: "group",
			enabled: true,
			session: { groupId: "987" },
		});
		h.subscriptions.push(makeRoutedSubscription("123456", "测试UP", "target-987"));

		await sendCommand(h.runtime, "bili列表");

		expect(h.replies).toHaveLength(0);
		expect(h.forwardReplies).toHaveLength(1);
		expect(h.forwardReplies[0]).toMatchObject({ groupId: "987" });
		expect(h.forwardReplies[0]?.nodes).toEqual([
			["📺 本群 B 站订阅（1 个）", "第 1/1 页", "", "1. 测试UP（UID 123456）"].join("\n"),
			["🧩 管理员可用", "• bili订阅<uid>|<名字>：订阅 UP", "• bili取消<uid>：取消订阅"].join("\n"),
		]);
	});

	it("bili list 每页 10 个订阅，并在最后追加管理员命令节点", async () => {
		const h = makeRuntime();
		h.targets.push({
			id: "target-987",
			name: "测试群",
			adapterId: "onebot-main",
			platform: "onebot",
			scope: "group",
			enabled: true,
			session: { groupId: "987" },
		});
		for (let i = 1; i <= 11; i += 1) {
			h.subscriptions.push(makeRoutedSubscription(String(100000 + i), `测试UP${i}`, "target-987"));
		}

		await sendCommand(h.runtime, "bili列表");

		expect(h.replies).toHaveLength(0);
		expect(h.forwardReplies).toHaveLength(1);
		expect(h.forwardReplies[0]?.nodes).toHaveLength(3);
		expect(h.forwardReplies[0]?.nodes[0]).toBe(
			[
				"📺 本群 B 站订阅（11 个）",
				"第 1/2 页",
				"",
				"1. 测试UP1（UID 100001）",
				"2. 测试UP2（UID 100002）",
				"3. 测试UP3（UID 100003）",
				"4. 测试UP4（UID 100004）",
				"5. 测试UP5（UID 100005）",
				"6. 测试UP6（UID 100006）",
				"7. 测试UP7（UID 100007）",
				"8. 测试UP8（UID 100008）",
				"9. 测试UP9（UID 100009）",
				"10. 测试UP10（UID 100010）",
			].join("\n"),
		);
		expect(h.forwardReplies[0]?.nodes[1]).toBe(
			["📺 本群 B 站订阅（11 个）", "第 2/2 页", "", "11. 测试UP11（UID 100011）"].join("\n"),
		);
		expect(h.forwardReplies[0]?.nodes[2]).toBe(
			["🧩 管理员可用", "• bili订阅<uid>|<名字>：订阅 UP", "• bili取消<uid>：取消订阅"].join("\n"),
		);
	});

	it("bili list 合并转发失败时回退普通文本", async () => {
		const h = makeRuntime();
		h.targets.push({
			id: "target-987",
			name: "测试群",
			adapterId: "onebot-main",
			platform: "onebot",
			scope: "group",
			enabled: true,
			session: { groupId: "987" },
		});
		h.subscriptions.push(makeRoutedSubscription("123456", "测试UP", "target-987"));

		await sendCommand(h.runtime, "bili列表", { forwardOk: false });

		expect(h.forwardReplies).toHaveLength(1);
		expect(h.replies[0]).toBe(
			["📺 本群 B 站订阅（1 个）", "", "• 1. 测试UP（UID 123456）"].join("\n"),
		);
	});

	it("bili help 按权限分组展示命令，并隐藏主人命令", async () => {
		const h = makeRuntime();

		await sendCommand(h.runtime, "bili帮助");

		const expected = [
			"B站订阅up主 推送动态和直播",
			"",
			"🧩 管理员可用",
			"• bili订阅<uid>|<名字>：订阅 UP",
			"• bili取消<uid>：取消订阅",
			"• bili权限开启|关闭：设置普通成员管理权限",
			"• bili权限状态：查看普通成员管理权限",
			"",
			"🔎 普通成员可用",
			"• bili列表：查看本群订阅",
			"• bili帮助：显示本说明",
		].join("\n");

		expect(h.replies).toHaveLength(0);
		expect(h.forwardReplies).toHaveLength(1);
		expect(h.forwardReplies[0]).toMatchObject({ groupId: "987" });
		expect(h.forwardReplies[0]?.nodes).toEqual([expected]);
	});

	it("bili help 合并转发失败时回退普通文本", async () => {
		const h = makeRuntime();

		await sendCommand(h.runtime, "bili帮助", { forwardOk: false });

		const expected = [
			"B站订阅up主 推送动态和直播",
			"",
			"🧩 管理员可用",
			"• bili订阅<uid>|<名字>：订阅 UP",
			"• bili取消<uid>：取消订阅",
			"• bili权限开启|关闭：设置普通成员管理权限",
			"• bili权限状态：查看普通成员管理权限",
			"",
			"🔎 普通成员可用",
			"• bili列表：查看本群订阅",
			"• bili帮助：显示本说明",
		].join("\n");

		expect(h.forwardReplies).toHaveLength(1);
		expect(h.replies[0]).toBe(expected);
	});

	it("delall 仅主人可用，群管理员也不能清空本群订阅", async () => {
		const h = makeRuntime();

		await sendCommand(h.runtime, "bili清空", { userId: "20000", role: "admin" });

		expect(h.replies[0]).toBe("只有主人可以执行这个命令。");
	});

	it("群管理员可以通过指令开启和关闭普通成员管理本群订阅权限", async () => {
		const h = makeRuntime();

		await sendCommand(h.runtime, "bili权限开启", { userId: "20000", role: "admin" });

		expect(h.replies[0]).toContain("普通成员管理权限已开启");
		expect(h.targets).toHaveLength(1);
		expect(h.targets[0]).toMatchObject({
			adapterId: "onebot-main",
			platform: "onebot",
			scope: "group",
			session: { groupId: "987", allowMemberManage: true },
		});

		await sendCommand(h.runtime, "bili权限关闭", { userId: "20000", role: "admin" });

		expect(h.replies[1]).toContain("普通成员管理权限已关闭");
		expect(h.targets[0]).toMatchObject({
			session: { groupId: "987" },
		});
		expect(
			(h.targets[0] as Extract<PushTarget, { platform: "onebot" }>).session,
		).not.toHaveProperty("allowMemberManage");
	});

	it("普通成员即使已被授权，也不能修改普通成员管理权限", async () => {
		const h = makeRuntime();
		h.targets.push({
			id: "target-987",
			name: "测试群",
			adapterId: "onebot-main",
			platform: "onebot",
			scope: "group",
			enabled: true,
			session: { groupId: "987", allowMemberManage: true },
		});

		await sendCommand(h.runtime, "bili权限关闭", { userId: "20000", role: "member" });

		expect(h.replies[0]).toBe("只有群主、管理员或主人可以修改普通成员管理权限。");
		expect((h.targets[0] as Extract<PushTarget, { platform: "onebot" }>).session).toMatchObject({
			allowMemberManage: true,
		});
	});

	it("自动解析 Bilibili 视频链接并回复封面和视频详情", async () => {
		const h = makeRuntime();

		await sendCommand(h.runtime, "看看 https://www.bilibili.com/video/BV1QY4y1p7Jd");

		expect(h.replies).toHaveLength(0);
		expect(h.segmentReplies).toHaveLength(1);
		expect(h.runtime.engines.api.getVideoInfo).toHaveBeenCalledWith({
			bvid: "BV1QY4y1p7Jd",
			aid: undefined,
		});
		const message = h.segmentReplies[0]?.message ?? [];
		expect(message[0]).toEqual({
			type: "image",
			data: { file: "https://i0.hdslb.com/bfs/archive/test-cover.jpg" },
		});
		expect(message[1]?.type).toBe("text");
		const text = message[1]?.data.text ?? "";
		expect(text).toContain("📺 标题：测试视频");
		expect(text).toContain("👤 UP主：测试UP");
		expect(text).toContain("📝 简介：测试简介");
		expect(text).toContain("🔗 https://www.bilibili.com/video/BV1QY4y1p7Jd");
		expect(text).not.toContain("🎬 Bilibili 视频解析");
	});

	it("视频解析全局关闭后不处理群聊视频链接", async () => {
		const h = makeRuntime();
		h.globals.commands.videoParse.enabled = false;

		await sendCommand(h.runtime, "https://www.bilibili.com/video/BV1QY4y1p7Jd");

		expect(h.segmentReplies).toHaveLength(0);
		expect(h.runtime.engines.api.getVideoInfo).not.toHaveBeenCalled();
	});
});

function makeRuntime() {
	const globals = makeDefaultGlobalConfig();
	globals.master.ownerQq = "1319870047";
	const targets: PushTarget[] = [];
	const subscriptions: Subscription[] = [];
	const patches: Array<{ id: string; partial: Record<string, unknown> }> = [];
	const replies: string[] = [];
	const forwardReplies: Array<{ groupId: string; nodes: string[] }> = [];
	const segmentReplies: Array<{
		groupId: string;
		message: Array<{ type: string; data: Record<string, string> }>;
	}> = [];

	const runtime = {
		engines: {
			api: {
				getUserCardInfo: vi.fn(async (uid: string) => ({
					code: 0,
					data: {
						card: {
							mid: uid,
							name: "测试UP",
							face: "https://example.invalid/avatar.png",
							sign: "sign",
							fans: 42,
						},
					},
				})),
				getVideoInfo: vi.fn(async () => ({
					code: 0,
					data: makeVideoInfo(),
				})),
				searchByType: vi.fn(async () => ({
					code: 0,
					data: { result: [] },
				})),
			},
		},
		serviceCtx: {
			logger: {
				warn: vi.fn(),
				info: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
			},
		},
		configStore: {
			getGlobals: () => globals,
			getAdapters: () => [{ id: "onebot-main", platform: "onebot" }],
			getTargets: () => targets,
			upsertTarget: vi.fn(async (target: PushTarget) => {
				const index = targets.findIndex((t) => t.id === target.id);
				if (index >= 0) targets[index] = target;
				else targets.push(target);
			}),
			getSubscriptions: () => subscriptions,
			upsertSubscription: vi.fn(async (sub: Subscription) => {
				const index = subscriptions.findIndex((s) => s.id === sub.id);
				if (index >= 0) subscriptions[index] = sub;
				else subscriptions.push(sub);
			}),
			deleteSubscription: vi.fn(async (id: string) => {
				const index = subscriptions.findIndex((s) => s.id === id);
				if (index < 0) return false;
				subscriptions.splice(index, 1);
				return true;
			}),
		},
		subRuntimeStore: {
			get: vi.fn(() => undefined),
			patch: vi.fn(async (id: string, partial: Record<string, unknown>) => {
				patches.push({ id, partial });
			}),
		},
		__testReplies: replies,
		__testForwardReplies: forwardReplies,
		__testSegmentReplies: segmentReplies,
	} as any;

	return {
		runtime,
		globals,
		targets,
		subscriptions,
		patches,
		replies,
		forwardReplies,
		segmentReplies,
	};
}

function makeRoutedSubscription(uid: string, name: string, targetId: string): Subscription {
	const sub = makeEmptySubscription({ id: `sub-${uid}`, uid });
	sub.name = name;
	for (const key of FEATURE_KEYS) sub.routing[key] = [targetId];
	return sub;
}

function makeVideoInfo() {
	return {
		bvid: "BV1QY4y1p7Jd",
		aid: 170001,
		videos: 1,
		tid: 17,
		tname: "单机游戏",
		copyright: 1,
		pic: "//i0.hdslb.com/bfs/archive/test-cover.jpg",
		title: "测试视频",
		pubdate: 0,
		ctime: 0,
		desc: "测试简介",
		duration: 125,
		owner: {
			mid: 123456,
			name: "测试UP",
			face: "https://example.invalid/face.jpg",
		},
		stat: {
			aid: 170001,
			view: 12345,
			danmaku: 678,
			reply: 9,
			favorite: 10,
			coin: 11,
			share: 12,
			like: 13,
		},
	};
}

async function sendCommand(
	runtime: any,
	text: string,
	options: {
		userId?: string;
		role?: "owner" | "admin" | "member";
		forwardOk?: boolean;
		groupName?: string | null;
		selfId?: string | number;
		message?: unknown;
	} = {},
): Promise<void> {
	const handler = createBiliOnebotCommandHandler(runtime);
	await handler({
		adapterId: "onebot-main",
		frame: {
			post_type: "message",
			message_type: "group",
			self_id: options.selfId ?? 10000,
			group_id: 987,
			user_id: options.userId ?? 1319870047,
			sender: { role: options.role ?? "member" },
			message: options.message ?? [{ type: "text", data: { text } }],
		},
		getGroupName: async () => options.groupName ?? null,
		sendGroupText: async (_groupId, message) => {
			runtime.__testReplies?.push(message);
			return { ok: true, latencyMs: 1 };
		},
		sendGroupMessage: async (groupId, message) => {
			runtime.__testSegmentReplies?.push({ groupId, message });
			return { ok: true, latencyMs: 1 };
		},
		sendGroupForwardText: async (groupId, nodes) => {
			runtime.__testForwardReplies?.push({ groupId, nodes });
			if (options.forwardOk === false) {
				return { ok: false, latencyMs: 1, err: "forward failed" };
			}
			return { ok: true, latencyMs: 1 };
		},
	});
}
