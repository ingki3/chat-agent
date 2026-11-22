import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { SettingsPage } from "../src/pages/SettingsPage.js";

const render = (viaAccess: boolean) =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(
        MemoryRouter,
        { initialEntries: ["/settings"] },
        createElement(SettingsPage, { onChanged: () => {}, isAdmin: false, viaAccess }),
      ),
    ),
  );

/** Settings' password section (#229): only a local sign-in has a password to change there. */
describe("settings password section (#229)", () => {
  it("is shown on local access (no Access email)", () => {
    const html = render(false);
    expect(html).toContain("비밀번호 변경");
    expect(html).toContain('autoComplete="current-password"');
  });

  it("is hidden when the app was reached through Cloudflare Access", () => {
    const html = render(true);
    expect(html).not.toContain("비밀번호 변경");
    // No password form (an API key field of the connections panel is not one).
    expect(html).not.toContain("current-password");
    expect(html).not.toContain("new-password");
    // The rest of the page still renders.
    expect(html).toContain("내 지침");
  });
});
