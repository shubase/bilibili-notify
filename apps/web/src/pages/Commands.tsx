import { buildPatch } from "@bilibili-notify/internal/patch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Toggle } from "../components/atoms";
import { Field, TInput } from "../components/forms";
import { GlassBox } from "../components/glass-box";
import { Icon } from "../components/icons";
import { useDirtyDraft } from "../hooks/useDirtyDraft";
import { api } from "../services/api";
import type {
	CommandAliases,
	CommandConfig,
	GlobalConfig,
	GlobalConfigPatch,
} from "../types/globals";

const DEFAULT_PREFIX = "bili";
const DEFAULT_OWNER_QQ = "1319870047";
const DEFAULT_ALIASES: CommandAliases = {
	help: "help",
	add: "add",
	del: "del",
	list: "list",
	listall: "listall",
	delall: "delall",
	delallall: "delallall",
	member: "member",
};

type AliasKey = keyof CommandAliases;

const COMMAND_ROWS: ReadonlyArray<{
	key: AliasKey;
	arg?: string;
	meaning: string;
	badge?: string;
}> = [
	{ key: "help", meaning: "显示帮助" },
	{ key: "add", arg: "<uid>", meaning: "订阅 UP 到本群" },
	{ key: "del", arg: "<uid>", meaning: "取消本群订阅" },
	{ key: "list", meaning: "查看本群订阅" },
	{ key: "listall", meaning: "查看全部订阅", badge: "主人" },
	{ key: "delall", meaning: "清空本群订阅", badge: "主人" },
	{ key: "delallall", meaning: "删除全部订阅", badge: "主人" },
	{ key: "member", arg: "on|off|status", meaning: "普通成员管理权限", badge: "群管" },
];

function deepMerge<T>(base: T, patch: GlobalConfigPatch): T {
	if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return patch as T;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const key of Object.keys(patch)) {
		const patchValue = (patch as Record<string, unknown>)[key];
		if (patchValue === null) {
			delete out[key];
			continue;
		}
		const baseValue = out[key];
		if (
			patchValue != null &&
			typeof patchValue === "object" &&
			!Array.isArray(patchValue) &&
			baseValue != null &&
			typeof baseValue === "object" &&
			!Array.isArray(baseValue)
		) {
			out[key] = deepMerge(baseValue, patchValue as GlobalConfigPatch);
		} else {
			out[key] = patchValue;
		}
	}
	return out as T;
}

function editableCommands(draft: GlobalConfig): CommandConfig {
	const commands = draft.commands ?? ({} as CommandConfig);
	return {
		enabled: commands.enabled ?? true,
		prefix: commands.prefix ?? DEFAULT_PREFIX,
		ownerQq: commands.ownerQq ?? draft.master.ownerQq ?? DEFAULT_OWNER_QQ,
		aliases: {
			...DEFAULT_ALIASES,
			...(commands.aliases ?? {}),
		},
	};
}

function previewToken(value: string | undefined, fallback: string): string {
	const token = value?.trim();
	return token && !/\s/.test(token) ? token : fallback;
}

function commandPreview(commands: CommandConfig, key: AliasKey, arg?: string): string {
	return [
		previewToken(commands.prefix, DEFAULT_PREFIX),
		previewToken(commands.aliases[key], DEFAULT_ALIASES[key]),
		arg,
	]
		.filter(Boolean)
		.join(" ");
}

function duplicateAliases(aliases: CommandAliases): Set<AliasKey> {
	const seen = new Map<string, AliasKey>();
	const duplicated = new Set<AliasKey>();
	for (const key of Object.keys(aliases) as AliasKey[]) {
		const normalized = aliases[key].trim().toLowerCase();
		if (!normalized) continue;
		const prev = seen.get(normalized);
		if (prev) {
			duplicated.add(prev);
			duplicated.add(key);
		} else {
			seen.set(normalized, key);
		}
	}
	return duplicated;
}

export default function Commands() {
	const qc = useQueryClient();
	const globalsQuery = useQuery({
		queryKey: ["globals"],
		queryFn: () => api.get<GlobalConfig>("/api/globals"),
	});

	const [draft, setDraft] = useState<GlobalConfig | null>(null);

	useEffect(() => {
		if (globalsQuery.data) setDraft(globalsQuery.data);
	}, [globalsQuery.data]);

	function patchDraft(delta: GlobalConfigPatch): void {
		setDraft((d) => (d ? deepMerge(d, delta) : d));
	}

	function patchCommands(delta: NonNullable<GlobalConfigPatch["commands"]>): void {
		patchDraft({ commands: delta });
	}

	const save = useMutation({
		mutationFn: async (next: GlobalConfig) => {
			const base = globalsQuery.data;
			await api.patch<GlobalConfig>(
				"/api/globals",
				buildPatch({ commands: next.commands }, { commands: base?.commands }),
			);
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["globals"] }),
	});

	useDirtyDraft<GlobalConfig>({
		pageKey: "commands",
		pageLabel: "指令功能",
		draft,
		baseline: globalsQuery.data ?? null,
		onSave: async () => {
			if (draft !== null) await save.mutateAsync(draft);
		},
		onDiscard: () => {
			if (globalsQuery.data) setDraft(globalsQuery.data);
		},
	});

	if (globalsQuery.isLoading || !draft) {
		return <div className="text-xs text-bn-text-tertiary">加载指令配置中…</div>;
	}
	if (globalsQuery.error) {
		return (
			<div className="rounded border border-bn-danger-border bg-bn-danger-soft p-2 text-xs text-bn-danger-text">
				拉取 /api/globals 失败：{String((globalsQuery.error as Error).message)}
			</div>
		);
	}

	const commands = editableCommands(draft);
	const duplicated = duplicateAliases(commands.aliases);
	const prefixInvalid = !commands.prefix.trim() || /\s/.test(commands.prefix);
	const ownerInvalid = !/^\d+$/.test(commands.ownerQq ?? "");

	return (
		<div className="bn-anim-fade-in space-y-5">
			<GlassBox
				title="指令功能"
				subtitle="OneBot 群聊订阅管理 · globals.commands"
				accent="#00AEEC"
				icon={<Icon.chat size={14} />}
				badge={commands.enabled ? "已启用" : "已停用"}
			>
				<Field code="commands.enabled">
					<Toggle value={commands.enabled} onChange={(v) => patchCommands({ enabled: v })} />
				</Field>

				<Field code="commands.prefix">
					<TInput
						value={commands.prefix}
						onChange={(v) => patchCommands({ prefix: v })}
						placeholder={DEFAULT_PREFIX}
						mono
					/>
				</Field>
				{prefixInvalid ? (
					<div className="-mt-1 mb-1 text-[11px] text-bn-danger-text">
						命令前缀不能为空，也不能包含空格。
					</div>
				) : null}

				<Field code="commands.ownerQq">
					<TInput
						value={commands.ownerQq ?? ""}
						onChange={(v) => patchCommands({ ownerQq: v.replace(/\D/g, "") || null })}
						placeholder={DEFAULT_OWNER_QQ}
						mono
					/>
				</Field>
				{ownerInvalid ? (
					<div className="-mt-1 mb-1 text-[11px] text-bn-danger-text">主人 QQ 只能填写数字。</div>
				) : null}
			</GlassBox>

			<GlassBox
				title="命令关键字"
				subtitle="只改第二段关键字；前缀统一使用上方配置"
				accent="#FB7299"
				icon={<Icon.list size={14} />}
				badge={`${COMMAND_ROWS.length} 条`}
			>
				<div className="space-y-1">
					{COMMAND_ROWS.map((row) => {
						const duplicate = duplicated.has(row.key);
						return (
							<Field code={`commands.aliases.${row.key}`} key={row.key}>
								<div className="flex w-full flex-col gap-1.5">
									<div className="flex flex-col gap-1 sm:flex-row sm:items-center">
										<TInput
											value={commands.aliases[row.key]}
											onChange={(v) =>
												patchCommands({
													aliases: { [row.key]: v } as Partial<CommandAliases>,
												})
											}
											placeholder={DEFAULT_ALIASES[row.key]}
											mono
										/>
										<div className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-bn-text-secondary sm:w-70">
											<code className="min-w-0 truncate rounded bg-bn-code-bg px-1.5 py-px font-mono text-[11px] text-bn-text-primary">
												{commandPreview(commands, row.key, row.arg)}
											</code>
											<span className="shrink-0">· {row.meaning}</span>
											{row.badge ? (
												<span className="shrink-0 rounded bg-bn-pink/12 px-1.5 py-px text-[10.5px] font-bold text-bn-pink">
													{row.badge}
												</span>
											) : null}
										</div>
									</div>
									{duplicate ? (
										<div className="text-[11px] text-bn-danger-text">关键字重复，请换一个。</div>
									) : null}
								</div>
							</Field>
						);
					})}
				</div>
			</GlassBox>

			<GlassBox
				title="权限规则"
				subtitle="主人 / 群主 / 管理员 / 普通成员授权"
				accent="#22c55e"
				icon={<Icon.guard size={14} />}
				badge="OneBot 群聊"
			>
				<div className="divide-y divide-bn-border-subtle text-[12px] text-bn-text-secondary">
					<div className="grid gap-2 py-2 sm:grid-cols-[140px_1fr]">
						<div className="font-bold text-bn-text-primary">主人 QQ</div>
						<div>可执行全部订阅命令，包括查看和删除全部订阅。</div>
					</div>
					<div className="grid gap-2 py-2 sm:grid-cols-[140px_1fr]">
						<div className="font-bold text-bn-text-primary">群主 / 管理员</div>
						<div>可新增、取消本群订阅，也可开关普通成员管理本群订阅的权限。</div>
					</div>
					<div className="grid gap-2 py-2 sm:grid-cols-[140px_1fr]">
						<div className="font-bold text-bn-text-primary">普通成员</div>
						<div>可查看本群订阅；开启授权后，可新增、取消本群订阅。</div>
					</div>
				</div>
			</GlassBox>
		</div>
	);
}
