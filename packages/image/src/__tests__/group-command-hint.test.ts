import { describe, expect, it } from "vite-plus/test";
import { CARD_FIXTURES } from "./fixtures/card-fixtures";
import { renderViaDefaultSkin } from "./fixtures/skin-render";

describe("group command hint on skinned dynamic cards", () => {
	it("keeps the hint in the new skin rendering path", async () => {
		const fixture = CARD_FIXTURES.find((item) => item.name === "dynamic-word");
		if (!fixture) throw new Error("Missing dynamic-word fixture");
		const input = await fixture.build();
		const hint = "发送 bili帮助 获取菜单";
		const html = await renderViaDefaultSkin(
			"dynamic",
			{ ...input.props, helpHint: hint },
			input.options,
		);
		expect(html).toContain(hint);
		const without = await renderViaDefaultSkin("dynamic", input.props, input.options);
		expect(without).not.toContain(hint);
	});

	it("escapes user-configured command tokens", async () => {
		const fixture = CARD_FIXTURES.find((item) => item.name === "dynamic-word");
		if (!fixture) throw new Error("Missing dynamic-word fixture");
		const input = await fixture.build();
		const html = await renderViaDefaultSkin(
			"dynamic",
			{ ...input.props, helpHint: "<script>alert(1)</script>" },
			input.options,
		);
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain("&lt;script&gt;");
	});
});
