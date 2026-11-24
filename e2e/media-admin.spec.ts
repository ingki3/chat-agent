import { expect, test } from "@playwright/test";
import { ADMIN, MOM, authFile, csrf, useAccount } from "./helpers.js";

/**
 * 관리자 → 미디어 생성 (#238 stage 1). The e2e server (FAKE_RUNTIME) answers for OpenRouter with a scripted fake
 * (`apps/server/src/media/fixture.ts`): a key starting with `sk-or-v1-e2e` is accepted, any other refused, and the
 * catalogs are small made-up lists — the real openrouter.ai is never called. The settings are server-wide, so the
 * write flow runs in one project only.
 */
let closeOther: (() => Promise<void>) | undefined;
test.afterEach(async () => {
  await closeOther?.();
  closeOther = undefined;
});

test("the admin registers an OpenRouter key, picks a model per kind and sets the limits", async ({
  page,
  baseURL,
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "server-wide settings: one project writes them");
  await useAccount(page, ADMIN);
  await page.goto("/admin?tab=media");
  const tab = page.getByRole("region", { name: "미디어 생성" });
  const keyForm = tab.getByRole("region", { name: "OpenRouter 키" });
  await expect(keyForm.getByTestId("media-key")).toContainText("키 없음");

  // A key OpenRouter refuses is not saved.
  await keyForm.getByLabel("OpenRouter API 키").fill("sk-or-v1-test-refused-000000000000000000000000");
  await keyForm.getByRole("button", { name: "확인하고 저장" }).click();
  await expect(keyForm.getByRole("alert")).toContainText("OpenRouter가 이 키를 받지 않았어요");
  await expect(keyForm.getByTestId("media-key")).toContainText("키 없음");

  // A good one: only its last 4 characters and the limit left are shown.
  const key = "sk-or-v1-e2e-synthetic-000000000000000000000wxyz";
  await keyForm.getByLabel("OpenRouter API 키").fill(key);
  await keyForm.getByRole("button", { name: "확인하고 저장" }).click();
  await expect(keyForm.getByTestId("media-key")).toContainText("관리자가 등록한 키");
  await expect(keyForm.getByTestId("media-key")).toContainText("wxyz");
  await expect(keyForm.getByTestId("media-key-remaining")).toHaveText("$87.50");
  await expect(page.locator("body")).not.toContainText(key.slice(0, 20));
  await expect(keyForm.getByLabel("OpenRouter API 키")).toHaveValue("");

  // Per kind: the catalog's models, with price and options.
  const form = tab.getByRole("form", { name: "미디어 생성 설정" });
  // Each kind's refresh button says which list it reloads.
  for (const label of ["이미지", "음성", "음악", "영상"])
    await expect(form.getByRole("button", { name: `${label} 목록 새로 고침` })).toBeEnabled();
  const image = form.getByLabel("이미지 모델");
  await expect(image.locator("option")).toHaveCount(3);
  await image.selectOption("fixture/image-one");
  await expect(form.getByTestId("media-model-image")).toContainText("$0.04/image");
  await expect(form.getByTestId("media-model-image")).toContainText("aspect_ratio: 1:1·16:9·9:16");
  await form.getByLabel("이미지 생성 켜기").check();
  await form.getByLabel("영상 모델").selectOption("fixture/video-one");
  await expect(form.getByTestId("media-model-video")).toContainText("최대 12초");
  await form.getByLabel("영상 생성 켜기").check();
  // Music lists only models with audio output.
  await expect(form.getByLabel("음악 모델").locator("option")).toHaveCount(2);

  await expect(form.getByLabel("1인당 하루 비용 한도 (USD)")).toHaveValue("50");
  await expect(form.getByLabel("한 번 실행에서 이미지 최대 횟수")).toHaveValue("4");
  await expect(form.getByLabel("한 번 실행에서 음성 최대 횟수")).toHaveValue("3");
  await expect(form.getByLabel("한 번 실행에서 영상 최대 횟수")).toHaveValue("1");
  await expect(form.getByLabel("영상 기본 길이 (초)")).toHaveValue("8");
  await form.getByLabel("1인당 하루 비용 한도 (USD)").fill("20");
  await form.getByLabel("한 번 실행에서 이미지 최대 횟수").fill("2");
  await form.getByRole("button", { name: "확인하고 저장" }).click();
  await expect(form.getByRole("status")).toHaveText("저장했어요.");

  // Kept after a reload.
  await page.reload();
  await expect(form.getByLabel("이미지 모델")).toHaveValue("fixture/image-one");
  await expect(form.getByLabel("이미지 생성 켜기")).toBeChecked();
  await expect(form.getByLabel("영상 생성 켜기")).toBeChecked();
  await expect(form.getByLabel("음성 생성 켜기")).not.toBeChecked();
  await expect(form.getByLabel("1인당 하루 비용 한도 (USD)")).toHaveValue("20");
  await expect(form.getByLabel("한 번 실행에서 이미지 최대 횟수")).toHaveValue("2");

  // Review r5: right after a save, only another field is edited and saved — the first save's value stays.
  await form.getByLabel("1인당 하루 비용 한도 (USD)").fill("15");
  await form.getByRole("button", { name: "확인하고 저장" }).click();
  await expect(form.getByRole("status")).toHaveText("저장했어요.");
  await form.getByLabel("한 번 실행에서 이미지 최대 횟수").fill("3");
  await form.getByRole("button", { name: "확인하고 저장" }).click();
  await expect(form.getByRole("status")).toHaveText("저장했어요.");
  await page.reload();
  await expect(form.getByLabel("1인당 하루 비용 한도 (USD)")).toHaveValue("15");
  await expect(form.getByLabel("한 번 실행에서 이미지 최대 횟수")).toHaveValue("3");

  // A save made from an older version (another tab saved meanwhile) is refused; the admin's value stays.
  const version = (await (await page.request.get("/api/admin/media")).json()) as {
    settingsVersion: number;
    settings: unknown;
  };
  const otherSave = await page.request.put("/api/admin/media/settings", {
    headers: csrf(baseURL!),
    data: { settings: version.settings, expectedVersion: version.settingsVersion },
  });
  expect(otherSave.status()).toBe(200);
  await form.getByLabel("1인당 하루 비용 한도 (USD)").fill("12");
  await form.getByRole("button", { name: "확인하고 저장" }).click();
  await expect(form.getByRole("alert")).toContainText("다른 곳에서 설정이 바뀌었어요");
  await expect(form.getByLabel("1인당 하루 비용 한도 (USD)")).toHaveValue("12");
  await form.getByRole("button", { name: "이 값으로 다시 저장" }).click();
  await expect(form.getByRole("status")).toHaveText("저장했어요.");
  await page.reload();
  await expect(form.getByLabel("1인당 하루 비용 한도 (USD)")).toHaveValue("12");

  // Turning a kind on needs a model (the save button waits for one).
  await form.getByLabel("음성 생성 켜기").check();
  await expect(form.getByText("켜려면 모델을 골라요.")).toBeVisible();
  await expect(form.getByRole("button", { name: "확인하고 저장" })).toBeDisabled();
  await form.getByLabel("음성 생성 켜기").uncheck();

  // Another tab swaps the key (review r3): this tab still shows wxyz. A manual refresh is refused for the old key
  // generation, the status is read again, and the new key's own list shows — never its list next to wxyz.
  // The other tab names the generation it shows, as this screen does.
  const generation = async () =>
    ((await (await page.request.get("/api/admin/media")).json()) as { key: { generation: string } }).key
      .generation;
  const other = await page.request.put("/api/admin/media/key", {
    headers: csrf(baseURL!),
    data: { key: "sk-or-v1-e2e-synthetic-other-tab-00000000000dddd", expectedGeneration: await generation() },
  });
  expect(other.status()).toBe(200);
  await expect(keyForm.getByTestId("media-key")).toContainText("wxyz");
  await form.getByRole("button", { name: "이미지 목록 새로 고침" }).click();
  await expect(keyForm.getByTestId("media-key")).toContainText("dddd");
  await expect(keyForm.getByTestId("media-key")).not.toContainText("wxyz");
  await expect(form.getByTestId("media-model-image")).toContainText("$0.04/image");
  await expect(form.getByTestId("media-catalog-error-image")).toHaveCount(0);

  // Deleting the key: back to none (this e2e server has no .env key).
  page.once("dialog", (d) => void d.accept());
  await keyForm.getByRole("button", { name: "키 지우기" }).click();
  await expect(keyForm.getByTestId("media-key")).toContainText("키 없음");
  // Nothing of the deleted key's lists stays on screen (review r2): no models, prices or list source — only the
  // saved choice itself, marked as not in a list.
  await expect(form.getByTestId("media-model-image")).toHaveCount(0);
  await expect(form.getByTestId("media-catalog-source-image")).toHaveCount(0);
  await expect(image.locator("option")).toHaveText(["모델 고르기", "fixture/image-one (목록에 없음)"]);
  await expect(form.getByLabel("음악 모델").locator("option")).toHaveText(["모델 고르기"]);
  // A new key reads its own lists.
  await keyForm.getByLabel("OpenRouter API 키").fill("sk-or-v1-e2e-synthetic-second-0000000000000vvvv");
  await keyForm.getByRole("button", { name: "확인하고 저장" }).click();
  await expect(keyForm.getByTestId("media-key")).toContainText("vvvv");
  await expect(form.getByTestId("media-model-image")).toContainText("$0.04/image");
  // Another tab deletes it: a manual refresh here ends in "키 없음" with no list and no error left over.
  const shownGeneration = await generation();
  expect(
    (
      await page.request.delete("/api/admin/media/key", {
        headers: csrf(baseURL!),
        data: { expectedGeneration: shownGeneration },
      })
    ).status(),
  ).toBe(200);
  await form.getByRole("button", { name: "이미지 목록 새로 고침" }).click();
  await expect(keyForm.getByTestId("media-key")).toContainText("키 없음");
  await expect(form.getByTestId("media-model-image")).toHaveCount(0);
  await expect(form.getByTestId("media-catalog-source-image")).toHaveCount(0);
  await expect(form.getByTestId("media-catalog-error-image")).toHaveCount(0);

  // Review r6: a write held back offline sends what was clicked, not what is on screen when it goes out.
  const otherTab = await browser.newContext({ storageState: authFile(ADMIN), baseURL: baseURL! });
  closeOther = () => otherTab.close();
  const keyInput = keyForm.getByLabel("OpenRouter API 키");
  const serverLast4 = async () =>
    ((await (await otherTab.request.get("/api/admin/media")).json()) as { key: { last4: string | null } }).key
      .last4;
  await keyInput.fill("sk-or-v1-e2e-synthetic-offline-00000000000bbbb");
  await page.context().setOffline(true);
  await keyForm.getByRole("button", { name: "확인하고 저장" }).click();
  await keyInput.fill("sk-or-v1-e2e-synthetic-offline-00000000000cccc");
  await page.context().setOffline(false);
  await expect(keyForm.getByTestId("media-key")).toContainText("bbbb");
  expect(await serverLast4()).toBe("bbbb");
  // The newer input is kept (only the saved key is cleared).
  await expect(keyInput).toHaveValue("sk-or-v1-e2e-synthetic-offline-00000000000cccc");
  await keyInput.fill("");

  // Delete of bbbb confirmed offline; meanwhile the other tab puts eeee in. Online again, the delete is refused
  // (it names bbbb's generation) and eeee stays.
  await page.context().setOffline(true);
  page.once("dialog", (d) => void d.accept());
  await keyForm.getByRole("button", { name: "키 지우기" }).click();
  const g = (
    (await (await otherTab.request.get("/api/admin/media")).json()) as { key: { generation: string } }
  ).key.generation;
  const swap = await otherTab.request.put("/api/admin/media/key", {
    headers: csrf(baseURL!),
    data: { key: "sk-or-v1-e2e-synthetic-offline-00000000000eeee", expectedGeneration: g },
  });
  expect(swap.status()).toBe(200);
  await page.context().setOffline(false);
  await expect(keyForm.getByTestId("media-key")).toContainText("eeee");
  expect(await serverLast4()).toBe("eeee");
  page.once("dialog", (d) => void d.accept());
  await keyForm.getByRole("button", { name: "키 지우기" }).click();
  await expect(keyForm.getByTestId("media-key")).toContainText("키 없음");
});

test("a member gets neither the tab's data nor the key routes", async ({ page }) => {
  await useAccount(page, MOM);
  expect((await page.request.get("/api/admin/media")).status()).toBe(403);
  expect((await page.request.get("/api/admin/media/catalog/image")).status()).toBe(403);
});
