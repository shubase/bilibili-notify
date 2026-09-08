import type { VideoInfo } from "@bilibili-notify/api";
import type { CommandConfig } from "@bilibili-notify/internal";
import type { OnebotInboundEventContext, OnebotMessageSegment } from "../platforms/onebot.js";
import type { AppRuntime } from "../runtime/bootstrap.js";

const BILI_BV_PATTERN = /\bBV[0-9A-Za-z]{10}\b/i;
const BILI_AV_PATTERN = /\bav(\d+)\b/i;
const BILI_VIDEO_URL_PATTERN =
	/https?:\/\/(?:(?:www|m)\.)?bilibili\.com\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i;
const BILI_SHORT_LINK_PATTERN = /https?:\/\/(?:b23\.tv|bili2233\.cn)\/[^\s"'<>]+/i;
const BILI_SHORT_HOSTS = new Set(["b23.tv", "bili2233.cn"]);
const VIDEO_PARSE_CACHE_TTL_MS = 5 * 60 * 1000;
const VIDEO_DESC_MAX_LENGTH = 120;
const SHORT_URL_TIMEOUT_MS = 10_000;
const SHORT_URL_MAX_REDIRECTS = 5;
const MAX_CANDIDATE_TEXTS = 80;
const MAX_SCAN_DEPTH = 8;
const SHORT_URL_HEADERS = {
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
	Referer: "https://www.bilibili.com/",
};

interface VideoParseConfig {
	enabled: boolean;
}

interface VideoMessageEvent {
	groupId: string;
	userId: string;
	selfId: string | null;
	message: unknown;
	rawMessage: unknown;
}

export interface BiliVideoTarget {
	bvid?: string;
	aid?: number;
	cacheKey: string;
}

const parseCache = new Map<string, number>();

export async function handleBiliVideoParse(
	runtime: AppRuntime,
	ctx: Pick<OnebotInboundEventContext, "frame" | "sendGroupMessage">,
): Promise<boolean> {
	const config = resolveVideoParseConfig(runtime);
	if (!config.enabled) return false;

	const event = parseVideoMessageEvent(ctx.frame);
	if (!event) return false;
	if (event.selfId && event.userId === event.selfId) return false;

	const target = await findBiliVideoTargetFromMessage(event.message, event.rawMessage);
	if (!target) return false;
	if (isVideoRecentlyParsed(event.groupId, target.cacheKey)) return false;

	const engines = runtime.engines;
	if (!engines) {
		runtime.serviceCtx.logger.warn("[bili-video] Bilibili API 尚未就绪，跳过视频解析");
		return false;
	}

	try {
		const response = await engines.api.getVideoInfo({ bvid: target.bvid, aid: target.aid });
		const video = response.data;
		if (response.code !== 0 || !video) {
			runtime.serviceCtx.logger.debug(
				`[bili-video] 获取视频详情失败 code=${response.code} message=${response.message ?? response.msg ?? ""}`,
			);
			return false;
		}

		const result = await ctx.sendGroupMessage(event.groupId, buildBiliVideoReplySegments(video));
		if (!result.ok) {
			runtime.serviceCtx.logger.warn(
				`[bili-video] 回复群 ${event.groupId} 失败: ${result.err ?? "unknown"}`,
			);
			return false;
		}
		rememberParsedVideo(event.groupId, target.cacheKey);
		if (video.bvid) rememberParsedVideo(event.groupId, video.bvid);
		return true;
	} catch (err) {
		runtime.serviceCtx.logger.warn(`[bili-video] 视频解析失败: ${String(err)}`);
		return false;
	}
}

export async function findBiliVideoTargetFromMessage(
	message: unknown,
	rawMessage: unknown,
): Promise<BiliVideoTarget | null> {
	for (const candidate of extractVideoCandidateTexts(message, rawMessage)) {
		const target = await parseBiliVideoTarget(candidate);
		if (target) return target;
	}
	return null;
}

export async function parseBiliVideoTarget(input: string): Promise<BiliVideoTarget | null> {
	const direct = parseDirectVideoTarget(input);
	if (direct) return direct;

	const shortLink = extractShortLink(input);
	if (!shortLink) return null;
	const realUrl = await resolveBiliShortUrl(shortLink);
	if (!realUrl) return null;
	return parseDirectVideoTarget(realUrl);
}

export function buildBiliVideoReplySegments(video: VideoInfo): OnebotMessageSegment[] {
	const segments: OnebotMessageSegment[] = [];
	const cover = normalizeResourceUrl(video.pic);
	if (cover) segments.push({ type: "image", data: { file: cover } });
	segments.push({ type: "text", data: { text: buildBiliVideoText(video) } });
	return segments;
}

export function clearBiliVideoParseCacheForTest(): void {
	parseCache.clear();
}

function parseVideoMessageEvent(frame: unknown): VideoMessageEvent | null {
	if (!frame || typeof frame !== "object") return null;
	const f = frame as {
		post_type?: unknown;
		message_type?: unknown;
		group_id?: unknown;
		user_id?: unknown;
		self_id?: unknown;
		message?: unknown;
		raw_message?: unknown;
	};
	if (f.post_type !== "message" || f.message_type !== "group") return null;
	const groupId = normalizeNumericId(f.group_id);
	const userId = normalizeNumericId(f.user_id);
	if (!groupId || !userId) return null;
	return {
		groupId,
		userId,
		selfId: normalizeNumericId(f.self_id),
		message: f.message,
		rawMessage: f.raw_message,
	};
}

function extractVideoCandidateTexts(message: unknown, rawMessage: unknown): string[] {
	const out: string[] = [];
	if (Array.isArray(message)) {
		const text = message
			.map((seg) => {
				if (!seg || typeof seg !== "object") return "";
				const item = seg as { type?: unknown; data?: { text?: unknown; data?: unknown } };
				if (item.type === "text" && typeof item.data?.text === "string") return item.data.text;
				if (item.type === "json" && item.data?.data !== undefined) {
					const jsonText = extractJsonSegmentText(item.data.data);
					if (jsonText) out.push(jsonText);
				}
				return " ";
			})
			.join("");
		if (text.trim()) out.push(text);
	} else if (typeof message === "string") {
		out.push(stripCqCodes(message));
	}
	if (typeof rawMessage === "string") {
		out.push(rawMessage, stripCqCodes(rawMessage));
		for (const data of extractCqJsonData(rawMessage)) out.push(data);
	}
	collectNestedTextCandidates(message, out);
	collectNestedTextCandidates(rawMessage, out);
	return uniqueCandidateTexts(out);
}

function extractJsonSegmentText(data: unknown): string | null {
	try {
		if (typeof data === "string") {
			const parsed = JSON.parse(data);
			return `${data}\n${JSON.stringify(parsed)}`;
		}
		if (data && typeof data === "object") return JSON.stringify(data);
	} catch {
		return typeof data === "string" ? data : null;
	}
	return null;
}

function collectNestedTextCandidates(value: unknown, out: string[], depth = 0): void {
	if (depth > MAX_SCAN_DEPTH || out.length >= MAX_CANDIDATE_TEXTS) return;

	if (typeof value === "string") {
		for (const candidate of expandStringCandidate(value)) {
			if (out.length >= MAX_CANDIDATE_TEXTS) return;
			out.push(candidate);
		}
		const parsed = tryParseJsonString(value);
		if (parsed !== null) collectNestedTextCandidates(parsed, out, depth + 1);
		return;
	}

	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) collectNestedTextCandidates(item, out, depth + 1);
		return;
	}

	for (const item of Object.values(value as Record<string, unknown>)) {
		collectNestedTextCandidates(item, out, depth + 1);
	}
}

function expandStringCandidate(value: string): string[] {
	const out: string[] = [];
	for (const candidate of [value, stripCqCodes(value), decodeHtmlEntities(value)]) {
		out.push(candidate, candidate.replace(/\\\//g, "/"));
		const decoded = tryDecodeURIComponent(candidate);
		if (decoded && decoded !== candidate) out.push(decoded, decoded.replace(/\\\//g, "/"));
	}
	return out;
}

function tryParseJsonString(value: string): unknown | null {
	const trimmed = value.trim();
	if (!trimmed || !/^[{[]/.test(trimmed)) return null;
	try {
		return JSON.parse(trimmed);
	} catch {
		return null;
	}
}

function tryDecodeURIComponent(value: string): string | null {
	if (!value.includes("%")) return null;
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}

function uniqueCandidateTexts(values: string[]): string[] {
	return [
		...new Set(
			values
				.map((s) => s.trim())
				.filter(Boolean)
				.slice(0, MAX_CANDIDATE_TEXTS),
		),
	];
}

function extractCqJsonData(text: string): string[] {
	const out: string[] = [];
	for (const match of text.matchAll(/\[CQ:json,data=([\s\S]*?)\]/g)) {
		const data = match[1];
		if (data) out.push(decodeHtmlEntities(data), decodeHtmlEntities(data).replace(/\\\//g, "/"));
	}
	return out;
}

function decodeHtmlEntities(value: string): string {
	return value
		.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

function parseDirectVideoTarget(text: string): BiliVideoTarget | null {
	const urlMatch = text.match(BILI_VIDEO_URL_PATTERN);
	if (urlMatch) return normalizeVideoId(urlMatch[1]);

	const bvMatch = text.match(BILI_BV_PATTERN);
	if (bvMatch) return normalizeVideoId(bvMatch[0]);

	const avMatch = text.match(BILI_AV_PATTERN);
	if (avMatch) return normalizeVideoId(`av${avMatch[1]}`);

	return null;
}

function normalizeVideoId(id: string | undefined): BiliVideoTarget | null {
	if (!id) return null;
	if (id.toLowerCase().startsWith("bv")) {
		const bvid = `BV${id.slice(2)}`;
		return { bvid, cacheKey: bvid };
	}
	if (id.toLowerCase().startsWith("av")) {
		const aid = Number(id.slice(2));
		if (Number.isSafeInteger(aid) && aid > 0) return { aid, cacheKey: `av${aid}` };
	}
	return null;
}

function extractShortLink(text: string): string | null {
	const match = decodeHtmlEntities(text).replace(/\\\//g, "/").match(BILI_SHORT_LINK_PATTERN);
	return match ? trimUrlPunctuation(match[0]) : null;
}

function trimUrlPunctuation(url: string): string {
	return url.replace(/[，。！？、；：）)\]】>}]+$/u, "");
}

async function resolveBiliShortUrl(shortUrl: string): Promise<string | null> {
	for (const url of makeShortUrlCandidates(shortUrl)) {
		const resolved = await resolveBiliShortUrlCandidate(url);
		if (resolved) return resolved;
	}
	return null;
}

function makeShortUrlCandidates(shortUrl: string): string[] {
	const out = new Set<string>();
	for (const value of expandStringCandidate(shortUrl)) {
		const trimmed = trimUrlPunctuation(value.trim());
		if (!trimmed) continue;
		out.add(trimmed);
		try {
			const url = new URL(trimmed);
			if (BILI_SHORT_HOSTS.has(url.hostname)) {
				url.search = "";
				url.hash = "";
				out.add(url.toString());
			}
		} catch {
			// Ignore malformed candidates.
		}
	}
	return [...out].filter(isAllowedShortResolverUrl);
}

async function resolveBiliShortUrlCandidate(shortUrl: string): Promise<string | null> {
	for (const method of ["HEAD", "GET"] as const) {
		let currentUrl = shortUrl;
		for (let redirect = 0; redirect <= SHORT_URL_MAX_REDIRECTS; redirect += 1) {
			const direct = extractDirectVideoText(currentUrl);
			if (direct) return direct;

			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), SHORT_URL_TIMEOUT_MS);
			try {
				const response = await fetch(currentUrl, {
					method,
					redirect: "manual",
					headers: SHORT_URL_HEADERS,
					signal: ctrl.signal,
				});
				const responseUrl = extractDirectVideoText(response.url);
				if (responseUrl) return responseUrl;

				const location = response.headers.get("location");
				if (location) {
					const nextUrl = new URL(location, currentUrl).toString();
					const nextDirect = extractDirectVideoText(nextUrl);
					if (nextDirect) return nextDirect;
					if (!isAllowedShortResolverUrl(nextUrl)) return null;
					currentUrl = nextUrl;
					continue;
				}

				if (method === "GET") {
					const body = await safeResponseText(response);
					const bodyDirect = body ? extractDirectVideoText(body) : null;
					if (bodyDirect) return bodyDirect;
				}
				break;
			} catch {
				// Try the next method/candidate. Some short-link edges do not allow HEAD.
				break;
			} finally {
				clearTimeout(timer);
			}
		}
	}
	return null;
}

function extractDirectVideoText(text: string): string | null {
	const normalized = decodeHtmlEntities(text).replace(/\\\//g, "/");
	const urlMatch = normalized.match(BILI_VIDEO_URL_PATTERN);
	if (urlMatch) return urlMatch[0];
	const bvMatch = normalized.match(BILI_BV_PATTERN);
	if (bvMatch) return bvMatch[0];
	const avMatch = normalized.match(BILI_AV_PATTERN);
	if (avMatch) return avMatch[0];
	return null;
}

async function safeResponseText(response: Response): Promise<string | null> {
	try {
		return await response.text();
	} catch {
		return null;
	}
}

function isAllowedShortResolverUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return BILI_SHORT_HOSTS.has(url.hostname) || isAllowedBilibiliHost(url.hostname);
	} catch {
		return false;
	}
}

function isAllowedBilibiliHost(hostname: string): boolean {
	return hostname === "bilibili.com" || hostname.endsWith(".bilibili.com");
}

function buildBiliVideoText(video: VideoInfo): string {
	return [
		`📺 标题：${video.title || "未命名视频"}`,
		`👤 UP主：${video.owner?.name || "未知"}`,
		`📁 分区：${video.tname || "未知"}`,
		`⏱ 时长：${formatDuration(video.duration)}`,
		`▶ 播放：${formatNumber(video.stat?.view ?? 0)}  💬 弹幕：${formatNumber(video.stat?.danmaku ?? 0)}`,
		`👍 点赞：${formatNumber(video.stat?.like ?? 0)}  🪙 投币：${formatNumber(video.stat?.coin ?? 0)}  ⭐ 收藏：${formatNumber(video.stat?.favorite ?? 0)}`,
		"",
		`📝 简介：${clipDescription(video.desc)}`,
		`🔗 https://www.bilibili.com/video/${video.bvid}`,
	].join("\n");
}

function formatDuration(value: number): string {
	const seconds = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = seconds % 60;
	if (hours > 0) {
		return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
	}
	return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function formatNumber(value: number): string {
	const n = Number.isFinite(value) && value > 0 ? value : 0;
	if (n >= 100_000_000) return `${trimFixed(n / 100_000_000)}亿`;
	if (n >= 10_000) return `${trimFixed(n / 10_000)}万`;
	return String(Math.round(n));
}

function trimFixed(value: number): string {
	return value.toFixed(1).replace(/\.0$/, "");
}

function clipDescription(desc: string): string {
	const normalized = desc.replace(/\s+/g, " ").trim();
	if (!normalized) return "暂无简介";
	const chars = Array.from(normalized);
	if (chars.length <= VIDEO_DESC_MAX_LENGTH) return normalized;
	return `${chars.slice(0, VIDEO_DESC_MAX_LENGTH).join("")}...`;
}

function normalizeResourceUrl(value: string | undefined): string | null {
	if (!value) return null;
	if (value.startsWith("//")) return `https:${value}`;
	return value;
}

function isVideoRecentlyParsed(groupId: string, cacheKey: string): boolean {
	const key = `${groupId}:${cacheKey}`;
	const ts = parseCache.get(key);
	if (!ts) return false;
	if (Date.now() - ts <= VIDEO_PARSE_CACHE_TTL_MS) return true;
	parseCache.delete(key);
	return false;
}

function rememberParsedVideo(groupId: string, cacheKey: string): void {
	parseCache.set(`${groupId}:${cacheKey}`, Date.now());
}

function resolveVideoParseConfig(runtime: AppRuntime): VideoParseConfig {
	const commands = runtime.configStore.getGlobals().commands as CommandConfig | undefined;
	return { enabled: commands?.videoParse?.enabled ?? true };
}

function normalizeNumericId(value: unknown): string | null {
	if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
	if (typeof value === "string" && /^\d+$/.test(value)) return value;
	return null;
}

function stripCqCodes(text: string): string {
	return text.replace(/\[CQ:[^\]]+\]/g, " ");
}
