import { describe, expect, it } from "vite-plus/test";
import { GlobalConfigSchema, makeDefaultGlobalConfig } from "./globals";
import { migrateConfigSections } from "./migration";
import { PushTargetSchema } from "./targets";

describe("custom group command migration", () => {
	it("moves legacy group settings without reusing them for private commands", () => {
		const defaults = makeDefaultGlobalConfig();
		const { groupCommands: _, ...raw } = defaults;
		const legacy = {
			enabled: false,
			prefix: "订阅",
			ownerQq: "123456",
			aliases: { ...defaults.groupCommands.aliases, help: "说明" },
			videoParse: { enabled: false },
		};
		const migrated = GlobalConfigSchema.parse({ ...raw, commands: legacy });
		expect(migrated.groupCommands).toEqual(legacy);
		expect(migrated.commands).toEqual(defaults.commands);
		expect(GlobalConfigSchema.parse(migrated)).toEqual(migrated);
	});

	it("preserves independent private and group settings", () => {
		const raw = makeDefaultGlobalConfig();
		raw.commands = { enabled: false, prefix: "/", aliases: { help: ["说明"] } };
		raw.groupCommands.prefix = "b站";
		expect(GlobalConfigSchema.parse(raw)).toEqual(raw);
	});

	it.each([true, false])("preserves legacy group member permission: %s", (enabled) => {
		const input = {
			id: "22222222-2222-4222-8222-222222222222",
			adapterId: "11111111-1111-4111-8111-111111111111",
			name: "Group",
			platform: "onebot",
			scope: "group",
			enabled: true,
			session: { groupId: "987", allowMemberManage: enabled },
		};
		const result = migrateConfigSections({ targets: [input] });
		const target = PushTargetSchema.parse(result.targets[0]);
		expect(target).toMatchObject({
			kind: "session",
			connectionId: input.adapterId,
			address: "987",
			allowMemberManage: enabled,
		});
		expect(target).not.toHaveProperty("session");
		expect(migrateConfigSections({ targets: [target] }).changed.targets).toBe(false);
	});

	it("keeps explicit new permissions over legacy values", () => {
		const result = migrateConfigSections({
			targets: [
				{
					id: "22222222-2222-4222-8222-222222222222",
					connectionId: "11111111-1111-4111-8111-111111111111",
					name: "Group",
					kind: "session",
					platform: "onebot",
					scope: "group",
					enabled: true,
					allowMemberManage: false,
					session: { groupId: "987", allowMemberManage: true },
				},
			],
		});
		expect(PushTargetSchema.parse(result.targets[0])).toMatchObject({ allowMemberManage: false });
	});
});
